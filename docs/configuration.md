# Configuration

Copy the safe template and provide a fresh token:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Place the generated value in `AUDIO_NODE_TOKEN`. Do not commit `.env` or paste
the token into issues, chat, source code, or logs.

| Variable | Default | Rules |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address passed to the HTTP server's `listen`. |
| `PORT` | `2333` | Positive integer; takes precedence over `SERVER_PORT`. |
| `SERVER_PORT` | `2333` when `PORT` is unset | Positive integer for hosts that inject a port. |
| `AUDIO_NODE_TOKEN` | Required | At least 24 characters; the template value is rejected. |
| `MAX_PLAYERS` | `5` | Positive integer; maximum players per session. |
| `IDLE_TIMEOUT_MS` | `30000` | Positive integer; idle-player cleanup delay in milliseconds. |
| `LOG_LEVEL` | `info` | Reserved; log filtering is not implemented yet. |

Invalid numeric values or a missing/short token stop startup with an error.

## Bot-side settings

The bot needs two values in its secret environment settings:

- `AUDIO_NODE_URL`: public HTTPS origin, for example
  `https://audio.example.net`—no `/healthz` or `/v1` suffix.
- `AUDIO_NODE_TOKEN`: the same node token configured on the Audio Node.

The bot does not need the Audio Node's `HOST`, `PORT`, or server-side `.env`.
