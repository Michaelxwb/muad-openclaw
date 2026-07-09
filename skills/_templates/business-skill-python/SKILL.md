---
name: business-skill-python-template
description: Python business skill template with muad-progress and session-manager integration.
---

# Python Business Skill Template

Use this template for long-running business-system skills implemented in Python.

Execution rules:

1. Report progress with `scripts/run.py`.
2. Use `muad-progress` before and after expensive SDK/API phases.
3. Use session-manager before accessing protected business systems.
4. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
