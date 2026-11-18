// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

export function createResolver({ apiVersion }) {
  if (apiVersion !== 1) {
    throw new Error(`Unsupported resolver API version: ${apiVersion}`);
  }

  return {
    apiVersion,
    name: 'example',
    supports(identifier) {
      return identifier.startsWith('example:');
    },
    async resolve(identifier) {
      const title = identifier.slice('example:'.length).trim();
      if (!title) throw new Error('Provide a title after the example: prefix');
      return {
        uri: 'https://media.example.net/replace-with-authorized-audio.ogg',
        identifier,
        title,
        author: 'Example resolver',
        length: 0,
        isSeekable: false,
        isStream: true,
      };
    },
  };
}
