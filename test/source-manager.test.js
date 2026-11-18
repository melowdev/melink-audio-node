// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoundCloudResolver } from '../src/audio/catalog-search.js';
import { ResolverRegistry } from '../src/audio/resolver-registry.js';
import { createSourceManager } from '../src/sources/builtins.js';
import { SourceManager } from '../src/sources/source-manager.js';
import { createLegacyResolverSource } from '../src/sources/legacy-resolver-adapter.js';

test('source registration validates capabilities and rejects duplicate ids', () => {
  const manager = new SourceManager();
  const source = {
    id: 'fixture',
    name: 'Fixture',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      return [];
    },
  };

  manager.register(source);
  assert.throws(() => manager.register(source), /already registered/);
  assert.throws(() => manager.register({
    ...source,
    id: 'invalid',
    capabilities: { ...source.capabilities, search: false },
  }), /does not match its implementation/);
  assert.deepEqual(manager.listSources(), [{
    id: 'fixture',
    name: 'Fixture',
    pluginId: null,
    loaded: true,
    enabled: true,
    configured: true,
    startupHealthy: true,
    healthy: true,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    searchSupported: true,
    catalogSupported: false,
    playbackSupported: false,
    playlistSupported: false,
    metadataSupported: false,
  }]);
});

test('legacy resolvers adapt to the source manager without changing normalized tracks', async () => {
  const manager = new SourceManager();
  manager.register(createLegacyResolverSource({
    apiVersion: 1,
    name: 'fixture',
    supports: (identifier) => identifier.startsWith('fixture:'),
    resolve: async (identifier) => ({
      uri: 'https://media.example.net/audio.ogg',
      identifier,
      title: 'Legacy track',
      author: 'Legacy artist',
      length: 60_000,
    }),
  }));

  const track = await manager.resolve('fixture:track');
  assert.equal(track.info.sourceName, 'fixture');
  assert.equal(track.info.title, 'Legacy track');
  assert.equal(
    JSON.parse(Buffer.from(track.encoded, 'base64url').toString()).uri,
    'https://media.example.net/audio.ogg',
  );
});

test('unavailable sources report declared capabilities without claiming support', () => {
  const manager = new SourceManager();
  manager.registerUnavailableSource({
    id: 'disabled',
    name: 'Disabled source',
    pluginId: 'fixture-plugin',
    declaredCapabilities: {
      search: true,
      catalog: false,
      playback: true,
      playlist: false,
      metadata: false,
    },
  });

  assert.deepEqual(manager.listSources(), [{
    id: 'disabled',
    name: 'Disabled source',
    pluginId: 'fixture-plugin',
    loaded: false,
    enabled: false,
    configured: false,
    startupHealthy: false,
    healthy: false,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    searchSupported: false,
    playbackSupported: false,
    playlistSupported: false,
    catalogSupported: false,
    metadataSupported: false,
    declaredCapabilities: {
      search: true,
      catalog: false,
      playback: true,
      playlist: false,
      metadata: false,
    },
  }]);
});

test('disabled sources retain loaded capability metadata but cannot be used', async () => {
  const manager = new SourceManager();
  manager.register({
    id: 'disabled-search',
    name: 'Disabled search',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      return [];
    },
  }, { enabled: false });

  const [status] = manager.listSources();
  assert.equal(status.loaded, true);
  assert.equal(status.enabled, false);
  assert.equal(status.searchSupported, true);
  await assert.rejects(manager.search('disabled-search', 'query'), /disabled/);
});

test('catalog-only sources cannot mark returned metadata as playable', async () => {
  const manager = new SourceManager();
  manager.register({
    id: 'catalog',
    name: 'Catalog',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      return [{
        playable: true,
        signedStreamUrl: 'https://cdn.example.net/audio?token=secret',
        info: { title: 'Metadata only', privateMetadata: 'secret' },
      }];
    },
  });

  const [track] = await manager.search('catalog', 'query');
  assert.deepEqual(track, {
    playable: false,
    info: { title: 'Metadata only', isStream: false },
  });
});

