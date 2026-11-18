# Source plugins

The Source Manager separates catalog search, playback resolution, and playlist
resolution. Plugin source IDs are globally unique, and every declared
capability must match the methods returned by the plugin factory.

Install an explicitly trusted package at an exact version and list the same
pin in the node configuration:

```powershell
npm install melink-source-example@1.0.0
```

```env
AUDIO_NODE_PLUGINS=melink-source-example@1.0.0
```

The installed package version, manifest version, and requested pin must match.
To allow disabled plugins to be skipped without importing their code, duplicate
the manifest in the package's `package.json` under `melinkAudioNode`. It must
match the module's exported manifest. The exported manifest uses Melink Plugin
API version `1`:

```js
export const manifest = {
  id: 'example-source',
  name: 'Example Source',
  version: '1.0.0',
  apiVersion: 1,
  dependencies: [],
  configKeys: ['logLevel'],
  secretConfigKeys: [],
  sources: [{
    id: 'example',
    name: 'Example',
    capabilities: {
      search: true,
      playback: true,
      playlist: false,
      catalog: false,
      metadata: false,
    },
  }],
};

export async function createPlugin({ apiVersion, config, dependencies, logger }) {
  if (apiVersion !== 1) throw new Error('Unsupported Melink Plugin API');

  return {
    sources: [{
      id: 'example',
      name: 'Example',
      capabilities: {
        search: true,
        playback: true,
        playlist: false,
        catalog: false,
        metadata: false,
      },
      async search({ query, limit, signal }) {
        // Pass signal to outbound requests and stop work when it is aborted.
        return [];
      },
      supportsIdentifier(identifier) {
        return identifier.startsWith('example:');
      },
      async resolve({ identifier, signal }) {
        // Pass signal to outbound requests and stop work when it is aborted.
        return {
          uri: 'https://media.example.net/authorized-audio.ogg',
          identifier,
          title: 'Example track',
          author: 'Example artist',
          length: 60_000,
          isStream: false,
        };
      },
    }],
    async close() {
      // Release resources created by this plugin.
    },
  };
}
```

The package metadata must include the same manifest:

```json
{
  "melinkAudioNode": {
    "id": "example-source",
    "name": "Example Source",
    "version": "1.0.0",
    "apiVersion": 1,
    "dependencies": [],
    "configKeys": ["logLevel"],
    "secretConfigKeys": [],
    "sources": [{
      "id": "example",
      "name": "Example",
      "capabilities": {
        "search": true,
        "playback": true,
        "playlist": false,
        "catalog": false,
        "metadata": false
      }
    }]
  }
}
```

Only keys listed in `configKeys` are passed to a plugin. Keys matching token,
secret, password, API-key, or credential patterns are omitted unless explicitly
listed in `secretConfigKeys`; the node token is never passed. Keep this
allowlist minimal.

Capability methods are:

- `search({ query, limit, signal })` returns an array of track-shaped
  `{ playable, info }` results.
- `supportsIdentifier(identifier)` and `resolve({ identifier, signal })`
  implement playback. `resolve` must return an HTTP(S) `uri` and track
  metadata; Melink applies its normal URL validation.
- `supportsPlaylistIdentifier(identifier)` and
  `resolvePlaylist({ identifier, signal })` implement playlist loading.
  `resolvePlaylist` returns `{ name, tracks, selectedTrack }`, with `tracks`
  in the same resolver-result format. Loadtracks preserves order and metadata.
- `resolveCatalog({ identifier, signal })` and
  `getMetadata({ identifier, signal })` implement the separately declared
  catalog-resolution and metadata capabilities. They are exposed through the
  session `/catalog` and `/metadata` routes; return only public metadata.

Declare a capability as `false` and omit its method when it is not implemented.
The manager rejects extra or missing methods, undeclared sources, duplicate
source IDs, dependency/version mismatches, dependency cycles, and unsupported
plugin API versions. Dependencies activate before dependents and their active
instances are available through the factory's `dependencies` object.
Capability flags in the source inventory describe loaded implementations and
are reported separately from whether the source is enabled or configured.

Use `AUDIO_NODE_DISABLED_PLUGINS` with plugin IDs or exact package names to
skip plugin loading, and `AUDIO_NODE_DISABLED_SOURCES` with source IDs to
disable individual sources. Disabled plugin modules are not imported.
`AbortSignal` is provided to provider operations; plugins must pass it through
to outbound requests and release resources when aborted. Runtime hot reload is
not supported. Plugin shutdown hooks run in reverse activation order.
Plugins run in the node's process with its operating-system permissions and
environment access. There is no plugin sandbox; only install packages you
trust. Source `startupHealthy` reports initialization state, while `healthy`
reflects the most recent completed provider operation.
Resolver metadata cannot opt a track into seeking. The current FFmpeg pipeline
reads media through a non-seekable pipe and does not perform verified HTTP
Range-based seeking; Melink therefore reports resolved tracks as non-seekable
until that transport is implemented.

Plugins execute in the node process with its operating-system permissions and
environment access; exact version pinning does not sandbox or audit package
code. Configure only packages you trust, keep factory/module initialization
free of side effects, and do not log credentials or signed stream URLs.
Playback still goes through Melink's HTTP(S) URL and public-address checks.
`GET /v1/sources` reports source state without returning configuration values
or stream URLs. Capability fields indicate methods implemented by loaded
providers, not merely manifest declarations.
