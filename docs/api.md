# API reference

All paths are relative to the Audio Node origin. Send JSON with
`Content-Type: application/json`. REST credentials use the
`Authorization: Bearer <token>` header.

## Authentication model

1. Use the **node token** to create a session or read node stats.
2. Keep the returned **session token** private to that bot process.
3. Use the session token for session, loadtracks, and player REST routes.
4. Authenticate the WebSocket with the session ID and session token in its
   first JSON packet.

The public health endpoint is the only unauthenticated REST route.

## Health

`GET /healthz`

```json
{ "status": "ok" }
```

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

## Load a direct media URL

`POST /v1/sessions/{sessionId}/loadtracks` — session token

```json
{ "identifier": "https://cdn.example.net/audio.mp3" }
```

Returns a single direct track:

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

Search terms, non-HTTP(S) schemes, embedded URL credentials, and media hosts
that resolve to non-public addresses are rejected. Redirect destinations are
validated too. The URL must still point to media FFmpeg can decode.

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
- `GET` returns a player snapshot.
- `DELETE` destroys the player and its voice connection.

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

Player events include `TrackStartEvent`, `TrackEndEvent`, `PlayerErrorEvent`,
`VoiceStateEvent`, `PlayerUpdateEvent`, and `PlayerClosedEvent`.

## Errors

Responses are JSON objects with an `error` field. Common statuses are `400`
(invalid request or player operation), `401` (missing/invalid token), `404`
(unknown route/player), `413` (request body too large), and `429` (session
player limit reached).
