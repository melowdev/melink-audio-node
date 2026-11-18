# API reference

All paths are relative to the Audio Node origin. Send JSON with
`Content-Type: application/json`. REST credentials use the
`Authorization: Bearer <token>` header.
Responses include an `x-request-id` for log correlation. See the machine-readable
[OpenAPI schema](openapi.json) for the current REST contract.

## Authentication model

1. Use the **node token** to create a session or read node stats/source inventory.
2. Keep the returned **session token** private to that bot process.
3. Use the session token for session, search, loadtracks, and player REST routes.
4. Authenticate the WebSocket with the session ID and session token in its
   first JSON packet.

`GET /healthz`, `GET /readyz`, and `GET /version` are unauthenticated.
`GET /metrics` requires the node token.
Session creation is limited by the direct HTTP peer address; authenticated
REST requests are limited per session. `GET /healthz` is exempt. A `429` response includes a
`Retry-After` header and the rate-limit headers `RateLimit-Limit`,
`RateLimit-Remaining`, and `RateLimit-Reset`.

## Health

`GET /healthz`

```json
{ "status": "ok" }
```

`GET /readyz` returns `{"status":"ready"}` when the HTTP listener is ready.
`GET /metrics` returns Prometheus text format and requires the node token.
See the [Lavalink compatibility guide](lavalink-compat.md) for experimental
`/version` and `/v4/*` routes.

## Create a session

`POST /v1/sessions` — node token

```json
{ "clientName": "my-discord-bot" }
```

Returns `201`:

```json
{
  "sessionId": "session-uuid",
  "sessionToken": "session-secret",
  "websocketUrl": "/v1/ws"
}
```

`clientName` is optional and truncated to 100 characters.

## Stats

`GET /v1/stats` — node token. Returns session/player counts, process uptime,
and Node.js memory-usage fields (bytes).

## Source inventory

`GET /v1/sources` — node token. Returns the source ID, provider name,
`loaded`/`enabled`/`configured` state, startup and runtime health, recent
success/failure timestamps, and search/playback/playlist plus catalog/metadata
capabilities. Capability flags report implemented methods independently from
enabled/configured state. Disabled plugin sources expose declared capabilities
separately without claiming the methods are loaded. Credentials and signed
stream URLs are never included.

```json
{
  "sources": [{
    "id": "soundcloud",
    "name": "soundcloud",
    "pluginId": null,
    "loaded": true,
    "enabled": true,
    "configured": false,
    "startupHealthy": true,
    "healthy": true,
    "consecutiveFailures": 0,
    "lastSuccessAt": null,
    "lastFailureAt": null,
    "searchSupported": true,
    "playbackSupported": true,
    "playlistSupported": false
  }]
}
```

`GET /v4/info` derives `sourceManagers` and `plugins` from the active registries.
`filters` lists implemented standard Lavalink filters;
`melinkFilters` lists Melink-specific extensions.

## Load a direct media URL

`POST /v1/sessions/{sessionId}/loadtracks` — session token

```json
{ "identifier": "https://cdn.example.net/audio.mp3" }
```

Returns one resolved track, or an ordered playlist when a loaded source
recognizes the identifier as a playlist:

```json
{
  "loadType": "track",
  "tracks": [{
    "encoded": "base64url-track-payload",
    "info": {
      "identifier": "https://cdn.example.net/audio.mp3",
      "title": "audio",
      "author": "",
      "length": 0,
      "uri": "https://cdn.example.net/audio.mp3",
      "sourceName": "direct",
      "isSeekable": false,
      "isStream": true
    }
  }]
}
```

Playlist response example:

```json
{
  "loadType": "playlist",
  "playlistInfo": { "name": "Playlist name", "selectedTrack": 0 },
  "tracks": [{ "encoded": "...", "info": { "title": "First track" } }]
}
```

An optional `source` field forces playlist resolution through a configured
playlist provider. Without it, the Source Manager selects an eligible provider
or falls back to one-track resolution.

