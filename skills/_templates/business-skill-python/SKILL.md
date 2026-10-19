---
name: business-skill-python-template
description: Python business skill template using requests plus Runtime Guard header injection.
---

# Python Business Skill Template

Use this template for business-system skills. Self-built Skills are Python-only.

Execution rules:

1. Run `python3 scripts/run.py`. The script resolves the session with `session-manager get-state --skill-name <skill>` (or `~/.muad-local/session-state.json` locally), reads the platform cookies, and sends the request with `requests`. Runtime Guard automatically adds `TraceId`/`X-Csrftoken` and request accounting for business hosts; the script does not import an SDK.
2. Let the script report only coarse user-readable nodes through `muad-progress`; never pass a channel or recipient.
3. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
4. Treat script stdout as the concise JSON result to summarize in the native final reply.
