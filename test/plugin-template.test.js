// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../examples/resolver-plugin/index.js';
import { ResolverRegistry } from '../src/audio/resolver-registry.js';

test('example resolver follows the versioned plugin contract', async () => {
  const registry = new ResolverRegistry([createResolver({ apiVersion: 1 })]);
  const track = await registry.resolve('example:sample track');

  assert.equal(track.info.title, 'sample track');
  assert.equal(track.info.sourceName, 'example');
  assert.equal(track.info.uri, 'https://media.example.net/replace-with-authorized-audio.ogg');
  assert.throws(() => createResolver({ apiVersion: 2 }), /Unsupported resolver API version/);
});