Configured resolver plugins and the built-in SoundCloud resolver can accept
identifiers in addition to direct HTTP(S) URLs. SoundCloud URLs require
configured API credentials and an officially authorized stream. If no
resolver accepts the identifier, non-HTTP(S) values and embedded URL
credentials are rejected by the built-in direct resolver. When playback opens
the resolved stream, the core rejects media hosts and redirect destinations
that resolve to non-public addresses. The resolved URL must still point to
media FFmpeg can decode.

## Search provider catalogs

`POST /v1/sessions/{sessionId}/search` — session token

```json
{ "query": "ambient music", "limit": 10 }
```

Omit `source` to search all loaded, enabled, configured sources that implement
search. They are queried in parallel. One provider failure does not discard
other results; each attempted provider is listed in `sources`, and failures
also appear in `errors`. `total` is the number of unique results before the
overall `limit` is applied. Each provider's `count` is its result count before
cross-provider deduplication. If every provider fails, the endpoint still
returns a structured `200` response with an empty `tracks` array and errors.

The optional `limit` must be an integer from 1 to 10 and applies to the merged
result list as well as each provider request. Without `source`, `query` must
contain 1–200 characters. For backward compatibility, a request may include
`source` to search only that provider; the response retains the original
`loadType`, `source`, and `tracks` shape:

```json
{ "source": "soundcloud", "query": "ambient music" }
```

`source` may be a built-in ID (`youtube`, `spotify`, or `soundcloud`) or a
configured plugin source ID with search capability. The aggregated response
shape is:

```json
{
  "loadType": "search",
  "query": "ambient music",
  "total": 0,
  "tracks": [],
  "sources": [
    { "source": "youtube", "success": true, "count": 0 },
    { "source": "spotify", "success": false, "count": 0 }
  ],
  "errors": [
    {
      "source": "spotify",
      "message": "Source \"spotify\" failed to search",
      "statusCode": 503
    }
  ],
  "successfulSources": 1,
  "failedSources": 1
}
```

The values above illustrate the response shape; results and provider status
come from the configured sources at request time. Sources that are disabled,
unconfigured, or lack search capability are not queried or counted.

Results are deduplicated by canonical identifier and, for non-stream tracks,
by matching normalized title, artist, and duration. Version-labelled tracks
(for example remixes, covers, and live recordings) are kept separate.

YouTube and Spotify use their official APIs for search metadata only. Their
results are always `playable: false`; those APIs do not provide audio stream
URLs. SoundCloud results are marked playable only when the official API reports
an authorized stream. Radio Browser plugin results are playable station streams,
not individual song tracks. A result is playable only when its source declares
playback support and marks that result playable. Pass a playable result's
`info.identifier` to `loadtracks` to resolve it before playback. Provider API
credentials are optional server settings; an unconfigured provider is skipped
by aggregated search and returns `503` for an explicit source request.

This native search route does not change Lavalink compatibility routes. The
experimental `/v4/loadtracks` route continues to resolve supported identifiers;
it does not advertise an unsupported catalog-search prefix.

## Catalog resolution and metadata

`POST /v1/sessions/{sessionId}/catalog` and
`POST /v1/sessions/{sessionId}/metadata` require a session token and accept
`{ "source": "example", "identifier": "example:item/123" }`. The source must
implement the corresponding capability. Providers must return public metadata
only—never credentials or signed stream URLs.

## Player routes

All player routes require a session token and use a 15–22 digit Discord guild
ID in `{guildId}`.

### Join a voice channel

`POST /v1/sessions/{sessionId}/players/{guildId}`

```json
{
  "op": "join",
  "channelId": "12345678901234567",
  "selfDeaf": true,
  "selfMute": false
}
```

`channelId` is required; the two voice flags are optional.

### Play

`PATCH /v1/sessions/{sessionId}/players/{guildId}`

```json
{ "op": "play", "track": { "encoded": "...", "info": { "title": "..." } } }
```

