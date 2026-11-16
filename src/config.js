// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import 'dotenv/config';

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const portValue = env.PORT || env.SERVER_PORT;
  const token = env.AUDIO_NODE_TOKEN;
  if (!token || token.length < 24 || token === 'replace-with-a-long-random-secret') {
    throw new Error('Set AUDIO_NODE_TOKEN to a random secret of at least 24 characters');
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: positiveInteger(portValue, env.PORT ? 'PORT' : 'SERVER_PORT', 2333),
    token,
    maxPlayers: positiveInteger(env.MAX_PLAYERS, 'MAX_PLAYERS', 5),
    idleTimeoutMs: positiveInteger(env.IDLE_TIMEOUT_MS, 'IDLE_TIMEOUT_MS', 30_000),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
