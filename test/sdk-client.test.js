// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioNodeClient } from '../packages/audio-node-client/index.js';
import { SessionManager } from '../src/core/session-manager.js';
import { createAudioNode } from '../src/http/server.js';
import { createLogger } from '../src/logger.js';

test('SDK supports both search forms and reconnects using the active same-process session', async (t) => {
  const config = {
    host: '127.0.0.1',
    port: 0,
    token: 'test-secret-with-more-than-24-characters',
    maxPlayers: 10,
    idleTimeoutMs: 1000,
    youtubeApiKey: 'fixture-youtube-key',
  };
  const sessions = new SessionManager(config);
  const node = createAudioNode(config, sessions, {
    logger: createLogger('silent'),
    catalogSearch: async (source, query) => [{
      playable: false,
      info: {
        identifier: `https://www.youtube.com/watch?v=${encodeURIComponent(query)}`,
        title: `${source} search`,
        author: '',
        length: 0,
        uri: `https://www.youtube.com/watch?v=${encodeURIComponent(query)}`,
        sourceName: source,
        isSeekable: false,
        isStream: false,
      },
    }],
  });
  await node.listen();

  const client = new AudioNodeClient({
    baseUrl: `http://127.0.0.1:${node.server.address().port}`,
    token: config.token,
    discordClient: {},
  });
  client.on('error', () => {});
  t.after(async () => {
    await client.destroy();
    await node.close();
  });

  await client.connect();
  const search = await client.searchTracks('youtube', 'ambient', { limit: 1 });
  assert.equal(search.loadType, 'search');
  assert.equal(search.source, 'youtube');
  assert.equal(search.tracks[0].playable, false);

  const aggregate = await client.searchTracks('ambient', { limit: 1 });
  assert.equal(aggregate.loadType, 'search');
  assert.equal(aggregate.query, 'ambient');
  assert.equal(aggregate.total, 1);
  assert.equal(aggregate.successfulSources, 1);
  assert.deepEqual(aggregate.sources, [
    { source: 'youtube', success: true, count: 1 },
  ]);
  const session = sessions.values().next().value;
  assert.ok(session);
  const reconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SDK did not reconnect in time')), 5000);
    client.once('reconnect', (event) => {
      clearTimeout(timer);
      resolve(event);
    });
    client.once('reconnectFailed', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  session.socket.close(1012, 'Temporary interruption');
  const event = await reconnected;

  assert.equal(event.attempts, 1);
  assert.equal(client.session.sessionId, session.id);
  assert.equal(sessions.stats().sessions, 1);
  assert.equal(session.socket.readyState, 1);
});