### Pause or resume

`PATCH /v1/sessions/{sessionId}/players/{guildId}`

```json
{ "op": "pause", "paused": true }
```

Set `paused` to `false` to resume.

### Stop, inspect, leave

- `POST` with `{ "op": "stop" }` stops the current track but retains the player.
- `PATCH` with `{ "op": "seek", "position": 30000 }` returns an explicit
  unsupported-source error. The current pipeline has no verified ranged seek
  transport; resolved tracks are not marked seekable.
- `PATCH` with `{ "op": "volume", "volume": 75 }` applies volume to audio output.
- `PATCH` with `{ "op": "filters", "filters": { "timescale": { "speed": 1.1 } } }`
  applies validated FFmpeg filters. Updating filters during playback restarts
  the stream at its current position; non-seekable tracks reject live updates.
- `GET` returns a player snapshot.
- `DELETE` destroys the player and its voice connection.

The FFmpeg pipeline accepts `volume`, `equalizer`, `timescale`, `karaoke`,
`tremolo`, `vibrato`, `lowPass`, `highPass`, `rotation`, and `channelMix`.
`highPass` is a Melink-specific extension; it is listed separately from standard
Lavalink filters. Omitted values use the defaults below. Invalid names, shapes,
and values return `400`.

| Filter | Parameters, defaults, and limits |
| --- | --- |
| `volume` | `0`–`5`; omitted means unchanged (unity). |
| `equalizer` | Up to 15 unique `{ band, gain }` entries; `band` is `0`–`14`, `gain` is `-0.25`–`1` (mapped to -3–12 dB). Empty list disables it. |
| `timescale` | `speed`, `pitch`, `rate`: each `0.01`–`5`, default `1`. |
| `karaoke` | `level` and `monoLevel`: `0`–`1`, default `1`; `filterBand`: `0`–`20000` Hz, default `220`; `filterWidth`: `0`–`20000` Hz, default `100`. |
| `tremolo` | `frequency`: `0.1`–`20` Hz, default `2`; `depth`: `0`–`1`, default `0.5`. |
| `vibrato` | `frequency`: `0.1`–`14` Hz, default `2`; `depth`: `0`–`1`, default `0.5`. |
| `lowPass`, `highPass` | `smoothing`: `0`–`20000` Hz, default `20`; values below `20` are clamped to `20`. |
| `rotation` | `rotationHz`: `0`–`10`, default `0` (zero disables the effect). |
| `channelMix` | `leftToLeft`, `leftToRight`, `rightToLeft`, `rightToRight`: each `-2`–`2`; defaults are identity routing (`1, 0, 0, 1`). |

## Delete a session

`DELETE /v1/sessions/{sessionId}` — session token. The session's players and
WebSocket are closed.

## WebSocket protocol

Connect to `/v1/ws`, then authenticate within five seconds:

```json
{
  "op": "authenticate",
  "sessionId": "session-uuid",
  "sessionToken": "session-secret"
}
```

The server replies with `{ "op": "ready", "sessionId": "..." }`.

The SDK relays Discord voice adapter updates as:

```json
{ "op": "voice:update", "guildId": "12345678901234567", "event": "state", "data": {} }
```

`event` is `state` or `server`. The server sends `voice:payload` packets back
to the bot adapter.

Player events include `TrackStartEvent`, `TrackEndEvent`, `TrackExceptionEvent`,
`TrackStuckEvent`, `WebSocketClosedEvent`, `PlayerErrorEvent`,
`VoiceStateEvent`, `PlayerUpdateEvent`, and `PlayerClosedEvent`.

## Errors

Responses are JSON objects with an `error` field. Common statuses are `400`
(invalid request or player operation), `401` (missing/invalid token), `404`
(unknown route/player), `413` (request body too large), and `429` (rate limit
or session player limit reached). Rate-limit responses include `Retry-After`
and `RateLimit-*` headers.