test('source search returns only public track fields and removes signed URLs', async () => {
  const manager = new SourceManager();
  manager.register({
    id: 'public-search',
    name: 'Public search',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      return [{
        playable: false,
        pluginInfo: { apiKey: 'secret' },
        info: {
          title: 'Public result',
          author: 'Artist',
          identifier: 'https://example.com/song?id=1',
          uri: 'https://cdn.example.com/song?signature=secret',
          sourceName: 'public-search',
          apiKey: 'secret',
          isStream: false,
        },
      }];
    },
  });

  const [track] = await manager.search('public-search', 'query');
  assert.deepEqual(track, {
    playable: false,
    info: {
      title: 'Public result',
      author: 'Artist',
      identifier: 'https://example.com/song?id=1',
      sourceName: 'public-search',
      isStream: false,
    },
  });
});

test('source search preserves custom radio identifiers without exposing signed URLs', async () => {
  const manager = new SourceManager();

  manager.register({
    id: 'radio-browser',
    name: 'Radio Browser',
    capabilities: { search: true, playback: true, playlist: false },
    supportsIdentifier(identifier) {
      return identifier.startsWith('radio:');
    },
    async resolve() {
      return {
        uri: 'https://stream.example.com/live',
        title: 'Test Radio',
        isStream: true,
      };
    },
    async search() {
      return [{
        playable: true,
        info: {
          title: 'Test Radio',
          identifier: 'radio:123e4567-e89b-12d3-a456-426614174000',
          uri: 'https://stream.example.com/live?token=secret',
          sourceName: 'radio-browser',
          isStream: true,
        },
      }];
    },
  });

  const [track] = await manager.search('radio-browser', 'test');

  assert.equal(
    track.info.identifier,
    'radio:123e4567-e89b-12d3-a456-426614174000',
  );
  assert.equal(track.info.title, 'Test Radio');
  assert.equal(track.info.sourceName, 'radio-browser');
  assert.equal(track.info.isStream, true);
  assert.equal('uri' in track.info, false);
  assert.equal(JSON.stringify(track).includes('secret'), false);
});

test('multi-source search runs eligible providers concurrently and preserves per-source playability', async () => {
  const manager = new SourceManager({ retries: 0 });
  let active = 0;
  let maximumActive = 0;
  const createProvider = (id) => ({
    id,
    name: id,
    capabilities: { search: true, playback: false, playlist: false },
    async search({ query, limit, signal }) {
      assert.equal(query, 'ambient');
      assert.equal(limit, 5);
      assert.ok(signal instanceof AbortSignal);
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return [{
        playable: true,
        info: {
          identifier: `https://${id}.example/track`,
          title: `${id} ambient`,
          author: id,
          length: 10_000,
          sourceName: id,
          isStream: false,
        },
      }];
    },
  });
  manager.register(createProvider('alpha'));
  manager.register(createProvider('beta'));

  const result = await manager.searchAll('ambient', { limit: 5 });

  assert.equal(maximumActive, 2);
  assert.deepEqual(result.sources, [
    { source: 'alpha', success: true, count: 1 },
    { source: 'beta', success: true, count: 1 },
  ]);
  assert.equal(result.successfulSources, 2);
  assert.equal(result.failedSources, 0);
  assert.deepEqual(result.tracks.map((track) => track.playable), [false, false]);
});

test('multi-source search isolates failures and returns partial results', async () => {
  const manager = new SourceManager({ retries: 0 });
  manager.register({
    id: 'broken',
    name: 'Broken provider',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
    },
  });
  manager.register({
    id: 'working',
    name: 'Working provider',
    capabilities: { search: true, playback: true, playlist: false },
    supportsIdentifier(identifier) {
      return identifier.startsWith('radio:');
    },
    async resolve({ identifier }) {
      return { uri: `https://radio.example/${identifier.slice(6)}` };
    },
    async search() {
      return [{
        playable: true,
        info: {
          identifier: 'radio:123e4567-e89b-12d3-a456-426614174000',
          title: 'Working station',
          author: '',
          length: 0,
          sourceName: 'working',
          isStream: true,
        },
      }];
    },
  });

  const result = await manager.searchAll('station');

  assert.deepEqual(result.sources, [
    { source: 'broken', success: false, count: 0 },
    { source: 'working', success: true, count: 1 },
  ]);
  assert.deepEqual(result.errors, [{
    source: 'broken',
    message: 'Source "broken" failed to search',
    statusCode: 503,
  }]);
  assert.equal(result.successfulSources, 1);
  assert.equal(result.failedSources, 1);
  assert.equal(result.tracks[0].playable, true);
});

