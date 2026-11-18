// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const openapi = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));

test('OpenAPI schema documents the implemented REST routes and authentication', () => {
  assert.equal(openapi.openapi, '3.1.0');
  for (const route of [
    '/healthz',
    '/readyz',
    '/metrics',
    '/version',
    '/v4/info',
    '/v4/stats',
    '/v4/loadtracks',
    '/v4/encodetracks',
    '/v4/decodetracks',
    '/v4/sessions/{sessionId}',
    '/v4/sessions/{sessionId}/players',
    '/v4/websocket',
    '/v1/sessions',
    '/v1/stats',
    '/v1/sources',
    '/v1/sessions/{sessionId}',
    '/v1/sessions/{sessionId}/loadtracks',
    '/v1/sessions/{sessionId}/search',
    '/v1/sessions/{sessionId}/players/{guildId}',
  ]) {
    assert.ok(openapi.paths[route], `Missing OpenAPI route ${route}`);
  }
  assert.deepEqual(openapi.paths['/v1/sessions'].post.security, [{ nodeToken: [] }]);
  assert.deepEqual(openapi.paths['/v1/sources'].get.security, [{ nodeToken: [] }]);
  assert.deepEqual(
    openapi.paths['/v1/sources'].get.responses[200].content['application/json']
      .schema.properties.sources.items.$ref,
    '#/components/schemas/SourceStatus',
  );
  assert.deepEqual(
    openapi.paths['/v1/sessions/{sessionId}/loadtracks'].post.security,
    [{ sessionToken: [] }],
  );
  assert.deepEqual(
    openapi.paths['/v1/sessions/{sessionId}/search'].post.security,
    [{ sessionToken: [] }],
  );
  const searchOperation = openapi.paths['/v1/sessions/{sessionId}/search'].post;
  const searchRequest = searchOperation.requestBody.content['application/json'].schema;
  assert.deepEqual(searchRequest.required, ['query']);
  assert.equal(searchRequest.properties.source.type, 'string');
  assert.deepEqual(searchRequest.properties.limit, {
    type: 'integer',
    minimum: 1,
    maximum: 10,
    default: 10,
  });
  assert.deepEqual(
    searchOperation.responses[200].content['application/json'].schema.oneOf,
    [
      { $ref: '#/components/schemas/SingleSourceSearchResponse' },
      { $ref: '#/components/schemas/MultiSourceSearchResponse' },
    ],
  );
  assert.equal(
    openapi.paths['/v4/sessions/{sessionId}/players/{guildId}'].patch.responses[200].description,
    'Updated player snapshot',
  );
  assert.match(
    openapi.paths['/v4/websocket'].get.description,
    /Lavalink-Api-Version and Session-Resumed/,
  );
});
