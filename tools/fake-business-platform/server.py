#!/usr/bin/env python3
"""Small standalone HTTP service used by session smoke tests.

The service intentionally has no session-manager knowledge. It only exposes a
login endpoint that issues a cookie and business endpoints that require it.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse


MAX_BODY_BYTES = 8192

# Recognized logins. Add a "username": "password" pair here and restart the
# service to enable another account; every account can be logged in at once.
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
        self.cookie_name = args.cookie_name
        self.session_ttl = args.session_ttl
        self.verbose = args.verbose
        # token -> (expires_at, username)
        self.sessions: dict[str, tuple[float, str]] = {}


class Handler(BaseHTTPRequestHandler):
    server: FakeBusinessPlatform

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/login":
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
            {"Set-Cookie": self._session_cookie(token)},
        )

    def do_GET(self) -> None:
        path = urlparse(self.path).path
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

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _valid_credentials(self, payload: dict[str, Any]) -> bool:
        return self.server.accounts.get(payload.get("username")) == payload.get("password")

    def _session_identity(self) -> tuple[str, str] | None:
        header = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie()
        try:
            jar.load(header)
        except cookies.CookieError:
            return None
        morsel = jar.get(self.server.cookie_name)
        if morsel is None:
            return None
        session = self.server.sessions.get(morsel.value)
        if session is None or session[0] <= time.time():
            return None
        return morsel.value, session[1]

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

    def _send_json(self, status: int, payload: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
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


def iso_time(epoch_seconds: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_seconds))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a fake cookie-based business platform.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--cookie-name", default="fake_session")
    parser.add_argument("--session-ttl", type=int, default=900)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = FakeBusinessPlatform((args.host, args.port), Handler, args)
    host = "127.0.0.1" if args.host in ("", "0.0.0.0", "::") else args.host
    base_url = f"http://{host}:{server.server_port}"
    print(json.dumps({"status": "ready", "baseUrl": base_url}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
