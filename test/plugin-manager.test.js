// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MELINK_PLUGIN_API_VERSION,
  PluginManager,
} from '../src/plugins/plugin-manager.js';
import { parsePinnedPackageSpec } from '../src/audio/plugin-loader.js';

function pluginPackage({
  packageName,
  id = packageName,
  version = '1.2.3',
  apiVersion = MELINK_PLUGIN_API_VERSION,
  dependencies = [],
  sourceId = `${id}-source`,
  sourceCapabilities = { search: true, playback: false, playlist: false },
  createPlugin = () => ({
    sources: [{
      id: sourceId,
      name: 'Fixture source',
      capabilities: sourceCapabilities,
      ...(sourceCapabilities.search ? { async search() { return []; } } : {}),
      ...(sourceCapabilities.playback
        ? { supportsIdentifier() { return true; }, async resolve() { return {}; } }
        : {}),
      ...(sourceCapabilities.playlist ? { async resolvePlaylist() { return {}; } } : {}),
    }],
  }),
} = {}) {
  return {
    packageName,
    version,
    manifest: {
      id,
      name: `Plugin ${id}`,
      version,
      apiVersion,
      dependencies,
      sources: [{ id: sourceId, name: 'Fixture source', capabilities: sourceCapabilities }],
    },
    pluginModule: {
      manifest: null,
      createPlugin,
    },
  };
}

function createManager(packages, options = {}) {
  const modules = new Map(packages.map((entry) => [entry.packageName, entry]));
  return new PluginManager({
    pluginPackages: packages.map(({ packageName, version }) => `${packageName}@${version}`),
    moduleLoader: async (spec, options) => {
      const packageName = spec.slice(0, spec.lastIndexOf('@'));
      const loaded = modules.get(packageName);
      if (!loaded) throw new Error('test package is not configured');
      return {
        packageName: loaded.packageName,
        version: loaded.version,
        manifest: loaded.manifest,
        ...(options?.loadModule === false
          ? {}
          : { pluginModule: { ...loaded.pluginModule, manifest: loaded.manifest } }),
      };
    },
    ...options,
  });
}

test('plugin manager validates pinned package specs', () => {
  assert.deepEqual(parsePinnedPackageSpec('@example/source@1.2.3'), {
    packageName: '@example/source',
    version: '1.2.3',
  });
  assert.throws(() => parsePinnedPackageSpec('source'), /pinned as package@x.y.z/);
  assert.throws(() => parsePinnedPackageSpec('source@^1.2.3'), /Invalid resolver package/);
});

test('plugin startup registers declared sources and shutdown runs in reverse order', async () => {
  const lifecycle = [];
  const first = pluginPackage({
    packageName: 'first-package',
    id: 'first',
    createPlugin: async () => {
      lifecycle.push('first-start');
      return {
        sources: [{
          id: 'first-source',
          name: 'First source',
          capabilities: { search: true, playback: false, playlist: false },
          async search() { return []; },
        }],
        async close() { lifecycle.push('first-stop'); },
      };
    },
  });
  const second = pluginPackage({
    packageName: 'second-package',
    id: 'second',
    dependencies: [{ id: 'first', version: '1.2.3' }],
    createPlugin: async ({ dependencies }) => {
      assert.equal(Array.isArray(dependencies.first.sources), true);
      lifecycle.push('second-start');
      return {
        sources: [{
          id: 'second-source',
          name: 'Second source',
          capabilities: { search: true, playback: false, playlist: false },
          async search() { return []; },
        }],
        async close() { lifecycle.push('second-stop'); },
      };
    },
  });
  const manager = createManager([second, first]);

  await manager.load();
  assert.deepEqual(lifecycle, ['first-start', 'second-start']);
  assert.deepEqual(manager.getSources().map(({ id }) => id), [
    'first-source',
    'second-source',
  ]);
  assert.equal(manager.listPlugins({ enabledOnly: true }).length, 2);
  await manager.close();
  assert.deepEqual(lifecycle, [
    'first-start',
    'second-start',
    'second-stop',
    'first-stop',
  ]);
});

test('plugin manager rejects duplicate plugin and source ids', async () => {
  const duplicatePlugin = pluginPackage({
    packageName: 'duplicate-package',
    id: 'same-id',
    sourceId: 'other-source',
  });
  const sameId = pluginPackage({
    packageName: 'another-package',
    id: 'same-id',
    sourceId: 'third-source',
  });
  await assert.rejects(createManager([duplicatePlugin, sameId]).load(), /Plugin id/);

  const first = pluginPackage({ packageName: 'first', id: 'first', sourceId: 'shared' });
  const second = pluginPackage({ packageName: 'second', id: 'second', sourceId: 'shared' });
  await assert.rejects(createManager([first, second]).load(), /Source id "shared"/);
});

