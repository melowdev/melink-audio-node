// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCatalogSearch, createSoundCloudResolver } from '../src/audio/catalog-search.js';
import { ResolverRegistry } from '../src/audio/resolver-registry.js';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

test('YouTube search uses the official API and returns non-playable metadata', async () => {
  const calls = [];
  const search = createCatalogSearch({ youtubeApiKey: 'youtube-test-key' }, async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    calls.push(new URL(url));
    return jsonResponse({
      items: [{
        id: { videoId: 'video-id' },
        snippet: { title: 'Video title', channelTitle: 'Channel' },
      }],
    });
  });

  const tracks = await search('youtube', '  ambient music  ', {
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'youtube.googleapis.com');
  assert.equal(calls[0].searchParams.get('q'), 'ambient music');
  assert.equal(calls[0].searchParams.get('maxResults'), '3');
  assert.equal(tracks[0].playable, false);
  assert.equal(tracks[0].info.uri, 'https://www.youtube.com/watch?v=video-id');
  assert.equal(tracks[0].info.sourceName, 'youtube');
});

test('Spotify search caches its official client-credentials token', async () => {
  let tokenRequests = 0;
  const searchRequests = [];
  const search = createCatalogSearch({
    spotifyClientId: 'client-id',
    spotifyClientSecret: 'client-secret',
  }, async (url, options) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'accounts.spotify.com') {
      tokenRequests++;
      assert.match(options.headers.authorization, /^Basic /);
      return jsonResponse({ access_token: 'access-token', expires_in: 3600 });
    }
    searchRequests.push(parsedUrl);
    assert.equal(options.headers.authorization, 'Bearer access-token');
    return jsonResponse({
      tracks: {
        items: [{
          id: 'track-id',
          name: 'Track title',
          duration_ms: 123_000,
          artists: [{ name: 'Artist' }],
        }],
      },
    });
  });

  const first = await search('spotify', 'track title');
  const second = await search('spotify', 'another track');

  assert.equal(tokenRequests, 1);
  assert.equal(searchRequests.length, 2);
  assert.equal(first[0].playable, false);
  assert.equal(first[0].info.uri, 'https://open.spotify.com/track/track-id');
  assert.equal(first[0].info.length, 123_000);
  assert.equal(second[0].info.sourceName, 'spotify');
});

test('Spotify search stops waiting for a shared token request when aborted', async () => {
  const search = createCatalogSearch({
    spotifyClientId: 'client-id',
    spotifyClientSecret: 'client-secret',
  }, async () => new Promise(() => {}));
  const controller = new AbortController();
  const pendingSearch = search('spotify', 'track', { signal: controller.signal });

  controller.abort();

  await assert.rejects(pendingSearch, { name: 'AbortError' });
});

test('SoundCloud search marks only streamable official transcodings playable', async () => {
  const search = createCatalogSearch({ soundcloudClientId: 'soundcloud-test-id' }, async (url) => {
    assert.equal(new URL(url).hostname, 'api-v2.soundcloud.com');
    return jsonResponse({
      collection: [
        {
          permalink_url: 'https://soundcloud.com/artist/streamable',
          title: 'Streamable track',
          duration: 90_000,
          streamable: true,
          user: { username: 'Artist' },
          media: { transcodings: [{ format: { protocol: 'progressive' } }] },
        },
        {
          permalink_url: 'https://soundcloud.com/artist/restricted',
          title: 'Restricted track',
          streamable: false,
          media: { transcodings: [{ format: { protocol: 'progressive' } }] },
        },
      ],
    });
  });

  const tracks = await search('soundcloud', 'track');

  assert.deepEqual(tracks.map((track) => track.playable), [true, false]);
  assert.equal(tracks[0].info.sourceName, 'soundcloud');
  assert.equal(tracks[0].info.length, 90_000);
});

test('SoundCloud link resolver obtains only an official authorized stream URL', async () => {
  const calls = [];
  const resolver = createSoundCloudResolver({
    soundcloudClientId: 'soundcloud-test-id',
    soundcloudOAuthToken: 'oauth-test-token',
  }, async (url, options) => {
    const parsedUrl = new URL(url);
    calls.push({ parsedUrl, options });
    if (parsedUrl.pathname === '/resolve') {
      return jsonResponse({
        kind: 'track',
        streamable: true,
        permalink_url: 'https://soundcloud.com/artist/song',
        title: 'Song title',
        duration: 42_000,
        user: { username: 'Artist' },
        media: {
          transcodings: [
            { url: 'https://api-v2.soundcloud.com/media/hls', format: { protocol: 'hls' } },
            { url: 'https://api-v2.soundcloud.com/media/progressive', format: { protocol: 'progressive' } },
          ],
        },
      });
    }
    throw new Error('Transcoding endpoint must use the validated request path');
  }, async (url, options) => {
    const parsedUrl = new URL(url);
    calls.push({ parsedUrl, options });
    assert.deepEqual([...options.allowedHosts], ['api-v2.soundcloud.com']);
    return Readable.from([Buffer.from(JSON.stringify({
      url: 'https://cf-media.sndcdn.com/audio.mp3',
    }))], {
      objectMode: false,
    });
  });

  const registry = new ResolverRegistry([resolver]);
  const track = await registry.resolve('https://soundcloud.com/artist/song');
  assert.equal(resolver.supports('https://user:pass@soundcloud.com/artist/song'), false);
  assert.equal(resolver.supports('https://arbitrary.soundcloud.com/artist/song'), false);

  assert.equal(track.info.sourceName, 'soundcloud');
  assert.equal(track.info.title, 'Song title');
  assert.equal(track.info.author, 'Artist');
  assert.equal(track.info.uri, 'https://cf-media.sndcdn.com/audio.mp3');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parsedUrl.searchParams.get('url'), 'https://soundcloud.com/artist/song');
  assert.equal(calls[1].parsedUrl.pathname, '/media/progressive');
  assert.equal(calls[0].options.headers.authorization, 'OAuth oauth-test-token');
});

test('SoundCloud rejects untrusted transcoding URLs before making the intermediate request', async () => {
  let intermediateRequests = 0;
  const resolver = createSoundCloudResolver({
    soundcloudClientId: 'soundcloud-test-id',
  }, async () => jsonResponse({
    kind: 'track',
    streamable: true,
    title: 'Untrusted',
    media: {
      transcodings: [{
        url: 'http://127.0.0.1/private',
        format: { protocol: 'progressive' },
      }],
    },
  }), async () => {
    intermediateRequests++;
    throw new Error('must not be called');
  });

  await assert.rejects(resolver.resolve('https://soundcloud.com/artist/song'), /untrusted transcoding endpoint/);
  assert.equal(intermediateRequests, 0);
});

test('catalog search validates input and reports missing provider credentials', async () => {
  const search = createCatalogSearch({});
  await assert.rejects(search('youtube', 'song'), { statusCode: 503 });
  await assert.rejects(search('other', 'song'), { statusCode: 400 });
  await assert.rejects(search('spotify', '  '), { statusCode: 400 });
});
