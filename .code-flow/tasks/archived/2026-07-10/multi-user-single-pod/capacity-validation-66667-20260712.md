# 66667 Capacity Validation (2026-07-12)

## Baseline

- Image: `muad-openclaw:multi-user-20260712.5`
- Digest/architecture: `sha256:b51485cf79a493e9a5eab446425e7ceb69d3021cde6d934a6573ffd65a039b25`, `arm64`
- OpenClaw: `2026.6.10`
- Pod limit: `2 CPU / 3 GiB`
- Runtime limits: Skill 2, Browser 2
- Capacity population: Alice, Bob, Charlie, and temporary `load04` through `load10`

Success required bounded queues, correct per-Agent provider/profile selection, no cross-user state access,
no Gateway crash under normal Gateway traffic, and deterministic cleanup after the run.

## Results

| Workload | Result | Wall time | Peak memory | Queue evidence |
| --- | --- | ---: | ---: | --- |
| 10 concurrent Gateway LLM turns | 10/10 | 6.007 s | 1,250,357,248 B | Alice/Charlie retained distinct providers |
| 10 long Skill runs | 10/10 | 44.871 s | 1,369,026,560 B | `active=2`, `queued=2` |
| 3 concurrent real Browser Agent runs | 3/3 | 14.445 s | 2,057,695,232 B | `active=2`, `queued=1`, zero `browser failed` logs |
| 10-user mixed LLM/Skill/Browser/Resolver | 10/10 | 16.723 s | 2,124,165,120 B | Skill `2+2`, Browser `2+0`; CPU usage 8,207,918 us |

The mixed run used two LLM-only turns, two Browser Agent turns, four long Skill runs, and two Resolver calls.
The two users intentionally had no XDR credential: the plugin returned its redacted tool error while a
service-token-authenticated Resolver assertion confirmed HTTP 404/code 40402 (`not_configured`). This is the
expected isolated boundary result, not a transport failure.

## Overload And Evidence Rules

- Shared Skill and Browser leases are filesystem-backed because OpenClaw creates multiple Agent runtime
  contexts in one Gateway process; an in-memory queue is not Pod-wide.
- Skill queue full/timeout and Browser `browser_busy` behavior have unit and real boundary evidence. Queue
  waiters are bounded; they do not create unbounded child processes.
- Four simultaneous in-Pod `openclaw` CLI processes caused an OOM at 3 GiB. Each CLI starts another Node
  runtime, so this is process amplification rather than representative IM/Gateway traffic. Bulk automation
  must reuse one Gateway client or the HTTP/RPC surfaces.
- Model final text is not accepted as Browser success evidence. One exploratory run replied `BROWSER_OK`
  after a Chrome/tool failure. Final Browser acceptance therefore combines Agent completion, shared queue
  sampling, and absence of `browser failed` in the tool log.
- A Browser wait on a newly created empty tab can be blocked by navigation policy. The verified run first
  established an allowed URL, then exercised the long wait and queue behavior.

## Production Defaults

New Pods default to `2 CPU / 3 GiB`, `max_skill_concurrency=2`, and
`max_browser_concurrency=2`. Observed normal peak memory was about 2.12 GiB, leaving roughly 0.88 GiB for
Gateway/channel variance. Capacity remains capped at 10 active/pending Human Users per Pod.

Scale out to another Pod when sustained queue latency is unacceptable; do not raise Browser concurrency
without repeating the Chrome startup and memory test. Alert on memory above 85%, repeated busy/timeout,
generation lag, Resolver transport failures, or Gateway restarts.

## Rollback And Cleanup

Rollback uses the previous image tag and the existing generation transaction: validate candidate, atomically
replace, restart, verify `muad.runtime.health`, and retain the last committed DTO on failure. If queue behavior
regresses, reduce Skill/Browser concurrency before increasing Pod memory.

Temporary users `load04` through `load10` were deleted after the run. Generation 34 converged with three
business mappings, no remaining temporary workspace/agent directories, empty queues, and Alice/Bob/Charlie
as the only business agents. The final Deployment uses image `.5`, `2 CPU`, and `3 GiB`.
