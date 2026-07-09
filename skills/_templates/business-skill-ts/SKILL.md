---
name: business-skill-ts-template
description: TypeScript business skill template with muad-progress and session-manager integration.
---

# TypeScript Business Skill Template

Use this template for long-running business-system skills implemented in TypeScript.

Execution rules:

1. Report progress with `scripts/run.mjs`.
2. Use `muad-progress` before and after expensive SDK/API phases.
3. Use session-manager before accessing protected business systems.
4. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
