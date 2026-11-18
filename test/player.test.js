// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { Player } from '../src/core/player.js';

class FixtureAudioPlayer extends EventEmitter {
  state = { status: AudioPlayerStatus.Idle };

  play(resource) {
    this.resource = resource;
    this.#change(AudioPlayerStatus.Playing, { resource });
  }

  pause() {
    this.#change(AudioPlayerStatus.Paused, { resource: this.resource });
  }

  unpause() {
    this.#change(AudioPlayerStatus.Playing, { resource: this.resource });
  }

  stop() {
    this.#change(AudioPlayerStatus.Idle);
    this.resource = null;
  }

  #change(status, extra = {}) {
    const oldState = this.state;
    this.state = { status, ...extra };
    this.emit('stateChange', oldState, this.state);
  }
}

function createTestPlayer({
  idleTimeoutMs = 1000,
  disableIdleCleanup = true,
} = {}) {
  const events = [];
  const streams = [];
  let destroyed = false;
  const player = new Player({
    session: { send: (type, data) => events.push({ type, data }) },
    guildId: '12345678901234567',
    onDestroy: () => { destroyed = true; },
    idleTimeoutMs,
    disableIdleCleanup,
    audioPlayerFactory: () => new FixtureAudioPlayer(),
    streamFactory: (_track, options) => {
      const stream = new PassThrough();
      stream.start = async () => stream;
      stream.options = options;
      streams.push(stream);
      return stream;
    },
  });
  player.connection = {
    state: { status: VoiceConnectionStatus.Ready },
    destroy() {},
  };
  return {
    player,
    events,
    streams,
    wasDestroyed: () => destroyed,
  };
}

test('player tracks position and preserves pause across FFmpeg seek restarts', async () => {
  const { player, events, streams } = createTestPlayer();
  const track = {
    encoded: 'fixture-track',
    info: { title: 'Fixture', length: 20_000, isSeekable: true },
  };

  await player.play(track);
  assert.equal(events.filter(({ type }) => type === 'TrackStartEvent').length, 1);
  let appliedVolume;
  const setResourceVolume = player.currentResource.volume.setVolume.bind(
    player.currentResource.volume,
  );
  player.currentResource.volume.setVolume = (volume) => {
    appliedVolume = volume;
    setResourceVolume(volume);
  };
  assert.deepEqual(player.setVolume(75), { volume: 75 });
  assert.equal(appliedVolume, 0.75);
  player.currentResource.playbackDuration = 1_500;
  assert.equal(player.snapshot().position, 1_500);

  assert.equal(player.pause(true).paused, true);
  await player.seek(5_000);
  assert.equal(streams[1].options.startPositionMs, 5_000);
  assert.equal(player.snapshot().position, 5_000);
  assert.equal(player.snapshot().state, AudioPlayerStatus.Paused);

  assert.equal(player.pause(false).paused, false);
  player.currentResource.playbackDuration = 1_000;
  assert.equal(player.snapshot().position, 6_000);

  await player.setFilters({ volume: 0.5, timescale: { speed: 1.5 } });
  assert.equal(streams[2].options.startPositionMs, 6_000);
  assert.equal(player.snapshot().filters.volume, 0.5);
  player.currentResource.playbackDuration = 1_000;
  assert.equal(player.snapshot().position, 7_500);
  assert.equal(events.filter(({ type }) => type === 'TrackStartEvent').length, 1);
  await assert.rejects(player.setFilters({ unknown: true }), /Unsupported audio filter/);
  player.destroy();
});

test('player rejects unsupported seek and emits one end event on replacement', async () => {
  const { player, events, streams, wasDestroyed } = createTestPlayer();
  await player.play({
    encoded: 'non-seekable',
    info: { title: 'Live', length: 0, isSeekable: false, isStream: true },
  });
  await assert.rejects(player.seek(100), /does not support seeking/);

  await player.play({
    encoded: 'replacement',
    info: { title: 'Replacement', length: 10_000, isSeekable: true },
  });
  const endEvents = events.filter(({ type }) => type === 'TrackEndEvent');
  assert.equal(endEvents.length, 1);
  assert.equal(endEvents[0].data.reason, 'replaced');
  assert.equal(endEvents[0].data.track.title, 'Live');
  assert.equal(streams[0].destroyed, true);

  player.stop();
  player.destroy();
  assert.equal(wasDestroyed(), true);
  assert.equal(events.filter(({ type }) => type === 'TrackEndEvent').length, 2);
});

test('player destroy aborts pending stream startup', async () => {
  const events = [];
  let pendingStream;
  const player = new Player({
    session: { send: (type, data) => events.push({ type, data }) },
    guildId: '12345678901234567',
    idleTimeoutMs: 1000,
    disableIdleCleanup: true,
    audioPlayerFactory: () => new FixtureAudioPlayer(),
    streamFactory: (_track, { signal }) => {
      pendingStream = new PassThrough();
      pendingStream.start = () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return pendingStream;
    },
  });
  player.connection = {
    state: { status: VoiceConnectionStatus.Ready },
    destroy() {},
  };
  const request = player.play({
    encoded: 'pending-track',
    info: { title: 'Pending', length: 10_000, isSeekable: false },
  });

  player.destroy();
  await assert.rejects(request, /cancelled/);
  assert.equal(pendingStream.destroyed, true);
  assert.equal(events.some(({ type }) => type === 'TrackStartEvent'), false);
});

test('idle cleanup destroys only idle players and leaves active playback alone', async () => {
  const { player, events, wasDestroyed } = createTestPlayer({
    idleTimeoutMs: 30,
    disableIdleCleanup: false,
  });
  await player.play({
    encoded: 'active-track',
    info: { title: 'Active', length: 10_000, isSeekable: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wasDestroyed(), false);
  assert.equal(player.currentTrack.title, 'Active');

  const closed = new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    const check = ({ type }) => {
      if (type !== 'PlayerClosedEvent') return;
      clearTimeout(timer);
      resolve();
    };
    const originalSend = player.session.send;
    player.session.send = (type, data) => {
      originalSend(type, data);
      check({ type, data });
    };
  });
  player.stop();
  await closed;
  assert.equal(wasDestroyed(), true);
  assert.equal(player.connection, null);
});
