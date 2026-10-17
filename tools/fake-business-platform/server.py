#!/usr/bin/env python3
"""Standalone business-platform simulator for session/SDK smoke tests.

Two modes:

- ``smoke_platform`` (default): cookie-based login used by the existing
  session-manager smoke tests. Behaviour is unchanged.
- ``mssw``: models the MSSW gateway contract closely enough to exercise the
  real ``MSSWSessionAdapter`` (SigV4-style AK/SK login, CSRF cookie/header,
  health endpoint) and the ``muad_skill_http.platform_request`` SDK
  (Cookie/CSRF/Host/static headers/Traceid).

The service intentionally has no session-manager import; it is a plain HTTP
server so both Node tests and Python skill scripts can drive it.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import secrets
import sys
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse


MAX_BODY_BYTES = 8192
GATEWAY_PREFIX = "/gateway/"
MSSW_LOGIN_PATH = "/gateway/mss-auth-acl-service/v1/certification/login_agent"
MSSW_GET_TOKEN_PATH = "/v1/certification/get_token"
MSSW_HEALTH_PATH = "/v1/rtt"
MSSW_PING_PATH = "/api/v1/ping"
MSSW_TARGETS_PATH = "/api/v1/targets"
MSSW_TRACE_HEADER = "Traceid"

# Recognized logins for the legacy smoke_platform mode. Add a
# "username": "password" pair here and restart the service to enable another
# account; every account can be logged in at once.
ACCOUNTS: dict[str, str] = {
    "demo": "demo-pass",
    "michael": "michael-pass",
}

# Business error codes, modeled on MSSW: /login always answers HTTP 200 and the
# outcome lives in the JSON body's "code" field. Session smoke tests use these
# to exercise the session-manager error classification path end to end.
CODE_SUCCESS = 0
CODE_PARAMS_ERR = 1001
CODE_AUTH_FAILED = 1002
CODE_ACCOUNT_LOCKED = 1003
CODE_RATE_LIMITED = 1004
CODE_SERVICE_ERR = 1005

# Username prefixes that trigger a non-auth account-state error even when the
# password is correct, so tests can hit every classification branch. The rest
# of the name is arbitrary (e.g. "locked-alice").
ERROR_PREFIX_CODES: dict[str, int] = {
    "locked-": CODE_ACCOUNT_LOCKED,
    "ratelimited-": CODE_RATE_LIMITED,
    "serviceerr-": CODE_SERVICE_ERR,
}


class FakeBusinessPlatform(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], args: argparse.Namespace):
        super().__init__(address, handler)
        self.accounts: dict[str, str] = dict(ACCOUNTS)
        self.platform = args.platform
        self.cookie_name = args.cookie_name
        self.session_ttl = args.session_ttl
        self.verbose = args.verbose
        self.ak = args.ak
        self.sk = args.sk
        self.csrf_enabled = not args.no_csrf
        self.request_counts: dict[str, int] = {}
        # Tokens issued by /v1/certification/get_token. The adapter fetches the
        # token and sends it as a header on login without a cookie jar, so login
        # validates the header against this set; business calls validate the
        # cookie/header pair on the session.
        self.csrf_tokens: set[str] = set()
        # token -> (expires_at, username)
        self.sessions: dict[str, tuple[float, str]] = {}


class Handler(BaseHTTPRequestHandler):
    server: FakeBusinessPlatform

    def _log_headers(self) -> None:
        # 打印每个请求的方法/路径/协议与全部请求头，便于调试适配器是否真的带上了
        # hostHeader（如 Host / X-Tag）。写 stderr，与 BaseHTTPRequestHandler 日志一致。
        lines = [f"{self.command} {self.path} {self.request_version}"]
        for key, value in self.headers.items():
            lines.append(f"  {key}: {value}")
        sys.stderr.write("\n".join(lines) + "\n")

    def do_POST(self) -> None:
        self._log_headers()
        path = urlparse(self.path).path
        if self.server.platform == "mssw":
            self._mssw_login(path)
            return
        if path != "/login":
            self._send_json(404, {"error": "not_found"})
            return
        payload = self._read_json_body()
        if payload is None or not payload.get("username") or not payload.get("password"):
            self._send_business_error(CODE_PARAMS_ERR, "username and password are required")
            return
        username = str(payload.get("username"))
        for prefix, code in ERROR_PREFIX_CODES.items():
            if username.startswith(prefix):
                self._send_business_error(code, f"account {prefix.rstrip('-')}")
                return
        if not self._valid_credentials(payload):
            self._send_business_error(CODE_AUTH_FAILED, "invalid credentials")
            return
        token = secrets.token_urlsafe(24)
        expires_at = time.time() + self.server.session_ttl
        self.server.sessions[token] = (expires_at, username)
        self._send_json(
            200,
            {"code": CODE_SUCCESS, "authenticated": True, "user": username, "expiresAt": iso_time(expires_at)},
            [("Set-Cookie", self._session_cookie(token))],
        )

    def do_GET(self) -> None:
        self._log_headers()
        parsed = urlparse(self.path)
        path = parsed.path
        if self.server.platform == "mssw":
            self._mssw_get(path)
            return
        if path == "/":
            self._send_html(200, self._home_page())
            return
        if path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        if path == "/health/session":
            self._send_auth_json({"ok": True})
            return
        if path == "/api/me":
            identity = self._session_identity()
            if identity is None:
                self._send_json(401, {"authenticated": False})
                return
            self._send_json(200, {"authenticated": True, "user": identity[1]})
            return
        self._send_json(404, {"error": "not_found"})

    # ------------------------------------------------------------------ #
    # MSSW mode
    # ------------------------------------------------------------------ #

    def _mssw_login(self, path: str) -> None:
        if path != MSSW_LOGIN_PATH:
            self._send_json(404, {"error": "not_found"})
            return
        body = self._read_body_text()
        if body is None:
            self._send_json(400, {"code": CODE_PARAMS_ERR, "msg": "unreadable body"})
            return
        if not self._verify_signature("POST", path, urlparse(self.path).query, body):
            self._send_json(401, {"code": CODE_AUTH_FAILED, "msg": "signature invalid"})
            return
        csrf = self.headers.get("x-csrftoken", "")
        if self.server.csrf_enabled and csrf not in self.server.csrf_tokens:
            self._send_json(403, {"code": CODE_AUTH_FAILED, "msg": "csrf token invalid"})
            return
        token = secrets.token_urlsafe(24)
        expires_at = time.time() + self.server.session_ttl
        self.server.sessions[token] = (expires_at, "demo")
        if not csrf:
            csrf = secrets.token_urlsafe(16)
            self.server.csrf_tokens.add(csrf)
        headers = [
            ("Set-Cookie", self._session_cookie(token)),
            ("Set-Cookie", self._csrf_cookie(csrf)),
        ]
        self._send_json(200, {"code": CODE_SUCCESS, "authenticated": True, "user": "demo"}, headers)

    def _mssw_get(self, path: str) -> None:
        if path == "/__stats":
            self._send_json(200, {"counts": dict(self.server.request_counts)})
            return
        if path == "/__stats/reset":
            self.server.request_counts.clear()
            self._send_json(200, {"ok": True})
            return
        if path == "/":
            self._send_html(200, self._home_page())
            return
        if path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        if path == MSSW_GET_TOKEN_PATH:
            csrf = secrets.token_urlsafe(16)
            self.server.csrf_tokens.add(csrf)
            self._send_json(200, {"code": CODE_SUCCESS}, [("Set-Cookie", self._csrf_cookie(csrf))])
            return
        if path == MSSW_HEALTH_PATH:
            if self._session_identity() is None:
                self._send_json(401, {"code": CODE_AUTH_FAILED, "msg": "no session"})
                return
            self._send_json(200, {"code": CODE_SUCCESS})
            return
        if path in (MSSW_PING_PATH, MSSW_TARGETS_PATH):
            identity = self._session_identity()
            if identity is None:
                self._send_json(401, {"code": CODE_AUTH_FAILED, "msg": "no session"})
                return
            if self.server.csrf_enabled and not self._csrf_valid():
                self._send_json(403, {"code": CODE_AUTH_FAILED, "msg": "csrf token invalid"})
                return
            self.server.request_counts[path] = self.server.request_counts.get(path, 0) + 1
            trace_id = self.headers.get(MSSW_TRACE_HEADER, "")
            payload: dict[str, Any] = {
                "code": CODE_SUCCESS,
                "user": identity[1],
                "traceId": trace_id,
                "path": path,
            }
            if path == MSSW_TARGETS_PATH:
                payload["items"] = [{"id": index, "name": f"target-{index}"} for index in range(1, 4)]
            self._send_json(200, payload)
            return
        self._send_json(404, {"error": "not_found"})

    def _verify_signature(self, method: str, path: str, query: str, body: str) -> bool:
        auth = self._parse_authorization(self.headers.get("Authorization", ""))
        if not auth:
            return False
        if auth.get("algorithm") != "HMAC-SHA256" or auth.get("Access") != self.server.ak:
            return False
        signed_names = [item for item in auth.get("SignedHeaders", "").split(";") if item]
        if not {"sign-date", "content-type"}.issubset(set(signed_names)):
            return False
        signed_headers = {name.lower(): self.headers.get(name, "") for name in signed_names}
        # The real adapter carries sign-date inside Authorization rather than as a
        # separate header; canonicalization must use that value.
        if not signed_headers.get("sign-date"):
            signed_headers["sign-date"] = auth.get("sign-date", "")
        timestamp = signed_headers.get("sign-date", "")
        if not timestamp:
            return False
        canonical = make_canonical_request(method, strip_gateway_prefix(path), query, signed_headers, body)
        sign_str = f"HMAC-SHA256\n{timestamp}\n{sha256_hex(canonical)}"
        expected = hmac.new(self.server.sk.encode("utf-8"), sign_str.encode("utf-8"), hashlib.sha256).hexdigest().upper()
        return hmac.compare_digest(expected, auth.get("Signature", "").upper())

    @staticmethod
    def _parse_authorization(value: str) -> dict[str, str]:
        result: dict[str, str] = {}
        for part in value.split(","):
            key, separator, item = part.strip().partition("=")
            if separator and key:
                result[key.strip()] = item.strip()
        return result

    def _csrf_valid(self) -> bool:
        cookie_value = self._cookie_value("csrf_token")
        header_value = self.headers.get("x-csrftoken", "")
        return bool(cookie_value and header_value and hmac.compare_digest(cookie_value, header_value))

    def _cookie_value(self, name: str) -> str:
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except cookies.CookieError:
            return ""
        morsel = jar.get(name)
        return morsel.value if morsel is not None else ""

    def _csrf_cookie(self, value: str) -> str:
        return (
            f"csrf_token={value}; Path=/; HttpOnly; "
            f"SameSite=Lax; Max-Age={self.server.session_ttl}"
        )

    # ------------------------------------------------------------------ #
    # shared helpers
    # ------------------------------------------------------------------ #

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.server.verbose:
            super().log_message(fmt, *args)

    def _send_auth_json(self, payload: dict[str, Any]) -> None:
        if self._session_identity() is None:
            self._send_json(401, {"authenticated": False})
            return
        self._send_json(200, payload)

    def _send_business_error(self, code: int, msg: str) -> None:
        self._send_json(200, {"code": code, "msg": msg, "authenticated": False})

    def _read_body_text(self) -> str | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            return None
        try:
            return self.rfile.read(length).decode("utf-8")
        except UnicodeDecodeError:
            return None

    def _read_json_body(self) -> dict[str, Any] | None:
        text = self._read_body_text()
        if text is None:
            return None
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def _valid_credentials(self, payload: dict[str, Any]) -> bool:
        return self.server.accounts.get(payload.get("username")) == payload.get("password")

    def _session_identity(self) -> tuple[str, str] | None:
        token = self._cookie_value(self.server.cookie_name)
        if not token:
            return None
        session = self.server.sessions.get(token)
        if session is None or session[0] <= time.time():
            return None
        return token, session[1]

    def _session_cookie(self, token: str) -> str:
        return (
            f"{self.server.cookie_name}={token}; Path=/; HttpOnly; "
            f"SameSite=Lax; Max-Age={self.server.session_ttl}"
        )

    def _home_page(self) -> str:
        status = "logged-in" if self._session_identity() else "logged-out"
        return (
            "<!doctype html><html><head><title>Fake Business Platform</title></head>"
            f"<body><main id=\"status\">{status}</main></body></html>"
        )

    def _send_json(
        self, status: int, payload: dict[str, Any], headers: list[tuple[str, str]] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, status: int, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def make_canonical_request(
    method: str,
    path: str,
    query: str,
    signed_headers: dict[str, str],
    body: str,
) -> str:
    canonical_query = "&".join(sorted(query.split("&"))) if query else ""
    keys = sorted(signed_headers)
    canon_headers = "".join(f"{key.lower()}:{signed_headers[key]}\n" for key in keys)
    result = f"{method}\n{path}\n"
    if canonical_query:
        result += f"{canonical_query}\n"
    result += f"{canon_headers}{';'.join(keys)}"
    if body:
        result += f"\n{sha256_hex(body)}"
    return result


def sha256_hex(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest().upper()


def strip_gateway_prefix(path: str) -> str:
    if not path.startswith(GATEWAY_PREFIX):
        return path
    rest = path[len(GATEWAY_PREFIX):]
    slash = rest.find("/")
    return rest[slash:] if slash >= 0 else "/"


def iso_time(epoch_seconds: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_seconds))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a fake business platform.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--platform", choices=("smoke_platform", "mssw"), default="smoke_platform")
    parser.add_argument("--cookie-name", default="fake_session")
    parser.add_argument("--session-ttl", type=int, default=900)
    parser.add_argument("--ak", default="test-ak")
    parser.add_argument("--sk", default="test-sk")
    parser.add_argument("--no-csrf", action="store_true", help="Disable CSRF validation in mssw mode")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = FakeBusinessPlatform((args.host, args.port), Handler, args)
    host = "127.0.0.1" if args.host in ("", "0.0.0.0", "::") else args.host
    base_url = f"http://{host}:{server.server_port}"
    ready: dict[str, Any] = {"status": "ready", "baseUrl": base_url, "platform": args.platform}
    if args.platform == "mssw":
        ready.update({
            "ak": args.ak,
            "sk": args.sk,
            "csrfEnabled": not args.no_csrf,
            "sessionEndpoint": MSSW_LOGIN_PATH,
            "healthEndpoint": MSSW_HEALTH_PATH,
            "pingEndpoint": MSSW_PING_PATH,
        })
    print(json.dumps(ready), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
