// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const licenseExpression = 'GPL-3.0-only OR AGPL-3.0-only';

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), 'utf8');
}

test('root, lockfile, and SDK declare the same alternative licenses', () => {
  assert.equal(JSON.parse(read('package.json')).license, licenseExpression);
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].license, licenseExpression);
  const sdk = JSON.parse(read('packages/audio-node-client/package.json'));
  assert.equal(sdk.license, licenseExpression);
  for (const file of ['LICENSE', 'LICENSE-GPL-3.0', 'LICENSE-AGPL-3.0']) {
    assert.ok(sdk.files.includes(file), `SDK package must include ${file}`);
  }
});

test('both full license texts are present in the repository and SDK package', () => {
  assert.match(read('LICENSE'), /GNU GPL v3\.0-only or the\s+GNU AGPL v3\.0-only/);
  assert.match(read('LICENSE-GPL-3.0'), /GNU GENERAL PUBLIC LICENSE/);
  assert.match(read('LICENSE-AGPL-3.0'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(read('packages/audio-node-client/LICENSE-GPL-3.0'), read('LICENSE-GPL-3.0'));
  assert.equal(read('packages/audio-node-client/LICENSE-AGPL-3.0'), read('LICENSE-AGPL-3.0'));
});

test('maintained source files identify both license alternatives', () => {
  const files = [
    'src/server.js',
    'src/config.js',
    'src/http/server.js',
    'src/audio/resolver.js',
    'src/core/session-manager.js',
    'src/core/player.js',
    'packages/audio-node-client/index.js',
    'assets/logo.svg',
    'test/api.test.js',
  ];

  for (const file of files) {
    assert.ok(read(file).includes(`SPDX-License-Identifier: ${licenseExpression}`), file);
  }
});

test('licensing guide explains the AGPL network-source condition', () => {
  const guide = read('docs/licensing.md');
  assert.match(guide, /recipient's choice/);
  assert.match(guide, /section 13/i);
  assert.match(guide, /github\.com\/lordyagizHEX\/melink-audio-node/);
});
