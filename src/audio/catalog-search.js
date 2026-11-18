// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { RESOLVER_API_VERSION } from './resolver-registry.js';
import { requestPublicResponse } from './safe-http.js';

const API_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 10;
const SOUNDCLOUD_HOSTS = new Set([
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'on.soundcloud.com',
]);
const SOUNDCLOUD_API_HOSTS = new Set(['api-v2.soundcloud.com']);
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

function providerError(provider, statusCode = 502, cause) {
  return Object.assign(new Error(`${provider} API request failed`), {
    statusCode,
    cause,
  });
}

async function fetchSoundCloudJson(requestImpl, input, headers) {
  let response;
  try {
    response = await requestImpl(input, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      allowedHosts: SOUNDCLOUD_API_HOSTS,
    });
  } catch (error) {
    throw providerError('SoundCloud', error.statusCode || 502, error);
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        response.destroy();
        throw new Error('SoundCloud response exceeded the size limit');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw providerError('SoundCloud', 502, error);
  }
}

async function fetchJson(fetchImpl, url, options, provider, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
        : AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    throw providerError(provider, 502, error);
  }

  if (!response.ok) throw providerError(provider);
  try {
    return await response.json();
  } catch (error) {
    throw providerError(provider, 502, error);
  }
}

function result(sourceName, { identifier, title, author, length = 0, playable = false }) {
  return {
    playable,
    info: {
      identifier,
      title: String(title || 'Untitled').slice(0, 256),
      author: String(author || '').slice(0, 256),
      length: Number.isSafeInteger(length) && length > 0 ? length : 0,
      uri: identifier,
      sourceName,
      isSeekable: false,
      isStream: playable,
    },
  };
}

function isSoundCloudUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      SOUNDCLOUD_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function spotifyAuthHeader(config) {
  const credentials = Buffer.from(
    `${config.spotifyClientId}:${config.spotifyClientSecret}`,
  ).toString('base64');
  return `Basic ${credentials}`;
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createCatalogSearch(config, fetchImpl = globalThis.fetch) {
  let spotifyToken;
  let spotifyTokenExpiresAt = 0;
  let spotifyTokenRequest;

  async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpiresAt) return spotifyToken;
    if (spotifyTokenRequest) return spotifyTokenRequest;

    spotifyTokenRequest = (async () => {
      const body = new URLSearchParams({ grant_type: 'client_credentials' });
      const response = await fetchJson(
        fetchImpl,
        'https://accounts.spotify.com/api/token',
        {
          method: 'POST',
          headers: {
            authorization: spotifyAuthHeader(config),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        },
        'Spotify',
      );
      if (typeof response.access_token !== 'string' ||
          !Number.isFinite(response.expires_in) ||
          response.expires_in <= 0) {
        throw providerError('Spotify');
      }
      spotifyToken = response.access_token;
      spotifyTokenExpiresAt = Date.now() + response.expires_in * 1000 - 30_000;
      return spotifyToken;
    })();

    try {
      return await spotifyTokenRequest;
    } finally {
      spotifyTokenRequest = null;
    }
  }

  async function searchYouTube(query, limit, signal) {
    if (!config.youtubeApiKey) {
      throw Object.assign(new Error('YouTube search is not configured'), { statusCode: 503 });
    }
    const url = new URL('https://youtube.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({
      key: config.youtubeApiKey,
      part: 'snippet',
      type: 'video',
      safeSearch: 'moderate',
      maxResults: String(limit),
      q: query,
    });
    const data = await fetchJson(fetchImpl, url, {}, 'YouTube', signal);
    return (Array.isArray(data.items) ? data.items : [])
      .filter((item) => item.id?.videoId && item.snippet)
      .map((item) => result('youtube', {
        identifier: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id.videoId)}`,
        title: item.snippet.title,
        author: item.snippet.channelTitle,
      }));
  }

  async function searchSpotify(query, limit, signal) {
    if (!config.spotifyClientId || !config.spotifyClientSecret) {
      throw Object.assign(new Error('Spotify search is not configured'), { statusCode: 503 });
    }
    signal?.throwIfAborted();
    const token = await waitForAbortable(getSpotifyToken(), signal);
    signal?.throwIfAborted();
    const url = new URL('https://api.spotify.com/v1/search');
    url.search = new URLSearchParams({
      type: 'track',
      limit: String(limit),
      q: query,
    });
    const data = await fetchJson(fetchImpl, url, {
      headers: { authorization: `Bearer ${token}` },
    }, 'Spotify', signal);
    return (Array.isArray(data.tracks?.items) ? data.tracks.items : [])
      .filter((track) => track.id)
      .map((track) => result('spotify', {
        identifier: `https://open.spotify.com/track/${encodeURIComponent(track.id)}`,
        title: track.name,
        author: Array.isArray(track.artists)
          ? track.artists.map((artist) => artist.name).filter(Boolean).join(', ')
          : '',
        length: track.duration_ms,
      }));
  }

  async function searchSoundCloud(query, limit, signal) {
    if (!config.soundcloudClientId) {
      throw Object.assign(new Error('SoundCloud search is not configured'), { statusCode: 503 });
    }
    const url = new URL('https://api-v2.soundcloud.com/search/tracks');
    url.search = new URLSearchParams({
      client_id: config.soundcloudClientId,
      limit: String(limit),
      q: query,
    });
    const headers = config.soundcloudOAuthToken
      ? { authorization: `OAuth ${config.soundcloudOAuthToken}` }
      : {};
    const data = await fetchJson(fetchImpl, url, { headers }, 'SoundCloud', signal);
    return (Array.isArray(data.collection) ? data.collection : [])
      .filter((track) => isSoundCloudUrl(track.permalink_url))
      .map((track) => {
        const hasStream = track.streamable === true &&
          Array.isArray(track.media?.transcodings) &&
          track.media.transcodings.some(({ format }) =>
            format?.protocol === 'progressive' || format?.protocol === 'hls');
        return result('soundcloud', {
          identifier: track.permalink_url,
          title: track.title,
          author: track.user?.username,
          length: track.duration,
          playable: hasStream,
        });
      });
  }

  return async function searchCatalog(
    source,
    query,
    { limit = MAX_RESULTS, signal } = {},
  ) {
    if (typeof source !== 'string' ||
        !['youtube', 'spotify', 'soundcloud'].includes(source)) {
      throw Object.assign(
        new Error('source must be youtube, spotify, or soundcloud'),
        { statusCode: 400 },
      );
    }
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw Object.assign(
        new Error('query must contain 1 to 200 characters'),
        { statusCode: 400 },
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
      throw Object.assign(
        new Error(`limit must be an integer from 1 to ${MAX_RESULTS}`),
        { statusCode: 400 },
      );
    }

    const trimmedQuery = query.trim();
    if (source === 'youtube') return searchYouTube(trimmedQuery, limit, signal);
    if (source === 'spotify') return searchSpotify(trimmedQuery, limit, signal);
    return searchSoundCloud(trimmedQuery, limit, signal);
  };
}

