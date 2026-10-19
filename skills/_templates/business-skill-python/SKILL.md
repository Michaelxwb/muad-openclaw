---
name: business-skill-python-template
description: Python business skill template using muad_skill_http.platform_request.
---

# Python Business Skill Template

Use this template for business-system skills. Self-built Skills are Python-only.

Execution rules:

1. Run `python3 scripts/run.py`. The script first calls `session-manager get-state --skill-name <skill>` and passes the returned `sessionStateFile` to `muad_skill_http.platform_request`; the SDK only builds headers, sends the request, and records trace/statistics.
2. Let the script report only coarse user-readable nodes through `muad-progress`; never pass a channel or recipient.
3. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
4. Treat script stdout as the concise JSON result to summarize in the native final reply.
