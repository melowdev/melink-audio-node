// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { randomBytes } from 'node:crypto';
import { createAudioNode } from '../src/http/server.js';
import { SessionManager } from '../src/core/session-manager.js';
import { createLogger } from '../src/logger.js';

function option(name, fallback) {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const value = argument ? Number(argument.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

const iterations = option('iterations', 500);
const concurrency = option('concurrency', 20);
if (iterations > 100_000 || concurrency > 256) {
  throw new Error('Use at most 100000 iterations and 256 concurrent workers');
}

const config = {
  host: '127.0.0.1',
  port: 0,
  token: randomBytes(32).toString('base64url'),
  maxPlayers: 1,
  idleTimeoutMs: 1000,
  sessionCreateLimit: iterations + 1,
  sessionRequestLimit: 10,
  rateLimitWindowMs: 60_000,
  logLevel: 'silent',
};
const sessions = new SessionManager(config);
const node = createAudioNode(config, sessions, { logger: createLogger('silent') });

try {
  const address = await node.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const memoryBefore = process.memoryUsage();
  let nextIteration = 0;
  const started = process.hrtime.bigint();

  async function worker() {
    while (true) {
      const current = nextIteration++;
      if (current >= iterations) return;

      const created = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ clientName: `benchmark-${current}` }),
      });
      if (created.status !== 201) {
        throw new Error(`Session creation failed with HTTP ${created.status}`);
      }
      const session = await created.json();

      const deleted = await fetch(`${baseUrl}/v1/sessions/${session.sessionId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.sessionToken}` },
      });
      if (deleted.status !== 200) {
        throw new Error(`Session deletion failed with HTTP ${deleted.status}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, worker));
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const memoryAfter = process.memoryUsage();
  console.log(JSON.stringify({
    benchmark: 'session-lifecycle',
    node: process.version,
    platform: process.platform,
    iterations,
    concurrency: Math.min(concurrency, iterations),
    httpRequests: iterations * 2,
    durationMs: Number(durationMs.toFixed(2)),
    operationsPerSecond: Number((iterations * 2 * 1000 / durationMs).toFixed(2)),
    memoryBytes: {
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      rssDelta: memoryAfter.rss - memoryBefore.rss,
      heapUsedAfter: memoryAfter.heapUsed,
    },
  }, null, 2));
} finally {
  await node.close();
}
