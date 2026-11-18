// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { createLegacyResolverSource } from './legacy-resolver-adapter.js';
import { SourceManager } from './source-manager.js';

const CATALOG_SOURCES = ['youtube', 'spotify', 'soundcloud'];
const SOURCE_ENABLE_KEYS = {
  http: 'httpEnabled',
  soundcloud: 'soundcloudEnabled',
  spotify: 'spotifyEnabled',
  youtube: 'youtubeEnabled',
};
const SOURCE_ENABLE_DEFAULTS = {
  http: true,
  soundcloud: false,
  spotify: true,
  youtube: true,
};

export function createSourceManager({
  resolverRegistry,
  catalogSearch,
  config,
  pluginManager,
  logger,
}) {
  const sourceManager = new SourceManager({
    timeoutMs: config.sourceRequestTimeoutMs ?? 10_000,
    retries: config.sourceRetries ?? 1,
    fallbackEnabled: config.sourceFallbackEnabled ?? false,
    logger,
  });
  const sources = resolverRegistry.getResolvers().map((resolver) =>
    createLegacyResolverSource(resolver, {
      id: resolver.name === 'direct' ? 'http' : resolver.name,
    }));

  for (const sourceId of CATALOG_SOURCES) {
    const existing = sources.find((source) => source.id === sourceId);
    const catalogSource = {
      search: ({ query, limit, signal }) =>
        catalogSearch(sourceId, query, { limit, signal }),
    };
    if (existing) {
      existing.search = catalogSource.search;
      existing.capabilities.search = true;
    } else {
      sources.push({
        id: sourceId,
        name: sourceId,
        capabilities: {
          search: true,
          playback: false,
          playlist: false,
        },
        ...catalogSource,
      });
    }
  }

  for (const source of sources) {
    const configured = source.id === 'soundcloud'
      ? Boolean(config.soundcloudClientId)
      : source.id === 'youtube'
        ? Boolean(config.youtubeApiKey)
        : source.id === 'spotify'
          ? Boolean(config.spotifyClientId && config.spotifyClientSecret)
          : true;
    const enabled = (config[SOURCE_ENABLE_KEYS[source.id]] ??
      SOURCE_ENABLE_DEFAULTS[source.id] ?? true) &&
      !config.disabledSources?.includes(source.id);
    sourceManager.register(source, {
      configured,
      enabled,
      healthy: true,
    });
  }

  for (const source of pluginManager?.getSources() || []) {
    sourceManager.register(source, {
      pluginId: source.pluginId,
      configured: source.configured ?? true,
      enabled: !config.disabledSources?.includes(source.id),
      healthy: source.healthy ?? true,
    });
  }

  for (const source of pluginManager?.getDisabledSources() || []) {
    sourceManager.registerUnavailableSource(source);
  }

  return sourceManager;
}
