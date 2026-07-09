---
name: business-skill-shell-template
description: Shell business skill template with muad-progress and session-manager integration.
---

# Shell Business Skill Template

Use this template for simple long-running business-system skills implemented in shell.

Execution rules:

1. Report progress with `scripts/run.sh`.
2. Use `muad-progress` before and after expensive SDK/API phases.
3. Use session-manager before accessing protected business systems.
4. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
