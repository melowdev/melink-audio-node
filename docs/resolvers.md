# Resolver plugins

The node includes resolvers for direct HTTP(S) media URLs and SoundCloud tracks
that the official API authorizes. Additional legacy
resolvers can be installed as trusted npm packages and listed in
`AUDIO_NODE_RESOLVERS`, separated by commas. Every package must use an exact
version pin:

```env
AUDIO_NODE_RESOLVERS=melink-resolver-example@1.0.0,@my-org/melink-resolver-catalog@2.3.1
```

Each package must export a `createResolver({ apiVersion })` factory returning
an object with `apiVersion: 1`, a unique `name`, `supports(identifier)`, and
`resolve(identifier)`:

```js
export function createResolver({ apiVersion }) {
  return {
    apiVersion,
    name: 'example',
    supports(identifier) {
      return identifier.startsWith('example:');
    },
    async resolve(identifier) {
      return {
        uri: 'https://media.example.net/audio.ogg',
        identifier,
        title: 'Example track',
        author: 'Example artist',
        length: 0,
        isSeekable: false,
        isStream: true,
      };
    },
  };
}
```

The factory receives the node-supported API version. The registry rejects
plugins that return a different or missing `apiVersion`, so incompatible
plugins fail explicitly during startup rather than being used accidentally.

Configured plugins are checked first, followed by the built-in SoundCloud
resolver and the direct HTTP(S) resolver. The first resolver whose
`supports()` returns `true` handles the identifier. A resolver result must contain an
HTTP(S) `uri`; the core validates URL syntax and credentials, then performs
public-address and redirect checks when opening the stream. A resolver error
is returned to the caller; the registry does not silently skip a failing
resolver and try another one.

Resolver `isSeekable` metadata is not trusted. The FFmpeg pipeline currently
reads through a non-seekable pipe and does not implement verified HTTP Range
seeking, so normalized tracks are reported as non-seekable.

Resolver packages run inside the node process with the node's operating-system
permissions and access to its environment. Install only packages you trust.
The plugin interface does not itself grant permission to access or redistribute
media; operators remain responsible for source terms and content rights.

Legacy resolvers are adapted into the Source Manager as playback providers.
New extensions should use the capability-aware manifest and lifecycle contract
in the [source plugin guide](plugins.md).

The node also provides official metadata search for YouTube and Spotify, but
does not extract their audio streams. SoundCloud playback uses only stream URLs
provided by its official API. Plugins should not log credentials or signed
media URLs.
The [example plugin](../examples/resolver-plugin/README.md) provides a
testable package template; replace its placeholder URL with a source you are
authorized to stream.
