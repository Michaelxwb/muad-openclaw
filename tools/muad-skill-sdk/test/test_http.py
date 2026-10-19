"""Acceptance tests for the muad_skill_http SDK (TASK-007).

Covers S-09/S-10/S-12/S-13/S-17/E-04/E-05/E-08/E-10/B-01/B-03/B-04/B-06/B-07/B-10.
The tests use real spool files, a real local HTTP server, a real session state
file and a real `session-manager` executable on PATH; only the transport target
of the platform itself is a local test server (the "httptest" boundary).
"""

from __future__ import annotations

import json
import stat
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests

import muad_skill_http as sdk
from muad_skill_http import _trace as sdk_trace
from muad_skill_http import _normalize as sdk_normalize
from muad_skill_http import compat as sdk_compat


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
    assert sdk_normalize.normalize_path(raw) == expected


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
# Local development helpers
# --------------------------------------------------------------------------- #

def test_cookies_from_header_parses_browser_cookie_header():
    assert sdk.cookies_from_header("Cookie: soc-token=abc; csrf_token=x=y") == [
        {"name": "soc-token", "value": "abc"},
        {"name": "csrf_token", "value": "x=y"},
    ]
    assert sdk.cookies_from_header(' a=1; ; b="two" ') == [
        {"name": "a", "value": "1"},
        {"name": "b", "value": "two"},
    ]
    assert sdk.cookies_from_header("") == []


def test_build_local_state_shape():
    state = sdk.build_local_state(
        "mssw",
        "Cookie: soc-token=soc-secret; csrf_token=csrf-secret",
        base_url="https://mssw.example",
        host_header={"Host": "mssw.sangfor.com.cn"},
        csrf=[{"cookie": "csrf_token", "header": "x-csrf-token"}],
    )
    section = state["platforms"]["mssw"]
    assert [item["name"] for item in section["cookies"]] == ["soc-token", "csrf_token"]
    assert section["requestProfile"]["baseUrl"] == "https://mssw.example"
    assert section["requestProfile"]["hostHeader"] == {"Host": "mssw.sangfor.com.cn"}
    assert section["requestProfile"]["csrf"] == [{"cookie": "csrf_token", "header": "x-csrf-token"}]


def test_build_local_state_validates_required_inputs():
    with pytest.raises(ValueError):
        sdk.build_local_state("mssw", "", base_url="http://127.0.0.1")
    with pytest.raises(ValueError):
        sdk.build_local_state("mssw", "a=1", base_url="")


def test_merge_local_states_combines_platforms():
    mssw = sdk.build_local_state("mssw", "a=1", base_url="https://mssw.example")
    mssp = sdk.build_local_state("mssp", "b=2", base_url="https://mssp.example")

    merged = sdk.merge_local_states(mssw, mssp)
    assert set(merged["platforms"]) == {"mssw", "mssp"}

    with pytest.raises(ValueError):
        sdk.merge_local_states(mssw, mssw)
    with pytest.raises(ValueError):
        sdk.merge_local_states({})


def test_merged_local_state_shape():
    mssw = sdk.build_local_state(
        "mssw",
        "soc-token=mssw-cookie",
        base_url="https://mssw.example",
        host_header={"Host": "mssw.sangfor.com.cn"},
        csrf=[{"cookie": "csrf_token", "header": "x-csrf-token"}],
    )
    mssp = sdk.build_local_state(
        "mssp",
        "soc-token=mssp-cookie",
        base_url="https://mssp.example",
        host_header={"Host": "mssp.sangfor.com.cn"},
        static_headers={"X-CSRFToken": "mssp-static-token", "timezone": "+08:00"},
    )
    merged = sdk.merge_local_states(mssw, mssp)
    assert set(merged["platforms"]) == {"mssw", "mssp"}
    assert merged["platforms"]["mssw"]["cookies"][0]["value"] == "mssw-cookie"
    assert merged["platforms"]["mssp"]["cookies"][0]["value"] == "mssp-cookie"


# --------------------------------------------------------------------------- #
# requests compat
# --------------------------------------------------------------------------- #

def _secondary_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.records = []
    httpd.plans = {}
    httpd.default = (200, '{"ok":true}')
    httpd.lock = threading.Lock()
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, thread


