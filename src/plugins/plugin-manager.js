// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import {
  loadInstalledPluginPackage,
  parsePinnedPackageSpec,
} from '../audio/plugin-loader.js';
import { RESOLVER_API_VERSION, validateResolver } from '../audio/resolver-registry.js';
import { isDeepStrictEqual } from 'node:util';

export const MELINK_PLUGIN_API_VERSION = 1;

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITIES = ['search', 'catalog', 'playback', 'playlist', 'metadata'];

function validateVersion(version, label) {
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`${label} must be an exact semantic version`);
  }
}

function validateConfigKeys(keys, label) {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) ||
      keys.some((key) => typeof key !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(key)) ||
      new Set(keys).size !== keys.length) {
    throw new Error(`${label} must be a list of unique config keys`);
  }
  return keys;
}

function validateSourceDeclarations(sources, pluginId) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`Plugin "${pluginId}" must declare at least one source`);
  }
  const ids = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object' ||
        typeof source.id !== 'string' || !IDENTIFIER.test(source.id) ||
        typeof source.name !== 'string' || !source.name.trim() ||
        !source.capabilities || typeof source.capabilities !== 'object' ||
        CAPABILITIES.some((key) =>
          source.capabilities[key] !== undefined &&
          typeof source.capabilities[key] !== 'boolean') ||
        Object.keys(source.capabilities).some((key) => !CAPABILITIES.includes(key))) {
      throw new Error(`Plugin "${pluginId}" has an invalid source declaration`);
    }
    if (ids.has(source.id)) {
      throw new Error(`Plugin "${pluginId}" declares duplicate source id "${source.id}"`);
    }
    ids.add(source.id);
  }
  return sources.map((source) => ({
    ...source,
    capabilities: Object.fromEntries(
      CAPABILITIES.map((key) => [key, source.capabilities[key] ?? false]),
    ),
  }));
}

function validateManifest(manifest, packageName, packageVersion) {
  if (!manifest || typeof manifest !== 'object' ||
      typeof manifest.id !== 'string' || !IDENTIFIER.test(manifest.id) ||
      typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error(`Plugin package "${packageName}" has an invalid manifest`);
  }
  validateVersion(manifest.version, `Plugin "${manifest.id}" version`);
  if (manifest.version !== packageVersion) {
    throw new Error(`Plugin "${manifest.id}" version does not match its pinned package`);
  }
  if (manifest.apiVersion !== MELINK_PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin "${manifest.id}" requires an unsupported Melink Plugin API version`,
    );
  }

  const dependencies = manifest.dependencies ?? [];
  if (!Array.isArray(dependencies)) {
    throw new Error(`Plugin "${manifest.id}" dependencies must be an array`);
  }
  const dependencyIds = new Set();
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency.id !== 'string' ||
        !IDENTIFIER.test(dependency.id)) {
      throw new Error(`Plugin "${manifest.id}" has an invalid dependency`);
    }
    validateVersion(dependency.version, `Plugin "${manifest.id}" dependency version`);
    if (dependencyIds.has(dependency.id)) {
      throw new Error(`Plugin "${manifest.id}" declares duplicate dependencies`);
    }
    dependencyIds.add(dependency.id);
  }

  const sources = validateSourceDeclarations(manifest.sources, manifest.id);
  const configKeys = validateConfigKeys(manifest.configKeys, `Plugin "${manifest.id}" configKeys`);
  const secretConfigKeys = validateConfigKeys(
    manifest.secretConfigKeys,
    `Plugin "${manifest.id}" secretConfigKeys`,
  );
  if (secretConfigKeys.some((key) => !configKeys.includes(key))) {
    throw new Error(`Plugin "${manifest.id}" secretConfigKeys must be included in configKeys`);
  }
  return { ...manifest, dependencies, sources, configKeys, secretConfigKeys };
}

function sameManifest(left, right) {
  return isDeepStrictEqual(left, right);
}

function pluginConfigFor(config, manifest) {
  const result = {};
  for (const key of manifest.configKeys) {
    if (key === 'token' || key === 'nodeToken') continue;
    const sensitive = /token|secret|password|api.?key|credential/i.test(key);
    if (sensitive && !manifest.secretConfigKeys.includes(key)) continue;
    if (Object.hasOwn(config, key)) result[key] = config[key];
  }
  return result;
}

function topologicalOrder(entries) {
  const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(entry) {
    const { id } = entry.manifest;
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle includes "${id}"`);
    visiting.add(id);

    for (const dependency of entry.manifest.dependencies) {
      const target = byId.get(dependency.id);
      if (!target) {
        throw new Error(
          `Plugin "${id}" requires missing plugin "${dependency.id}"`,
        );
      }
      if (target.manifest.version !== dependency.version) {
        throw new Error(
          `Plugin "${id}" requires "${dependency.id}" version ${dependency.version}`,
        );
      }
      visit(target);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(entry);
  }

  for (const entry of entries) visit(entry);
  return ordered;
}

