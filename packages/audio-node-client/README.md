# melink-audio-node-client

The ESM client SDK for connecting a discord.js v14 bot to a Melink Audio Node.
It handles session creation, WebSocket authentication, Discord voice adapter
payloads, and player REST calls.

```bash
npm install melink-audio-node-client
```

## Requirements

- Node.js 20.11 or newer.
- discord.js 14 in the bot project.
- A running Melink Audio Node endpoint using HTTPS in production.

## Basic use

```js
import { AudioNodeClient } from 'melink-audio-node-client';

const audio = new AudioNodeClient({
  baseUrl: process.env.AUDIO_NODE_URL,
  token: process.env.AUDIO_NODE_TOKEN,
  discordClient: client,
});

audio.on('error', (error) => console.error('Audio Node:', error.message));
audio.on('TrackStartEvent', ({ guildId, track }) => {
  console.log(`Started ${track.title} in ${guildId}`);
});

await audio.connect();
await audio.join(guildId, voiceChannelId);
const loaded = await audio.loadTracks('https://cdn.example.net/audio.mp3');
await audio.play(guildId, loaded.tracks[0]);

// On graceful bot shutdown:
await audio.destroy();
```

`AUDIO_NODE_URL` is the origin only, without `/v1` or `/healthz`.
`AUDIO_NODE_TOKEN` must match the node's secret token. The server accepts
direct HTTP(S) media URLs and provides configured catalog search through
`searchTracks()`. Use `searchTracks(query)` to aggregate results from all
eligible configured search sources, or `searchTracks(source, query)` to retain
the legacy single-source behavior. YouTube and Spotify results are metadata
only; SoundCloud results are playable only when its official API authorizes a
stream. Plugin sources can provide their own search and playback capabilities.

## Client methods

- `connect()`
- `join(guildId, channelId, options?)`
- `searchTracks(query, options?)`
- `searchTracks(source, query, options?)`
- `loadTracks(identifier)`
- `play(guildId, track)`
- `pause(guildId, paused?)`
- `stop(guildId)`
- `leave(guildId)`
- `destroy()`

The complete protocol is documented in the repository's
[API reference](../../docs/api.md).

## Reconnect behavior

After an authenticated WebSocket disconnect, the SDK retries the same session
with exponential backoff (250 ms up to 10 seconds, at most eight attempts).
Listen for `disconnect`, `reconnecting`, `reconnect`, `reconnectAttemptFailed`,
and `reconnectFailed` events. This resumes only while the Audio Node process
still holds the session; it does not restore players after a node restart.
Calling `destroy()` cancels pending reconnects.

## License

Dual-licensed under GNU GPL v3.0-only OR GNU AGPL v3.0-only, at the
recipient's choice. The complete license texts are included as
[`LICENSE-GPL-3.0`](LICENSE-GPL-3.0) and
[`LICENSE-AGPL-3.0`](LICENSE-AGPL-3.0). The previously published npm version
`0.1.0` remains GPL-3.0-only; the dual-license metadata is prepared for
`0.1.1`, which has not been published.
