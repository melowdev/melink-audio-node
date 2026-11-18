// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createAudioNode } from '../src/http/server.js';
import { SessionManager } from '../src/core/session-manager.js';
import { openAudioStream, resolveIdentifier } from '../src/audio/resolver.js';
import { ResolverRegistry } from '../src/audio/resolver-registry.js';
import { loadConfig } from '../src/config.js';
import { SourceManager } from '../src/sources/source-manager.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  token: 'test-secret-with-more-than-24-characters',
  maxPlayers: 10,
  idleTimeoutMs: 1000,
  httpEnabled: true,
  soundcloudEnabled: true,
  spotifyEnabled: true,
  youtubeEnabled: true,
};

test('health endpoint is available without credentials', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const response = await fetch(`http://127.0.0.1:${node.server.address().port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('readiness and Prometheus metrics expose service state with protected metrics', async (t) => {
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const node = createAudioNode(config, new SessionManager(config), { logger });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });

  const unauthorized = await fetch(`${baseUrl}/metrics`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
  const output = await response.text();
  assert.match(output, /melink_audio_node_sessions 0/);
  assert.match(output, /melink_audio_node_http_requests_total/);
});

test('source inventory requires the node token and omits provider credentials', async (t) => {
  const configured = {
    ...config,
    youtubeApiKey: 'secret-youtube-key',
    spotifyClientId: 'secret-spotify-id',
    spotifyClientSecret: 'secret-spotify-secret',
    soundcloudClientId: 'secret-soundcloud-id',
    soundcloudOAuthToken: 'secret-soundcloud-token',
  };
  const node = createAudioNode(configured, new SessionManager(configured));
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/v1/sources`)).status, 401);
  const response = await fetch(`${baseUrl}/v1/sources`, {
    headers: { authorization: `Bearer ${configured.token}` },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const { sources } = JSON.parse(body);
  assert.deepEqual(sources.map(({ id }) => id), [
    'http',
    'soundcloud',
    'spotify',
    'youtube',
  ]);
  assert.equal(sources.find(({ id }) => id === 'soundcloud').configured, true);
  for (const secret of [
    configured.youtubeApiKey,
    configured.spotifyClientId,
    configured.spotifyClientSecret,
    configured.soundcloudClientId,
    configured.soundcloudOAuthToken,
  ]) {
    assert.equal(body.includes(secret), false);
  }
});