function safeErrorType(error) {
  return typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error';
}

export class PluginManager {
  #plugins = [];
  #sources = [];
  #disabledSources = [];
  #legacyResolvers = [];
  #closeHandlers = [];
  #loaded = false;
  #moduleLoader;

  constructor({
    pluginPackages = [],
    legacyResolverPackages = [],
    disabledPlugins = [],
    config = {},
    logger,
    moduleLoader = loadInstalledPluginPackage,
  } = {}) {
    this.pluginPackages = pluginPackages;
    this.legacyResolverPackages = legacyResolverPackages;
    this.disabledPlugins = new Set(disabledPlugins);
    this.config = config;
    this.logger = logger;
    this.#moduleLoader = moduleLoader;
  }

  async load() {
    if (this.#loaded) throw new Error('Plugin manager has already been loaded');
    try {
      return await this.#loadConfigured();
    } catch (error) {
      this.logger?.error?.({
        phase: 'startup',
        errorType: safeErrorType(error),
      }, 'Plugin manager startup failed');
      try {
        await this.close();
      } catch (shutdownError) {
        throw new AggregateError(
          [error, shutdownError],
          'Plugin loading failed and cleanup was incomplete',
        );
      }
      throw error;
    }
  }

  async #loadConfigured() {
    const entries = [];
    const seenPackages = new Set();
    const instances = new Map();

    for (const spec of this.pluginPackages) {
      const loaded = await this.#loadPackage(spec, seenPackages, { loadModule: false });
      const manifest = validateManifest(
        loaded.manifest,
        loaded.packageName,
        loaded.version,
      );
      entries.push({ ...loaded, spec, manifest });
    }

    const ids = new Set();
    const sourceIds = new Set();
    for (const entry of entries) {
      if (ids.has(entry.manifest.id)) {
        throw new Error(`Plugin id "${entry.manifest.id}" is already registered`);
      }
      ids.add(entry.manifest.id);
      for (const source of entry.manifest.sources) {
        if (sourceIds.has(source.id)) {
          throw new Error(`Source id "${source.id}" is declared by multiple plugins`);
        }
        sourceIds.add(source.id);
      }
    }
    const legacyPackageNames = this.legacyResolverPackages.map(
      (spec) => parsePinnedPackageSpec(spec).packageName,
    );
    for (const packageName of legacyPackageNames) {
      if (ids.has(packageName)) {
        throw new Error(`Plugin id "${packageName}" is already registered`);
      }
      ids.add(packageName);
    }

    const order = topologicalOrder(entries);
    const configuredPluginKeys = new Set();
    for (const { manifest, packageName } of order) {
      configuredPluginKeys.add(manifest.id);
      configuredPluginKeys.add(packageName);
    }
    for (const spec of this.legacyResolverPackages) {
      configuredPluginKeys.add(parsePinnedPackageSpec(spec).packageName);
    }
    for (const disabledId of this.disabledPlugins) {
      if (!configuredPluginKeys.has(disabledId)) {
        throw new Error(`Disabled plugin "${disabledId}" is not configured`);
      }
    }
    for (const entry of order) {
      const disabled = this.disabledPlugins.has(entry.manifest.id) ||
        this.disabledPlugins.has(entry.packageName);
      if (disabled) {
        this.#plugins.push(this.#pluginStatus(entry, {
          loaded: false,
          enabled: false,
          healthy: false,
        }));
        for (const source of entry.manifest.sources) {
          this.#disabledSources.push({
            id: source.id,
            name: source.name,
            pluginId: entry.manifest.id,
            declaredCapabilities: { ...source.capabilities },
          });
        }
        continue;
      }

      if (entry.manifest.dependencies.some((dependency) => {
        const target = order.find(({ manifest }) => manifest.id === dependency.id);
        return this.disabledPlugins.has(dependency.id) ||
          this.disabledPlugins.has(target.packageName);
      })) {
        throw new Error(`Plugin "${entry.manifest.id}" depends on a disabled plugin`);
      }

      let instance;
      try {
        const loadedModule = await this.#moduleLoader(entry.spec, { loadModule: true });
        if (loadedModule.packageName !== entry.packageName ||
            loadedModule.version !== entry.version) {
          throw new Error(`Plugin "${entry.manifest.id}" package identity changed during import`);
        }
        const moduleManifest = validateManifest(
          loadedModule.pluginModule?.manifest,
          loadedModule.packageName,
          loadedModule.version,
        );
        if (!sameManifest(entry.manifest, moduleManifest)) {
          throw new Error(`Plugin "${entry.manifest.id}" exported manifest does not match package metadata`);
        }
        if (typeof loadedModule.pluginModule?.createPlugin !== 'function') {
          throw new Error(`Plugin "${entry.manifest.id}" must export createPlugin()`);
        }
        instance = await loadedModule.pluginModule.createPlugin({
          apiVersion: MELINK_PLUGIN_API_VERSION,
          config: pluginConfigFor(this.config, entry.manifest),
          dependencies: Object.fromEntries(entry.manifest.dependencies.map(
            ({ id }) => [id, instances.get(id)],
          )),
          logger: this.logger?.child?.({ pluginId: entry.manifest.id }) || this.logger,
        });
        if (typeof instance?.close === 'function') {
          this.#closeHandlers.push({
            id: entry.manifest.id,
            close: () => instance.close(),
          });
        }
        this.#validatePluginInstance(entry.manifest, instance);
      } catch (error) {
        this.logger?.error?.({
          pluginId: entry.manifest.id,
          phase: 'initialize',
          errorType: safeErrorType(error),
        }, 'Source plugin initialization failed');
        throw new Error(`Plugin "${entry.manifest.id}" failed to initialize`);
      }

      for (const source of instance.sources) {
        this.#sources.push({
          ...source,
          pluginId: entry.manifest.id,
          configured: source.configured ?? true,
          healthy: true,
        });
      }
      instances.set(entry.manifest.id, instance);
      this.#plugins.push(this.#pluginStatus(entry, {
        loaded: true,
        enabled: true,
        healthy: true,
      }));
    }

    for (const spec of this.legacyResolverPackages) {
      const metadata = await this.#loadPackage(spec, seenPackages, { loadModule: false });
      const disabled = this.disabledPlugins.has(metadata.packageName);
      if (disabled) {
        this.#plugins.push({
          id: metadata.packageName,
          name: metadata.packageName,
          version: metadata.version,
          apiVersion: RESOLVER_API_VERSION,
          legacy: true,
          loaded: false,
          enabled: false,
          healthy: false,
        });
        continue;
      }
      const loadedModule = await this.#moduleLoader(spec, { loadModule: true });
      if (loadedModule.packageName !== metadata.packageName ||
          loadedModule.version !== metadata.version) {
        throw new Error(`Resolver package "${metadata.packageName}" changed during import`);
      }
      const loaded = { ...metadata, ...loadedModule };
      if (typeof loaded.pluginModule.createResolver !== 'function') {
        throw new Error(`Resolver package "${loaded.packageName}" must export createResolver()`);
      }
      let resolver;
      try {
        resolver = await loaded.pluginModule.createResolver({
          apiVersion: RESOLVER_API_VERSION,
        });
        validateResolver(resolver);
      } catch (error) {
        this.logger?.error?.({
          packageName: loaded.packageName,
          phase: 'initialize',
          errorType: safeErrorType(error),
        }, 'Legacy resolver initialization failed');
        throw new Error(`Resolver package "${loaded.packageName}" failed to initialize`);
      }
      this.#legacyResolvers.push(resolver);
      if (typeof resolver.close === 'function') {
        this.#closeHandlers.push({
          id: loaded.packageName,
          close: () => resolver.close(),
        });
      }
      this.#plugins.push({
        id: loaded.packageName,
        name: loaded.packageName,
        version: loaded.version,
        apiVersion: RESOLVER_API_VERSION,
        legacy: true,
        loaded: true,
        enabled: true,
        healthy: true,
      });
    }

    this.#loaded = true;
    return this;
  }

  getSources() {
    return [...this.#sources];
  }

  getDisabledSources() {
    return [...this.#disabledSources];
  }

  getLegacyResolvers() {
    return [...this.#legacyResolvers];
  }

  listPlugins({ enabledOnly = false } = {}) {
    return this.#plugins
      .filter((plugin) => !enabledOnly || (plugin.loaded && plugin.enabled))
      .map((plugin) => ({ ...plugin }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async close() {
    const errors = [];
    for (const handler of this.#closeHandlers.splice(0).reverse()) {
      try {
        await handler.close();
      } catch (error) {
        this.logger?.error?.({
          pluginId: handler.id,
          phase: 'shutdown',
          errorType: safeErrorType(error),
        }, 'Source plugin shutdown failed');
        errors.push(new Error(`Plugin "${handler.id}" failed to shut down`));
      }
    }
    this.#loaded = false;
    if (errors.length) throw new AggregateError(errors, 'One or more plugins failed to shut down');
  }

  async #loadPackage(spec, seenPackages, options) {
    const { packageName, version, manifest, pluginModule } = await this.#moduleLoader(spec, options);
    if (seenPackages.has(packageName)) {
      throw new Error(`Plugin package "${packageName}" is configured more than once`);
    }
    seenPackages.add(packageName);
    return {
      packageName,
      version,
      ...(manifest ? { manifest } : {}),
      ...(pluginModule ? { pluginModule } : {}),
    };
  }

  #pluginStatus(entry, status) {
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      apiVersion: entry.manifest.apiVersion,
      legacy: false,
      ...status,
    };
  }

  #validatePluginInstance(manifest, instance) {
    if (!instance || typeof instance !== 'object' || !Array.isArray(instance.sources)) {
      throw new Error('createPlugin() must return a sources array');
    }
    const declarations = new Map(manifest.sources.map((source) => [source.id, source]));
    const registered = new Set();
    for (const source of instance.sources) {
      const declaration = declarations.get(source?.id);
      if (!declaration) {
        throw new Error('Plugin returned an undeclared source');
      }
      if (registered.has(source.id)) {
        throw new Error(`Plugin returned duplicate source id "${source.id}"`);
      }
      registered.add(source.id);
      if (!source.capabilities ||
          CAPABILITIES.some((key) =>
            (source.capabilities[key] ?? false) !== declaration.capabilities[key])) {
        throw new Error(`Plugin source "${source.id}" capabilities differ from its manifest`);
      }

      const implemented = {
        search: typeof source.search === 'function',
        catalog: typeof source.resolveCatalog === 'function',
        playback: typeof source.supportsIdentifier === 'function' &&
          typeof source.resolve === 'function',
        playlist: typeof source.supportsPlaylistIdentifier === 'function' &&
          typeof source.resolvePlaylist === 'function',
        metadata: typeof source.getMetadata === 'function',
      };
      if (CAPABILITIES.some((key) =>
        implemented[key] !== (declaration.capabilities[key] ?? false))) {
        throw new Error(`Plugin source "${source.id}" capabilities do not match its methods`);
      }
    }
    if (registered.size !== declarations.size) {
      throw new Error(`Plugin "${manifest.id}" did not create all declared sources`);
    }
    if (instance.close !== undefined && typeof instance.close !== 'function') {
      throw new Error(`Plugin "${manifest.id}" close must be a function`);
    }
  }
}
