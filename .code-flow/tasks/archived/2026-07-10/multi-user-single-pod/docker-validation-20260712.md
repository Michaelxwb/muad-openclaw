# Docker Image Contract Validation (2026-07-12)

## Artifact

- Image: `muad-openclaw:multi-user-20260712`
- Image/manifest digest: `sha256:d9ef134dd0527b4d0f278bafbc5669ed22934d50a86815458a53944f9d478adc`
- OpenClaw label/version: `2026.6.10`
- Resolved OpenClaw base digest: `sha256:3814fb1f62f9cfc5944de088c5817c68c88b5d721feebe36420b666a90a61ce7`
- Architecture: `arm64`

Build command:

```bash
docker build --progress=plain -t muad-openclaw:multi-user-20260712 .
```

## Image And Plugin Contracts

The following checks passed:

```bash
docker run --rm --entrypoint node muad-openclaw:multi-user-20260712 \
  /opt/muad/runtime-image-self-check.mjs --image-only
docker run --rm --entrypoint openclaw muad-openclaw:multi-user-20260712 --version
docker run --rm --entrypoint session-manager muad-openclaw:multi-user-20260712 --help
node --test bin/test/*.test.mjs
(cd tools/muad-runtime-guard && npm test)
(cd tools/muad-run-skill && npm test)
(cd tools/session-manager && npm test)
```

Results:

- Image self-check: passed; pinned OpenClaw `2026.6.10` matched.
- Runtime Guard: 19 tests passed, including `/bind` trusted context and Trusted Tool Policy.
- `muad-run-skill`: 23 tests passed, including trusted Tool Context and bounded concurrency.
- session-manager: 19 tests passed, including fixed token path, cross-agent rejection and cache ownership.
- Runtime renderer/image contract: 16 tests passed.
- Cold Gateway inventory reported `muad-run-skill`, `session-manager` and `muad-runtime-guard` as enabled and `loaded`.

## Runtime Smoke

The container was started with `bin/test/fixtures/runtime-v1.json`, an isolated state volume and a read-only service-token volume. The following checks passed:

- `openclaw config validate` accepted the generated strict config.
- Generated config contained `main` and `alice`, two strict routes, `session.identityLinks.alice`, and `quarantine`/`alice` browser profiles.
- All three Muad plugins were present in `plugins.allow`, `plugins.load.paths` and enabled entries.
- `/run/secrets/muad/pod-service-token` was `0400 node:node` and absent from container env.
- Updating the mounted token changed its in-container SHA-256 without placing the token in env or image history.
- `muad.runtime.health` returned `ok=true`, the expected generation, one agent mapping, loaded session-manager, and Skill/Browser queue limits.

## Apply And Rollback

The real container transaction sequence passed:

1. Prepare generation 8 returned `restartMode=gateway`.
2. Candidate validation and commit passed.
3. Sending `SIGUSR1` to foreground Gateway PID 1 loaded generation 8.
4. Generation 9 committed and became healthy.
5. Rollback restored generation 8; a second `SIGUSR1` made health report generation 8 again.
6. A deliberately corrupted generation 10 candidate failed `openclaw config validate`; `abort` removed it and the running generation remained 8.

The smoke test exposed that `openclaw gateway restart --wait 30s --json` exits zero with `result=not-loaded` in the worker container because it targets a systemd user service. `runtimeapply.Applier` now sends `kill -USR1 1`, matching the foreground-container behavior already used by the channel injector. Unit tests assert the exact signal command and rollback restart count.

## DockerDriver Integration

Repeatable command:

```bash
cd console/backend
MUAD_DOCKER_TEST_IMAGE=muad-openclaw:multi-user-20260712 \
  go test -tags=integration ./internal/driver \
  -run TestDockerIntegration_RetainedStateAndTokenLifecycle -v
```

The integration test passed and verifies:

- private service-token creation and `0400` mode;
- in-place token rotation;
- token cleanup on container removal;
- retained state rejects implicit same-name reuse with `ErrRetainedState`;
- explicit `AdoptState` permits controlled reuse;
- final container, volume and token cleanup.

## Final Runtime Revision

The 66667 end-to-end run produced two follow-up revisions without changing the pinned OpenClaw base:

- `multi-user-20260712.1` prevents a stale startup Runtime DTO from replacing a newer PVC generation.
- `multi-user-20260712.2` additionally marks business-platform transport failures as retryable.
- `multi-user-20260712.5` adds Pod-shared filesystem leases for Skill and Browser concurrency and keeps the
  shared Browser manager alive across Agent runtime contexts.

The final image is `muad-openclaw:multi-user-20260712.5`, digest
`sha256:b51485cf79a493e9a5eab446425e7ceb69d3021cde6d934a6573ffd65a039b25`.
Its build ran the session-manager, Runtime Guard, Skill runner, bin contract, and image self-check suites.
Real Pod restart, generation reconciliation,
multi-model, Browser, binding, session cache, and final media delivery evidence is recorded in
`e2e-validation-66667-20260712.md`; capacity evidence is recorded in
`capacity-validation-66667-20260712.md`.
