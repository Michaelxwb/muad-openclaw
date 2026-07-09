# Skill Progress Feedback Deployment

This document explains how to ship `muad-progress`, progress adapters, and progress-aware skill templates.

## Build

From `tools/muad-progress`:

```bash
go test ./...
go build -o dist/muad-progress ./cmd/muad-progress
go build -o dist/muad-skill-check ./cmd/muad-skill-check
```

Cross-compile production binaries:

```bash
GOOS=linux GOARCH=amd64 go build -o dist/muad-progress-linux-amd64 ./cmd/muad-progress
GOOS=linux GOARCH=arm64 go build -o dist/muad-progress-linux-arm64 ./cmd/muad-progress
GOOS=linux GOARCH=amd64 go build -o dist/muad-skill-check-linux-amd64 ./cmd/muad-skill-check
GOOS=linux GOARCH=arm64 go build -o dist/muad-skill-check-linux-arm64 ./cmd/muad-skill-check
```

## Worker Image Layout

```text
/usr/local/bin/muad-progress
/usr/local/bin/muad-skill-check
/opt/muad/progress-adapters/openclaw
/opt/muad/progress-adapters/hermes
/opt/openclaw-skills/_templates
```

`muad-progress` is a worker runtime tool. It must not be placed under `console/` or called through Console APIs.

## Runtime Environment

| Variable | Purpose |
|----------|---------|
| `MUAD_PROGRESS_ADAPTER_CMD` | Command that receives one progress event JSON on stdin. |
| `MUAD_PROGRESS_STATE_DIR` | State and diagnostic directory, default `$HOME/.muad`. |
| `MUAD_PROGRESS_STRICT_ADAPTER` | When `1`, missing adapter returns exit code 4. |
| `MUAD_SKILL_NAME` | Default skill name when `--skill` is omitted. |

## Rollout

1. PoC: enable the CLI and OpenClaw adapter for one demo skill.
2. Gray: enable for XDR or SOAR business skills.
3. Full: require new long-running business skills to use `muad-progress`.

Rollback:

- revert worker image to the previous `muad-progress` binary;
- revert `/opt/muad/progress-adapters`;
- change `muad-skill-check --fail` to warning mode in CI.

## Smoke Checks

```bash
muad-progress stage --stage query --text "正在查询 XDR 告警数据" --json
muad-progress validate --stage query --text "正在查询 XDR 告警数据" --json
muad-skill-check --root skills
```

OpenClaw deployment should verify that progress reaches the channel progress path. Hermes deployment should verify plugin/tool registration and, if native progress is unavailable, low-frequency normal message fallback.
