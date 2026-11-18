// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMetrics } from '../src/http/metrics.js';

test('Prometheus metrics use bounded labels and expose player, retry, and memory values', () => {
  const metrics = new NodeMetrics();
  metrics.recordHttpRequest('GET', 200);
  metrics.recordHttpRequest('UNTRUSTED-METHOD', 404);
  metrics.recordRetry();

  const rendered = metrics.render({
    sessions: 2,
    players: 3,
    memory: { rss: 100, heapUsed: 50, heapTotal: 80 },
  }, { lavalinkSessions: 4 });

  assert.match(rendered, /melink_audio_node_sessions 2/);
  assert.match(rendered, /melink_audio_node_lavalink_sessions 4/);
  assert.match(rendered, /melink_audio_node_players 3/);
  assert.match(rendered, /melink_audio_node_retries_total 1/);
  assert.match(rendered, /method="GET",status="200"\} 1/);
  assert.match(rendered, /method="OTHER",status="404"\} 1/);
  assert.match(rendered, /process_resident_memory_bytes 100/);
  assert.ok(rendered.endsWith('\n'));
});
