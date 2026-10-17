# Python Business Skill Template

Run:

```bash
python3 scripts/run.py
```

`platform_request` reads the current user's session state and builds Cookie/CSRF/Host/static headers plus a fresh `Traceid` for every request. Replace `example_platform` with a Console-created platform name that also appears in `muad.skill.json` `platforms`; keep `platforms` empty for a generic Skill and do not call `platform_request` in that case.

`report_progress` invokes the language-neutral `muad-progress` command at start, completion, and user-readable failure nodes. It is explicitly best-effort and never turns business success into failure. CLI stdout is discarded so the script's stdout remains one JSON result; OpenClaw keeps ownership of the complete final reply.

Files are written under `SKILL_OUTPUT_DIR`; never write to the Skill root (read-only) or `/tmp`. Failures go to stderr with a non-zero exit so exec failure logs are forwarded.
