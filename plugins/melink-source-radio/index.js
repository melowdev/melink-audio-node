
// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

const API_BASE_URL = 'https://de1.api.radio-browser.info';
const API_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const manifest = {
  id: 'melink-radio-browser',
  name: 'Melink Radio Browser',
  version: '1.0.0',
  apiVersion: API_VERSION,
  dependencies: [],
  configKeys: [],
  secretConfigKeys: [],
  sources: [
    {
      id: 'radio-browser',
      name: 'Radio Browser',
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

function pluginError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseIdentifier(identifier) {
  if (typeof identifier !== 'string') return null;

  const match = /^radio:([0-9a-f-]{36})$/i.exec(identifier);
  if (!match || !UUID_PATTERN.test(match[1])) return null;

  return match[1].toLowerCase();
}

function validateStreamUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) {
    throw pluginError('Radio station has no valid stream URL');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw pluginError('Radio station returned an invalid stream URL');
  }

  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password) {
    throw pluginError('Radio station returned an unsupported stream URL');
  }

  return url.href;
}

export function createRadioSource({
  fetchImpl = globalThis.fetch,
  apiBaseUrl = API_BASE_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Radio Browser requires fetch support');
  }

  const baseUrl = new URL(apiBaseUrl);
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error('Radio Browser API must use a trusted HTTPS endpoint');
  }

  async function request(path, signal) {
    let response;

    try {
      response = await fetchImpl(new URL(path, baseUrl), {
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
      throw pluginError('Could not contact Radio Browser');
    }

    if (!response.ok) {
      throw pluginError(
        `Radio Browser returned HTTP ${response.status}`,
        response.status === 404 ? 404 : 502,
      );
    }

    try {
      return await response.json();
    } catch {
      throw pluginError('Radio Browser returned invalid JSON');
    }
  }

  function toSearchTrack(station) {
    if (!station ||
        typeof station.stationuuid !== 'string' ||
        !UUID_PATTERN.test(station.stationuuid) ||
        typeof station.name !== 'string' ||
        !station.name.trim()) {
      return null;
    }

    return {
      playable: true,
      info: {
        identifier: `radio:${station.stationuuid.toLowerCase()}`,
        title: station.name.slice(0, 256),
        author: typeof station.country === 'string'
          ? station.country.slice(0, 256)
          : '',
        length: 0,
        sourceName: 'radio-browser',
        isSeekable: false,
        isStream: true,
      },
    };
  }

  return {
    id: 'radio-browser',
    name: 'Radio Browser',
    capabilities: manifest.sources[0].capabilities,

    async search({ query, limit = 10, signal }) {
      const params = new URLSearchParams({
        name: query.trim(),
        limit: String(Math.min(limit, 10)),
        hidebroken: 'true',
        order: 'clickcount',
        reverse: 'true',
      });

      const stations = await request(
        `/json/stations/search?${params}`,
        signal,
      );

      if (!Array.isArray(stations)) {
        throw pluginError('Radio Browser returned an invalid station list');
      }

      return stations
        .map(toSearchTrack)
        .filter(Boolean)
        .slice(0, limit);
    },

    supportsIdentifier(identifier) {
      return parseIdentifier(identifier) !== null;
    },

    async resolve({ identifier, signal }) {
      const stationUuid = parseIdentifier(identifier);
      if (!stationUuid) {
        throw pluginError('Invalid Radio Browser identifier', 400);
      }

      const stations = await request(
        `/json/stations/byuuid/${stationUuid}`,
        signal,
      );

      if (!Array.isArray(stations) || stations.length === 0) {
        throw pluginError('Radio station was not found', 404);
      }

      const station = stations.find(
        (item) => item.stationuuid?.toLowerCase() === stationUuid,
      );

      if (!station) {
        throw pluginError('Radio station was not found', 404);
      }

      return {
        uri: validateStreamUrl(station.url_resolved || station.url),
        title: station.name,
        author: typeof station.country === 'string' ? station.country : '',
        length: 0,
        isStream: true,
      };
    },
  };
}

export async function createPlugin({ apiVersion }) {
  if (apiVersion !== API_VERSION) {
    throw new Error(`Unsupported Melink Plugin API version: ${apiVersion}`);
  }

  return {
    sources: [createRadioSource()],
  };
}
