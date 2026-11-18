// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import ytdlp from 'youtube-dl-exec';

const API_VERSION = 1;
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

function pluginError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseIsoDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseFloat(match[3] || 0);
  return (hours * 3600) + (minutes * 60) + seconds;
}

export const manifest = {
  id: 'youtube',
  name: 'YouTube',
  version: '1.0.0',
  apiVersion: API_VERSION,
  dependencies: [],
  configKeys: [],
  secretConfigKeys: [],
  sources: [
    {
      id: 'youtube',
      name: 'YouTube',
      capabilities: {
        search: true,
        catalog: false,
        playback: true,
        playlist: false,
        metadata: false,
      },
    },
  ],
};

export function createYouTubeSource({ fetchImpl = globalThis.fetch, getAudioFormat = resolveYouTubeAudio, apiKey = process.env.YOUTUBE_API_KEY || '' } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('YouTube requires fetch support');
  }

  const searchResults = new Map();

  async function request(endpoint, params, signal) {
    if (!apiKey) throw pluginError('YOUTUBE_API_KEY environment variable is required', 400);

    const baseUrl = new URL(`https://www.googleapis.com/youtube/v3${endpoint}`);
    const qs = new URLSearchParams(params);
    qs.set('key', apiKey);

    let response;
    try {
      response = await fetchImpl(`${baseUrl.toString()}?${qs}`, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Melink-Audio-Node/0.1.0',
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw pluginError('Could not contact YouTube API');
    }

    if (!response.ok) {
      throw pluginError(
        `YouTube API returned HTTP ${response.status}`,
        response.status === 404 ? 404 : 502,
      );
    }

    try {
      return await response.json();
    } catch {
      throw pluginError('YouTube API returned invalid JSON');
    }
  }

  return {
    id: 'youtube',
    name: 'YouTube',
    capabilities: manifest.sources[0].capabilities,

    async search({ query, limit = 10, signal }) {
      const data = await request('/search', {
        part: 'snippet',
        q: query.trim(),
        type: 'video',
        maxResults: Math.min(limit, 10),
        safeSearch: 'none',
        order: 'relevance',
      }, signal);

      if (!Array.isArray(data.items)) {
        throw pluginError('YouTube API returned invalid search results');
      }

      const videoIds = data.items
        .map((item) => item.id?.videoId)
        .filter((videoId) => typeof videoId === 'string');
      const durations = new Map();
      if (videoIds.length) {
        try {
          const details = await request('/videos', {
            part: 'contentDetails',
            id: videoIds.join(','),
          }, signal);
          for (const item of details.items || []) {
            if (item.id && item.contentDetails?.duration) {
              durations.set(item.id, Math.round(parseIsoDuration(item.contentDetails.duration) * 1000));
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          // Search still works if duration metadata is temporarily unavailable.
        }
      }

      return data.items.map((item) => {
        if (!item.id?.videoId || !item.snippet?.title) return null;
        const identifier = `youtube:${item.id.videoId}`;
        searchResults.set(identifier, {
          title: item.snippet.title.slice(0, 256),
          author: item.snippet.channelTitle?.slice(0, 256) || '',
        });
        return {
          playable: true,
          info: {
            identifier,
            title: item.snippet.title.slice(0, 256),
            author: item.snippet.channelTitle?.slice(0, 256) || '',
            length: durations.get(item.id.videoId) || 0,
            sourceName: 'youtube',
            isSeekable: false,
            isStream: false,
          },
        };
      }).filter(Boolean).slice(0, limit);
    },

    supportsIdentifier(identifier) {
      if (typeof identifier !== 'string') return false;
      return VIDEO_ID_PATTERN.test(identifier.split(':')[1]);
    },

    async resolve({ identifier, signal }) {
      const match = /^youtube:([a-zA-Z0-9_-]{11})$/.exec(identifier);
      if (!match) throw pluginError('Invalid YouTube identifier', 400);

      const videoId = match[1];
      let videoInfo;
      try {
        videoInfo = await getAudioFormat(videoId);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw pluginError(`Could not resolve YouTube audio: ${error.message || 'video unavailable'}`);
      }

      if (!videoInfo?.url || !videoInfo.url.startsWith('https://')) {
        throw pluginError('YouTube did not return a playable audio stream');
      }
      const metadata = searchResults.get(identifier) || {};

      return {
        uri: videoInfo.url,
        title: videoInfo.title || metadata.title || `YouTube Video ${videoId}`,
        author: videoInfo.channel || metadata.author || '',
        length: Number(videoInfo.duration || 0) * 1000,
        isStream: false,
      };
    },
  };
}

async function resolveYouTubeAudio(videoId) {
  return ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
    dumpSingleJson: true,
    format: 'bestaudio',
    noWarnings: true,
    remoteComponents: 'ejs:github',
    jsRuntimes: 'node',
    // Similar to Lavalink's ordered YouTube clients, ask yt-dlp to try
    // several supported playback clients instead of relying on its default
    // client selection. The client list can be adjusted per host if needed.
    extractorArgs: `youtube:player-client=${process.env.YOUTUBE_PLAYER_CLIENTS || 'ios,web_embedded,tv_samsung'}`,
  });
}

export async function createPlugin({ apiVersion }) {
  if (apiVersion !== API_VERSION) {
    throw new Error(`Unsupported Melink Plugin API version: ${apiVersion}`);
  }
  return { sources: [createYouTubeSource()] };
}
