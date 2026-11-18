// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createAudioNode } from '../src/http/server.js';
import { SessionManager } from '../src/core/session-manager.js';
import { createLogger } from '../src/logger.js';
import { SourceManager } from '../src/sources/source-manager.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  token: 'test-secret-with-more-than-24-characters',
  maxPlayers: 10,
  idleTimeoutMs: 1000,
  soundcloudClientId: 'test-soundcloud-client-id',
  soundcloudEnabled: true,
};

async function createNode(t, nodeConfig = config, dependencies = {}) {
  const node = createAudioNode(nodeConfig, new SessionManager(nodeConfig), {
    logger: createLogger('silent'),
    ...dependencies,
  });
  await node.listen();
  t.after(() => node.close());
  return {
    node,
    baseUrl: `http://127.0.0.1:${node.server.address().port}`,
    websocketUrl: `ws://127.0.0.1:${node.server.address().port}/v4/websocket`,
  };
}

function openLavalinkSocket(url) {
  const socket = new WebSocket(url, {
    headers: {
      authorization: config.token,
      'user-id': '12345678901234567',
      'client-name': 'test-lavalink-client',
    },
  });
  const ready = new Promise((resolve, reject) => {
    socket.on('message', (message) => {
      const packet = JSON.parse(message.toString());
      if (packet.op === 'ready') resolve(packet);
    });
    socket.once('error', reject);
  });
  const upgraded = once(socket, 'upgrade').then(([response]) => response);
  return { socket, ready, upgraded };
}

test('Lavalink compatibility exposes authenticated info, stats, and loadtracks endpoints', async (t) => {
  const { baseUrl } = await createNode(t);

  const version = await fetch(`${baseUrl}/version`);
  assert.equal(version.status, 200);
  assert.match(await version.text(), /^4\.0\.0-melink\.0$/);

  const unauthorized = await fetch(`${baseUrl}/v4/info`);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: config.token };
  const infoResponse = await fetch(`${baseUrl}/v4/info`, { headers });
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.equal(info.version.major, 4);
  assert.deepEqual(info.sourceManagers, ['http', 'soundcloud', 'spotify', 'youtube']);
  assert.deepEqual(info.filters, [
    'volume',
    'equalizer',
    'karaoke',
    'timescale',
    'tremolo',
    'vibrato',
    'rotation',
    'channelMix',
    'lowPass',
  ]);
  assert.deepEqual(info.melinkFilters, ['highPass']);
  assert.deepEqual(info.plugins, []);

  const statsResponse = await fetch(`${baseUrl}/v4/stats`, { headers });
  const stats = await statsResponse.json();
  assert.equal(statsResponse.status, 200);
  assert.equal(typeof stats.memory.used, 'number');

  const query = encodeURIComponent('https://media.example.net/audio.mp3');
  const trackResponse = await fetch(`${baseUrl}/v4/loadtracks?identifier=${query}`, { headers });
  const loaded = await trackResponse.json();
  assert.equal(trackResponse.status, 200);
  assert.equal(loaded.loadType, 'track');
  assert.equal(loaded.data.info.title, 'audio');

  const unsupportedPlayer = await fetch(
    `${baseUrl}/v4/sessions/${'00000000-0000-0000-0000-000000000000'}/players/12345678901234567`,
    { headers },
  );
  assert.equal(unsupportedPlayer.status, 404);
});

test('Lavalink info reports active sources and loaded plugin versions from registries', async (t) => {
  const sourceManager = {
    sourceManagerNames: () => ['http', 'fixture-source'],
    listSources: () => [],
    resolve: async () => {
      throw new Error('not used');
    },
  };
  const pluginManager = {
    listPlugins: ({ enabledOnly }) => enabledOnly
      ? [{
        id: 'fixture-plugin',
        name: 'Fixture Plugin',
        version: '1.2.3',
        apiVersion: 1,
        loaded: true,
        enabled: true,
        healthy: true,
      }]
      : [],
  };
  const { baseUrl } = await createNode(t, config, { sourceManager, pluginManager });
  const response = await fetch(`${baseUrl}/v4/info`, {
    headers: { authorization: config.token },
  });

  assert.equal(response.status, 200);
  const info = await response.json();
  assert.deepEqual(info.sourceManagers, ['http', 'fixture-source']);
  assert.equal(info.plugins[0].id, 'fixture-plugin');
  assert.equal(info.plugins[0].version, '1.2.3');
  assert.deepEqual(info.filters, [
    'volume',
    'equalizer',
    'karaoke',
    'timescale',
    'tremolo',
    'vibrato',
    'rotation',
    'channelMix',
    'lowPass',
  ]);
});

