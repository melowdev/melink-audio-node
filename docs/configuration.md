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
| `LOG_LEVEL` | `info` | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |
| `AUDIO_NODE_RESOLVERS` | Empty | Legacy resolver packages pinned as `package@x.y.z`. |
| `AUDIO_NODE_PLUGINS` | Empty | Trusted source-plugin npm packages pinned as `package@x.y.z`; see the [plugin guide](plugins.md). |
| `AUDIO_NODE_DISABLED_PLUGINS` | Empty | Comma-separated plugin IDs or package names to disable. |
| `AUDIO_NODE_DISABLED_SOURCES` | Empty | Comma-separated source IDs to disable. |
| `HTTP_ENABLED` | `true` | Enables direct HTTP(S) URL playback. |
| `SOUNDCLOUD_ENABLED` | `false` | Enables SoundCloud search and playback; when `true`, `SOUNDCLOUD_CLIENT_ID` is required. |
| `SPOTIFY_ENABLED` | `true` | Enables Spotify catalog search when credentials are configured. |
| `YOUTUBE_ENABLED` | `true` | Enables YouTube metadata search when an API key is configured. |
| `SOURCE_REQUEST_TIMEOUT_MS` | `10000` | Timeout for a source provider operation. |
| `SOURCE_RETRIES` | `1` | Additional attempts for transient source failures; bounded to 0–3. |
| `SOURCE_FALLBACK_ENABLED` | `false` | Try another matching playback source after eligible provider errors. |
| `YOUTUBE_API_KEY` | Empty | YouTube Data API v3 key; enables YouTube metadata search only. |
| `SPOTIFY_CLIENT_ID` | Empty | Spotify Web API client-credentials ID; required with the client secret. |
| `SPOTIFY_CLIENT_SECRET` | Empty | Spotify Web API client-credentials secret; required with the client ID. |
| `SOUNDCLOUD_CLIENT_ID` | Empty | SoundCloud API application ID; enables official search and authorized stream resolution. |
| `SOUNDCLOUD_OAUTH_TOKEN` | Empty | Optional SoundCloud OAuth token for API calls requiring user authorization. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Positive integer; fixed-window duration in milliseconds. |
| `SESSION_CREATE_LIMIT` | `10` | Maximum session-creation requests per HTTP peer address per window. |
| `SESSION_REQUEST_LIMIT` | `120` | Maximum authenticated REST requests per session per window. |

Invalid numeric values or a missing/short token stop startup with an error.
Source enable flags must be `true` or `false`. SoundCloud is off by default;
enabling it without a Client ID stops startup with a clear configuration error.
The SoundCloud OAuth token remains optional, as before. Provider toggles only
affect their matching built-in source. Plugin sources, including Radio Browser,
continue to use `AUDIO_NODE_DISABLED_SOURCES`; that list overrides the
corresponding built-in toggle if both are set.
The unauthenticated `GET /healthz` endpoint is not rate-limited. Resolver
plugins execute in the node process and must be treated as trusted code; see
the [source plugin guide](plugins.md) and [legacy resolver guide](resolvers.md).
Provider credentials are never required for startup. Search requests to a
provider without credentials return `503`; YouTube and Spotify return metadata
only, while SoundCloud playback is limited to streams its official API
authorizes. See the [API reference](api.md#search-provider-catalogs).
The peer address is the direct TCP connection address; behind a reverse proxy,
all proxied requests may share the proxy's address. The service does not trust
forwarded-IP headers. `/metrics` requires the node token; keep the endpoint
available only to trusted monitoring clients.

## Bot-side settings

The bot needs two values in its secret environment settings:

- `AUDIO_NODE_URL`: public HTTPS origin, for example
  `https://audio.example.net`—no `/healthz` or `/v1` suffix.
- `AUDIO_NODE_TOKEN`: the same node token configured on the Audio Node.

The bot does not need the Audio Node's `HOST`, `PORT`, or server-side `.env`.
