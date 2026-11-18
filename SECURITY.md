# Security policy

## Reporting a vulnerability

Please do not publish credentials, exploitable request samples, or an
unpatched vulnerability in a public issue. Use GitHub's private vulnerability
reporting for this repository if it is enabled. Otherwise, contact the
maintainers privately through the contact information on the Melow Studio
GitHub profile.

Include the affected version or commit, impact, and a minimal reproduction
that does not contain real tokens or third-party data.

## Deployment guidance

- Use HTTPS for the REST and WebSocket endpoints.
- Keep `AUDIO_NODE_TOKEN` private, rotate it if exposed, and do not put it in
  client-side code or logs.
- Restrict the service to trusted bot clients; session storage is in memory and
  there is no per-IP rate limiter.
- Only process media that the operator is authorized to stream.
- Treat the project as experimental and review dependency advisories before
  production use.
