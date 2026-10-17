"""Acceptance tests for the muad_skill_http SDK (TASK-007).

Covers S-09/S-10/S-12/S-13/S-17/E-04/E-05/E-08/E-10/B-01/B-03/B-04/B-06/B-07/B-10.
The tests use real spool files, a real local HTTP server, a real session state
file and a real `session-manager` executable on PATH; only the transport target
of the platform itself is a local test server (the "httptest" boundary).
"""

from __future__ import annotations

import json
import os
import stat
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests

import muad_skill_http as sdk
from muad_skill_http import _platform as sdk_platform
from muad_skill_http import _trace as sdk_trace


class Terminated(BaseException):
    """Test stand-in for os._exit(86); deliberately not an Exception."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep test output clean
        return

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        path = self.path.split("?", 1)[0]
        record = {
            "method": self.command,
            "path": path,
            "headers": dict(self.headers.items()),
            "body": body,
        }
        self.server.records.append(record)
        with self.server.lock:
            plan = self.server.plans.get(path)
            if plan:
                status, payload = plan.pop(0)
            else:
                status, payload = self.server.default
        data = payload.encode("utf-8") if isinstance(payload, str) else payload
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_HEAD = _handle


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.records = []
    httpd.plans = {}
    httpd.default = (200, '{"ok":true}')
    httpd.lock = threading.Lock()
    httpd.base_url = "http://127.0.0.1:%d" % httpd.server_port
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


@pytest.fixture(autouse=True)
def clean_sdk(monkeypatch):
    # Keep the local test server off any developer/CI HTTP proxy.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    sdk._reset_for_tests()
    yield
    sdk._reset_for_tests()


@pytest.fixture
def trace_env(monkeypatch, tmp_path):
    spool = tmp_path / "exec-trace.jsonl"
    monkeypatch.setenv("MUAD_EXECUTION_ID", "exec-1")
    monkeypatch.setenv("MUAD_SKILL_NAME", "test-skill")
    monkeypatch.setenv("MUAD_TRACE_SPOOL", str(spool))
    monkeypatch.delenv("MUAD_SKILL_REQUEST_LIMIT", raising=False)
    return spool


@pytest.fixture
def terminate(monkeypatch):
    def _terminate(code):
        raise Terminated(code)

    monkeypatch.setattr(sdk_trace, "_terminate", _terminate)


def header(record, name):
    for key, value in record["headers"].items():
        if key.lower() == name.lower():
            return value
    return None


def read_spool(path):
    if not path.exists():
        return []
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    return [json.loads(line) for line in lines]


def events(path, kind):
    return [item for item in read_spool(path) if item.get("kind") == kind]


def cookie(name, value):
    return {"name": name, "value": value, "domain": "127.0.0.1", "path": "/"}


def write_state_file(tmp_path, platforms, filename="test-skill.session.json"):
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    path = tmp_path / filename
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "agentId": "agent-1",
                "skillName": "test-skill",
                "humanUserId": "u_1",
                "podId": "pod-1",
                "platforms": {
                    name: dict(section, expiresAt=section.get("expiresAt", expiry))
                    for name, section in platforms.items()
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def install_session_manager(tmp_path, monkeypatch, state_file, fail_after=None):
    """Create a real executable on PATH that behaves like session-manager get-state."""
    counter = tmp_path / "sm-calls.txt"
    script = tmp_path / "session-manager"
    fail_line = "fail_after = %d" % (fail_after if fail_after is not None else 0)
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "counter = os.environ['FAKE_SM_COUNTER']\n"
        "try:\n"
        "    count = int(open(counter).read() or '0')\n"
        "except OSError:\n"
        "    count = 0\n"
        "count += 1\n"
        "open(counter, 'w').write(str(count))\n"
        + fail_line
        + "\n"
        "if fail_after and count > fail_after:\n"
        "    sys.stderr.write('session-manager: login failed reason=auth_failed\\n')\n"
        "    sys.exit(1)\n"
        "print(json.dumps({'sessionStateFile': os.environ['FAKE_SM_STATE_FILE']}))\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    monkeypatch.setenv("FAKE_SM_COUNTER", str(counter))
    monkeypatch.setenv("FAKE_SM_STATE_FILE", str(state_file))
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))

    def calls():
        return int(counter.read_text(encoding="utf-8") or "0") if counter.exists() else 0

    return calls


def mssw_profile(base_url):
    return {
        "baseUrl": base_url,
        "hostHeader": {"Host": "mssw.sangfor.com.cn"},
        "referer": base_url + "/index.html",
        "csrf": [{"cookie": "csrf_token", "header": "x-csrf-token"}],
        "staticHeaders": {},
        "traceHeader": "Traceid",
        "extraAllowed": True,
    }


def mssp_profile(base_url):
    return {
        "baseUrl": base_url,
        "hostHeader": {"Host": "mssp.sangfor.com.cn"},
        "referer": base_url + "/index.html",
        "csrf": [{"cookie": "csrf_token", "header": "x-csrf-token"}],
        "staticHeaders": {"X-CSRFToken": "mssp-static-token", "timezone": "+08:00"},
        "traceHeader": "Traceid",
        "extraAllowed": True,
    }


# --------------------------------------------------------------------------- #
# S-09 / B-01 / spool contract
# --------------------------------------------------------------------------- #

def test_spool_records_success_and_failure_with_error_count(server, trace_env, monkeypatch):
    """S-09: every helper request hits the real spool file; 5xx raises errorCount."""
    monkeypatch.setenv("MUAD_SKILL_REQUEST_LIMIT", "100")
    server.plans["/ok"] = [(200, '{"ok":true}')]
    server.plans["/boom"] = [(500, '{"error":true}')]

    assert sdk.get(server.base_url + "/ok").status_code == 200
    assert sdk.get(server.base_url + "/boom").status_code == 500
    sdk._flush_summary()

    http_events = events(trace_env, "http")
    assert [item["status"] for item in http_events] == [200, 500]
    assert http_events[0]["host"] == "127.0.0.1:%d" % server.server_port
    assert http_events[0]["method"] == "GET"
    assert http_events[0]["path"] == "/ok"
    assert http_events[0]["errorClass"] == ""
    assert http_events[1]["errorClass"] == "http_500"
    summary = events(trace_env, "summary")[-1]
    assert summary["totalRequests"] == 2
    assert summary["errorCount"] == 1
    assert summary["truncated"] is False
    assert summary["aborted"] is False
    assert stat.S_IMODE(trace_env.stat().st_mode) == 0o600


def test_limit_one_allows_first_and_terminates_second(server, trace_env, terminate, monkeypatch):
    """B-01: the N+1 request is never sent; abort + summary are flushed."""
    monkeypatch.setenv("MUAD_SKILL_REQUEST_LIMIT", "1")
    assert sdk.get(server.base_url + "/targets").status_code == 200

    with pytest.raises(Terminated) as excinfo:
        sdk.get(server.base_url + "/targets")
    assert excinfo.value.code == 86
    assert len(server.records) == 1  # second request never left the process

    abort = events(trace_env, "abort")
    assert len(abort) == 1
    assert abort[0]["reason"] == "request_limit"
    assert abort[0]["count"] == 2
    assert abort[0]["limit"] == 1
    assert abort[0]["interface"] == "GET 127.0.0.1:%d /targets" % server.server_port
    summary = events(trace_env, "summary")[-1]
    assert summary["aborted"] is True
    assert summary["totalRequests"] == 2


def test_limit_zero_is_unlimited_and_detail_caps_at_500(server, trace_env, terminate, monkeypatch):
    """S-10/B-04: limit=0 never terminates; 1000 requests are counted in full."""
    monkeypatch.setenv("MUAD_SKILL_REQUEST_LIMIT", "0")
    with sdk.session() as session:
        for _ in range(1000):
            assert session.get(server.base_url + "/list").status_code == 200
    sdk._flush_summary()

    http_events = events(trace_env, "http")
    summary = events(trace_env, "summary")[-1]
    assert len(http_events) == 500  # detail cap
    assert summary["totalRequests"] == 1000
    assert summary["truncated"] is True
    assert summary["aborted"] is False
    assert summary["hosts"]["127.0.0.1:%d" % server.server_port] == 1000
    assert summary["topInterfaces"][0]["count"] == 1000
    assert not events(trace_env, "abort")


def test_missing_limit_env_does_not_limit(server, trace_env, terminate):
    """B-04: a missing MUAD_SKILL_REQUEST_LIMIT behaves like 0."""
    for _ in range(3):
        assert sdk.get(server.base_url + "/x").status_code == 200
    sdk._flush_summary()
    assert not events(trace_env, "abort")


def test_nothing_is_written_without_spool_env(server, monkeypatch, tmp_path, terminate):
    monkeypatch.delenv("MUAD_TRACE_SPOOL", raising=False)
    monkeypatch.delenv("MUAD_EXECUTION_ID", raising=False)
    assert sdk.get(server.base_url + "/x").status_code == 200
    assert not list(tmp_path.glob("*.jsonl"))


def test_spool_failure_is_silent(server, trace_env, monkeypatch):
    """Audit failures never break the request path."""
    trace_env.parent.joinpath("missing-dir").mkdir()
    monkeypatch.setenv("MUAD_TRACE_SPOOL", str(trace_env.parent / "missing-dir" / "no" / "trace.jsonl"))
    assert sdk.get(server.base_url + "/ok").status_code == 200


# --------------------------------------------------------------------------- #
# B-03 / B-06
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("/api/v1/targets/123", "/api/v1/targets/{id}"),
        ("/api/v1/targets/550e8400-e29b-41d4-a716-446655440000", "/api/v1/targets/{id}"),
        ("/api/v1/targets/deadbeefcafe1234", "/api/v1/targets/{id}"),
        ("/api/v1/targets?page=1&size=20", "/api/v1/targets"),
        ("/api/v1/targets/abc", "/api/v1/targets/abc"),
    ],
)
def test_path_normalization(raw, expected):
    """B-03: numeric/UUID/hex segments collapse to {id}; query is dropped."""
    assert sdk_platform.normalize_path(raw) == expected


def test_traceid_is_unique_uuid4_and_always_rotates():
    """B-06: 1000 header builds produce distinct UUID v4 values."""
    profile = mssw_profile("http://inner.example.com")
    cookies = [cookie("csrf_token", "csrf-value")]
    values = []
    for _ in range(1000):
        headers, trace_id = sdk_platform.build_platform_headers(profile, cookies)
        assert headers["Traceid"] == trace_id
        values.append(trace_id)
    assert len(set(values)) == 1000
    assert all(uuid.UUID(value).version == 4 for value in values)


# --------------------------------------------------------------------------- #
# E-05 concurrency
# --------------------------------------------------------------------------- #

def test_threaded_counting_admits_exactly_limit(server, trace_env, terminate, monkeypatch):
    """E-05: the lock admits exactly N requests; the rest never reach the server."""
    monkeypatch.setenv("MUAD_SKILL_REQUEST_LIMIT", "5")
    barrier = threading.Barrier(20)

    def call():
        barrier.wait()
        try:
            sdk.get(server.base_url + "/parallel")
            return "ok"
        except Terminated:
            return "terminated"

    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _: call(), range(20)))

    assert results.count("ok") == 5
    assert results.count("terminated") == 15
    assert len(server.records) == 5
    # The process would os._exit on the first over-limit attempt, so the
    # summary stops at the N allowed requests plus the terminating attempt.
    summary = events(trace_env, "summary")[-1]
    assert summary["totalRequests"] == 6
    assert summary["aborted"] is True
    assert summary["topInterfaces"][0]["count"] == 6


# --------------------------------------------------------------------------- #
# S-12 / S-13 / B-07 / B-10 / E-10 / E-08 platform flow
# --------------------------------------------------------------------------- #

def test_mssw_platform_request_headers(server, trace_env, tmp_path, monkeypatch):
    """S-12: Cookie/CSRF/Host come from the real state file; Traceid rotates."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc-secret"), cookie("csrf_token", "csrf-secret")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state)
    monkeypatch.setenv("MUAD_SKILL_REQUEST_LIMIT", "10")

    first = sdk.platform_request("mssw", "GET", "/api/v1/targets")
    second = sdk.platform_request("mssw", "GET", "/api/v1/targets")
    assert first.status_code == 200 and second.status_code == 200
    assert calls() == 1  # state file cached across requests

    first_headers = server.records[0]["headers"]
    assert "soc-token=soc-secret" in header(server.records[0], "Cookie")
    assert "csrf_token=csrf-secret" in header(server.records[0], "Cookie")
    assert header(server.records[0], "x-csrf-token") == "csrf-secret"
    assert header(server.records[0], "Host") == "mssw.sangfor.com.cn"
    assert header(server.records[0], "Traceid") != header(server.records[1], "Traceid")
    assert uuid.UUID(header(server.records[1], "Traceid")).version == 4
    assert "Referer" in first_headers

    sdk._flush_summary()
    spool_text = trace_env.read_text(encoding="utf-8")
    assert "soc-secret" not in spool_text
    assert "csrf-secret" not in spool_text
    http_events = events(trace_env, "http")
    assert http_events[0]["platform"] == "mssw"
    assert http_events[0]["traceId"] == header(server.records[0], "Traceid")


