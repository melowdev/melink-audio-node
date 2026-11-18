// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionDisconnectReason,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { OggReadStream } from '../audio/resolver.js';
import { buildAudioFilterChain } from '../audio/filters.js';
import { retryTransient } from '../audio/retry.js';

const STUCK_TIMEOUT_MS = 10_000;

function trackErrorData(track, error) {
  return {
    track,
    message: error.message,
    severity: 'fault',
    cause: error.message,
  };
}

export class Player {
  constructor({
    session,
    guildId,
    onDestroy,
    idleTimeoutMs,
    disableIdleCleanup = false,
    logger,
    metrics,
    audioPlayerFactory = createAudioPlayer,
    streamFactory = (track, options) => new OggReadStream(track, options),
  }) {
    this.session = session;
    this.guildId = guildId;
    this.onDestroy = onDestroy;
    this.idleTimeoutMs = idleTimeoutMs;
    this.disableIdleCleanup = disableIdleCleanup;
    this.logger = logger;
    this.metrics = metrics;
    this.streamFactory = streamFactory;
    this.connection = null;
    this.currentTrack = null;
    this.currentTrackPayload = null;
    this.volume = 100;
    this.currentResource = null;
    this.pendingEndReason = 'finished';
    this.positionOffsetMs = 0;
    this.filters = {};
    this.trackStarted = false;
    this.suppressIdleEnd = false;
    this.destroyed = false;
    this.playbackErrorHandled = false;
    this.playGeneration = 0;
    this.pendingStreams = new Set();
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.idleTimer = null;
    this.stuckTimer = null;
    this.positionTimer = null;
    this.methods = null;
    this.audioPlayer = audioPlayerFactory({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this._currentStream = null;

    this.audioPlayer.on('stateChange', (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.lastActivityAt = Date.now();
        this.#clearStuck();
        if (this.currentTrack && !this.trackStarted) {
          this.trackStarted = true;
          this.#startPositionUpdates();
          this.#emit('TrackStartEvent', {
            track: this.currentTrack,
            trackPayload: this.currentTrackPayload,
          });
        }
      } else if (newState.status === AudioPlayerStatus.Buffering) {
        this.#scheduleStuck();
      } else if (newState.status === AudioPlayerStatus.Idle) {
        this.#clearStuck();
        if (!this.suppressIdleEnd) {
          this.#clearPositionUpdates();
          this.#finishTrack(this.pendingEndReason);
        }
      }
    });
    this.audioPlayer.on('error', (error) => {
      this.#handlePlaybackError(error);
    });
    this.#scheduleIdle();
  }

  join({
    channelId,
    selfDeaf = true,
    selfMute = false,
    sendVoicePayload = true,
  }) {
    if (!/^\d{15,22}$/.test(channelId)) throw new Error('Invalid voice channel ID');
    this.lastActivityAt = Date.now();
    this.#clearIdle();

    const adapterCreator = (methods) => {
      this.methods = methods;
      return {
        sendPayload: (payload) => {
          if (!sendVoicePayload) return true;
          return this.session.send('voice:payload', {
            guildId: this.guildId,
            payload,
          });
        },
        destroy: () => {
          this.methods = null;
          return true;
        },
      };
    };

    if (this.connection) this.connection.destroy();
    this.connection = joinVoiceChannel({
      channelId,
      guildId: this.guildId,
      adapterCreator,
      selfDeaf,
      selfMute,
    });
    this.connection.on('stateChange', (oldState, newState) => {
      this.#emit('VoiceStateEvent', { state: newState.status });
      if (newState.status === VoiceConnectionStatus.Disconnected &&
          oldState.status === VoiceConnectionStatus.Ready &&
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose) {
        this.#emit('WebSocketClosedEvent', {
          code: newState.closeCode,
          reason: 'Discord voice connection disconnected',
          byRemote: true,
        });
      }
    });
    this.connection.on('error', (error) => {
      this.#emit('PlayerErrorEvent', { message: error.message });
    });
    this.connection.subscribe(this.audioPlayer);
    this.#emit('PlayerUpdateEvent', { state: 'connecting', channelId });
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) this.#scheduleIdle();
  }

  joinLavalinkVoice({ channelId, sessionId, token, endpoint, userId }) {
    this.join({ channelId, sendVoicePayload: false });
    this.updateVoice('state', {
      guild_id: this.guildId,
      channel_id: channelId,
      session_id: sessionId,
      user_id: userId,
      self_deaf: true,
      self_mute: false,
    });
    this.updateVoice('server', {
      guild_id: this.guildId,
      token,
      endpoint,
    });
  }

  disconnectVoice() {
    this.connection?.destroy();
    this.connection = null;
    this.methods = null;
  }

  updateVoice(event, data) {
    if (!this.methods) throw new Error('Join a voice channel before sending voice updates');
    if (event === 'state') this.methods.onVoiceStateUpdate(data);
    else if (event === 'server') this.methods.onVoiceServerUpdate(data);
    else throw new Error('Voice event must be "state" or "server"');
  }

  async play(track, { filters = this.filters } = {}) {
    if (!this.connection) throw new Error('Join a voice channel before playing audio');
    if (!track?.encoded || !track?.info?.title) throw new Error('Invalid track payload');
    if (this.destroyed) throw new Error('Player has been destroyed');

    const generation = ++this.playGeneration;
    this.#cancelPendingStreams();
    this.#clearIdle();
    const nextFilters = { ...filters };
    let stream;
    try {
      stream = await this.#startCandidate(track, { filters: nextFilters }, generation);
    } catch (error) {
      if (generation === this.playGeneration && !this.currentTrack) this.#scheduleIdle();
      throw error;
    }

    if (generation !== this.playGeneration || this.destroyed) {
      stream.destroy();
      throw new Error('Playback request was superseded');
    }

    const replacedTrack = this.currentTrack;
    if (replacedTrack) {
      this.pendingEndReason = 'replaced';
      this.audioPlayer.stop(true);
      this.#finishTrack('replaced');
    }
    this.filters = nextFilters;
    this.positionOffsetMs = 0;
    this.currentTrackPayload = track;
    this.currentTrack = track.info;
    this.trackStarted = false;
    this.playbackErrorHandled = false;
    this.pendingEndReason = 'finished';
    this.#playStream(stream);
    this.lastActivityAt = Date.now();
    this.#clearIdle();
    return { track: this.currentTrack };
  }

  async seek(positionMs) {
    return this.#seek(positionMs, this.filters);
  }

  async #seek(positionMs, filters) {
    if (!Number.isSafeInteger(positionMs) || positionMs < 0) {
      throw new Error('Seek position must be a non-negative integer');
    }
    if (!this.currentTrack || !this.currentTrackPayload) {
      throw new Error('No track is currently playing');
    }
    if (this.currentTrack.isSeekable !== true) {
      throw new Error('The current source does not support seeking');
    }
    if (this.currentTrack.length > 0 && positionMs > this.currentTrack.length) {
      throw new Error('Seek position exceeds the track duration');
    }
    if (!this.connection) throw new Error('Join a voice channel before seeking');

    const generation = ++this.playGeneration;
    this.#cancelPendingStreams();
    const stream = await this.#startCandidate(this.currentTrackPayload, {
      startPositionMs: positionMs,
      filters,
    }, generation);
    if (generation !== this.playGeneration || this.destroyed) {
      stream.destroy();
      throw new Error('Seek request was superseded');
    }

    const wasPaused = this.audioPlayer.state.status === AudioPlayerStatus.Paused;
    this.positionOffsetMs = positionMs;
    this.playbackErrorHandled = false;
    this.#playStream(stream);
    if (wasPaused) this.audioPlayer.pause(true);
    this.lastActivityAt = Date.now();
    return { position: this.snapshot().position };
  }

  async setFilters(filters) {
    const nextFilters = filters === null ? {} : { ...filters };
    buildAudioFilterChain(nextFilters);
    if (this.currentTrack && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      if (this.currentTrack.isSeekable !== true) {
        throw new Error('Cannot update filters while playing a non-seekable track');
      }
      const position = this.snapshot().position;
      await this.#seek(position, nextFilters);
      this.filters = nextFilters;
      return { filters: this.filters };
    }
    this.filters = nextFilters;
    return { filters: this.filters };
  }

  setVolume(volume) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 1000) {
      throw new Error('Volume must be an integer from 0 to 1000');
    }
    this.volume = volume;
    this.currentResource?.volume?.setVolume(volume / 100);
    return { volume };
  }

  pause(paused) {
    if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
    this.lastActivityAt = Date.now();
    if (paused) this.audioPlayer.pause(true);
    else this.audioPlayer.unpause();
    return { paused: this.audioPlayer.state.status === AudioPlayerStatus.Paused };
  }

  stop() {
    this.pendingEndReason = 'stopped';
    this.playGeneration++;
    this.#cancelPendingStreams();
    this.audioPlayer.stop(true);
    this.#finishTrack('stopped');
    this.lastActivityAt = Date.now();
    this.#scheduleIdle();
    return { stopped: true };
  }

  snapshot() {
    const playbackDuration = this.currentResource?.playbackDuration || 0;
    const playbackSpeed = this.filters.timescale?.speed ?? 1;
    const position = this.currentTrack
      ? this.positionOffsetMs + playbackDuration * playbackSpeed
      : 0;
    return {
      guildId: this.guildId,
      connected: Boolean(this.connection && this.connection.state.status === VoiceConnectionStatus.Ready),
      state: this.audioPlayer.state.status,
      track: this.currentTrack,
      position,
      volume: this.volume,
      filters: this.filters,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#clearIdle();
    this.#clearStuck();
    this.playGeneration++;
    this.#cancelPendingStreams();
    this.audioPlayer.stop(true);
    this.#finishTrack('stopped');
    this.connection?.destroy();
    this.connection = null;
    this.methods = null;
    this.onDestroy?.(this.guildId);
  }

  #playStream(stream) {
    const previousStream = this._currentStream;
    const resource = createAudioResource(stream, {
      inputType: StreamType.OggOpus,
      inlineVolume: true,
    });
    resource.volume.setVolume(this.volume / 100);
    this._currentStream = stream;
    this.currentResource = resource;
    stream.once('error', (error) => {
      if (this._currentStream !== stream) return;
      this.#handlePlaybackError(error);
    });
    this.suppressIdleEnd = true;
    this.audioPlayer.play(resource);
    this.suppressIdleEnd = false;
    if (previousStream && previousStream !== stream) previousStream.destroy();
  }

  async #startCandidate(track, options, generation) {
    return retryTransient(async () => {
      const controller = new AbortController();
      const stream = this.streamFactory(track, {
        ...options,
        signal: controller.signal,
      });
      const pending = { controller, stream };
      this.pendingStreams.add(pending);
      try {
        await stream.start();
        if (generation !== this.playGeneration || this.destroyed) {
          throw new Error('Playback request was superseded');
        }
        return stream;
      } catch (error) {
        stream.destroy();
        throw error;
      } finally {
        this.pendingStreams.delete(pending);
      }
    }, {
      onRetry: (error, { attempt, delayMs }) => {
        this.logger?.warn({
          guildId: this.guildId,
          attempt,
          delayMs,
          errorCode: error.cause?.code || error.code,
        }, 'Retrying track startup');
        this.metrics?.recordRetry();
      },
    });
  }

  #cancelPendingStreams() {
    for (const { controller, stream } of this.pendingStreams) {
      controller.abort(new Error('Pending playback stream was cancelled'));
      stream.destroy();
    }
    this.pendingStreams.clear();
  }

  #finishTrack(reason) {
    const endedTrack = this.currentTrack;
    const endedTrackPayload = this.currentTrackPayload;
    this.#clearStuck();
    this.#clearPositionUpdates();
    this._currentStream?.destroy();
    this._currentStream = null;
    this.currentResource = null;
    this.currentTrack = null;
    this.currentTrackPayload = null;
    this.positionOffsetMs = 0;
    this.trackStarted = false;
    if (endedTrack) {
      this.#emit('TrackEndEvent', {
        track: endedTrack,
        trackPayload: endedTrackPayload,
        reason,
      });
    }
    this.pendingEndReason = 'finished';
    this.#scheduleIdle();
  }

  #handlePlaybackError(error) {
    if (!this.currentTrack || this.playbackErrorHandled) return;
    this.playbackErrorHandled = true;
    this.logger?.warn?.({
      guildId: this.guildId,
      errorType: error.name,
      errorCode: error.code || null,
    }, 'Audio playback failed');
    this.#emit('TrackExceptionEvent', trackErrorData(this.currentTrack, error));
    this.#emit('PlayerErrorEvent', { message: error.message });
    this.pendingEndReason = 'loadFailed';
    this.audioPlayer.stop(true);
    this.#finishTrack('loadFailed');
  }

  #scheduleStuck() {
    if (!this.currentTrack || this.stuckTimer) return;
    const track = this.currentTrack;
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = null;
      if (this.currentTrack !== track ||
          this.audioPlayer.state.status !== AudioPlayerStatus.Buffering) return;
      this.#emit('TrackStuckEvent', {
        track,
        thresholdMs: STUCK_TIMEOUT_MS,
      });
    }, STUCK_TIMEOUT_MS);
    this.stuckTimer.unref?.();
  }

  #clearStuck() {
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
  }

  #startPositionUpdates() {
    if (this.positionTimer) return;
    this.positionTimer = setInterval(() => {
      if (!this.currentTrack) return this.#clearPositionUpdates();
      this.#emit('PlayerUpdateEvent', {
        state: this.audioPlayer.state.status,
        position: this.snapshot().position,
        connected: Boolean(
          this.connection &&
          this.connection.state.status === VoiceConnectionStatus.Ready,
        ),
      });
    }, 5_000);
    this.positionTimer.unref?.();
  }

  #clearPositionUpdates() {
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = null;
  }

  #scheduleIdle() {
    if (this.disableIdleCleanup || this.destroyed) return;
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1) return;
    this.#clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) return;
      this.destroy();
      this.#emit('PlayerClosedEvent', {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  #emit(type, data) {
    this.session.send(type, { guildId: this.guildId, ...data });
  }
}
