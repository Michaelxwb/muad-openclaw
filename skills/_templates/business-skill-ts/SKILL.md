---
name: business-skill-ts-template
description: TypeScript business skill template with session-manager integration.
---

# TypeScript Business Skill Template

Use this template for business-system skills implemented in TypeScript.

Execution rules:

1. Use session-manager before accessing protected business systems.
2. Do not expose Cookie, token, password, internal URLs, SQL, or stack traces.
3. Return a concise JSON result for the Agent to summarize.
