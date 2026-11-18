# Contributing

Thanks for helping improve Melink Audio Node. The project is experimental, so
focused bug reports and small, testable changes are especially valuable.

## Before opening an issue

- Check the README and the relevant page in [`docs/`](docs/).
- Include Node.js version, operating system, hosting type, and sanitized logs.
- Never include tokens, `.env` files, private media URLs, or Discord user data.
- For security issues, follow [`SECURITY.md`](SECURITY.md) instead of posting
  exploit details publicly.

## Development setup

1. Install Node.js 22.12 or newer.
2. Copy `.env.example` to `.env` and set a local test token.
3. Run `npm ci`.
4. Run `npm test` and `node --check` on any modified JavaScript files.

The tests are local and do not require a Discord bot or live Lavalink server.
Live voice tests should be clearly identified as manual tests and must use
authorized media.

## Pull requests

- Keep changes scoped and explain the user-visible behavior.
- Add or update tests for behavior changes.
- Update documentation when API, configuration, or deployment behavior changes.
- Do not commit generated dependencies, deployment exports, credentials, or
  unrelated formatting changes.
- Preserve the `SPDX-License-Identifier` headers and mark substantial modified
  files as changed where appropriate.

## License

By submitting a contribution, you agree that recipients may use it under
either GNU GPL v3.0-only or GNU AGPL v3.0-only, at their choice. This lets
each recipient select one license; both do not apply simultaneously. See
[`LICENSE`](LICENSE), [`LICENSE-GPL-3.0`](LICENSE-GPL-3.0), and
[`LICENSE-AGPL-3.0`](LICENSE-AGPL-3.0). If you cannot authorize this dual
licensing for your contribution, state that before submitting a pull request.
