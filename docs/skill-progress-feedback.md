# Skill Progress Feedback Deployment

> Status: retired. This document is kept only as a historical note.

The current minimal runtime no longer ships `muad-progress`, `muad-run-skill`,
`progress-adapters`, or telemetry outbox delivery. Do not follow the old build,
image layout, rollout, or smoke-check instructions for current deployments.

Current runtime responsibilities are:

- `muad-runtime-guard`: agent isolation plus Skill/browser concurrency leases.
- `session-manager`: platform credential/session lookup and refresh.
- OpenClaw native Skill activation and final reply: Skill execution entry and
  user-visible result delivery.

When progress reporting is reintroduced, it should be owned by a new audited
execution layer and documented in a new deployment guide.