test('Lavalink player limits are atomic per guild and idle players are cleaned up', async (t) => {
  const limitedConfig = { ...config, maxPlayers: 1, idleTimeoutMs: 2000 };
  const { baseUrl, websocketUrl } = await createNode(t, limitedConfig);
  const connection = openLavalinkSocket(websocketUrl);
  t.after(() => connection.socket.close());
  const { sessionId } = await connection.ready;
  const headers = {
    authorization: limitedConfig.token,
    'content-type': 'application/json',
  };
  const firstGuild = '22345678901234567';
  const secondGuild = '32345678901234567';
  const patchPlayer = (guildId) => fetch(
    `${baseUrl}/v4/sessions/${sessionId}/players/${guildId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ volume: 75 }),
    },
  );

  const duplicateRequests = await Promise.all([
    patchPlayer(firstGuild),
    patchPlayer(firstGuild),
  ]);
  assert.deepEqual(duplicateRequests.map(({ status }) => status), [200, 200]);
  const playersResponse = await fetch(
    `${baseUrl}/v4/sessions/${sessionId}/players`,
    { headers },
  );
  assert.equal((await playersResponse.json()).length, 1);
  assert.equal((await patchPlayer(secondGuild)).status, 429);

  await new Promise((resolve) => setTimeout(resolve, 2100));
  const afterIdle = await fetch(
    `${baseUrl}/v4/sessions/${sessionId}/players`,
    { headers },
  );
  assert.deepEqual(await afterIdle.json(), []);
});

test('Lavalink loadtracks preserves provider failures and reports unavailable endpoints', async (t) => {
  const sourceManager = {
    sourceManagerNames: () => [],
    listSources: () => [],
    load: async () => {
      throw Object.assign(new Error('Provider unavailable'), { statusCode: 503 });
    },
  };
  const { baseUrl } = await createNode(t, config, { sourceManager });
  const headers = { authorization: config.token };
  const query = encodeURIComponent('https://media.example.net/audio.mp3');
  const failed = await fetch(`${baseUrl}/v4/loadtracks?identifier=${query}`, { headers });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).status, 503);

  for (const endpoint of ['encodetracks', 'decodetracks']) {
    const response = await fetch(`${baseUrl}/v4/${endpoint}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });
    assert.equal(response.status, 501);
  }
});

test('Lavalink loadtracks returns ordered playlist metadata for plugin sources', async (t) => {
  const sourceManager = new SourceManager();
  sourceManager.register({
    id: 'playlist',
    name: 'Playlist source',
    capabilities: { search: false, playback: false, playlist: true },
    supportsPlaylistIdentifier: (identifier) => identifier.startsWith('playlist:'),
    async resolvePlaylist() {
      return {
        name: 'Ordered playlist',
        selectedTrack: 1,
        tracks: [
          { uri: 'https://media.example.net/one.ogg', title: 'One' },
          { uri: 'https://media.example.net/two.ogg', title: 'Two' },
        ],
      };
    },
  });
  const { baseUrl } = await createNode(t, config, { sourceManager });
  const response = await fetch(
    `${baseUrl}/v4/loadtracks?identifier=${encodeURIComponent('playlist:fixture')}`,
    { headers: { authorization: config.token } },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.loadType, 'playlist');
  assert.equal(result.data.info.name, 'Ordered playlist');
  assert.deepEqual(result.data.tracks.map((track) => track.info.title), ['One', 'Two']);
});

test('Lavalink REST routes honor the configured rate limit', async (t) => {
  const limitedConfig = { ...config, sessionRequestLimit: 1 };
  const { baseUrl } = await createNode(t, limitedConfig);
  const headers = { authorization: limitedConfig.token };

  assert.equal((await fetch(`${baseUrl}/v4/info`, { headers })).status, 200);
  const limited = await fetch(`${baseUrl}/v4/stats`, { headers });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('Lavalink WebSocket session can resume within the configured timeout', async (t) => {
  const { baseUrl, websocketUrl } = await createNode(t);
  const headers = { authorization: config.token };
  const first = openLavalinkSocket(websocketUrl);
  t.after(() => first.socket.close());
  const initialHeaders = await first.upgraded;
  assert.equal(initialHeaders.headers['lavalink-api-version'], 'v4');
  assert.equal(initialHeaders.headers['session-resumed'], 'false');
  const initialReady = await first.ready;
  assert.equal(initialReady.resumed, false);

  const resumeResponse = await fetch(`${baseUrl}/v4/sessions/${initialReady.sessionId}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ resuming: true, timeout: 10 }),
  });
  assert.equal(resumeResponse.status, 200);

  const closed = new Promise((resolve) => first.socket.once('close', resolve));
  first.socket.close(1001, 'Reconnect test');
  await closed;

  const second = openLavalinkSocket(websocketUrl);
  t.after(() => second.socket.close());
  const resumedHeaders = await second.upgraded;
  assert.equal(resumedHeaders.headers['session-resumed'], 'true');
  const resumedReady = await second.ready;
  assert.equal(resumedReady.resumed, true);
  assert.equal(resumedReady.sessionId, initialReady.sessionId);
});