test('source APIs return ordered playlists and only public catalog metadata', async (t) => {
  const sourceManager = new SourceManager();
  sourceManager.register({
    id: 'fixture',
    name: 'Fixture',
    capabilities: {
      search: false,
      catalog: true,
      playback: false,
      playlist: true,
      metadata: true,
    },
    supportsPlaylistIdentifier: (identifier) => identifier.startsWith('fixture:'),
    async resolvePlaylist() {
      return {
        name: 'Fixture playlist',
        selectedTrack: 1,
        tracks: [
          { uri: 'https://media.example.net/first.ogg', title: 'First' },
          { uri: 'https://media.example.net/second.ogg', title: 'Second' },
        ],
      };
    },
    async resolveCatalog() {
      return {
        playable: true,
        info: {
          title: 'Catalog item',
          uri: 'https://media.example.net/audio?signature=secret',
          apiKey: 'secret-api-key',
        },
      };
    },
    async getMetadata() {
      return {
        title: 'Catalog item',
        uri: 'https://media.example.net/audio?signature=secret',
        apiKey: 'secret-api-key',
      };
    },
  });
  const node = createAudioNode(config, new SessionManager(config), { sourceManager });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const nodeHeaders = { authorization: `Bearer ${config.token}` };

  const sourceResponse = await fetch(`${baseUrl}/v1/sources`, { headers: nodeHeaders });
  const source = (await sourceResponse.json()).sources[0];
  assert.equal(source.catalogSupported, true);
  assert.equal(source.playlistSupported, true);
  assert.equal(source.metadataSupported, true);

  const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { ...nodeHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ clientName: 'fixture' }),
  });
  const { sessionId, sessionToken } = await sessionResponse.json();
  const sessionHeaders = {
    authorization: `Bearer ${sessionToken}`,
    'content-type': 'application/json',
  };
  const playlistResponse = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ identifier: 'fixture:playlist', source: 'fixture' }),
  });
  const playlist = await playlistResponse.json();
  assert.equal(playlist.loadType, 'playlist');
  assert.equal(playlist.playlistInfo.selectedTrack, 1);
  assert.deepEqual(playlist.tracks.map((track) => track.info.title), ['First', 'Second']);

  for (const route of ['catalog', 'metadata']) {
    const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/${route}`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ source: 'fixture', identifier: 'fixture:item' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.info?.title || result.title, 'Catalog item');
    assert.equal(JSON.stringify(result).includes('signature'), false);
    assert.equal(JSON.stringify(result).includes('apiKey'), false);
  }
});

test('session creation requires the node token and issues a session credential', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof body.sessionToken, 'string');
});

test('track loading accepts direct HTTP URLs and rejects search terms', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  const { sessionId, sessionToken } = await created.json();

  const valid = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identifier: 'https://example.com/audio.mp3' }),
  });
  assert.equal(valid.status, 200);
  const track = (await valid.json()).tracks[0];
  assert.equal(track.info.title, 'audio');
  assert.equal(JSON.parse(Buffer.from(track.encoded, 'base64url').toString()).uri,
    'https://example.com/audio.mp3');

  const invalid = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identifier: 'lofi music' }),
  });
  assert.equal(invalid.status, 400);

  const soundcloudWithoutCredentials = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/loadtracks`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ identifier: 'https://soundcloud.com/artist/track' }),
    },
  );
  assert.equal(soundcloudWithoutCredentials.status, 503);
});

test('track loading dispatches supported identifiers to configured resolver plugins', async (t) => {
  const sessions = new SessionManager(config);
  const resolverRegistry = new ResolverRegistry([{
    apiVersion: 1,
    name: 'fixture',
    supports: (identifier) => identifier.startsWith('fixture:'),
    resolve: async (identifier) => ({
      uri: 'https://media.example.net/audio.ogg',
      identifier,
      title: 'Plugin track',
      author: 'Plugin artist',
      length: 60_000,
    }),
  }]);
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const node = createAudioNode(config, sessions, { resolverRegistry, logger });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  const { sessionId, sessionToken } = await created.json();

  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identifier: 'fixture:audio' }),
  });

  assert.equal(response.status, 200);
  const track = (await response.json()).tracks[0];
  assert.equal(track.info.sourceName, 'fixture');
  assert.equal(track.info.title, 'Plugin track');
});

