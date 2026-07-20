# Spec rebuild 2026-07-19

## Done
- Backed up previous specs to `specs.legacy-2026-07-19/` (gitignored via `specs.legacy-*/`; local only)
- `config.yml`: schema 1 + domains `frontend` / `backend` / `runtime` with project paths
- Frontend patterns cover `src/`, `test/`, and root build configs (`vite` / `eslint` / `vitest`)
- `validation.yml`: console + bin + muad-run-skill + runtime-guard + session-manager + muad-progress
- Rewrote domain maps and required specs; cf-learn rules + verifiers applied
- Removed legacy `cf_inject_hook.py`, `cf_session_hook.py`, `.claude/commands/cf-scan.md`
- Archived incomplete demand `agent-telemetry-plugin-architecture` (empty Context)
- Synced project conventions in `CLAUDE.md` and `AGENTS.md`

## Optional later
- Cherry-pick any unique rules from local `specs.legacy-2026-07-19/` then delete it
- Run `/cf-spec doctor` after next task start
