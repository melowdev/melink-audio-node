# Bot integration

The optional published package `melink-audio-node-client` bridges the REST and
WebSocket protocol to a discord.js v14 bot. Install it in the bot project:

```bash
npm install melink-audio-node-client
```

## ESM bot

```js
import { AudioNodeClient } from 'melink-audio-node-client';

const audio = new AudioNodeClient({
  baseUrl: process.env.AUDIO_NODE_URL,
  token: process.env.AUDIO_NODE_TOKEN,
  discordClient: client,
});

audio.on('TrackStartEvent', ({ guildId, track }) => {
  console.info(`Started ${track.title} in ${guildId}`);
});
audio.on('TrackEndEvent', ({ guildId, track }) => {
  console.info(`Finished ${track.title} in ${guildId}`);
});
audio.on('error', (error) => {
  console.error('Audio Node client error:', error.message);
});

client.once('ready', async () => {
  await audio.connect();
});

async function playDirectUrl(guildId, voiceChannelId, mediaUrl) {
  await audio.join(guildId, voiceChannelId);
  const result = await audio.loadTracks(mediaUrl);
  await audio.play(guildId, result.tracks[0]);
}

async function shutdown() {
  await audio.destroy();
}
```

Call `shutdown()` during the bot's graceful shutdown so the node can release
the session and player resources.

## CommonJS bot

The package is ESM. A CommonJS bot can load it with dynamic import:

```js
async function createAudioClient(options) {
  const { AudioNodeClient } = await import('melink-audio-node-client');
  return new AudioNodeClient(options);
}
```

## Routing strategy

The current node only accepts direct HTTP(S) media URLs. A bot may route those
URLs to this client while keeping catalog search and unsupported sources on an
existing backend. Do not route a YouTube or Spotify page URL to
`loadTracks()`—the node does not extract those platforms.

Use the [API reference](api.md) for protocol details. Do not log or expose the
node token, session token, or signed media URL query strings.
