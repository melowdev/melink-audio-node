# Licensing

Melink Audio Node and the client SDK are available under either
`GPL-3.0-only` **OR** `AGPL-3.0-only`, at the recipient's choice. This is an
alternative grant: a recipient follows one license, not both at once.

The full texts are:

- [GNU GPL v3.0-only](../LICENSE-GPL-3.0)
- [GNU AGPL v3.0-only](../LICENSE-AGPL-3.0)

## What the choice means

- Under the GPL option, the source-code obligations apply when a covered copy
  is conveyed to others. Running a modified version as a network service, by
  itself, does not trigger the AGPL's additional network-source offer.
- Under the AGPL option, section 13 additionally applies when a modified
  version supports remote interaction over a network: the operator must
  prominently offer those remote users access to the corresponding source of
  that running version, at no charge.

A recipient choosing the GPL option is not bound by the AGPL-only network
condition. The AGPL option does not require users to publish their changes to
Melow Studio's repository; it requires them to offer the corresponding source
to the users of their modified network service.

## Source offer for a deployed version

The official source repository is
<https://github.com/melowdev/melink-audio-node>. Before operating a
modified AGPL-licensed deployment, publish or otherwise make the exact
corresponding source available and provide a prominent, no-charge offer to
the remote users of that deployment. A link to upstream is not sufficient if
the running build contains unpublished modifications.

The current API does not expose a source-code URL. The deployment's source
offer and the matching source location must therefore be set up before an
AGPL-modified build is put into network service.

## SDK release note

The previously published npm version `melink-audio-node-client@0.1.0` remains
licensed as published under `GPL-3.0-only`. The repository prepares version
`0.1.1` for the dual-license expression; publishing it is a separate release
step and has not been done.

## Contributions

Contributions must be offered under both alternatives so recipients can
choose either license. See [Contributing](../CONTRIBUTING.md).

This document is a project summary, not legal advice. Consult qualified
counsel for a specific distribution or deployment.