test('catalog search requires a session and returns provider metadata', async (t) => {
  const configWithToken = {
    ...config,
    sessionRequestLimit: 10,
    youtubeApiKey: 'test-youtube-key',
  };
  const sessions = new SessionManager(configWithToken);
  const catalogSearch = async (source, query) => {
    assert.equal(source, 'youtube');
    assert.equal(query, 'ambient');
    return [{
      playable: false,
      info: {
        identifier: 'https://www.youtube.com/watch?v=video-id',
        title: 'Ambient video',
        author: 'Creator',
        length: 0,
        uri: 'https://www.youtube.com/watch?v=video-id',
        sourceName: 'youtube',
        isSeekable: false,
        isStream: false,
      },
    }];
  };
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const node = createAudioNode(configWithToken, sessions, { catalogSearch, logger });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configWithToken.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  const { sessionId, sessionToken } = await created.json();

  const unauthorized = await fetch(`${baseUrl}/v1/sessions/${sessionId}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'youtube', query: 'ambient' }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: 'youtube', query: 'ambient' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.loadType, 'search');
  assert.equal(body.tracks[0].playable, false);
  assert.equal(body.tracks[0].info.sourceName, 'youtube');
});

test('search API aggregates configured sources and retains source-specific requests', async (t) => {
  const configWithToken = { ...config, sessionRequestLimit: 10 };
  const sessions = new SessionManager(configWithToken);
  const sourceManager = new SourceManager({ retries: 0 });
  const searchLimits = [];
  sourceManager.register({
    id: 'alpha',
    name: 'Alpha',
    capabilities: { search: true, playback: false, playlist: false },
    async search({ query, limit }) {
      assert.equal(query, 'ambient');
      searchLimits.push(limit);
      return [{
        playable: false,
        info: {
          identifier: 'https://alpha.example/ambient',
          title: 'Ambient track',
          author: 'Alpha artist',
          length: 10_000,
          sourceName: 'alpha',
        },
      }];
    },
  });
  sourceManager.register({
    id: 'broken',
    name: 'Broken',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
    },
  });
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const node = createAudioNode(configWithToken, sessions, {
    sourceManager,
    logger,
  });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configWithToken.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  const { sessionId, sessionToken } = await created.json();
  const searchUrl = `${baseUrl}/v1/sessions/${sessionId}/search`;
  const headers = {
    authorization: `Bearer ${sessionToken}`,
    'content-type': 'application/json',
  };

  const aggregateResponse = await fetch(searchUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'ambient', limit: 5 }),
  });
  assert.equal(aggregateResponse.status, 200);
  const aggregate = await aggregateResponse.json();
  assert.equal(aggregate.loadType, 'search');
  assert.equal(aggregate.query, 'ambient');
  assert.equal(aggregate.total, 1);
  assert.equal(aggregate.tracks[0].info.title, 'Ambient track');
  assert.deepEqual(aggregate.sources, [
    { source: 'alpha', success: true, count: 1 },
    { source: 'broken', success: false, count: 0 },
  ]);
  assert.equal(aggregate.successfulSources, 1);
  assert.equal(aggregate.failedSources, 1);
  assert.equal(aggregate.errors[0].statusCode, 503);

  const legacyResponse = await fetch(searchUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: 'alpha', query: 'ambient' }),
  });
  assert.equal(legacyResponse.status, 200);
  const legacy = await legacyResponse.json();
  assert.equal(legacy.source, 'alpha');
  assert.equal(legacy.tracks.length, 1);
  assert.equal('sources' in legacy, false);
  assert.deepEqual(searchLimits, [5, 10]);

  const invalidLimit = await fetch(searchUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'ambient', limit: 11 }),
  });
  assert.equal(invalidLimit.status, 400);
});

test('REST rate limits include retry metadata and health remains exempt', async (t) => {
  const limitedConfig = {
    ...config,
    rateLimitWindowMs: 60_000,
    sessionRequestLimit: 1,
  };
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const node = createAudioNode(limitedConfig, new SessionManager(limitedConfig), { logger });
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const headers = { authorization: `Bearer ${limitedConfig.token}` };

  const first = await fetch(`${baseUrl}/v1/stats`, { headers });
  assert.equal(first.status, 200);
  assert.ok(first.headers.get('x-request-id'));
  assert.equal(first.headers.get('ratelimit-limit'), '1');

  const limited = await fetch(`${baseUrl}/v1/stats`, { headers });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.ok(Number(limited.headers.get('ratelimit-reset')) >= 1);
  assert.equal(limited.headers.get('ratelimit-remaining'), '0');

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
});

test('media resolver rejects credentials and private-network destinations', async () => {
  assert.throws(
    () => resolveIdentifier('https://user:password@example.com/audio.mp3'),
    /must not contain credentials/,
  );
  await assert.rejects(
    openAudioStream('http://127.0.0.1:8080/audio.mp3'),
    /public IP addresses/,
  );
});

test('WebSocket sessions authenticate and deliver node events', async (t) => {
  const sessions = new SessionManager(config);
  const session = sessions.create('test-bot');
  const node = createAudioNode(config, sessions);
  await node.listen();
  t.after(() => node.close());

  const socket = new WebSocket(`ws://127.0.0.1:${node.server.address().port}/v1/ws`);
  t.after(() => socket.close());
  const ready = new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({
      op: 'authenticate',
      sessionId: session.id,
      sessionToken: session.token,
    })));
    socket.on('message', (message) => {
      const packet = JSON.parse(message.toString());
      if (packet.op === 'ready') resolve();
    });
    socket.once('error', reject);
  });
  await ready;

  const event = new Promise((resolve) => {
    socket.once('message', (message) => resolve(JSON.parse(message.toString())));
  });
  assert.equal(session.send('TestEvent', { guildId: '12345678901234567' }), true);
  assert.deepEqual(await event, { op: 'TestEvent', guildId: '12345678901234567' });
});

