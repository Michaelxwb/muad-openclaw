# muad-skill-http

Trace-aware HTTP helpers and a platform request client for muad skills.

`platform_request()` sends business-platform requests through a platform session
managed by `session-manager`. It assembles the browser defaults, platform host
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
from muad_skill_http import get, platform_request

# Plain HTTP with trace accounting.
response = get("https://example.com/api/v1/items")

# Business-platform request: headers and Traceid are built by the SDK.
response = platform_request("demo", "GET", "/api/v1/targets")
```

`get` / `post` / `put` / `patch` / `delete` / `head` / `options` / `request`
wrap `requests` and record request counts for the current skill execution.

### Runtime requirements for `platform_request`

`platform_request` resolves the platform session from the skill runtime, not
from the local machine. It needs:

- `MUAD_SKILL_NAME` set to the running skill name;
- a `session-manager` executable on `PATH` that answers
  `session-manager get-state --skill-name <name>` with
  `{"sessionStateFile": "..."}`;
- a session state file containing the requested platform's credentials.

Outside that environment it raises `muad_skill_http.PlatformSessionError`.
Plain `get` / `post` calls work anywhere.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MUAD_SKILL_NAME` | Skill name used to resolve the platform session. |
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
