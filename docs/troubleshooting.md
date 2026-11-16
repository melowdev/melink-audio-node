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

## Track loading returns `400`

`loadTracks()` accepts a direct HTTP(S) URL, not a search phrase or platform
watch page. The host must resolve to public IP addresses and the media response
must be reachable by the node.

## Unauthorized response

Use the node token only for `POST /v1/sessions` and `GET /v1/stats`. Use the
session token returned by the node for session/player operations. Check that
the `Authorization` header is `Bearer <token>` and that no URL path suffix was
added to `AUDIO_NODE_URL`.

## Bot cannot join or stops receiving voice updates

The host must permit outbound UDP and keep the process alive. Reconnect the bot
session after node restarts; sessions are in memory and are not restored.

## Lavalink errors

This project is not Lavalink and does not receive Lavalink protocol requests.
If a bot keeps Lavalink connected for search or unsupported sources, Lavalink
errors are separate from this node's REST/voice pipeline.

## Still stuck?

Open an issue with Node.js version, deployment type, sanitized logs, and the
minimal steps to reproduce. Never attach `.env`, tokens, session credentials,
or private/signed URLs.
