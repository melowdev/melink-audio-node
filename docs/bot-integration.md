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

async function searchAndPlayAvailableSource(guildId, voiceChannelId, query) {
  await audio.join(guildId, voiceChannelId);
  const results = await audio.searchTracks(query, { limit: 10 });
  const match = results.tracks.find((track) => track.playable);
  if (!match) throw new Error('No playable result was found');
  const loaded = await audio.loadTracks(match.info.uri || match.info.identifier);
  await audio.play(guildId, loaded.tracks[0]);
}

async function searchAndPlaySoundCloud(guildId, voiceChannelId, query) {
  await audio.join(guildId, voiceChannelId);
  const results = await audio.searchTracks('soundcloud', query);
  const match = results.tracks.find((track) => track.playable);
  if (!match) throw new Error('No authorized SoundCloud stream was found');
  const loaded = await audio.loadTracks(match.info.uri);
  await audio.play(guildId, loaded.tracks[0]);
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

## Search and playback limits

Use `searchTracks(query)` to aggregate all eligible, configured search sources,
or `searchTracks(source, query)` to select one source. The response includes
per-source success/count details and isolated errors. Always select a result
marked `playable`; YouTube and Spotify results are metadata only and cannot be
played. SoundCloud results are playable only when its official API authorizes a
stream. Radio Browser plugin results are station streams, not individual songs.
Resolve a playable result through `loadTracks(match.info.uri ||
match.info.identifier)` before passing it to `play()`. Direct HTTP(S) media URLs
remain supported.

Use the [API reference](api.md) for protocol details. Do not log or expose the
node token, session token, or signed media URL query strings.

## Hosting requirements

The Audio Node host—not just the bot host—must keep the process running, allow
outbound UDP to Discord voice, and provide FFmpeg with the `libopus` encoder.
If the VDS provider blocks outbound UDP or prevents FFmpeg/libopus from running,
the bot can connect and report a track as playing while the voice channel stays
silent. An open HTTP API port and a successful `/healthz` response do not test
audio playback. The bot host must also stay online and reach the Audio Node's
HTTPS/WebSocket API and the Discord Gateway.
