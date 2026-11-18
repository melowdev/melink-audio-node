// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { normalizeTrack } from '../audio/resolver-registry.js';
import { retryTransient } from '../audio/retry.js';

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const CAPABILITIES = ['search', 'catalog', 'playback', 'playlist', 'metadata'];
const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);
const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;
const PUBLIC_TRACK_INFO_FIELDS = new Set([
  'identifier',
  'title',
  'author',
  'length',
  'uri',
  'sourceName',
  'isSeekable',
  'isStream',
  'position',
]);
const SENSITIVE_URL_PARAMETER = /token|secret|signature|(^|_)sig($|_)|api.?key|auth|credential|expires/i;
const TRACK_VERSION_MARKER =
  /\b(?:acoustic|cover|demo|edit|extended|instrumental|karaoke|live|mix|remix|rework|remaster(?:ed)?|nightcore|sped up|slowed|version)\b/i;
const TRACKING_QUERY_PARAMETER = /^(?:utm_.+|fbclid|gclid|feature|si)$/i;

function sourceError(message, statusCode = 400, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  return error;
}

function validateSearchRequest(query, limit) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) {
    throw sourceError('query must contain 1 to 200 characters');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw sourceError('limit must be an integer from 1 to 10');
  }
}

function normalizedSearchText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    : '';
}

function canonicalTrackKey(track) {
  const identifier = track.info.identifier || track.info.uri;
  if (typeof identifier !== 'string' || !identifier) return null;

  try {
    const url = new URL(identifier);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_QUERY_PARAMETER.test(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      return `url:${url.href}`;
    }
  } catch {
    // Source-specific identifiers are valid deduplication keys.
  }

  return `id:${identifier.toLowerCase()}`;
}

function metadataTrackKey(track) {
  const { info } = track;
  if (info.isStream === true ||
      typeof info.length !== 'number' ||
      !Number.isFinite(info.length) ||
      info.length <= 0 ||
      TRACK_VERSION_MARKER.test(info.title || '')) {
    return null;
  }

  const title = normalizedSearchText(info.title);
  const author = normalizedSearchText(info.author);
  return title && author
    ? `${title}\0${author}\0${Math.round(info.length / 1000)}`
    : null;
}

function uniqueSearchTracks(sourceResults) {
  const identifiers = new Set();
  const recordings = new Set();
  const tracks = [];

  for (const result of sourceResults) {
    for (const track of result.tracks) {
      const identifier = canonicalTrackKey(track);
      const recording = metadataTrackKey(track);
      if ((identifier && identifiers.has(identifier)) ||
          (recording && recordings.has(recording))) {
        continue;
      }
      if (identifier) identifiers.add(identifier);
      if (recording) recordings.add(recording);
      tracks.push(track);
    }
  }

  return tracks;
}

function validateCapabilities(source) {
  if (!source.capabilities || typeof source.capabilities !== 'object') {
    throw new Error(`Source "${source.id}" must declare capabilities`);
  }

  const actual = {
    search: typeof source.search === 'function',
    catalog: typeof source.resolveCatalog === 'function',
    playback: typeof source.supportsIdentifier === 'function' &&
      typeof source.resolve === 'function',
    playlist: typeof source.supportsPlaylistIdentifier === 'function' &&
      typeof source.resolvePlaylist === 'function',
    metadata: typeof source.getMetadata === 'function',
  };

  for (const capability of CAPABILITIES) {
    const declared = source.capabilities[capability] ?? false;
    if (typeof declared !== 'boolean' || declared !== actual[capability]) {
      throw new Error(
        `Source "${source.id}" capability "${capability}" does not match its implementation`,
      );
    }
  }

  return actual;
}

