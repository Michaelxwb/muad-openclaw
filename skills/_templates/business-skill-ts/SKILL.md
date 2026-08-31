---
name: business-skill-ts-template
description: TypeScript business skill template with session-manager integration.
---

# TypeScript Business Skill Template

Use this template for business-system skills implemented in TypeScript.

Execution rules:

1. Run `node scripts/run.mjs`; it uses session-manager before accessing protected business systems.
2. Let the script report only coarse user-readable nodes through `muad-progress`; never pass a channel or recipient.
3. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
4. Treat script stdout as the concise JSON result to summarize in the native final reply.