def test_mssp_static_headers_do_not_leak_to_mssw(server, trace_env, tmp_path, monkeypatch):
    """S-13/B-07: mssp static headers and timezone stay on the mssp profile."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "mssw-cookie")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            },
            "mssp": {
                "cookies": [cookie("soc-token", "mssp-cookie")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssp_profile(server.base_url),
            },
        },
    )
    install_session_manager(tmp_path, monkeypatch, state)

    sdk.platform_request("mssp", "GET", "/api/v1/assets")
    sdk.platform_request("mssw", "GET", "/api/v1/assets")

    mssp_headers = server.records[0]["headers"]
    mssw_headers = server.records[1]["headers"]
    assert header(server.records[0], "X-CSRFToken") == "mssp-static-token"
    assert header(server.records[0], "timezone") == "+08:00"
    assert header(server.records[0], "Host") == "mssp.sangfor.com.cn"
    assert header(server.records[1], "X-CSRFToken") is None
    assert header(server.records[1], "timezone") is None
    assert header(server.records[1], "Host") == "mssw.sangfor.com.cn"
    assert "mssp-cookie" in header(server.records[0], "Cookie")
    assert "mssw-cookie" in header(server.records[1], "Cookie")
    assert header(server.records[0], "Traceid") != header(server.records[1], "Traceid")
    del mssp_headers, mssw_headers


def test_extra_headers_cannot_override_mandatory_headers(server, trace_env, tmp_path, monkeypatch):
    """S-12: Cookie / CSRF / Traceid are written last and win over caller headers."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "real-cookie"), cookie("csrf_token", "real-csrf")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    install_session_manager(tmp_path, monkeypatch, state)

    sdk.platform_request(
        "mssw",
        "GET",
        "/api/v1/targets",
        headers={"Cookie": "evil=1", "traceid": "evil-trace", "x-csrf-token": "evil-csrf"},
        extra_headers={"Traceid": "evil-extra", "cookie": "evil-extra"},
    )

    record = server.records[0]
    assert "real-cookie" in header(record, "Cookie")
    assert "evil" not in header(record, "Cookie")
    assert header(record, "Traceid") != "evil-trace"
    assert header(record, "Traceid") != "evil-extra"
    assert header(record, "x-csrf-token") == "real-csrf"