test('multi-source search returns structured errors when every provider fails', async () => {
  const manager = new SourceManager({ retries: 0 });
  for (const id of ['alpha', 'beta']) {
    manager.register({
      id,
      name: id,
      capabilities: { search: true, playback: false, playlist: false },
      async search() {
        throw Object.assign(new Error('unavailable'), { statusCode: 502 });
      },
    });
  }

  const result = await manager.searchAll('query');

  assert.deepEqual(result.tracks, []);
  assert.equal(result.total, 0);
  assert.equal(result.successfulSources, 0);
  assert.equal(result.failedSources, 2);
  assert.deepEqual(result.errors.map(({ source, statusCode }) => [source, statusCode]), [
    ['alpha', 502],
    ['beta', 502],
  ]);
});

test('multi-source search skips disabled, unconfigured, and non-search sources', async () => {
  const manager = new SourceManager({ retries: 0 });
  let skippedCalls = 0;
  const createProvider = (id, searchable = true) => ({
    id,
    name: id,
    capabilities: { search: searchable, playback: false, playlist: false },
    ...(searchable ? {
      async search() {
        skippedCalls++;
        return [];
      },
    } : {}),
  });
  manager.register(createProvider('disabled'), { enabled: false });
  manager.register(createProvider('unconfigured'), { configured: false });
  manager.register(createProvider('metadata-only', false));
  manager.register({
    id: 'active',
    name: 'Active',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      return [];
    },
  });

  const result = await manager.searchAll('query');

  assert.deepEqual(result.sources, [{ source: 'active', success: true, count: 0 }]);
  assert.equal(result.errors.length, 0);
  assert.equal(skippedCalls, 0);
});

test('multi-source search deduplicates matching recordings without dropping versions and applies the total limit', async () => {
  const manager = new SourceManager({ retries: 0 });
  const makeTrack = (source, identifier, title, author, length) => ({
    playable: false,
    info: {
      identifier: `https://${source}.example/${identifier}`,
      title,
      author,
      length,
      sourceName: source,
      isStream: false,
    },
  });
  manager.register({
    id: 'alpha',
    name: 'Alpha',
    capabilities: { search: true, playback: false, playlist: false },
    async search({ limit }) {
      assert.equal(limit, 3);
      return [
        makeTrack('alpha', 'same', 'Song', 'Artist', 200_000),
        makeTrack('alpha', 'remix', 'Song (Remix)', 'Artist', 200_000),
        makeTrack('alpha', 'cover', 'Song', 'Different Artist', 200_000),
      ];
    },
  });
  manager.register({
    id: 'beta',
    name: 'Beta',
    capabilities: { search: true, playback: false, playlist: false },
    async search({ limit }) {
      assert.equal(limit, 3);
      return [
        makeTrack('beta', 'duplicate', 'Song', 'Artist', 200_000),
        makeTrack('beta', 'other-version', 'Song', 'Artist', 210_000),
        makeTrack('beta', 'unique', 'Another Song', 'Artist', 180_000),
      ];
    },
  });

  const result = await manager.searchAll('song', { limit: 3 });

  assert.equal(result.total, 5);
  assert.equal(result.tracks.length, 3);
  assert.deepEqual(result.tracks.map(({ info }) => info.title), [
    'Song',
    'Song (Remix)',
    'Song',
  ]);
  assert.deepEqual(result.sources.map(({ count }) => count), [3, 3]);
});

test('multi-source search uses configured transient retries and reports timed-out sources', async () => {
  const retryingManager = new SourceManager({ retries: 1 });
  let attempts = 0;
  retryingManager.register({
    id: 'retrying',
    name: 'Retrying provider',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary outage'), { statusCode: 503 });
      }
      return [];
    },
  });
  const retryResult = await retryingManager.searchAll('query');
  assert.equal(attempts, 2);
  assert.equal(retryResult.sources[0].success, true);

  const timeoutManager = new SourceManager({ timeoutMs: 10, retries: 0 });
  let aborted = false;
  timeoutManager.register({
    id: 'slow',
    name: 'Slow provider',
    capabilities: { search: true, playback: false, playlist: false },
    search({ signal }) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  });
  const timeoutResult = await timeoutManager.searchAll('query');
  assert.equal(timeoutResult.errors[0].statusCode, 504);
  assert.equal(timeoutResult.failedSources, 1);
  assert.equal(aborted, true);
});

