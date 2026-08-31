# Shell Business Skill Template

Run:

```bash
bash scripts/run.sh
```

Replace the `--skill-name` placeholder with the packaged Skill name. Keep `platforms` empty for a generic Skill, or replace `example_platform` with Console-created platform names when the Skill needs business credentials.

The script calls `muad-progress` at start, completion, and user-readable failure nodes. Calls are best-effort: a missing/failed progress channel does not change the business result. The CLI is silent by default, so stdout remains the single JSON business result; the complete final answer is still sent by OpenClaw's native reply path.
