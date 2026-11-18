# Live Discord playback validation

This is an opt-in integration harness for a dedicated Discord test bot, test
guild, and test Audio Node. It does not change the production configuration.
The harness reads environment variables directly; it does not load `.env` and
never prints token values, raw API errors, media URLs, or voice payloads.

## Requirements

- Node.js 22.12 or newer and a running Melink Audio Node.
- `discord.js` 14 is installed as a development dependency for the test bot;
  it is not part of the Audio Node's production dependencies.
- A test bot authorized only for the test guild, with `Guilds` and
  `GuildVoiceStates` intents and View Channel, Connect, and Speak permissions.
- A dedicated test voice channel without real users.
- A short, finite, authorized HTTPS audio URL for natural track-end tests.
- A second authorized HTTPS audio URL for track replacement tests.
- The test machine must be able to reach the Audio Node over HTTPS. HTTP is
  accepted only for loopback.
- To run the suite, explicitly confirm control of the test guild.

Set these variables in the shell that will run the harness:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | Test bot token; never paste it into source or chat. |
| `DISCORD_GUILD_ID` | Yes | Controlled primary test guild. |
| `DISCORD_VOICE_CHANNEL_ID` | Yes | Empty, controlled primary voice channel. |
| `AUDIO_NODE_URL` | Yes | Test Audio Node origin. |
| `AUDIO_NODE_TOKEN` | Yes | Test Audio Node node token. |
| `AUDIO_NODE_TEST_AUDIO_URL` | Yes | Short finite test audio that the node can fetch. |
| `AUDIO_NODE_TEST_SECOND_AUDIO_URL` | For replacement tests | A different authorized test track. |
| `DISCORD_SECOND_GUILD_ID` | For dual-guild test | A second controlled test guild. |
| `DISCORD_SECOND_VOICE_CHANNEL_ID` | For dual-guild test | Its empty test voice channel. |
| `AUDIO_NODE_TEST_BAD_AUDIO_URL` | For source-failure test | Controlled URL expected to fail during fetch. |
| `AUDIO_NODE_TEST_CORRUPT_AUDIO_URL` | For FFmpeg failure test | Controlled URL serving invalid audio bytes. |
| `MELINK_LIVE_CONFIRM` | Yes | Must equal `I_CONTROL_THIS_TEST_GUILD_AND_TEST_NODE`. |
| `MELINK_LIVE_STRESS` | For 30-minute test | Set to `1` to opt in to a 30-minute run. |
| `AUDIO_NODE_LONG_AUDIO_URL` | For stress test | Authorized stream/file long enough for 30 minutes. |

On PowerShell, set values with `$env:NAME = 'value'` and then run the test in
that same shell. Do not echo token variables.

## Run a short live test

From `E:\aaaaa`:

```powershell
npm run test:live:quick
```

Quick mode verifies the short test-source preflight, Discord Gateway login,
empty-channel and permission checks, Audio Node authentication, voice readiness,
one FFmpeg-backed playback start, player state, Pause/Resume, Volume, Stop, and
cleanup. It skips natural end, disconnect/rejoin, repeated switching, failure
URLs, dual-guild, player recreation, and stress tests.

The harness does not connect to Discord or the Audio Node unless all required
environment values are set and `MELINK_LIVE_CONFIRM` equals
`I_CONTROL_THIS_TEST_GUILD_AND_TEST_NODE`. Before logging in, it probes one byte
of the configured test audio using the same SSRF-safe HTTP helper as the node.
That proves reachability from the test runner only; a remote Audio Node's access
is confirmed only when playback starts.

## Run the full suite

```powershell
npm run test:live
```

Full mode additionally runs any configured track replacement, natural end,
controlled voice leave/rejoin, source/corrupt-audio recovery, rapid switching,
player recreation, and dual-guild tests. The 30-minute test remains `SKIP`
unless `MELINK_LIVE_STRESS=1` is set separately and a valid
`AUDIO_NODE_LONG_AUDIO_URL` is provided.

Exit code `2` means one or more tests are `BLOCKED`, `1` means a test failed, and
`0` means no tests failed or were blocked.

The harness performs gateway login, Audio Node session/WebSocket authentication,
voice readiness, playback/event checks, player controls, track replacement,
controlled voice leave/rejoin, failure recovery, player recreation, and (when
configured) two-guild isolation. The 30-minute run samples player state, Node
RSS/heap, reported CPU load, FFmpeg process count when the Node is on the same
Windows host, and playback error events.

Pending-stream cancellation, externally injected FFmpeg process termination,
and unexpected voice-network loss remain `BLOCKED`: the public API has no
deterministic test barrier or safe process-level fault-injection control. The
harness does not kill arbitrary FFmpeg processes or disrupt host networking.
It does test a controlled bot leave/rejoin and a corrupt-audio input when those
URLs are configured.

The process does not expose a trustworthy outbound RTP packet counter. A
`TrackStartEvent` and a `playing` player state demonstrate the Audio Player
started; they do not prove that a person heard audio. The report therefore
leaves packet and audible-output confirmation `BLOCKED` for a test user to
confirm by listening in the dedicated channel. Remote FFmpeg process counts are
also `BLOCKED`; the harness never claims local process counts describe a remote
host. Local process cleanup is reported only if the harness observes an FFmpeg
process appear during playback and then return to a clean baseline.

Always run against a test Audio Node and empty test channels. Cleanup deletes
the test Audio Node session, which destroys its players and voice connections,
then disconnects the test bot. Do not point the harness at production.
