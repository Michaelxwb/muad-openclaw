# TypeScript Business Skill Template

Run:

```bash
node scripts/run.mjs
```

Replace the `--skill-name` placeholder with the packaged Skill name. Keep `platforms` empty for a generic Skill, or replace `example_platform` with Console-created platform names when the Skill needs business credentials.

`reportProgress` executes the language-neutral `muad-progress` command at start, completion, and user-readable failure nodes. It catches progress-only failures without changing the business outcome. The CLI is silent unless `--json` is explicitly requested, and this template leaves it off so stdout remains one JSON business result. The complete final reply remains native OpenClaw behavior.
