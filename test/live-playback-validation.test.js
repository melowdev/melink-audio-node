// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const harnessPath = fileURLToPath(
  new URL('../scripts/live-playback-validation.js', import.meta.url),
);

test('live playback harness blocks before connecting when prerequisites are absent', () => {
  const result = spawnSync(process.execPath, [harnessPath], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.PASS, 0);
  assert.equal(report.summary.FAIL, 0);
  assert.ok(report.summary.BLOCKED > 0);
  assert.ok(report.missingPrerequisites.includes('DISCORD_BOT_TOKEN'));
  assert.ok(report.results.every(({ status }) => status === 'BLOCKED'));
});