test('hosting SERVER_PORT is used when PORT is not set', () => {
  const loaded = loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    SERVER_PORT: '25627',
  });
  assert.equal(loaded.port, 25627);
});

test('resolver, logging, and rate-limit settings are parsed and validated', () => {
  const loaded = loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    LOG_LEVEL: 'debug',
    AUDIO_NODE_RESOLVERS: 'resolver-one, @example/resolver-two',
    AUDIO_NODE_PLUGINS: 'source-one@1.2.3',
    AUDIO_NODE_DISABLED_PLUGINS: 'source-one',
    AUDIO_NODE_DISABLED_SOURCES: 'youtube',
    HTTP_ENABLED: 'false',
    SOUNDCLOUD_ENABLED: 'true',
    SPOTIFY_ENABLED: 'false',
    YOUTUBE_ENABLED: 'false',
    YOUTUBE_API_KEY: 'youtube-key',
    SPOTIFY_CLIENT_ID: 'spotify-id',
    SPOTIFY_CLIENT_SECRET: 'spotify-secret',
    SOUNDCLOUD_CLIENT_ID: 'soundcloud-id',
    SOUNDCLOUD_OAUTH_TOKEN: 'soundcloud-token',
    RATE_LIMIT_WINDOW_MS: '30000',
    SESSION_CREATE_LIMIT: '5',
    SESSION_REQUEST_LIMIT: '75',
  });
  assert.equal(loaded.logLevel, 'debug');
  assert.deepEqual(loaded.resolverPlugins, ['resolver-one', '@example/resolver-two']);
  assert.deepEqual(loaded.pluginPackages, ['source-one@1.2.3']);
  assert.deepEqual(loaded.disabledPlugins, ['source-one']);
  assert.deepEqual(loaded.disabledSources, ['youtube']);
  assert.equal(loaded.httpEnabled, false);
  assert.equal(loaded.soundcloudEnabled, true);
  assert.equal(loaded.spotifyEnabled, false);
  assert.equal(loaded.youtubeEnabled, false);
  assert.equal(loaded.youtubeApiKey, 'youtube-key');
  assert.equal(loaded.spotifyClientId, 'spotify-id');
  assert.equal(loaded.spotifyClientSecret, 'spotify-secret');
  assert.equal(loaded.soundcloudClientId, 'soundcloud-id');
  assert.equal(loaded.soundcloudOAuthToken, 'soundcloud-token');
  assert.equal(loaded.rateLimitWindowMs, 30_000);
  assert.equal(loaded.sessionCreateLimit, 5);
  assert.equal(loaded.sessionRequestLimit, 75);
  assert.throws(() => loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    LOG_LEVEL: 'verbose',
  }), /LOG_LEVEL must be one of/);
});

test('source enable flags default safely and SoundCloud requires a client ID when enabled', () => {
  const defaults = loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
  });
  assert.equal(defaults.httpEnabled, true);
  assert.equal(defaults.soundcloudEnabled, false);
  assert.equal(defaults.spotifyEnabled, true);
  assert.equal(defaults.youtubeEnabled, true);

  assert.doesNotThrow(() => loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    SOUNDCLOUD_ENABLED: 'false',
  }));
  assert.throws(() => loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    SOUNDCLOUD_ENABLED: 'true',
  }), /SOUNDCLOUD_ENABLED=true requires SOUNDCLOUD_CLIENT_ID/);
  assert.throws(() => loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    HTTP_ENABLED: 'yes',
  }), /HTTP_ENABLED must be "true" or "false"/);
});
