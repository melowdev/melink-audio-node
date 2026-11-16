# Deployment

## Host requirements

The API is HTTP/WebSocket, while Discord voice also requires a persistent
process and outbound UDP. A web host that sleeps the process or blocks outbound
UDP is not suitable. Put the API behind TLS and restrict access to trusted
clients.

The audio path requires FFmpeg with the `libopus` encoder. The node uses the
`ffmpeg-static` binary when installed; if it is unavailable, it looks for
`ffmpeg` on `PATH`. The node sends Ogg/Opus to Discord; FFmpeg performs the
encoding, so playback does not depend on a Node-native PCM-to-Opus encoder.

## Node.js deployment

1. Deploy the repository to a Node.js host with Node.js 22.12 or newer.
2. Set `AUDIO_NODE_TOKEN` and any host-specific settings in the host's secret
   environment panel.
3. Use `npm ci` for a lockfile-based install.
4. Start with `npm start` (`node src/server.js`).
5. Configure the provider's port through `PORT` or `SERVER_PORT`.
6. Confirm `GET /healthz` returns `200` and `{"status":"ok"}`.
7. Test a real, authorized direct media URL and verify the bot receives
   `TrackStartEvent`.

Health only confirms the HTTP process is responding. It does not validate
Discord voice connectivity, FFmpeg's Opus encoder, or a particular media URL.

## Docker

Build and run:

```powershell
docker build -t melink-audio-node .
docker run --name melink-audio-node --restart unless-stopped `
  --env-file .env -p 2333:2333 melink-audio-node
```

The image exposes the HTTP API port. Ensure the container host permits the
outbound UDP traffic needed for Discord voice. Do not bake `.env` into an image.

## Reverse proxy

Terminate TLS at a trusted reverse proxy and forward both HTTP and WebSocket
traffic to the node. Preserve the `Upgrade` and `Connection` headers for
`/v1/ws`, configure reasonable timeouts, and do not cache authenticated API
responses.

## Provider-specific hosting

Providers often assign a port dynamically. Set `SERVER_PORT` or `PORT` to the
provider's assigned value; `PORT` wins when both are present. Keep the public
base URL and secret token in the bot's environment, not in command source.

## Shutdown and state

The process closes its HTTP server and session players on `SIGINT` and
`SIGTERM`. Sessions are in memory, so a restart ends all active players and
clients must create new sessions after reconnecting.
