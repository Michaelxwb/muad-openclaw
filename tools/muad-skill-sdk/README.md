# muad-skill-http

Trace-aware HTTP helpers and a platform request client for muad skills.

`platform_request()` sends business-platform requests using a session state
file resolved by the caller. The Skill runs `session-manager get-state
--skill-name <name>` and passes the returned `sessionStateFile`; the SDK never
runs `session-manager` itself. It assembles the browser defaults, platform host
header, platform static headers, cookies, CSRF header and a fresh `Traceid`
UUID v4 for every request, and re-asserts the mandatory headers last so caller
headers cannot override them. Cookie and CSRF values never reach the trace
spool.

## Install

```bash
pip install muad-skill-http
```

## Usage

```python
import json
import subprocess

from muad_skill_http import get, platform_request

# Plain HTTP with trace accounting.
response = get("https://example.com/api/v1/items")

# Resolve the login state with session-manager, then pass its state file.
completed = subprocess.run(
    ["session-manager", "get-state", "--skill-name", "my-skill"],
    capture_output=True, text=True, check=True,
)
state_file = json.loads(completed.stdout)["sessionStateFile"]
response = platform_request(
    "demo", "GET", "/api/v1/targets", state_file=state_file,
)

# Optional: a reusable client bound to the same state file.
from muad_skill_http import platform

client = platform("demo", state_file)
response = client.get("/api/v1/targets")
```

`get` / `post` / `put` / `patch` / `delete` / `head` / `options` / `request`
wrap `requests` and record request counts for the current skill execution.

### Local development: build a state file from browser cookies

`build_local_state` converts the `Cookie` request header copied from browser
DevTools into the state JSON expected by `state_file`. It also writes the
cookies into `storageState`; cookie values are never logged.

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
with open("/home/me/muad-local/demo.json", "w", encoding="utf-8") as handle:
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

### Runtime requirements for `platform_request`

`platform_request` requires the `state_file` argument: the
`sessionStateFile` returned by `session-manager get-state`. Resolving the
session is the Skill's responsibility; the SDK does not run `session-manager`
or read credentials from the environment. If the file is missing, malformed,
expired, or lacks the requested platform, the SDK raises
`muad_skill_http.PlatformSessionError` before sending any request.

Plain `get` / `post` calls work anywhere.

## Environment variables

| Variable | Purpose |
| --- | --- |
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
