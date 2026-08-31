# Python Business Skill Template

Run:

```bash
python3 scripts/run.py
```

Replace the `--skill-name` placeholder with the packaged Skill name. Keep `platforms` empty for a generic Skill, or replace `example_platform` with Console-created platform names when the Skill needs business credentials.

`report_progress` invokes the language-neutral `muad-progress` command at start, completion, and user-readable failure nodes. It is explicitly best-effort and never turns business success into failure. CLI stdout is discarded so the script's stdout remains one JSON result; OpenClaw keeps ownership of the complete final reply.
