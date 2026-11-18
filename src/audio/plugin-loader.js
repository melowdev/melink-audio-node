// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';
import { RESOLVER_API_VERSION, validateResolver } from './resolver-registry.js';

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parsePinnedPackageSpec(spec) {
  if (typeof spec !== 'string') {
    throw new Error('Plugin package must use the exact package@version format');
  }
  const separator = spec.lastIndexOf('@');
  if (separator <= 0) {
    throw new Error(
      `Invalid resolver package name or unpinned plugin specifier "${spec}"; package must be pinned as package@x.y.z`,
    );
  }

  const packageName = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!NPM_PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(version)) {
    throw new Error(`Invalid resolver package name or unpinned plugin specifier "${spec}"`);
  }
  return { packageName, version };
}

function findInstalledPackage(packageName) {
  let resolvedPath;
  try {
    resolvedPath = fileURLToPath(import.meta.resolve(packageName));
  } catch {
    throw new Error(`Plugin package "${packageName}" is not installed`);
  }
  let directory = dirname(resolvedPath);
  const filesystemRoot = parse(directory).root;

  while (directory !== filesystemRoot) {
    let contents;
    try {
      contents = readFileSync(join(directory, 'package.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      directory = dirname(directory);
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(contents);
    } catch {
      throw new Error(`Installed metadata for "${packageName}" is invalid`);
    }
    if (packageJson.name === packageName) return packageJson;
    directory = dirname(directory);
  }

  throw new Error(`Could not find installed package metadata for "${packageName}"`);
}

export async function loadInstalledPluginPackage(spec, { loadModule = true } = {}) {
  const { packageName, version } = parsePinnedPackageSpec(spec);
  const installed = findInstalledPackage(packageName);
  if (installed.version !== version) {
    throw new Error(
      `Installed version of "${packageName}" does not match the pinned version`,
    );
  }

  let pluginModule;
  if (loadModule) {
    try {
      pluginModule = await import(packageName);
    } catch {
      throw new Error(`Could not import plugin package "${packageName}"`);
    }
  }
  return {
    packageName,
    version,
    manifest: installed.melinkAudioNode,
    ...(pluginModule ? { pluginModule } : {}),
  };
}

export async function loadResolverPlugins(packageSpecs = []) {
  const resolvers = [];
  for (const spec of packageSpecs) {
    const { packageName, pluginModule } = await loadInstalledPluginPackage(spec);
    if (typeof pluginModule.createResolver !== 'function') {
      throw new Error(`Resolver plugin "${packageName}" must export createResolver()`);
    }
    const resolver = await pluginModule.createResolver({ apiVersion: RESOLVER_API_VERSION });
    validateResolver(resolver);
    resolvers.push(resolver);
  }
  return resolvers;
}
