# Fake Business Platform

Standalone cookie-based HTTP service for session smoke tests. It has no
session-manager dependency and only models a normal business system:

- `POST /login` with `{"username":"demo","password":"demo-pass"}` issues an
  `HttpOnly` session cookie.
- `GET /api/me` requires the cookie and returns the current user.
- `GET /health/session` requires the cookie and is used by cache validation.
- `GET /` renders `logged-in` or `logged-out` for browser profile checks.

`/login` always answers HTTP 200 (MSSW style): the outcome is carried in the
JSON body's `code` field, so session-manager's business-code classification can
be exercised end to end. `code: 0` means success; any other code is an error:

| code | meaning | triggered by |
| --- | --- | --- |
| `1001` | `params_error` | request body missing username/password |
| `1002` | `auth_failed` | wrong password or unknown user |
| `1003` | `account_locked` | username prefixed `locked-` (correct password) |
| `1004` | `rate_limited` | username prefixed `ratelimited-` (correct password) |
| `1005` | `service_error` | username prefixed `serviceerr-` (correct password) |

Run locally:

```bash
python3 tools/fake-business-platform/server.py --port 18080
```

The first stdout line is a JSON readiness message containing `baseUrl`.

Accounts are configured in the `ACCOUNTS` dict at the top of `server.py`.
To add or change a login, edit that dict and restart the service; every
configured account can be logged in at once. The default configuration
ships `demo`/`demo-pass` and `michael`/`michael-pass` (a second human user
whose session must not be reachable by the first).

`/api/me` returns the username of the session's owner, so a leaked session
exposes which account it belongs to.

## MSSW mode

`--platform mssw` models the MSSW gateway contract closely enough to exercise
the real `MSSWSessionAdapter` and `muad_skill_http.platform_request`:

```bash
python3 tools/fake-business-platform/server.py --platform mssw --port 18080 \
  --ak test-ak --sk test-sk
```

Endpoints:

- `GET /v1/certification/get_token` issues a `csrf_token` cookie.
- `POST /gateway/mss-auth-acl-service/v1/certification/login_agent` verifies the
  SigV4-style `Authorization` header (HMAC-SHA256 over the canonical request),
  the `x-csrftoken` header and issues `fake_session` + `csrf_token` cookies.
- `GET /v1/rtt` is the health endpoint used by adapter validation.
- `GET /api/v1/ping` requires the session cookie and the `x-csrftoken` header;
  it echoes the `Traceid` request header.
- `GET /__stats` returns per-path request counts; `GET /__stats/reset` clears them.

Use it with the `mssw-platform-smoke` Skill or these tests:

```bash
# Real MSSWSessionAdapter login/health/profile against the fake server
cd tools/session-manager && npm test -- --test-name-pattern="fake MSSW"

# SDK + fake MSSW + per-interface request limit (Traceid/CSRF/exit 86)
python3 tools/fake-business-platform/test_mssw_skill_smoke.py
```

