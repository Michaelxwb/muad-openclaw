# session-manager

`session-manager` resolves the current agent's business-platform credential and materializes an isolated browser session state.

The script-facing command is:

```text
session-manager get-state --platform <name>
```

The OpenClaw plugin exposes the equivalent `session_get_state` Tool with one model-facing parameter:

```json
{
  "platform": "xdr"
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

Every request resolves the current credential first. Cached state is reusable only when its Human User, agent, Pod, platform, credential fingerprint, platform-config fingerprint, and expiry all match. A file lock serializes refreshes across processes and stale crash locks are reclaimed after a bounded timeout.

The installed adapters are `mssw`, `sdsp`, `sea_soar`, `soar`, and `xdr`. Their initial shared HTTP contract uses these non-secret platform config fields:

```json
{
  "baseUrl": "https://platform.internal",
  "sessionEndpoint": "/api/session",
  "sessionMode": "storage_state",
  "sessionTtlSeconds": 900
}
```

The adapter sends `POST sessionEndpoint` with the API key in the in-memory `Authorization: Bearer` header. The response must contain `cookies`, optional Playwright `storageState`, and optional `expiresAt`. The API key is rejected if an adapter attempts to include it in persisted state.

Python, TypeScript, and Shell integration examples live under `fixtures/`. They all invoke the same CLI and intentionally contain no Resolver, cache, or adapter implementation.

Build and test with Node.js 24:

```text
npm ci
npm test
```
