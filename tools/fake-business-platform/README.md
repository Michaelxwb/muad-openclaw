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
