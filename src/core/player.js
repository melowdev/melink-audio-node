// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { OggReadStream } from '../audio/resolver.js';

export class Player {
  constructor({ session, guildId, onDestroy, idleTimeoutMs }) {
    this.session = session;
    this.guildId = guildId;
    this.onDestroy = onDestroy;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connection = null;
    this.currentTrack = null;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.idleTimer = null;
    this.methods = null;
    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this._currentStream = null;

    this.audioPlayer.on('stateChange', (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.lastActivityAt = Date.now();
        this.#emit('TrackStartEvent', { track: this.currentTrack });
      } else if (newState.status === AudioPlayerStatus.Idle && this.currentTrack) {
        const endedTrack = this.currentTrack;
        this.currentTrack = null;
        this.#emit('TrackEndEvent', { track: endedTrack, reason: 'finished' });
        this.#scheduleIdle();
      }
    });
    this.audioPlayer.on('error', (error) => {
      this.#emit('PlayerErrorEvent', { message: error.message });
    });
  }

  join({ channelId, selfDeaf = true, selfMute = false }) {
    if (!/^\d{15,22}$/.test(channelId)) throw new Error('Invalid voice channel ID');
    this.lastActivityAt = Date.now();
    this.#clearIdle();

    const adapterCreator = (methods) => {
      this.methods = methods;
      return {
        sendPayload: (payload) => this.session.send('voice:payload', {
          guildId: this.guildId,
          payload,
        }),
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
    this.connection.on('stateChange', (_oldState, newState) => {
      this.#emit('VoiceStateEvent', { state: newState.status });
    });
    this.connection.on('error', (error) => {
      this.#emit('PlayerErrorEvent', { message: error.message });
    });
    this.connection.subscribe(this.audioPlayer);
    this.#emit('PlayerUpdateEvent', { state: 'connecting', channelId });
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) this.#scheduleIdle();
  }

  updateVoice(event, data) {
    if (!this.methods) throw new Error('Join a voice channel before sending voice updates');
    if (event === 'state') this.methods.onVoiceStateUpdate(data);
    else if (event === 'server') this.methods.onVoiceServerUpdate(data);
    else throw new Error('Voice event must be "state" or "server"');
  }

  async play(track) {
    if (!this.connection) throw new Error('Join a voice channel before playing audio');
    if (!track?.encoded || !track?.info?.title) throw new Error('Invalid track payload');

    this.lastActivityAt = Date.now();
    this.#clearIdle();
    const stream = new OggReadStream(track);
    try {
      await stream.start();
    } catch (error) {
      stream.destroy();
      throw error;
    }
    this._currentStream = stream;
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
    this.currentTrack = track.info;
    this.audioPlayer.play(resource);
    return { track: this.currentTrack };
  }

  pause(paused) {
    this.lastActivityAt = Date.now();
    if (paused) this.audioPlayer.pause();
    else this.audioPlayer.unpause();
    return { paused: this.audioPlayer.state.status === AudioPlayerStatus.Paused };
  }

  stop() {
    this._currentStream?.destroy();
    this.audioPlayer.stop(true);
    this.currentTrack = null;
    this.lastActivityAt = Date.now();
    this.#scheduleIdle();
    return { stopped: true };
  }

  snapshot() {
    return {
      guildId: this.guildId,
      connected: Boolean(this.connection && this.connection.state.status === VoiceConnectionStatus.Ready),
      state: this.audioPlayer.state.status,
      track: this.currentTrack,
      position: this.audioPlayer.state.resource?.playbackDuration ?? 0,
    };
  }

  destroy() {
    this.#clearIdle();
    this._currentStream?.destroy();
    this.audioPlayer.stop(true);
    this.connection?.destroy();
    this.connection = null;
  }

  #scheduleIdle() {
    this.#clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) return;
      this.destroy();
      this.onDestroy(this.guildId);
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