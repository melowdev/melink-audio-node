// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import 'dotenv/config';

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function booleanValue(value, name, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

export function loadConfig(env = process.env) {
  const portValue = env.PORT || env.SERVER_PORT;
  const token = env.AUDIO_NODE_TOKEN;
  if (!token || token.length < 24 || token === 'replace-with-a-long-random-secret') {
    throw new Error('Set AUDIO_NODE_TOKEN to a random secret of at least 24 characters');
  }
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}`);
  }

  const httpEnabled = booleanValue(env.HTTP_ENABLED, 'HTTP_ENABLED', true);
  const soundcloudEnabled = booleanValue(
    env.SOUNDCLOUD_ENABLED,
    'SOUNDCLOUD_ENABLED',
    false,
  );
  const spotifyEnabled = booleanValue(env.SPOTIFY_ENABLED, 'SPOTIFY_ENABLED', true);
  const youtubeEnabled = booleanValue(env.YOUTUBE_ENABLED, 'YOUTUBE_ENABLED', true);
  const soundcloudClientId = env.SOUNDCLOUD_CLIENT_ID?.trim() || '';
  const soundcloudOAuthToken = env.SOUNDCLOUD_OAUTH_TOKEN?.trim() || '';
  if (soundcloudEnabled && !soundcloudClientId) {
    throw new Error('SOUNDCLOUD_ENABLED=true requires SOUNDCLOUD_CLIENT_ID');
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: positiveInteger(portValue, env.PORT ? 'PORT' : 'SERVER_PORT', 2333),
    token,
    maxPlayers: positiveInteger(env.MAX_PLAYERS, 'MAX_PLAYERS', 5),
    idleTimeoutMs: positiveInteger(env.IDLE_TIMEOUT_MS, 'IDLE_TIMEOUT_MS', 30_000),
    logLevel,
    httpEnabled,
    soundcloudEnabled,
    spotifyEnabled,
    youtubeEnabled,
    resolverPlugins: (env.AUDIO_NODE_RESOLVERS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    pluginPackages: (env.AUDIO_NODE_PLUGINS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    disabledPlugins: (env.AUDIO_NODE_DISABLED_PLUGINS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    disabledSources: (env.AUDIO_NODE_DISABLED_SOURCES || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    sourceRequestTimeoutMs: positiveInteger(
      env.SOURCE_REQUEST_TIMEOUT_MS,
      'SOURCE_REQUEST_TIMEOUT_MS',
      10_000,
    ),
    sourceRetries: nonNegativeInteger(env.SOURCE_RETRIES, 'SOURCE_RETRIES', 1),
    sourceFallbackEnabled: booleanValue(
      env.SOURCE_FALLBACK_ENABLED,
      'SOURCE_FALLBACK_ENABLED',
    ),
    youtubeApiKey: env.YOUTUBE_API_KEY || '',
    spotifyClientId: env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    soundcloudClientId,
    soundcloudOAuthToken,
    rateLimitWindowMs: positiveInteger(
      env.RATE_LIMIT_WINDOW_MS,
      'RATE_LIMIT_WINDOW_MS',
      60_000,
    ),
    sessionCreateLimit: positiveInteger(env.SESSION_CREATE_LIMIT, 'SESSION_CREATE_LIMIT', 10),
    sessionRequestLimit: positiveInteger(env.SESSION_REQUEST_LIMIT, 'SESSION_REQUEST_LIMIT', 120),
  };
}