test('playlist providers resolve and normalize tracks through the source manager', async () => {
  const manager = new SourceManager();
  manager.register({
    id: 'playlist',
    name: 'Playlist source',
    capabilities: { search: false, playback: false, playlist: true },
    supportsPlaylistIdentifier(identifier) {
      return identifier.startsWith('playlist:');
    },
    async resolvePlaylist() {
      return {
        name: 'Fixture playlist',
        selectedTrack: 0,
        tracks: [{
          uri: 'https://media.example.net/playlist-track.ogg',
          title: 'Playlist track',
          length: 10_000,
        }],
      };
    },
  });

  const playlist = await manager.resolvePlaylist('playlist', 'playlist:fixture');
  assert.equal(playlist.name, 'Fixture playlist');
  assert.equal(playlist.selectedTrack, 0);
  assert.equal(playlist.tracks[0].info.title, 'Playlist track');
  const loaded = await manager.load('playlist:fixture');
  assert.equal(loaded.loadType, 'playlist');
  assert.equal(loaded.playlist.tracks[0].info.title, 'Playlist track');
});

test('source operations time out and abort the provider signal', async () => {
  const manager = new SourceManager({ timeoutMs: 10, retries: 0 });
  let aborted = false;
  manager.register({
    id: 'slow',
    name: 'Slow provider',
    capabilities: { search: true, playback: false, playlist: false },
    search({ signal }) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  });

  await assert.rejects(manager.search('slow', 'query'), (error) => error.statusCode === 504);
  assert.equal(aborted, true);
});

test('source failure logs redact URLs and secret-like values', async () => {
  const warnings = [];
  const manager = new SourceManager({
    retries: 0,
    logger: {
      warn(fields, message) {
        warnings.push({ fields, message });
      },
    },
  });
  manager.register({
    id: 'sensitive-error',
    name: 'Sensitive error',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      throw new Error('Request failed https://media.example/audio?token=abc password=hunter2');
    },
  });

  await assert.rejects(manager.search('sensitive-error', 'query'));

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fields.errorMessage, 'Request failed [url] password=[redacted]');
  assert.equal(JSON.stringify(warnings).includes('hunter2'), false);
  assert.equal(JSON.stringify(warnings).includes('token=abc'), false);
});

test('runtime health reflects failures and later success without changing startup health', async () => {
  const manager = new SourceManager({ retries: 0 });
  let shouldFail = true;
  manager.register({
    id: 'health',
    name: 'Health provider',
    capabilities: { search: true, playback: false, playlist: false },
    async search() {
      if (shouldFail) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      return [];
    },
  });

  await assert.rejects(manager.search('health', 'query'), /failed to search/);
  let [status] = manager.listSources();
  assert.equal(status.startupHealthy, true);
  assert.equal(status.healthy, false);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(typeof status.lastFailureAt, 'number');

  shouldFail = false;
  await manager.search('health', 'query');
  [status] = manager.listSources();
  assert.equal(status.startupHealthy, true);
  assert.equal(status.healthy, true);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(typeof status.lastSuccessAt, 'number');
});

test('catalog and metadata providers are independent declared capabilities', async () => {
  const manager = new SourceManager();
  manager.register({
    id: 'metadata',
    name: 'Metadata provider',
    capabilities: {
      search: false,
      catalog: true,
      playback: false,
      playlist: false,
      metadata: true,
    },
    async resolveCatalog({ identifier }) {
      return { playable: false, info: { title: identifier } };
    },
    async getMetadata({ identifier }) {
      return { title: identifier };
    },
  });

  assert.equal((await manager.resolveCatalog('metadata', 'item')).info.title, 'item');
  assert.equal((await manager.getMetadata('metadata', 'item')).title, 'item');
  await assert.rejects(manager.resolve('item'), /No configured source/);
});