def test_compat_instruments_every_http_method(server, trace_env, monkeypatch):
    monkeypatch.setenv("MUAD_REQUESTS_COMPAT", "1")
    monkeypatch.setenv("MUAD_BUSINESS_HOSTS", "127.0.0.1:%d" % server.server_port)
    assert sdk_compat.install() is True
    try:
        calls = [
            ("GET", lambda: requests.get(server.base_url + "/methods")),
            ("POST", lambda: requests.post(server.base_url + "/methods")),
            ("PUT", lambda: requests.put(server.base_url + "/methods")),
            ("PATCH", lambda: requests.patch(server.base_url + "/methods")),
            ("DELETE", lambda: requests.delete(server.base_url + "/methods")),
            ("HEAD", lambda: requests.head(server.base_url + "/methods")),
        ]
        for _, call in calls:
            assert call().status_code == 200

        sdk._flush_summary()
        http_events = events(trace_env, "http")
        assert [item["method"] for item in http_events] == [name for name, _ in calls]
        for item in http_events:
            assert uuid.UUID(item["traceId"]).version == 4
        assert len({item["traceId"] for item in http_events}) == len(calls)
    finally:
        sdk_compat.uninstall()


def test_compat_instruments_only_allowlisted_hosts(server, trace_env, monkeypatch):
    monkeypatch.setenv("MUAD_REQUESTS_COMPAT", "1")
    monkeypatch.setenv("MUAD_BUSINESS_HOSTS", "127.0.0.1:%d" % server.server_port)
    other, other_thread = _secondary_server()
    try:
        assert sdk_compat.install() is True

        allowed = requests.get(server.base_url + "/business")
        assert allowed.status_code == 200
        allowed_trace = header(server.records[0], "TraceId")
        allowed_csrf = header(server.records[0], "X-Csrftoken")
        assert uuid.UUID(allowed_trace).version == 4
        assert uuid.UUID(allowed_csrf).version == 4

        other_url = "http://127.0.0.1:%d/non-business" % other.server_port
        assert requests.get(other_url).status_code == 200
        assert header(other.records[0], "TraceId") is None
        assert header(other.records[0], "X-Csrftoken") is None

        sdk._flush_summary()
        http_events = events(trace_env, "http")
        assert [item["path"] for item in http_events] == ["/business"]
        assert http_events[0]["traceId"] == allowed_trace
    finally:
        sdk_compat.uninstall()
        other.shutdown()
        other.server_close()
        other_thread.join(timeout=2)


def test_compat_overrides_existing_trace_and_csrf_headers(server, trace_env, monkeypatch):
    monkeypatch.setenv("MUAD_REQUESTS_COMPAT", "1")
    monkeypatch.setenv("MUAD_BUSINESS_HOSTS", "127.0.0.1:%d" % server.server_port)
    try:
        assert sdk_compat.install() is True
        response = requests.get(
            server.base_url + "/override",
            headers={"Traceid": "old-trace", "X-Csrftoken": "old-csrf"},
        )
        assert response.status_code == 200
        record = server.records[0]
        assert header(record, "TraceId") != "old-trace"
        assert header(record, "X-Csrftoken") != "old-csrf"
        assert uuid.UUID(header(record, "TraceId")).version == 4
        assert uuid.UUID(header(record, "X-Csrftoken")).version == 4
    finally:
        sdk_compat.uninstall()


def test_compat_does_not_double_count_sdk_helpers(server, trace_env, monkeypatch):
    monkeypatch.setenv("MUAD_REQUESTS_COMPAT", "1")
    monkeypatch.setenv("MUAD_BUSINESS_HOSTS", "127.0.0.1:%d" % server.server_port)
    try:
        assert sdk_compat.install() is True
        assert sdk.get(server.base_url + "/helper").status_code == 200
        sdk._flush_summary()
        summary = events(trace_env, "summary")[-1]
        assert summary["totalRequests"] == 1
        assert len(events(trace_env, "http")) == 1
    finally:
        sdk_compat.uninstall()


def test_shared_limit_counter_is_shared_between_recorders(tmp_path, terminate):
    spool = tmp_path / "exec.jsonl"
    first = sdk_trace.TraceRecorder(str(spool), "exec-shared", 2)
    second = sdk_trace.TraceRecorder(str(spool), "exec-shared", 2)

    first.admit("host", "GET", "/shared")
    first.admit("host", "GET", "/shared")
    with pytest.raises(Terminated) as excinfo:
        second.admit("host", "GET", "/shared")
    assert excinfo.value.code == 86

    counter = json.loads((tmp_path / "exec.jsonl.limit.json").read_text(encoding="utf-8"))
    assert counter["total"] == 3
    assert counter["interfaces"]["GET host /shared"] == 3
    assert counter["aborted"] is True
    assert counter["abortCount"] == 3


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