test('plugin manager rejects unsupported API versions and manifest version mismatches', async () => {
  const wrongApi = pluginPackage({ packageName: 'wrong-api', apiVersion: 99 });
  await assert.rejects(createManager([wrongApi]).load(), /unsupported Melink Plugin API/);

  const wrongVersion = pluginPackage({ packageName: 'wrong-version', version: '1.2.3' });
  wrongVersion.manifest.version = '1.2.4';
  await assert.rejects(createManager([wrongVersion]).load(), /does not match its pinned package/);
});

test('plugin manager rejects missing or mismatched dependencies', async () => {
  const missing = pluginPackage({
    packageName: 'requires-missing',
    id: 'requires-missing',
    dependencies: [{ id: 'missing', version: '1.0.0' }],
  });
  await assert.rejects(createManager([missing]).load(), /requires missing plugin/);

  const dependency = pluginPackage({
    packageName: 'dependency',
    id: 'dependency',
    version: '1.0.0',
  });
  const consumer = pluginPackage({
    packageName: 'consumer',
    id: 'consumer',
    dependencies: [{ id: 'dependency', version: '2.0.0' }],
  });
  await assert.rejects(createManager([dependency, consumer]).load(), /requires "dependency" version/);
});

test('disabled plugins do not start and expose only unavailable source declarations', async () => {
  let started = false;
  const moduleLoads = [];
  let topLevelCodeRuns = 0;
  const entry = pluginPackage({
    packageName: 'disabled-package',
    id: 'disabled-plugin',
    createPlugin: () => {
      started = true;
      return { sources: [] };
    },
  });
  const manager = createManager([entry], {
    disabledPlugins: ['disabled-plugin'],
    moduleLoader: async (spec, options) => {
      moduleLoads.push(options?.loadModule === true);
      if (options?.loadModule === true) topLevelCodeRuns++;
      return {
        packageName: entry.packageName,
        version: entry.version,
        manifest: entry.manifest,
        ...(options?.loadModule === false
          ? {}
          : { pluginModule: { ...entry.pluginModule, manifest: entry.manifest } }),
      };
    },
  });

  await manager.load();
  assert.equal(started, false);
  assert.deepEqual(moduleLoads, [false]);
  assert.equal(topLevelCodeRuns, 0);
  assert.equal(manager.getSources().length, 0);
  assert.equal(manager.getDisabledSources()[0].id, 'disabled-plugin-source');
  assert.equal(manager.listPlugins()[0].enabled, false);
  assert.equal(manager.listPlugins()[0].loaded, false);
  await manager.close();
});

test('plugin factories receive only allowlisted non-secret config unless explicitly opted in', async () => {
  let receivedConfig;
  const entry = pluginPackage({
    packageName: 'config-plugin',
    id: 'config-plugin',
    createPlugin: async ({ config }) => {
      receivedConfig = config;
      return {
        sources: [{
          id: 'config-plugin-source',
          name: 'Fixture source',
          capabilities: { search: true, playback: false, playlist: false },
          async search() { return []; },
        }],
      };
    },
  });
  entry.manifest.configKeys = [
    'logLevel',
    'spotifyClientSecret',
    'youtubeApiKey',
    'token',
  ];
  entry.manifest.secretConfigKeys = ['spotifyClientSecret'];
  entry.pluginModule.manifest = entry.manifest;

  const manager = createManager([entry], {
    config: {
      logLevel: 'debug',
      spotifyClientSecret: 'allowed-secret',
      youtubeApiKey: 'secret-by-default',
      token: 'node-token',
      unlistedValue: 'not-allowed',
    },
  });
  await manager.load();

  assert.deepEqual(receivedConfig, {
    logLevel: 'debug',
    spotifyClientSecret: 'allowed-secret',
  });
  await manager.close();
});

test('plugin module manifest must match package metadata before activation', async () => {
  const entry = pluginPackage({ packageName: 'manifest-mismatch', id: 'manifest-mismatch' });
  const manager = createManager([entry], {
    moduleLoader: async (spec, options) => {
      const loaded = {
        packageName: entry.packageName,
        version: entry.version,
        manifest: entry.manifest,
      };
      if (options?.loadModule !== false) {
        loaded.pluginModule = {
          ...entry.pluginModule,
          manifest: { ...entry.manifest, name: 'Changed after inspection' },
        };
      }
      return loaded;
    },
  });

  await assert.rejects(manager.load(), /failed to initialize/);
});

test('plugin source capability declarations must match implemented methods', async () => {
  const entry = pluginPackage({
    packageName: 'bad-source',
    id: 'bad-source',
    createPlugin: () => ({
      sources: [{
        id: 'bad-source-source',
        name: 'Bad source',
        capabilities: { search: false, playback: false, playlist: false },
        async search() { return []; },
      }],
    }),
  });
  const logger = { error() {} };
  await assert.rejects(createManager([entry], { logger }).load(), /failed to initialize/);
});
