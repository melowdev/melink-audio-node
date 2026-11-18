// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'melink-audio-node' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
        'token',
        'sessionToken',
        'password',
        'secret',
      ],
      censor: '[REDACTED]',
    },
  });
}
