// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { loadConfig } from './config.js';
import { createAudioNode } from './http/server.js';
import { SessionManager } from './core/session-manager.js';

const config = loadConfig();
const sessions = new SessionManager(config);
const audioNode = createAudioNode(config, sessions);

const address = await audioNode.listen();
console.log(`Audio Node listening on ${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await audioNode.close();
    process.exit(0);
  });
}
