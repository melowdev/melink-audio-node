# Resolver plugin example

This private package is a starting point for a Melink Audio Node resolver
plugin. It demonstrates the versioned factory contract; its example media URL
is a placeholder and must be replaced with a URL you are authorized to stream.

From the repository root, install the example package into the node project:

```powershell
npm install .\examples\resolver-plugin
```

Then set:

```env
AUDIO_NODE_RESOLVERS=melink-resolver-example@0.1.0
```

The node validates the exported resolver's `apiVersion`, `name`,
`supports(identifier)`, and `resolve(identifier)` members at startup. Plugins
run in the node's process and must be trusted.