@pytest.mark.parametrize("method,status", [("GET", 401), ("GET", 403), ("HEAD", 401), ("HEAD", 403)])
def test_idempotent_401_403_refreshes_and_retries_once(
    server, trace_env, tmp_path, monkeypatch, method, status
):
    """E-10: GET/HEAD refresh the session state once and retry once."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state)
    server.plans["/api/v1/retry"] = [(status, "{}"), (200, '{"ok":true}')]

    response = sdk.platform_request("mssw", method, "/api/v1/retry")

    assert response.status_code == 200
    assert calls() == 2  # initial load + one forced refresh
    assert len(server.records) == 2


def test_post_401_is_returned_without_retry(server, trace_env, tmp_path, monkeypatch):
    """E-10/RISK-13: non-idempotent methods never auto-retry."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state)
    server.default = (401, '{"error":"unauthorized"}')

    response = sdk.platform_request("mssw", "POST", "/api/v1/write", json={"a": 1})

    assert response.status_code == 401
    assert calls() == 1
    assert len(server.records) == 1


def test_second_401_after_refresh_is_returned(server, trace_env, tmp_path, monkeypatch):
    """E-10: only one retry happens even if it fails again."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state)
    server.default = (401, "{}")

    response = sdk.platform_request("mssw", "GET", "/api/v1/retry")

    assert response.status_code == 401
    assert calls() == 2
    assert len(server.records) == 2


def test_refresh_failure_fails_loud_without_sending(server, trace_env, tmp_path, monkeypatch):
    """E-08: failed session refresh raises before any business request is sent."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state, fail_after=-1)

    with pytest.raises(sdk.PlatformSessionError):
        sdk.platform_request("mssw", "GET", "/api/v1/targets")

    assert calls() == 1
    assert server.records == []


