// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolverRegistry } from '../src/audio/resolver-registry.js';
import { loadResolverPlugins } from '../src/audio/plugin-loader.js';
import { retryTransient } from '../src/audio/retry.js';
import { FixedWindowRateLimiter } from '../src/http/rate-limiter.js';

test('resolver registry uses a matching plugin and normalizes its track', async () => {
  const registry = new ResolverRegistry([{
    apiVersion: 1,
    name: 'catalog',
    supports: (identifier) => identifier.startsWith('catalog:'),
    resolve: async (identifier) => ({
      uri: 'https://media.example.net/song.ogg',
      identifier,
      title: '  Example song  ',
      author: 'Example artist',
      length: 42_000,
      isSeekable: true,
      isStream: false,
    }),
  }]);

  const track = await registry.resolve('catalog:example-song');
  assert.equal(track.info.title, 'Example song');
  assert.equal(track.info.author, 'Example artist');
  assert.equal(track.info.length, 42_000);
  assert.equal(track.info.sourceName, 'catalog');
  assert.equal(track.info.isSeekable, false);
  assert.equal(
    JSON.parse(Buffer.from(track.encoded, 'base64url').toString()).uri,
    'https://media.example.net/song.ogg',
  );
});

test('resolver registry surfaces plugin failures and rejects invalid output URLs', async () => {
  const failingRegistry = new ResolverRegistry([{
    apiVersion: 1,
    name: 'failing',
    supports: () => true,
    resolve: async () => {
      throw new Error('source unavailable');
    },
  }]);
  await assert.rejects(failingRegistry.resolve('catalog:track'), /failed to resolve/);

  const invalidRegistry = new ResolverRegistry([{
    apiVersion: 1,
    name: 'invalid',
    supports: () => true,
    resolve: async () => ({ uri: 'file:///etc/passwd' }),
  }]);
  await assert.rejects(invalidRegistry.resolve('catalog:track'), /failed to resolve/);
});

test('resolver plugin loader rejects package specifiers outside npm package names', async () => {
  await assert.rejects(loadResolverPlugins(['../untrusted-plugin.js']), /Invalid resolver package name/);
});

test('transient retry uses bounded exponential delays and stops at the attempt limit', async () => {
  const delays = [];
  let attempts = 0;
  const result = await retryTransient(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('temporary'), { retryable: true });
    return 'ready';
  }, {
    initialDelayMs: 10,
    maxDelayMs: 15,
    wait: async (delayMs) => delays.push(delayMs),
  });

  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 15]);
});

test('transient retry does not retry permanent errors', async () => {
  let attempts = 0;
  await assert.rejects(retryTransient(async () => {
    attempts++;
    throw new Error('permanent');
  }, { wait: async () => assert.fail('must not wait') }), /permanent/);
  assert.equal(attempts, 1);
});

test('fixed-window rate limiter enforces limits and resets expired buckets', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000 });

  assert.deepEqual(limiter.consume('client', 100), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 1100,
    retryAfterSeconds: 1,
  });
  assert.equal(limiter.consume('client', 200).remaining, 0);
  assert.equal(limiter.consume('client', 300).allowed, false);
  assert.equal(limiter.consume('client', 1100).allowed, true);
});

test('fixed-window rate limiter caps the number of tracked clients', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, maxBuckets: 1 });
  assert.equal(limiter.consume('first', 0).allowed, true);
  assert.equal(limiter.consume('second', 1).allowed, false);
  assert.equal(limiter.consume('second', 1000).allowed, true);
});
