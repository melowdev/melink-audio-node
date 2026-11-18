// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, requestPublicResponse, resolveRedirectUrl } from '../src/audio/safe-http.js';

test('public address validation rejects private, loopback, and special-purpose IPv4 and IPv6', () => {
  for (const address of [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
  ]) {
    assert.equal(isPublicAddress(address), false, `${address} must not be public`);
  }

  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('public HTTP requests reject loopback and credential-bearing URLs', async () => {
  await assert.rejects(requestPublicResponse('http://127.0.0.1:8080/private'), /public IP addresses/);
  await assert.rejects(requestPublicResponse('https://user:pass@example.com/'), /must not contain credentials/);
});

test('redirect targets are revalidated against the provider allowlist', () => {
  const allowedHosts = new Set(['api-v2.soundcloud.com']);
  assert.equal(
    resolveRedirectUrl(
      'https://api-v2.soundcloud.com/start',
      '/next',
      allowedHosts,
    ).hostname,
    'api-v2.soundcloud.com',
  );
  assert.throws(
    () => resolveRedirectUrl(
      'https://api-v2.soundcloud.com/start',
      'http://127.0.0.1/private',
      allowedHosts,
    ),
    /HTTPS/,
  );
  assert.throws(
    () => resolveRedirectUrl(
      'https://api-v2.soundcloud.com/start',
      'https://evil.example/redirect',
      allowedHosts,
    ),
    /allowed provider host/,
  );
  assert.throws(
    () => resolveRedirectUrl(
      'https://api-v2.soundcloud.com/start',
      'http://api-v2.soundcloud.com/redirect',
      allowedHosts,
    ),
    /HTTPS/,
  );
});
