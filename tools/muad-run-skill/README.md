# muad-run-skill

`muad-run-skill` is an OpenClaw tool plugin that runs Muad script skills from
inside the current OpenClaw tool execution context. It owns the execution
boundary for script skills and forwards progress through OpenClaw tool updates.

It is separate from `muad-progress`:

- `muad-progress` is a language-neutral CLI called by Shell, Python, TS, or Go
  skill scripts.
- `muad-run-skill` is the OpenClaw runtime bridge that starts script skills,
  receives progress events, and emits OpenClaw progress updates.

## Skill Manifest

Each script skill should include `muad.skill.json` next to `SKILL.md`.

Steps mode lets the runner own coarse progress:

```json
{
  "name": "example-long-task",
  "runtime": "script",
  "mode": "steps",
  "steps": [
    { "id": "auth", "title": "鉴权", "command": ["bash", "scripts/auth.sh"] },
    { "id": "query", "title": "查询数据", "command": ["python3", "scripts/query.py"] }
  ]
}
```

Entrypoint mode lets an existing top-level script orchestrate sub-scripts. The
script can call `muad-progress` for coarse step updates:

```json
{
  "name": "example-long-task",
  "runtime": "script",
  "mode": "entrypoint",
  "entrypoint": ["bash", "scripts/run.sh"],
  "steps": [
    { "id": "auth", "title": "鉴权" },
    { "id": "query", "title": "查询数据" }
  ]
}
```

## Tool

The plugin registers:

```text
muad_run_skill(skill_name, input?, args?)
```

For `runtime: script` skills, prompts and slash-command routing should call this
tool instead of directly running `exec`.
