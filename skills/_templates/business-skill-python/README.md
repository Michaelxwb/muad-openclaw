# Python Business Skill Template

Run:

```bash
python3 scripts/run.py
```

`get_session_state()` runs `session-manager get-state --skill-name <skill>` and returns the `sessionStateFile`. `platform_request(..., state_file=...)` reads that file and builds Cookie/CSRF/Host/static headers plus a fresh `Traceid` for every request; the SDK does not resolve logins itself. Replace `example_platform` with a Console-created platform name that also appears in `muad.skill.json` `platforms`; keep `platforms` empty for a generic Skill and do not call `session-manager`/`platform_request` in that case.

For local development without `session-manager`, write a state file built with `muad_skill_http.build_local_state(...)` to `~/.muad-local/session-state.json`. The fallback only applies when `MUAD_SESSION_KEY` is absent; a pod always has it, so production keeps using `session-manager`.

`report_progress` invokes the language-neutral `muad-progress` command at start, completion, and user-readable failure nodes. It is explicitly best-effort and never turns business success into failure. CLI stdout is discarded so the script's stdout remains one JSON result; OpenClaw keeps ownership of the complete final reply.

Files are written under `SKILL_OUTPUT_DIR`; never write to the Skill root (read-only) or `/tmp`. Failures go to stderr with a non-zero exit so exec failure logs are forwarded.
