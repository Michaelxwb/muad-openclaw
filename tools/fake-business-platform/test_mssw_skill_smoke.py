#!/usr/bin/env python3
"""End-to-end smoke: fake MSSW + skill SDK + request limit.

Starts the fake platform in ``mssw`` mode, performs the same SigV4-style login
the real ``MSSWSessionAdapter`` performs, writes a skill-scoped session state
file, then runs the ``mssw-platform-smoke`` skill scripts with the repo SDK.

This exercises:
  - AK/SK signature canonicalization and server-side verification;
  - CSRF cookie/header validation;
  - SDK Cookie/CSRF/Traceid header construction;
  - per-interface request accounting and hard abort (exit 86) before the N+1
    request is sent.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "tools/fake-business-platform/server.py"
SKILL = ROOT / "skills/mssw-platform-smoke"
SDK = ROOT / "tools/muad-skill-sdk"
LOGIN_PATH = "/gateway/mss-auth-acl-service/v1/certification/login_agent"
SIGN_PATH = "/v1/certification/login_agent"
CSRF_HEADER = "x-csrftoken"
TRACE_HEADER = "Traceid"


def start_server() -> tuple[subprocess.Popen[str], dict[str, object]]:
    process = subprocess.Popen(
        [sys.executable, str(SERVER), "--platform", "mssw", "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert process.stdout is not None
    line = process.stdout.readline()
    if not line:
        process.terminate()
        raise RuntimeError("fake platform did not become ready")
    return process, json.loads(line)


def login(base_url: str, ak: str, sk: str) -> requests.Session:
    session = requests.Session()
    token_response = session.get(base_url + "/v1/certification/get_token", timeout=5)
    token_response.raise_for_status()
    csrf = session.cookies.get("csrf_token")
    if not csrf:
        raise RuntimeError("fake platform did not issue a csrf cookie")

    timestamp = str(int(time.time()))
    signed = {"content-type": "application/json", "sign-date": timestamp}
    canonical = make_canonical_request("POST", SIGN_PATH, "", signed, "")
    sign_string = "HMAC-SHA256\n%s\n%s" % (timestamp, sha256_hex(canonical))
    signature = hmac.new(sk.encode(), sign_string.encode(), hashlib.sha256).hexdigest().upper()
    authorization = (
        "algorithm=HMAC-SHA256,Access=%s,SignedHeaders=content-type;sign-date,"
        "Signature=%s,sign-date=%s" % (ak, signature, timestamp)
    )
    response = session.post(
        base_url + LOGIN_PATH,
        headers={
            "Authorization": authorization,
            "sign-date": timestamp,
            "Content-Type": "application/json",
            "X-Branch-Tag": "MSSW-ADAPTER",
            CSRF_HEADER: csrf,
        },
        data=b"",
        timeout=5,
    )
    if response.status_code != 200:
        raise RuntimeError("fake platform login failed: %s %s" % (response.status_code, response.text))
    if not session.cookies.get("fake_session"):
        raise RuntimeError("fake platform login did not issue a session cookie")
    return session


def make_canonical_request(method: str, path: str, query: str, signed_headers: dict[str, str], body: str) -> str:
    keys = sorted(signed_headers)
    canonical_query = "&".join(sorted(query.split("&"))) if query else ""
    result = "%s\n%s\n" % (method, path)
    if canonical_query:
        result += canonical_query + "\n"
    result += "".join("%s:%s\n" % (key.lower(), signed_headers[key]) for key in keys)
    result += ";".join(keys)
    if body:
        result += "\n" + sha256_hex(body)
    return result


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest().upper()


def write_state(path: Path, base_url: str, session: requests.Session) -> None:
    host = urlparse(base_url).hostname or "127.0.0.1"
    expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="seconds").replace("+00:00", "Z")
    cookies = [
        {"name": cookie.name, "value": cookie.value, "domain": cookie.domain or host, "path": cookie.path or "/"}
        for cookie in session.cookies
    ]
    state = {
        "version": 1,
        "agentId": "agent-smoke",
        "skillName": "mssw-platform-smoke",
        "humanUserId": "user-smoke",
        "podId": "pod-smoke",
        "platforms": {
            "mssw": {
                "platform": "mssw",
                "source": "refresh",
                "expiresAt": expires,
                "credentialFingerprint": "sha256:smoke",
                "cookies": cookies,
                "storageState": {"cookies": cookies, "origins": []},
                "requestProfile": {
                    "baseUrl": base_url,
                    "hostHeader": {},
                    "csrf": [{"cookie": "csrf_token", "header": CSRF_HEADER}],
                    "staticHeaders": {},
                    "traceHeader": TRACE_HEADER,
                    "extraAllowed": True,
                },
            }
        },
    }
    path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def make_session_manager(bin_dir: Path, state_path: Path) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    cli = bin_dir / "session-manager"
    cli.write_text(
        "#!/usr/bin/env python3\nimport json\nprint(json.dumps({'sessionStateFile': %s}))\n"
        % json.dumps(str(state_path)),
        encoding="utf-8",
    )
    cli.chmod(0o755)


def skill_env(bin_dir: Path, spool: Path, limit: int, execution_id: str) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = "%s%s%s" % (bin_dir, os.pathsep, env.get("PATH", ""))
    env["PYTHONPATH"] = "%s%s%s" % (SDK, os.pathsep, env.get("PYTHONPATH", ""))
    env["MUAD_SKILL_NAME"] = "mssw-platform-smoke"
    env["MUAD_EXECUTION_ID"] = execution_id
    env["MUAD_TRACE_SPOOL"] = str(spool)
    env["MUAD_SKILL_REQUEST_LIMIT"] = str(limit)
    return env


def run_skill(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=str(SKILL),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def main() -> int:
    process, ready = start_server()
    base_url = str(ready["baseUrl"])
    try:
        session = login(base_url, str(ready["ak"]), str(ready["sk"]))
        with tempfile.TemporaryDirectory(prefix="mssw-skill-smoke-") as temporary:
            root = Path(temporary)
            state_path = root / "mssw-platform-smoke.session.json"
            spool = root / "trace.jsonl"
            bin_dir = root / "bin"
            write_state(state_path, base_url, session)
            make_session_manager(bin_dir, state_path)

            result = run_skill(
                [str(SKILL / "scripts/run.py")],
                skill_env(bin_dir, spool, 0, "exec-smoke-" + uuid.uuid4().hex),
            )
            assert result.returncode == 0, "run.py failed: %s" % (result.stderr or result.stdout)
            payload = json.loads(result.stdout.strip().splitlines()[-1])
            assert payload["httpStatus"] == 200, payload
            trace_id = payload.get("trace") or payload.get("traceId")
            assert trace_id and uuid.UUID(str(trace_id)).version == 4, payload

            stats = requests.get(base_url + "/__stats", timeout=5).json()["counts"]
            assert stats.get("/api/v1/ping", 0) >= 1, stats

            raw_env = skill_env(bin_dir, spool, 0, "exec-raw-" + uuid.uuid4().hex)
            raw_env.pop("MUAD_SKILL_NAME", None)
            raw_result = run_skill([str(SKILL / "scripts/run.py")], raw_env)
            assert raw_result.returncode == 4, (
                "raw shell execution must be rejected, got %s: %s"
                % (raw_result.returncode, raw_result.stderr)
            )
            assert "must run through Skill execution" in raw_result.stderr, raw_result.stderr

            requests.get(base_url + "/__stats/reset", timeout=5).raise_for_status()
            limit_spool = root / "limit-trace.jsonl"
            limit_result = run_skill(
                [str(SKILL / "scripts/limit_probe.py")],
                skill_env(bin_dir, limit_spool, 3, "exec-limit-" + uuid.uuid4().hex),
            )
            assert limit_result.returncode == 86, (
                "limit probe expected exit 86, got %s: %s" % (limit_result.returncode, limit_result.stderr)
            )
            summary = json.loads(limit_result.stdout.strip().splitlines()[-1])
            assert summary["status"] == "LIMIT_TRIGGERED", limit_result.stdout
            assert summary["requested"] == 4, "default probe must send limit+1 requests: %s" % summary
            assert summary["sent"] == 3 and summary["limit"] == 3, summary
            events = [json.loads(line) for line in limit_spool.read_text(encoding="utf-8").splitlines() if line.strip()]
            aborts = [event for event in events if event.get("kind") == "abort"]
            assert aborts and aborts[-1].get("count") == 4, events
            stats = requests.get(base_url + "/__stats", timeout=5).json()["counts"]
            requests_before_abort = stats.get("/api/v1/ping", 0)
            assert requests_before_abort == 3, "the N+1 request must not reach the server: %s" % stats

            requests.get(base_url + "/__stats/reset", timeout=5).raise_for_status()
            below_limit = run_skill(
                [str(SKILL / "scripts/limit_probe.py"), "--count", "2"],
                skill_env(bin_dir, root / "below-limit-trace.jsonl", 3, "exec-below-" + uuid.uuid4().hex),
            )
            assert below_limit.returncode == 0, below_limit.stderr
            below_summary = json.loads(below_limit.stdout.strip().splitlines()[-1])
            assert below_summary["status"] == "LIMIT_NOT_TRIGGERED", below_limit.stdout
            assert below_summary["sent"] == 2 and below_summary["limit"] == 3, below_summary

            print(json.dumps({
                "status": "MSSW_SKILL_SMOKE_OK",
                "traceId": trace_id,
                "limitExitCode": limit_result.returncode,
                "requestsBeforeAbort": requests_before_abort,
            }))
            return 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write("%s\n" % error)
        sys.exit(1)
