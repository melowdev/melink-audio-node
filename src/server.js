// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { loadConfig } from './config.js';
import { createAudioNode } from './http/server.js';
import { SessionManager } from './core/session-manager.js';
import { ResolverRegistry } from './audio/resolver-registry.js';
import { createSoundCloudResolver } from './audio/catalog-search.js';
import { createLogger } from './logger.js';
import { PluginManager } from './plugins/plugin-manager.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const sessions = new SessionManager(config);
const pluginManager = new PluginManager({
  pluginPackages: config.pluginPackages,
  legacyResolverPackages: config.resolverPlugins,
  disabledPlugins: config.disabledPlugins,
  config,
  logger,
});
try {
  await pluginManager.load();
} catch (error) {
  logger.fatal({ errorType: error.name }, 'Could not load configured plugins');
  throw error;
}
let audioNode;
try {
  const resolverRegistry = new ResolverRegistry([
    ...pluginManager.getLegacyResolvers(),
    createSoundCloudResolver(config),
  ]);
  audioNode = createAudioNode(config, sessions, { logger, resolverRegistry, pluginManager });
} catch (error) {
  try {
    await pluginManager.close();
  } catch (shutdownError) {
    logger.error({ errorType: shutdownError.name }, 'Plugin cleanup after startup failure failed');
  }
  throw error;
}

let address;
try {
  address = await audioNode.listen();
} catch (error) {
  try {
    await audioNode.close();
  } catch (shutdownError) {
    logger.error({ errorType: shutdownError.name }, 'Plugin cleanup after listen failure failed');
  }
  throw error;
}
logger.info({ address: address.address, port: address.port }, 'Audio Node listening');

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down Audio Node');
    try {
      await audioNode.close();
      logger.info('Audio Node stopped');
    } catch (error) {
      logger.error({ err: error }, 'Audio Node shutdown failed');
      process.exitCode = 1;
    }
  });
}