export function createSoundCloudResolver(
  config,
  fetchImpl = globalThis.fetch,
  requestImpl = requestPublicResponse,
) {
  return {
    apiVersion: RESOLVER_API_VERSION,
    name: 'soundcloud',
    supports(identifier) {
      return isSoundCloudUrl(identifier);
    },
    async resolve(identifier) {
      if (!config.soundcloudClientId) {
        throw Object.assign(new Error('SoundCloud resolution is not configured'), {
          statusCode: 503,
        });
      }

      const headers = config.soundcloudOAuthToken
        ? { authorization: `OAuth ${config.soundcloudOAuthToken}` }
        : {};
      const sourceUrl = new URL(identifier);
      sourceUrl.search = '';
      sourceUrl.hash = '';
      const resolveUrl = new URL('https://api-v2.soundcloud.com/resolve');
      resolveUrl.search = new URLSearchParams({
        client_id: config.soundcloudClientId,
        url: sourceUrl.href,
      });
      const track = await fetchJson(fetchImpl, resolveUrl, { headers }, 'SoundCloud');
      if (track.kind !== 'track' || track.streamable !== true) {
        throw new Error('This SoundCloud item is not an authorized playable track');
      }

      const transcodings = Array.isArray(track.media?.transcodings)
        ? track.media.transcodings
        : [];
      const transcoding = transcodings.find(({ format }) =>
        format?.protocol === 'progressive') ||
        transcodings.find(({ format }) => format?.protocol === 'hls');
      if (!transcoding?.url) {
        throw new Error('SoundCloud did not provide an authorized audio stream');
      }

      const streamUrl = new URL(transcoding.url);
      streamUrl.searchParams.set('client_id', config.soundcloudClientId);
      if (streamUrl.protocol !== 'https:' ||
          !SOUNDCLOUD_API_HOSTS.has(streamUrl.hostname.toLowerCase())) {
        throw new Error('SoundCloud returned an untrusted transcoding endpoint');
      }
      const streamData = await fetchSoundCloudJson(requestImpl, streamUrl, headers);
      if (typeof streamData.url !== 'string') {
        throw new Error('SoundCloud did not return an audio stream URL');
      }

      return {
        uri: streamData.url,
        identifier: track.permalink_url || identifier,
        title: track.title,
        author: track.user?.username || '',
        length: track.duration,
        isStream: true,
      };
    },
  };
}