function validateStatusValue(value, fallback, name, sourceId) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Source "${sourceId}" status "${name}" must be a boolean`);
  }
  return value;
}

function sourceStatus(source, state) {
  const capabilities = state.loaded
    ? state.capabilities
    : Object.fromEntries(CAPABILITIES.map((key) => [key, false]));

  return {
    id: source.id,
    name: source.name,
    pluginId: state.pluginId || null,
    loaded: state.loaded,
    enabled: state.enabled,
    configured: state.configured,
    startupHealthy: state.startupHealthy,
    healthy: state.healthy,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    searchSupported: capabilities.search,
    catalogSupported: capabilities.catalog,
    playbackSupported: capabilities.playback,
    playlistSupported: capabilities.playlist,
    metadataSupported: capabilities.metadata,
    ...(state.declaredCapabilities
      ? { declaredCapabilities: { ...state.declaredCapabilities } }
      : {}),
  };
}

function publicTrack(track) {
  const info = {};
  for (const [key, value] of Object.entries(track.info)) {
    if (!PUBLIC_TRACK_INFO_FIELDS.has(key)) continue;
    if (key === 'uri') {
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) ||
            url.username || url.password ||
            [...url.searchParams.keys()].some((parameter) =>
              SENSITIVE_URL_PARAMETER.test(parameter))) {
          continue;
        }
      } catch {
        continue;
      }
      info[key] = value.slice(0, 2048);
      continue;
    }
    if (key === 'identifier') {
      if (typeof value !== 'string' || value.length > 2048 ||
          /[\u0000-\u0020]/.test(value)) continue;
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) &&
            (url.username || url.password ||
             [...url.searchParams.keys()].some((parameter) =>
               SENSITIVE_URL_PARAMETER.test(parameter)))) {
          continue;
        }
      } catch {
        // Non-URL identifiers are valid source routing keys.
      }
      info.identifier = value;
      continue;
    }
    if (typeof value === 'string') info[key] = value.slice(0, 256);
    else if (typeof value === 'boolean') info[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) info[key] = value;
  }
  const result = { info };
  if (typeof track.playable === 'boolean') result.playable = track.playable;
  return result;
}

export class SourceManager {
  #sources = new Map();

  constructor({
    timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
    retries = 1,
    fallbackEnabled = false,
    logger,
  } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Source timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) {
      throw new Error('Source retries must be an integer from 0 to 3');
    }
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fallbackEnabled = fallbackEnabled;
    this.logger = logger;
  }

  register(source, {
    pluginId = null,
    loaded = true,
    enabled = true,
    configured = source?.configured ?? true,
    healthy = source?.healthy ?? true,
  } = {}) {
    if (!source || typeof source !== 'object' ||
        typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) {
      throw new Error('Sources must provide a valid unique id');
    }
    if (this.#sources.has(source.id)) {
      throw new Error(`Source id "${source.id}" is already registered`);
    }
    if (typeof source.name !== 'string' || !source.name.trim()) {
      throw new Error(`Source "${source.id}" must provide a name`);
    }

    const capabilities = validateCapabilities(source);
    const startupHealthy = validateStatusValue(healthy, true, 'healthy', source.id);
    const status = {
      loaded: validateStatusValue(loaded, true, 'loaded', source.id),
      enabled: validateStatusValue(enabled, true, 'enabled', source.id),
      configured: validateStatusValue(configured, true, 'configured', source.id),
      startupHealthy,
      healthy: startupHealthy,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      pluginId,
      capabilities,
    };
    this.#sources.set(source.id, { source, status });
    return source.id;
  }

  registerUnavailableSource({
    id,
    name,
    pluginId,
    declaredCapabilities,
  }) {
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) {
      throw new Error('Unavailable sources must provide a valid unique id');
    }
    if (this.#sources.has(id)) throw new Error(`Source id "${id}" is already registered`);
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`Source "${id}" must provide a name`);
    }
    if (!declaredCapabilities || typeof declaredCapabilities !== 'object' ||
        CAPABILITIES.some((key) =>
          declaredCapabilities[key] !== undefined &&
          typeof declaredCapabilities[key] !== 'boolean') ||
        Object.keys(declaredCapabilities).some((key) => !CAPABILITIES.includes(key))) {
      throw new Error(`Source "${id}" has invalid declared capabilities`);
    }
    const normalizedCapabilities = Object.fromEntries(
      CAPABILITIES.map((key) => [key, declaredCapabilities[key] ?? false]),
    );

    const source = {
      id,
      name,
      capabilities: Object.fromEntries(CAPABILITIES.map((key) => [key, false])),
    };
    this.#sources.set(id, {
      source,
      status: {
        loaded: false,
        enabled: false,
        configured: false,
        startupHealthy: false,
        healthy: false,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        pluginId,
        capabilities: Object.fromEntries(CAPABILITIES.map((key) => [key, false])),
        declaredCapabilities: normalizedCapabilities,
      },
    });
  }

  listSources() {
    return [...this.#sources.values()]
      .map(({ source, status }) => sourceStatus(source, status))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  sourceManagerNames() {
    return this.listSources()
      .filter((source) => source.loaded && source.enabled)
      .map((source) => source.id);
  }

  async search(sourceId, query, { limit = 10, signal } = {}) {
    validateSearchRequest(query, limit);
    const entry = this.#requireSource(sourceId, 'search');
    if (!entry.status.loaded || !entry.status.enabled || !entry.status.configured) {
      throw sourceError(`Source "${sourceId}" is disabled`, 503);
    }
    if (!entry.status.capabilities.search) {
      throw sourceError(`Source "${sourceId}" does not support search`, 400);
    }

    let tracks;
    try {
      tracks = await this.#run(sourceId, 'search', (requestSignal) =>
        entry.source.search({ query, limit, signal: requestSignal }), signal);
    } catch (error) {
      throw sourceError(
        `Source "${sourceId}" failed to search`,
        error.statusCode || 502,
        error,
      );
    }
    if (!Array.isArray(tracks)) {
      throw sourceError(`Source "${sourceId}" returned invalid search results`, 502);
    }
    return tracks.slice(0, limit).map((track) => {
      if (!track || typeof track !== 'object' || !track.info ||
          typeof track.info !== 'object') {
        throw sourceError(`Source "${sourceId}" returned an invalid track`, 502);
      }
      const sanitized = publicTrack(track);
      const playable = entry.status.capabilities.playback && track.playable === true;
      if (!playable) {
        return {
          ...sanitized,
          playable: false,
          info: { ...sanitized.info, isStream: false },
        };
      }
      return { ...sanitized, playable: true };
    });
  }

  async searchAll(query, { limit = 10, signal } = {}) {
    validateSearchRequest(query, limit);
    const eligibleSources = [...this.#sources.entries()]
      .filter(([, entry]) => entry.status.loaded &&
        entry.status.enabled &&
        entry.status.configured &&
        entry.status.capabilities.search)
      .sort(([left], [right]) => left.localeCompare(right));
    const sourceResults = await Promise.all(eligibleSources.map(async ([sourceId]) => {
      try {
        const tracks = await this.search(sourceId, query.trim(), { limit, signal });
        return { source: sourceId, success: true, count: tracks.length, tracks };
      } catch (error) {
        if (signal?.aborted) throw error;
        const statusCode = Number.isInteger(error?.statusCode)
          ? error.statusCode
          : 502;
        return {
          source: sourceId,
          success: false,
          count: 0,
          error: {
            source: sourceId,
            message: error?.message || `Source "${sourceId}" failed to search`,
            statusCode,
          },
        };
      }
    }));
    const tracks = uniqueSearchTracks(sourceResults.filter((result) => result.success));
    const errors = sourceResults
      .filter((result) => !result.success)
      .map((result) => result.error);
    const successfulSources = sourceResults.filter((result) => result.success).length;

    return {
      loadType: 'search',
      query: query.trim(),
      total: tracks.length,
      tracks: tracks.slice(0, limit),
      sources: sourceResults.map(({ source, success, count }) => ({
        source,
        success,
        count,
      })),
      errors,
      successfulSources,
      failedSources: errors.length,
    };
  }

  async resolve(identifier, { signal, fallback = this.fallbackEnabled } = {}) {
    if (typeof identifier !== 'string' || !identifier) {
      throw sourceError('Identifier must be a non-empty string');
    }

    const allowFallback = fallback ?? this.fallbackEnabled;
    let lastError;
    for (const { source, status } of this.#sources.values()) {
      if (!status.capabilities.playback || !status.loaded || !status.enabled) continue;

      let supported;
      try {
        supported = await this.#run(source.id, 'inspect', (requestSignal) =>
          source.supportsIdentifier(identifier, { signal: requestSignal }), signal);
      } catch (error) {
        const wrapped = sourceError(
          `Source "${source.id}" failed to inspect the identifier`,
          error.statusCode || 502,
          error,
        );
        lastError = wrapped;
        if (!allowFallback || !isFallbackError(wrapped)) throw wrapped;
        continue;
      }
      if (!supported) continue;
      if (!status.configured) {
        throw sourceError(`Source "${source.id}" is not configured`, 503);
      }
      try {
        const result = await this.#run(source.id, 'resolve', (requestSignal) =>
          source.resolve({ identifier, signal: requestSignal }), signal);
        return normalizeTrack({
          name: source.trackSourceName || source.id,
        }, identifier, result);
      } catch (error) {
        lastError = sourceError(
          `Source "${source.id}" failed to resolve the identifier`,
          error.statusCode || 400,
          error,
        );
        if (!allowFallback || !isFallbackError(lastError)) throw lastError;
        this.logger?.warn?.({
          sourceId: source.id,
          operation: 'resolve',
          errorType: error.name,
          statusCode: error.statusCode || null,
        }, 'Source failed; trying the next matching provider');
      }
    }

    if (lastError) throw lastError;
    throw sourceError('No configured source supports this identifier');
  }

  async load(identifier, { signal, fallback } = {}) {
    const allowFallback = fallback ?? this.fallbackEnabled;
    let lastError;
    for (const { source, status } of this.#sources.values()) {
      if (!status.capabilities.playlist || !status.loaded || !status.enabled ||
          !status.configured) continue;
      let supported;
      try {
        supported = await this.#run(source.id, 'inspect-playlist', (requestSignal) =>
          source.supportsPlaylistIdentifier(identifier, { signal: requestSignal }), signal);
      } catch (error) {
        lastError = sourceError(
          `Source "${source.id}" failed to inspect the playlist`,
          error.statusCode || 502,
          error,
        );
        if (!allowFallback || !isFallbackError(lastError)) throw lastError;
        continue;
      }
      if (!supported) continue;
      try {
        return {
          loadType: 'playlist',
          playlist: await this.resolvePlaylist(source.id, identifier, { signal }),
        };
      } catch (error) {
        lastError = error;
        if (!allowFallback || !isFallbackError(error)) throw error;
      }
    }
    if (lastError) throw lastError;
    return {
      loadType: 'track',
      track: await this.resolve(identifier, { signal, fallback }),
    };
  }

  async resolvePlaylist(sourceId, identifier, { signal } = {}) {
    const entry = this.#requireSource(sourceId, 'playlist');
    if (!entry.status.loaded || !entry.status.enabled || !entry.status.configured) {
      throw sourceError(`Source "${sourceId}" is disabled`, 503);
    }
    let result;
    try {
      result = await this.#run(sourceId, 'playlist', (requestSignal) =>
        entry.source.resolvePlaylist({ identifier, signal: requestSignal }), signal);
    } catch (error) {
      throw sourceError(
        `Source "${sourceId}" failed to resolve the playlist`,
        error.statusCode || 502,
        error,
      );
    }
    if (!result || typeof result.name !== 'string' || !Array.isArray(result.tracks)) {
      throw sourceError(`Source "${sourceId}" returned an invalid playlist`, 502);
    }
    if (result.tracks.length > 500) {
      throw sourceError(`Source "${sourceId}" returned more than 500 playlist tracks`, 502);
    }
    const selectedTrack = result.selectedTrack ?? -1;
    if (!Number.isSafeInteger(selectedTrack) ||
        selectedTrack < -1 ||
        selectedTrack >= result.tracks.length) {
      throw sourceError(`Source "${sourceId}" returned an invalid selected track`, 502);
    }
    return {
      name: result.name.slice(0, 256),
      selectedTrack,
      tracks: result.tracks.map((track) => normalizeTrack(
        { name: sourceId },
        identifier,
        track,
      )),
    };
  }

  async resolveCatalog(sourceId, identifier, { signal } = {}) {
    const entry = this.#requireSource(sourceId, 'catalog');
    if (!entry.status.loaded || !entry.status.enabled || !entry.status.configured) {
      throw sourceError(`Source "${sourceId}" is disabled`, 503);
    }
    const result = await this.#run(sourceId, 'catalog', (requestSignal) =>
      entry.source.resolveCatalog({ identifier, signal: requestSignal }), signal);
    if (!result || typeof result !== 'object' || !result.info ||
        typeof result.info.title !== 'string') {
      throw sourceError(`Source "${sourceId}" returned invalid catalog data`, 502);
    }
    return result;
  }

  async getMetadata(sourceId, identifier, { signal } = {}) {
    const entry = this.#requireSource(sourceId, 'metadata');
    if (!entry.status.loaded || !entry.status.enabled || !entry.status.configured) {
      throw sourceError(`Source "${sourceId}" is disabled`, 503);
    }
    const result = await this.#run(sourceId, 'metadata', (requestSignal) =>
      entry.source.getMetadata({ identifier, signal: requestSignal }), signal);
    if (!result || typeof result !== 'object' || typeof result.title !== 'string') {
      throw sourceError(`Source "${sourceId}" returned invalid metadata`, 502);
    }
    return result;
  }

  #requireSource(sourceId, capability) {
    const entry = this.#sources.get(sourceId);
    if (!entry) throw sourceError(`Unknown source "${sourceId}"`, 400);
    if (!entry.status.capabilities[capability]) {
      throw sourceError(`Source "${sourceId}" does not support ${capability}`, 400);
    }
    return entry;
  }

  async #run(sourceId, operation, invoke, parentSignal) {
    let attempt = 0;
    return retryTransient(async () => {
      attempt++;
      const controller = new AbortController();
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal;
      let timeout;
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Source request timed out'), {
            statusCode: 504,
            retryable: true,
          }));
        }, this.timeoutMs);
      });

      try {
        const result = await Promise.race([invoke(signal), timeoutPromise]);
        const status = this.#sources.get(sourceId)?.status;
        if (status) {
          status.healthy = true;
          status.lastSuccessAt = Date.now();
          status.consecutiveFailures = 0;
        }
        return result;
      } catch (error) {
        const status = this.#sources.get(sourceId)?.status;
        if (status) {
          status.healthy = false;
          status.lastFailureAt = Date.now();
          status.consecutiveFailures++;
        }
        const retryable = error.retryable === true ||
          error.statusCode === 429 ||
          error.statusCode >= 500 ||
          TRANSIENT_NETWORK_CODES.has(error.code);
        const wrapped = sourceError(
          `Source "${sourceId}" ${operation} request failed`,
          error.statusCode || 502,
          error,
        );
        wrapped.retryable = retryable;
        const safeErrorMessage = String(error.message || '')
          .replace(/https?:\/\/\S+/gi, '[url]')
          .replace(/(token|authorization|password|secret|sig|lsig)[=:]\s*\S+/gi, '$1=[redacted]')
          .slice(0, 240);
        this.logger?.warn?.({
          sourceId,
          operation,
          attempt,
          errorType: error.name,
          statusCode: error.statusCode || null,
          errorMessage: safeErrorMessage,
        }, 'Source operation failed');
        throw wrapped;
      } finally {
        clearTimeout(timeout);
      }
    }, {
      maxAttempts: this.retries + 1,
      initialDelayMs: 100,
      maxDelayMs: 500,
      onRetry: (_error, { attempt: retryAttempt, delayMs }) => {
        this.logger?.warn?.({
          sourceId,
          operation,
          attempt: retryAttempt,
          delayMs,
        }, 'Retrying source operation');
      },
    });
  }
}

function isFallbackError(error) {
  return error.statusCode === 403 || error.statusCode === 404 ||
    error.statusCode === 429 || error.statusCode >= 500 ||
    TRANSIENT_NETWORK_CODES.has(error.code);
}