test('playback fallback is opt-in and tries the next matching source', async () => {
  const createProvider = (id, resolve) => ({
    id,
    name: id,
    capabilities: { search: false, playback: true, playlist: false },
    supportsIdentifier: (identifier) => identifier.startsWith('fixture:'),
    resolve,
  });
  const manager = new SourceManager({ retries: 0, fallbackEnabled: true });
  manager.register(createProvider('primary', async () => {
    throw Object.assign(new Error('provider unavailable'), { statusCode: 403 });
  }));
  manager.register(createProvider('secondary', async () => ({
    uri: 'https://media.example.net/fallback.ogg',
    title: 'Fallback track',
  })));

  const track = await manager.resolve('fixture:track');
  assert.equal(track.info.sourceName, 'secondary');
  assert.equal(track.info.title, 'Fallback track');
});

test('playlist loading falls back to the next matching provider', async () => {
  const createProvider = (id, resolvePlaylist) => ({
    id,
    name: id,
    capabilities: { search: false, playback: false, playlist: true },
    supportsPlaylistIdentifier: (identifier) => identifier.startsWith('fixture:'),
    resolvePlaylist,
  });
  const manager = new SourceManager({ retries: 0, fallbackEnabled: true });
  manager.register(createProvider('primary-playlist', async () => {
    throw Object.assign(new Error('temporarily unavailable'), { statusCode: 503 });
  }));
  manager.register(createProvider('backup-playlist', async () => ({
    name: 'Recovered playlist',
    selectedTrack: 0,
    tracks: [{
      uri: 'https://media.example.net/track.ogg',
      title: 'Recovered track',
    }],
  })));

  const result = await manager.load('fixture:playlist');
  assert.equal(result.loadType, 'playlist');
  assert.equal(result.playlist.name, 'Recovered playlist');
  assert.equal(result.playlist.tracks[0].info.title, 'Recovered track');
});

test('built-in source toggles are isolated and plugin sources retain the disabled-source list', async () => {
  const config = {
    httpEnabled: false,
    soundcloudEnabled: false,
    spotifyEnabled: true,
    youtubeEnabled: true,
    disabledSources: [],
    soundcloudClientId: 'test-soundcloud-id',
    spotifyClientId: 'test-spotify-id',
    spotifyClientSecret: 'test-spotify-secret',
    youtubeApiKey: 'test-youtube-key',
    sourceRequestTimeoutMs: 1000,
    sourceRetries: 0,
    sourceFallbackEnabled: false,
  };
  const radioSource = {
    id: 'radio-browser',
    name: 'Radio Browser',
    capabilities: { search: true, playback: true, playlist: false },
    async search() {
      return [];
    },
    supportsIdentifier(identifier) {
      return identifier.startsWith('radio:');
    },
    async resolve({ identifier }) {
      return {
        uri: 'https://radio.example.net/live',
        identifier,
        title: 'Test radio',
        isStream: true,
      };
    },
  };
  const pluginManager = {
    getSources: () => [radioSource],
    getDisabledSources: () => [],
  };
  const createManager = (sourceConfig) => createSourceManager({
    resolverRegistry: new ResolverRegistry([
      createSoundCloudResolver(sourceConfig),
    ]),
    catalogSearch: async (sourceId) => [{
      playable: false,
      info: { title: sourceId, sourceName: sourceId },
    }],
    config: sourceConfig,
    pluginManager,
  });
  const manager = createManager(config);
  const status = new Map(manager.listSources().map((source) => [source.id, source]));

  assert.equal(status.get('http').enabled, false);
  assert.equal(status.get('soundcloud').enabled, false);
  assert.equal(status.get('spotify').enabled, true);
  assert.equal(status.get('youtube').enabled, true);
  assert.equal(status.get('radio-browser').enabled, true);
  await assert.rejects(
    manager.resolve('https://media.example.net/audio.mp3'),
    /No configured source supports/,
  );
  await assert.rejects(manager.search('soundcloud', 'query'), /disabled/);
  assert.equal((await manager.search('youtube', 'query'))[0].info.title, 'youtube');
  assert.equal((await manager.search('spotify', 'query'))[0].info.title, 'spotify');
  assert.equal((await manager.resolve('radio:station')).info.sourceName, 'radio-browser');

  const radioDisabled = createManager({
    ...config,
    disabledSources: ['radio-browser'],
  });
  assert.equal(
    radioDisabled.listSources().find((source) => source.id === 'radio-browser').enabled,
    false,
  );
});
