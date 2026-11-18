// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Connector, Shoukaku } from 'shoukaku';
import { createAudioNode } from '../src/http/server.js';
import { SessionManager } from '../src/core/session-manager.js';
import { createLogger } from '../src/logger.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  token: 'test-secret-with-more-than-24-characters',
  maxPlayers: 10,
  idleTimeoutMs: 1000,
};

class FixtureConnector extends Connector {
  constructor(userId) {
    super({});
    this.userId = userId;
  }

  getId() {
    return this.userId;
  }

  sendPacket(_shardId, packet) {
    if (packet.op !== 4 || !packet.d.channel_id) return;
    const { guild_id: guildId, channel_id: channelId } = packet.d;
    setImmediate(() => {
      this.raw({
        t: 'VOICE_STATE_UPDATE',
        d: {
          guild_id: guildId,
          user_id: this.userId,
          channel_id: channelId,
          session_id: 'discord-voice-session',
          self_deaf: packet.d.self_deaf,
          self_mute: packet.d.self_mute,
        },
      });
      this.raw({
        t: 'VOICE_SERVER_UPDATE',
        d: {
          guild_id: guildId,
          token: 'fixture-voice-token',
          endpoint: 'voice.example.invalid',
        },
      });
    });
  }

  listen(nodes) {
    this.ready(nodes);
  }
}

function createFixturePlayer({ session, guildId, onDestroy }) {
  const player = {
    voice: null,
    track: null,
    volume: 100,
    paused: false,
    filters: {},
    async joinLavalinkVoice(voice) {
      this.voice = voice;
    },
    disconnectVoice() {
      this.voice = null;
    },
    setVolume(volume) {
      this.volume = volume;
    },
    async setFilters(filters) {
      this.filters = filters;
    },
    async play(track) {
      this.track = track;
      this.paused = false;
      session.send('TrackStartEvent', { guildId, track: track.info });
    },
    pause(paused) {
      this.paused = paused;
    },
    stop() {
      const endedTrack = this.track;
      this.track = null;
      if (endedTrack) {
        session.send('TrackEndEvent', {
          guildId,
          track: endedTrack.info,
          reason: 'stopped',
        });
      }
    },
    snapshot() {
      return {
        connected: Boolean(this.voice),
        state: this.track ? (this.paused ? 'paused' : 'playing') : 'idle',
        position: 0,
        filters: this.filters,
      };
    },
    destroy() {
      this.track = null;
      this.voice = null;
      onDestroy(guildId);
    },
  };
  return player;
}

test('Shoukaku connects, resolves a direct track, joins, plays, pauses, and leaves', async (t) => {
  const node = createAudioNode(config, new SessionManager(config), {
    logger: createLogger('silent'),
    lavalinkPlayerFactory: createFixturePlayer,
  });
  await node.listen();

  const nodeAddress = `127.0.0.1:${node.server.address().port}`;
  const userId = '12345678901234567';
  const guildId = '22345678901234567';
  const connector = new FixtureConnector(userId);
  const manager = new Shoukaku(connector, [{
    name: 'melink',
    url: nodeAddress,
    auth: config.token,
    secure: false,
  }], {
    reconnectTries: 1,
    reconnectInterval: 0.01,
    restTimeout: 2,
    voiceConnectionTimeout: 2,
  });
  manager.on('error', () => {});
  const shoukakuNode = manager.nodes.get('melink');
  t.after(async () => {
    if (manager.connections.has(guildId)) await manager.leaveVoiceChannel(guildId);
    shoukakuNode.ws?.removeAllListeners();
    shoukakuNode.ws?.terminate();
    await node.close();
  });

  await once(manager, 'ready');
  assert.ok(shoukakuNode.sessionId);
  assert.equal((await shoukakuNode.rest.getLavalinkInfo()).version.major, 4);

  const loaded = await shoukakuNode.rest.resolve('https://media.example.net/audio.mp3');
  assert.equal(loaded.loadType, 'track');
  assert.equal(loaded.data.info.title, 'audio');
  assert.equal(typeof loaded.data.encoded, 'string');

  const player = await manager.joinVoiceChannel({
    guildId,
    shardId: 0,
    channelId: '32345678901234567',
  });
  const joined = await shoukakuNode.rest.getPlayer(guildId);
  assert.equal(joined.voice.channelId, '32345678901234567');

  const started = once(player, 'start');
  await player.playTrack({ track: { encoded: loaded.data.encoded } });
  assert.equal((await started)[0].track.info.title, 'audio');

  await player.setPaused(true);
  await player.setGlobalVolume(75);
  await player.setFilters({ volume: 0.5 });
  const playerResponse = await shoukakuNode.rest.getPlayer(guildId);
  assert.equal(playerResponse.paused, true);
  assert.equal(playerResponse.volume, 75);
  assert.equal(playerResponse.track.info.title, 'audio');
  assert.equal(playerResponse.filters.volume, 0.5);

  const ended = once(player, 'end');
  await player.stopTrack();
  assert.equal((await ended)[0].reason, 'stopped');

  await manager.leaveVoiceChannel(guildId);
  await assert.rejects(
    shoukakuNode.rest.getPlayer(guildId),
    (error) => error.status === 404,
  );
});
