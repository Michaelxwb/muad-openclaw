# session-manager

`session-manager` resolves the current agent's business-platform credential and materializes an isolated browser session state. Platformless Skills should not call it.

The script-facing command is:

```text
session-manager get-state --skill-name <name> [--platform <platform>]
```

The OpenClaw plugin exposes the equivalent `session_get_state` Tool with model-facing Skill and optional platform parameters:

```json
{
  "skillName": "mssw-query",
  "platform": "mssw"
}
```

The plugin reads `agentId` and `sessionKey` only from OpenClaw's trusted tool context. They are not accepted in Tool parameters. The manifest declares `contracts.tools=["session_get_state"]`, and the plugin is loaded from `openclaw-plugin.mjs`.

The caller must provide trusted `MUAD_AGENT_ID` and `MUAD_SESSION_KEY` environment values. The CLI intentionally has no `--agent-id`, `--pod-id`, API-key, Cookie, or account-selection argument. It reads the Pod service token only from `/run/secrets/muad/pod-service-token` and writes a stable JSON result to stdout.

State is stored at:

```text
/home/node/.openclaw/agents/<agentId>/session-store/<platform>/default/
  cookies.json
  storageState.json
  meta.json
  refresh.lock
```

Every request resolves the current credential first. Console maps `agentId + skillName` to the effective Skill and its declared platform dependencies, then to the user's platform credential JSON. A single-platform Skill can omit `--platform`; a multi-platform Skill must pass one of its declared platforms. Cached state is reusable only when its Human User, agent, Pod, platform, credential fingerprint, and expiry all match. A file lock serializes refreshes across processes and stale crash locks are reclaimed after a bounded timeout.

Platforms are not seeded by runtime code. Administrators create platform names in Console, upload Skills with optional platform dependencies, then save each user's credential JSON for the required platforms. The generic HTTP adapter is created dynamically for any valid platform name and reads these credential fields:

```json
{
  "baseUrl": "https://platform.internal",
  "sessionEndpoint": "/api/session",
  "healthEndpoint": "/health",
  "ak": "user-access-key",
  "sk": "user-secret-key",
  "sessionMode": "storage_state",
  "sessionTtlSeconds": 900
}
```

If `apiKey` is present, the adapter sends it as an in-memory `Authorization: Bearer` header. If `ak/sk` or `accessKey/secretKey` are present, the adapter sends them as `X-Access-Key` / `X-Secret-Key` headers and includes them in the login request body. The session response may return cookies in JSON or via `Set-Cookie`; optional Playwright `storageState` and optional `expiresAt` are also supported. If `healthEndpoint` is configured, cached cookies are checked before reuse; 401/403 clears the cache and triggers a fresh login. Sensitive credential values are rejected if an adapter attempts to include them in persisted state.

Python, TypeScript, and Shell integration examples live under `fixtures/`. They all invoke the same CLI and intentionally contain no Resolver, cache, or adapter implementation.

Build and test with Node.js 24:

```text
npm ci
npm test
```
