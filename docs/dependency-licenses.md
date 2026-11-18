# Dependency license review

This is a metadata-based review of the dependency versions resolved in
`package-lock.json` and the installed package manifests. It is not a legal
opinion and does not replace checking the exact files and build options in a
distribution.

## Direct server dependencies

| Package | Resolved version | Declared license |
| --- | --- | --- |
| `@discordjs/voice` | 0.19.2 | Apache-2.0 |
| `dotenv` | 16.6.1 | BSD-2-Clause |
| `ffmpeg-static` | 5.3.0 | GPL-3.0-or-later |
| `pino` | 10.4.0 | MIT |
| `ws` | 8.23.0 | MIT |

The client SDK directly depends on `ws` (MIT) and declares `discord.js` as a
peer dependency (`^14.0.0`); check the peer package's license in the bot
application's own dependency tree.

## Transitive metadata snapshot

The installed third-party dependency tree contained 92 unique named
package/version manifests with license metadata. The declared identifiers were:

| License identifier | Package count |
| --- | ---: |
| MIT | 54 |
| ISC | 24 |
| Apache-2.0 | 4 |
| BlueOak-1.0.0 | 4 |
| BSD-2-Clause | 2 |
| BSD | 1 |
| BSD-3-Clause | 1 |
| 0BSD | 1 |
| GPL-3.0-or-later | 1 |

## Items to verify before distributing a build

- `ffmpeg-static` is copyleft-licensed and supplies a platform-specific FFmpeg
  binary. Verify the exact binary's build configuration and corresponding
  notices for each platform artifact distributed with the node.
- Preserve the notices and license texts shipped by dependencies when
  packaging or containerizing the service.
- Re-run this review when dependency versions change. The metadata snapshot
  does not inspect generated binaries or independently validate every
  upstream license declaration.
