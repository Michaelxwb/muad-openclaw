---
name: example-long-task
description: Example long-running skill used to verify muad-progress integration.
---

# Example Long Task

Use this sample when the user asks to verify long-running task progress, `muad-progress`,
or the `example-long-task` skill.

## Required Action

Run this skill through the Muad runner. Do not simulate, summarize, or invent progress
results without running it.

```text
muad_run_skill(skill_name="example-long-task", input=<user request>)
```

The runner executes `muad.skill.json`, then the entrypoint script reports these
user-visible progress stages through `muad-progress`:

1. accepted
2. auth
3. query
4. analysis
5. done

After the tool completes, reply with one short completion sentence. Do not repeat the
progress stages as a table or report. If the tool fails, report a concise failure message
and do not claim that progress verification passed.

## Guardrails

- Do not include credentials, tokens, cookies, internal URLs, SQL, or stack traces in progress text.
- Do not call `exec` directly for this skill.
- Do not replace the tool call with a hand-written table.
- Do not claim that the 5 stages were emitted unless `muad_run_skill` actually ran.
