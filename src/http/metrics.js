// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export class NodeMetrics {
  #httpRequests = new Map();
  #startupTime = Date.now();
  #retries = 0;

  recordHttpRequest(method, status) {
    const normalizedMethod = METHODS.has(method) ? method : 'OTHER';
    const key = `${normalizedMethod}:${status}`;
    this.#httpRequests.set(key, (this.#httpRequests.get(key) || 0) + 1);
  }

  recordRetry() {
    this.#retries++;
  }

  render(stats, { lavalinkSessions = 0 } = {}) {
    const lines = [
      '# HELP melink_audio_node_sessions Current authenticated client sessions.',
      '# TYPE melink_audio_node_sessions gauge',
      `melink_audio_node_sessions ${stats.sessions}`,
      '# HELP melink_audio_node_lavalink_sessions Current experimental Lavalink sessions.',
      '# TYPE melink_audio_node_lavalink_sessions gauge',
      `melink_audio_node_lavalink_sessions ${lavalinkSessions}`,
      '# HELP melink_audio_node_players Current guild players.',
      '# TYPE melink_audio_node_players gauge',
      `melink_audio_node_players ${stats.players}`,
      '# HELP melink_audio_node_retries_total Transient playback startup retries.',
      '# TYPE melink_audio_node_retries_total counter',
      `melink_audio_node_retries_total ${this.#retries}`,
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Math.floor((Date.now() - this.#startupTime) / 1000)}`,
      '# HELP process_resident_memory_bytes Resident process memory in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${stats.memory.rss}`,
      '# HELP nodejs_heap_used_bytes Node.js heap used in bytes.',
      '# TYPE nodejs_heap_used_bytes gauge',
      `nodejs_heap_used_bytes ${stats.memory.heapUsed}`,
      '# HELP nodejs_heap_total_bytes Node.js heap total in bytes.',
      '# TYPE nodejs_heap_total_bytes gauge',
      `nodejs_heap_total_bytes ${stats.memory.heapTotal}`,
      '# HELP melink_audio_node_http_requests_total HTTP responses by method and status.',
      '# TYPE melink_audio_node_http_requests_total counter',
    ];

    for (const [key, count] of [...this.#httpRequests].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const [method, status] = key.split(':');
      lines.push(`melink_audio_node_http_requests_total{method="${method}",status="${status}"} ${count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
