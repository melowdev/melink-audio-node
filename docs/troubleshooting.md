# Troubleshooting

## `AUDIO_NODE_TOKEN` startup error

Set a random token of at least 24 characters in the node's environment. The
same node token belongs in the bot's secret settings. Do not confuse it with
the session token returned after `connect()`.

## `EADDRINUSE`

Another process is already listening on the configured port. Stop the duplicate
process or use the port assigned by the hosting provider. Check whether
`PORT` overrides `SERVER_PORT`.

## Health check succeeds but playback does not

`/healthz` confirms only that the HTTP server answers. Check the node logs for
FFmpeg startup errors, ensure `ffmpeg-static` installed its binary or that
system FFmpeg is on `PATH`, confirm the binary includes the `libopus` encoder, and
verify that the bot receives `VoiceStateEvent` and `TrackStartEvent`.
The Audio Node VDS must also allow outbound UDP to Discord voice and keep the
process running. A provider that blocks UDP or FFmpeg/libopus can leave the bot
connected with no audible audio; opening the HTTP API port is not sufficient.

## Track loading returns `400`

`loadTracks()` accepts a direct HTTP(S) URL or an authorized SoundCloud track
URL, not a search phrase. Use `searchTracks(query)` to aggregate eligible
configured catalogs, or `searchTracks(source, query)` for one provider. Check
the aggregate response's `sources` and `errors` to see which providers were
queried. YouTube and Spotify results are metadata only and cannot be played by
this node; Radio Browser returns stations rather than individual songs. The
host must resolve to public IP addresses and the media response must be
reachable by the node.

## Unauthorized response

Use the node token only for `POST /v1/sessions` and `GET /v1/stats`. Use the
session token returned by the node for session/player operations. Check that
the `Authorization` header is `Bearer <token>` and that no URL path suffix was
added to `AUDIO_NODE_URL`.

## Bot cannot join or stops receiving voice updates

The host must permit outbound UDP and keep the process alive. Reconnect the bot
session after node restarts; sessions are in memory and are not restored.

## Lavalink errors

Melink implements only a limited experimental Lavalink v4-style control plane.
Check the [compatibility guide](lavalink-compat.md) for supported operations
and known gaps. Non-empty filters, seeking, and track end-time limits return
`501`; live Discord/FFmpeg playback through a Lavalink client has not been
validated.

## Still stuck?

Open an issue with Node.js version, deployment type, sanitized logs, and the
minimal steps to reproduce. Never attach `.env`, tokens, session credentials,
or private/signed URLs.
