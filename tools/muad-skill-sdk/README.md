# muad-skill-http

Trace-aware HTTP helpers and runtime instrumentation for muad skills.

Business skills keep using `import requests`. In the runtime image a `.pth`
startup hook imports `muad_skill_http.compat`, which patches
`requests.Session.request` only when Runtime Guard injects
`MUAD_REQUESTS_COMPAT=1` and a non-empty `MUAD_BUSINESS_HOSTS` allowlist. Only
requests whose URL `host:port` exactly matches an allowlisted business host are
instrumented: `TraceId` and `X-Csrftoken` are overwritten with fresh UUID v4
values and the request is counted against the execution limit. Every other
request passes through untouched. Skill code does not import the SDK.

## Install

```bash
pip install muad-skill-http
```

## Usage

```python
import requests

response = requests.get(
    "https://demo.example.internal/api/v1/targets",
    headers={"Cookie": cookie_header},
)
```

Runtime Guard then adds the tracing/CSRF headers and records the request.

`get` / `post` / `put` / `patch` / `delete` / `head` / `options` / `request` /
`session` are also exported as thin `requests` wrappers that record request
counts for the current skill execution. They are optional; plain `requests`
calls are instrumented by the compat layer.

### Local development: build a state file from browser cookies

`build_local_state` converts the `Cookie` request header copied from browser
DevTools into the state JSON the skill template reads from
`~/.muad-local/session-state.json`. It also writes the cookies into
`storageState`; cookie values are never logged.

```python
import json

from muad_skill_http import build_local_state

state = build_local_state(
    "demo",
    "Cookie: session=...; csrf_token=...",
    base_url="https://demo.example.internal",
    host_header={"Host": "demo.example.internal"},
    csrf=[{"cookie": "csrf_token", "header": "x-csrftoken"}],
)
with open("/home/me/.muad-local/session-state.json", "w", encoding="utf-8") as handle:
    json.dump(state, handle)
```

Multiple platforms can share one file with `merge_local_states`:

```python
from muad_skill_http import build_local_state, merge_local_states

state = merge_local_states(
    build_local_state("mssw", mssw_cookie_header, base_url="https://mssw.example.internal"),
    build_local_state("mssp", mssp_cookie_header, base_url="https://mssp.example.internal"),
)
```

`cookies_from_header("a=1; b=2")` returns just the parsed cookie list. These
helpers are for local development only; production sessions come from
`session-manager get-state`. The skill template reads
`~/.muad-local/session-state.json` when `MUAD_SESSION_KEY` is absent, so local
runs do not need a `session-manager` binary. Never commit a filled-in state
file.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MUAD_REQUESTS_COMPAT` | `1` enables the `requests` instrumentation. Runtime Guard injects it. |
| `MUAD_BUSINESS_HOSTS` | Comma-separated `host:port` allowlist. Only these hosts are instrumented. Runtime Guard injects the pod-wide union of enabled platform `baseUrl` hosts. |
| `MUAD_TRACE_SPOOL` | Optional JSONL trace spool path; paired with `MUAD_EXECUTION_ID`. |
| `MUAD_EXECUTION_ID` | Execution id written to the trace spool. |
| `MUAD_SKILL_REQUEST_LIMIT` | Per-execution interface request limit; unset or `0` means unlimited. Exceeding the limit exits with code `86`. |

I/O failures while writing the trace spool are swallowed: auditing never breaks
a skill request.

## Development

```bash
python -m pytest test
```

Releases are published by pushing an `sdk-v*` tag; the tag must match
`project.version` in `pyproject.toml`.