def test_401_refresh_failure_fails_loud(server, trace_env, tmp_path, monkeypatch):
    """E-08: the one refresh attempt failing surfaces a loud error."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": mssw_profile(server.base_url),
            }
        },
    )
    calls = install_session_manager(tmp_path, monkeypatch, state, fail_after=1)
    server.default = (401, "{}")

    with pytest.raises(sdk.PlatformSessionError):
        sdk.platform_request("mssw", "GET", "/api/v1/targets")

    assert calls() == 2
    assert len(server.records) == 1


def test_old_state_file_without_profile_falls_back(server, trace_env, tmp_path, monkeypatch, capsys):
    """B-10: legacy state file (cookies only) keeps working with a default profile."""
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "legacy-cookie")],
                "storageState": {"cookies": [], "origins": []},
            }
        },
    )
    install_session_manager(tmp_path, monkeypatch, state)

    response = sdk.platform_request("mssw", "GET", server.base_url + "/api/v1/legacy")

    assert response.status_code == 200
    record = server.records[0]
    assert "legacy-cookie" in header(record, "Cookie")
    assert header(record, "Traceid")
    assert header(record, "x-csrf-token") is None
    captured = capsys.readouterr()
    assert "request profile fallback missing=requestProfile" in captured.err
    assert "legacy-cookie" not in captured.err


def test_profile_can_disable_trace_header(server, trace_env, tmp_path, monkeypatch):
    profile = mssw_profile(server.base_url)
    profile["traceHeader"] = None
    state = write_state_file(
        tmp_path,
        {
            "mssw": {
                "cookies": [cookie("soc-token", "soc")],
                "storageState": {"cookies": [], "origins": []},
                "requestProfile": profile,
            }
        },
    )
    install_session_manager(tmp_path, monkeypatch, state)

    sdk.platform_request("mssw", "GET", "/api/v1/no-trace")

    assert header(server.records[0], "Traceid") is None


# --------------------------------------------------------------------------- #
# E-04 / S-17 raw requests compatibility
# --------------------------------------------------------------------------- #

def test_raw_requests_bypass_the_helper(server, trace_env):
    """E-04: direct requests calls work and produce no interface events."""
    assert requests.get(server.base_url + "/raw").status_code == 200
    sdk._flush_summary()

    assert not events(trace_env, "http")
    summary = events(trace_env, "summary")[-1]
    assert summary["totalRequests"] == 0


def test_mixed_helper_and_raw_requests_only_count_helper(server, trace_env):
    """S-17: helper requests are counted; raw requests still succeed uncounted."""
    assert sdk.get(server.base_url + "/helper").status_code == 200
    assert requests.get(server.base_url + "/raw").status_code == 200
    sdk._flush_summary()

    http_events = events(trace_env, "http")
    assert len(http_events) == 1
    assert http_events[0]["path"] == "/helper"
    assert events(trace_env, "summary")[-1]["totalRequests"] == 1
    assert len(server.records) == 2


def test_session_wrapper_is_context_managed_and_counted(server, trace_env):
    with sdk.session() as session:
        assert session.post(server.base_url + "/session", json={"a": 1}).status_code == 200
    sdk._flush_summary()
    http_events = events(trace_env, "http")
    assert len(http_events) == 1
    assert http_events[0]["method"] == "POST"
