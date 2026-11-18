// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

export function createLegacyResolverSource(resolver, { id = resolver.name } = {}) {
  return {
    id,
    name: resolver.name,
    trackSourceName: resolver.name,
    capabilities: {
      search: false,
      playback: true,
      playlist: false,
    },
    supportsIdentifier(identifier) {
      return resolver.supports(identifier);
    },
    resolve({ identifier }) {
      return resolver.resolve(identifier);
    },
  };
}
