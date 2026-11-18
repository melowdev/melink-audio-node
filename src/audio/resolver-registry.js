// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { resolveIdentifier } from './resolver.js';

export const RESOLVER_API_VERSION = 1;

const directResolver = {
  apiVersion: RESOLVER_API_VERSION,
  name: 'direct',
  supports(identifier) {
    try {
      resolveIdentifier(identifier);
      return true;
    } catch {
      return false;
    }
  },
  resolve(identifier) {
    const track = resolveIdentifier(identifier);
    return {
      uri: track.info.uri,
      title: track.info.title,
      author: track.info.author,
      length: track.info.length,
      isSeekable: track.info.isSeekable,
      isStream: track.info.isStream,
    };
  },
};

export function normalizeTrack(resolver, identifier, result) {
  if (!result || typeof result !== 'object' || typeof result.uri !== 'string') {
    throw new Error(`Resolver "${resolver.name}" returned an invalid track`);
  }

  const directTrack = resolveIdentifier(result.uri);
  const info = directTrack.info;
  const title = typeof result.title === 'string' && result.title.trim()
    ? result.title.trim().slice(0, 256)
    : info.title;
  const author = typeof result.author === 'string' ? result.author.slice(0, 256) : '';
  const length = Number.isSafeInteger(result.length) && result.length > 0 ? result.length : 0;

  return {
    encoded: directTrack.encoded,
    info: {
      ...info,
      identifier: typeof result.identifier === 'string' ? result.identifier : identifier,
      title,
      author,
      length,
      sourceName: resolver.name,
      isSeekable: false,
      isStream: result.isStream === undefined ? !length : Boolean(result.isStream),
    },
  };
}

export function validateResolver(resolver) {
  if (
    !resolver ||
    resolver.apiVersion !== RESOLVER_API_VERSION ||
    typeof resolver.name !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(resolver.name) ||
    typeof resolver.supports !== 'function' ||
    typeof resolver.resolve !== 'function'
  ) {
    throw new Error(`Resolver plugins must implement API version ${RESOLVER_API_VERSION} and provide a valid name, supports(), and resolve()`);
  }
  return resolver;
}

export class ResolverRegistry {
  #resolvers = [];

  constructor(resolvers = []) {
    for (const resolver of resolvers) this.register(resolver);
    this.register(directResolver);
  }

  register(resolver) {
    validateResolver(resolver);
    if (this.#resolvers.some((registered) => registered.name === resolver.name)) {
      throw new Error(`Resolver plugin name "${resolver.name}" is already registered`);
    }
    this.#resolvers.push(resolver);
  }

  getResolvers() {
    return [...this.#resolvers];
  }

  async resolve(identifier) {
    if (typeof identifier !== 'string' || !identifier) {
      throw new Error('Identifier must be a non-empty string');
    }

    for (const resolver of this.#resolvers) {
      let supported;
      try {
        supported = await resolver.supports(identifier);
      } catch (error) {
        const resolverError = new Error(
          `Resolver "${resolver.name}" failed to inspect the identifier`,
          {
          cause: error,
          },
        );
        if (error.statusCode) resolverError.statusCode = error.statusCode;
        throw resolverError;
      }
      if (!supported) continue;

      try {
        const result = await resolver.resolve(identifier);
        return normalizeTrack(resolver, identifier, result);
      } catch (error) {
        const resolverError = new Error(
          `Resolver "${resolver.name}" failed to resolve the identifier`,
          { cause: error },
        );
        if (error.statusCode) resolverError.statusCode = error.statusCode;
        throw resolverError;
      }
    }

    throw new Error('No configured resolver supports this identifier');
  }
}
