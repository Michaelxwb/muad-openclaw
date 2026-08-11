---
name: smoke-platform
description: Smoke-test Skill for validating cookie-backed business platform sessions.
---

# Smoke Platform Skill

Use this Skill when the user asks to check or validate `smoke_platform`,
business-platform cookies, or fake business platform login state.

Run the validation script directly:

```bash
node /opt/openclaw-skills/smoke-platform/scripts/run.mjs
```

The script ensures fresh session state automatically. It calls the trusted
`session-manager get-state` CLI, which checks the skill-scoped session state for
the platform's `smoke_platform` cookies, logs in to the fake business platform
when the session is stale or missing, and writes a fresh skill-scoped session
state file. The Runtime Guard injects the trusted execution context
(`MUAD_SESSION_KEY`) into every script invocation automatically, so the script
never needs to pass its own identity — just run it and read the output.

The script then reads the skill-scoped session state file returned by the CLI,
extracts the `smoke_platform` cookie section, and calls `/api/me` on the fake
business platform. It defaults to `http://host.docker.internal:18080`, so do not
inspect local ports or search for `tools/fake-business-platform/server.py`.

Return the script stdout as the result. A successful validation prints:

```json
{"status":"SMOKE_OK","platform":"smoke_platform","source":"cache","user":"demo","authenticated":true}
```
