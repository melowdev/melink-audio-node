# Experimental Lavalink v4-style compatibility

Melink implements a limited Lavalink v4-style control plane. The REST and
WebSocket handshake, track loading, Discord voice handoff, and basic Shoukaku
player controls have been exercised with Shoukaku 4.3.0. This does **not** make
Melink a full or drop-in Lavalink replacement: audio playback still depends on
Melink's supported media resolvers, and live Discord/FFmpeg playback has not
been validated by this integration test.

## Supported

| Route | Behavior |
| --- | --- |
| `GET /version` | Returns `4.0.0-melink.0`. |
| `GET /v4/info` | Reports the experimental compatibility version, active Source Manager IDs, loaded plugins, supported standard filters, and Melink-only filters. |
| `GET /v4/stats` | Returns player counts, heap, uptime, and CPU estimates. |
| `GET /v4/loadtracks?identifier=...` | Resolves one track or a supported playlist into a v4 `loadType` / `data` response. |
| `GET /v4/websocket` | Authenticates `Authorization` and `User-Id`; returns Lavalink handshake headers and emits `ready`, `stats`, `playerUpdate`, and supported player events. |
| `PATCH /v4/sessions/{sessionId}` | Enables or disables same-process WebSocket session resumption. |
| `GET /v4/sessions/{sessionId}/players` | Lists players in a session. |
| `GET /v4/sessions/{sessionId}/players/{guildId}` | Reads a player's track, voice, volume, pause, and connection state. |
| `PATCH /v4/sessions/{sessionId}/players/{guildId}` | Applies voice state, plays a supported encoded track or identifier, pauses/resumes, sets volume, seeks seekable tracks, and applies FFmpeg filters. |
| `DELETE /v4/sessions/{sessionId}/players/{guildId}` | Destroys a player. |

Use the configured node token as `Authorization` (raw token or `Bearer`
form). WebSocket clients must also send a 15–22 digit `User-Id` header.
Resumption must be enabled with `{"resuming":true,"timeout":60}` before a
disconnect; the timeout is limited to 600 seconds. Session state is in memory
and does not survive a process restart.

Voice payloads are passed through to Melink's Discord voice adapter. The
node does not establish Discord Gateway connections on behalf of the bot.
Track identifiers and encoded tracks must resolve to media supported by the
configured Melink resolvers.

## Supported audio operations and limitations

The FFmpeg pipeline accepts `volume`, `equalizer`, `timescale`, `karaoke`,
`tremolo`, `vibrato`, `lowPass`, `highPass`, `rotation`, and `channelMix`.
`highPass` is Melink-only; `/v4/info.filters` reports the implemented standard
Lavalink subset and `melinkFilters` reports extensions. Lavalink's `distortion`
filter is not implemented. The current transport does not implement verified
HTTP Range seeking, so resolved tracks are reported as non-seekable.

Playlist loading requires a configured plugin source with playlist capability.
Track end-time limits, server-side queues, the `encodetracks` and `decodetracks`
endpoints, and the full Lavalink plugin/source-manager ecosystem are not
implemented. The encoding endpoints return `501 Not Implemented`. Melink's
independent Source Manager and plugin interfaces do not provide Lavalink plugin
compatibility. Unsupported end-time requests also return `501 Not Implemented`.

The REST/voice protocol and playback have not been tested end-to-end against a
live Discord server, so FFmpeg processing and event behavior still need a real
Discord playback test. YouTube and Spotify catalog results are metadata only;
they cannot be played unless a configured resolver provides an authorized
media stream.

Use the documented Melink `/v1` API when you need its native client contract.
Do not treat this experimental compatibility surface as a general Lavalink
replacement.
