#!/usr/bin/env python3
"""Resolve the current user's MSSP session through session-manager."""

import json
import os
import subprocess
from typing import Callable, Dict, List


SKILL_NAME = "policy-check-mssp"
PLATFORM = "mssp"


class MSSPSession:
    """In-process MSSP session that can reacquire its cookie safely."""

    def __init__(self, cookie: str, loader: Callable[[], str]):
        self._cookie = cookie
        self._loader = loader

    @property
    def cookie(self) -> str:
        return self._cookie

    def refresh(self) -> bool:
        refreshed = self._loader()
        changed = refreshed != self._cookie
        self._cookie = refreshed
        return changed


def _cookie_pairs(cookies: List[dict]) -> List[str]:
    pairs = []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        name = cookie.get("name")
        value = cookie.get("value")
        if isinstance(name, str) and isinstance(value, str):
            pairs.append(f"{name}={value}")
    return pairs


def _load_session_file(path: str) -> Dict:
    if not path or not os.path.isfile(path):
        raise RuntimeError("未获取到 MSSP 登录态文件，请确认老平台凭据已配置")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("MSSP 登录态文件读取失败") from exc


def get_cookie(run: Callable = subprocess.run) -> str:
    """Return a Cookie header without exposing session material to logs."""
    command = ["session-manager", "get-state", "--skill-name", SKILL_NAME]
    try:
        result = run(command, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("调用 session-manager 失败") from exc
    if result.returncode != 0:
        raise RuntimeError("获取 MSSP 登录态失败，请确认老平台凭据有效")
    try:
        state = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("session-manager 返回格式无效") from exc
    session = _load_session_file(state.get("sessionStateFile", ""))
    cookies = session.get("platforms", {}).get(PLATFORM, {}).get("cookies", [])
    pairs = _cookie_pairs(cookies) if isinstance(cookies, list) else []
    if not pairs:
        raise RuntimeError("MSSP 登录态中没有可用 Cookie")
    return "; ".join(pairs)


def get_session(run: Callable = subprocess.run) -> MSSPSession:
    """Acquire a session whose cookie can be refreshed after a request failure."""
    return MSSPSession(get_cookie(run), lambda: get_cookie(run))


def extract_cookie_value(cookie: str, key: str) -> str:
    for item in cookie.split(";"):
        name, separator, value = item.strip().partition("=")
        if separator and name == key:
            return value
    return ""
