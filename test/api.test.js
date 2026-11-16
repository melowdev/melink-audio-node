// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createAudioNode } from '../src/http/server.js';
import { SessionManager } from '../src/core/session-manager.js';
import { openAudioStream, resolveIdentifier } from '../src/audio/resolver.js';
import { loadConfig } from '../src/config.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  token: 'test-secret-with-more-than-24-characters',
  maxPlayers: 10,
  idleTimeoutMs: 1000,
};

test('health endpoint is available without credentials', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const response = await fetch(`http://127.0.0.1:${node.server.address().port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('session creation requires the node token and issues a session credential', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof body.sessionToken, 'string');
});

test('track loading accepts direct HTTP URLs and rejects search terms', async (t) => {
  const node = createAudioNode(config, new SessionManager(config));
  await node.listen();
  t.after(() => node.close());
  const baseUrl = `http://127.0.0.1:${node.server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientName: 'test-bot' }),
  });
  const { sessionId, sessionToken } = await created.json();

  const valid = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identifier: 'https://example.com/audio.mp3' }),
  });
  assert.equal(valid.status, 200);
  const track = (await valid.json()).tracks[0];
  assert.equal(track.info.title, 'audio');
  assert.equal(JSON.parse(Buffer.from(track.encoded, 'base64url').toString()).uri,
    'https://example.com/audio.mp3');

  const invalid = await fetch(`${baseUrl}/v1/sessions/${sessionId}/loadtracks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identifier: 'lofi music' }),
  });
  assert.equal(invalid.status, 400);
});

test('media resolver rejects credentials and private-network destinations', async () => {
  assert.throws(
    () => resolveIdentifier('https://user:password@example.com/audio.mp3'),
    /must not contain credentials/,
  );
  await assert.rejects(
    openAudioStream('http://127.0.0.1:8080/audio.mp3'),
    /public IP addresses/,
  );
});

test('WebSocket sessions authenticate and deliver node events', async (t) => {
  const sessions = new SessionManager(config);
  const session = sessions.create('test-bot');
  const node = createAudioNode(config, sessions);
  await node.listen();
  t.after(() => node.close());

  const socket = new WebSocket(`ws://127.0.0.1:${node.server.address().port}/v1/ws`);
  t.after(() => socket.close());
  const ready = new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({
      op: 'authenticate',
      sessionId: session.id,
      sessionToken: session.token,
    })));
    socket.on('message', (message) => {
      const packet = JSON.parse(message.toString());
      if (packet.op === 'ready') resolve();
    });
    socket.once('error', reject);
  });
  await ready;

  const event = new Promise((resolve) => {
    socket.once('message', (message) => resolve(JSON.parse(message.toString())));
  });
  assert.equal(session.send('TestEvent', { guildId: '12345678901234567' }), true);
  assert.deepEqual(await event, { op: 'TestEvent', guildId: '12345678901234567' });
});

test('hosting SERVER_PORT is used when PORT is not set', () => {
  const loaded = loadConfig({
    AUDIO_NODE_TOKEN: 'a-valid-test-token-with-at-least-24-chars',
    SERVER_PORT: '25627',
  });
  assert.equal(loaded.port, 25627);
});
