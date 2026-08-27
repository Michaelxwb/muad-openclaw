#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""策略检查（policy-check）共享模块（muad 改造版）

对外 API 与旧版基本保持一致（log / load_api_config / get_origin / get_endpoint /
get_base / get_cookie / extract_cookie_value / request_with_retry /
load_session / save_session / clean_reports），各 phase 文件改动量很小。

相对旧版的关键差异：
  1. 登录态：get_cookie() 由 muad 的 session-manager 代管（经 guard 注入的
     MUAD_SESSION_KEY 决定 agent 身份），不再手动粘贴 Cookie / 读 cookie 文件。
  2. 写目录：会话/候选/报告统一写到 guard 注入的 SKILL_OUTPUT_DIR（per-user 隔离，
     skill 根目录只读）。缺失时仅开发调试 fallback 到本地临时目录。
  3. 移除企微通知：不再原生依赖出网 webhook。
  4. 业务 URL：origin 默认读 config/api_config.json，支持环境变量 POLICY_CHECK_BASE_URL 覆盖。
"""

import json
import os
import subprocess
import sys
import time
import warnings
from datetime import datetime
from typing import Any, Dict, Optional

import requests

warnings.filterwarnings("ignore", message="Unverified HTTPS request")
# 禁止向只读 skill 根写 __pycache__
sys.dont_write_bytecode = True

SKILL_NAME = "policy-check"
PLATFORM = "mssw"

# 项目根目录（skill 安装目录，含 config/、shared/、phase*/）
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# 重试常量
# ─────────────────────────────────────────────────────────────
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds


# ─────────────────────────────────────────────────────────────
# 日志
# ─────────────────────────────────────────────────────────────
def log(msg: str, level: str = "INFO") -> None:
    """统一日志输出，格式: [HH:MM:SS] [LEVEL] msg（进度日志走 stdout，不入输出目录）"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────
# API 端点配置
# ─────────────────────────────────────────────────────────────
_API_CONFIG_CACHE: Optional[Dict[str, Any]] = None
_API_CONFIG_PATH = os.path.join(POLICY_CHECK_ROOT, "config", "api_config.json")


def load_api_config(force_reload: bool = False) -> Dict[str, Any]:
    """读取 config/api_config.json，结果在进程内缓存。"""
    global _API_CONFIG_CACHE
    if _API_CONFIG_CACHE is not None and not force_reload:
        return _API_CONFIG_CACHE
    if not os.path.exists(_API_CONFIG_PATH):
        raise RuntimeError(f"API 配置文件不存在: {_API_CONFIG_PATH}")
    with open(_API_CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    _API_CONFIG_CACHE = cfg
    return cfg


def get_origin() -> str:
    """取业务 API 域名。优先 POLICY_CHECK_BASE_URL env，其次 config/origin（沿用原值）。"""
    env_origin = os.environ.get("POLICY_CHECK_BASE_URL")
    if env_origin:
        return env_origin.rstrip("/")
    cfg = load_api_config()
    origin = cfg.get("origin")
    if not origin:
        raise KeyError("api_config.json 缺少顶层 origin 配置项")
    return origin.rstrip("/")


def get_host_header() -> str:
    """取统一请求 Host 头（nginx 靠 Host 路由）；无配置回退 inner.sangfor.com.cn。"""
    cfg = load_api_config()
    return str(cfg.get("host_header") or "inner.sangfor.com.cn")


def get_endpoint(key: str) -> str:
    """便捷取 endpoints[key] 并与 origin 拼接成完整 URL。"""
    cfg = load_api_config()
    endpoints = cfg.get("endpoints", {})
    if key not in endpoints:
        raise KeyError(f"api_config.json 缺少 endpoints.{key} 配置项")
    value = endpoints[key]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError(
            f"api_config.json endpoints.{key} 必须以 '/' 开头（相对路径）"
            f" 或为完整 http(s):// URL，当前值: {value!r}"
        )
    return get_origin() + value


def get_base(key: str) -> str:
    """便捷取 base[key]，若值为相对路径则用 get_origin() 拼接。"""
    cfg = load_api_config()
    base = cfg.get("base", {})
    if key not in base:
        raise KeyError(f"api_config.json 缺少 base.{key} 配置项")
    value = base[key]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    return get_origin() + value


# ─────────────────────────────────────────────────────────────
# 登录态（session-manager 代管，不再手动 Cookie）
# ─────────────────────────────────────────────────────────────
def get_cookie(args_cookie: Optional[str] = None) -> str:
    """获取当前 agent 的 mssw 平台 Cookie（经 session-manager）。

    - 身份由 guard 注入的 MUAD_SESSION_KEY 决定，脚本不自报。
    - cookie 不写入 stdout / 日志。
    - 旧的手动粘贴/文件读取/字符混淆校验已废弃，args_cookie 参数保留仅为兼容调用方。
    """
    cmd = ["session-manager", "get-state", "--skill-name", SKILL_NAME]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        raise RuntimeError(f"调用 session-manager 失败: {e}") from e

    if result.returncode != 0:
        raise RuntimeError(f"获取登录态失败: {(result.stderr or result.stdout or '').strip()}")

    try:
        state = json.loads(result.stdout)
    except Exception as e:
        raise RuntimeError(f"session-manager 输出解析失败: {e}") from e

    session_file = state.get("sessionStateFile")
    if not session_file or not os.path.exists(session_file):
        raise RuntimeError("未获取到登录态文件，请先确认 mssw 平台已绑定并登录")

    try:
        with open(session_file, "r", encoding="utf-8") as f:
            session = json.load(f)
    except Exception as e:
        raise RuntimeError(f"读取登录态文件失败: {e}") from e

    section = (session or {}).get("platforms", {}).get(PLATFORM)
    cookies = (section or {}).get("cookies")
    if not isinstance(cookies, list) or not cookies:
        raise RuntimeError(f"登录态缺少 {PLATFORM} 平台 cookie")

    pairs = []
    for c in cookies:
        if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("value"), str):
            pairs.append(f"{c['name']}={c['value']}")
    if not pairs:
        raise RuntimeError(f"登录态 {PLATFORM} 平台的 cookie 无效")
    return "; ".join(pairs)


def extract_cookie_value(cookie: str, key: str) -> Optional[str]:
    """从 Cookie 字符串中提取指定 key 的值（用于 csrf_token）。"""
    if not cookie:
        return None
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


# ─────────────────────────────────────────────────────────────
# HTTP 请求
# ─────────────────────────────────────────────────────────────
def request_with_retry(method: str, url: str, headers: dict, timeout: int = 30,
                       **kwargs) -> requests.Response:
    """带重试的 HTTP 请求，返回 requests.Response。

    - 自动从 headers['cookie']（小写 key）或改造版 build_raw_headers 中提取 csrf_token。
    - 失败重试 MAX_RETRIES 次，超过后抛原异常（fail loud）。
    """
    cookie = headers.get("cookie") or headers.get("Cookie") or ""
    if cookie:
        csrf_token = extract_cookie_value(cookie, "csrf_token")
        if csrf_token:
            headers["X-Csrftoken"] = csrf_token

    for attempt in range(MAX_RETRIES):
        try:
            if method.upper() == "POST":
                return requests.post(url, headers=headers, timeout=timeout, verify=False, **kwargs)
            return requests.get(url, headers=headers, timeout=timeout, verify=False, **kwargs)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError, requests.exceptions.RequestException) as e:
            log(f"请求失败 (尝试 {attempt + 1}/{MAX_RETRIES}) - {e}", "WARNING")
            if attempt < MAX_RETRIES - 1:
                log(f"等待 {RETRY_DELAY}s 后重试...", "INFO")
                time.sleep(RETRY_DELAY)
            else:
                log(f"重试 {MAX_RETRIES} 次后仍然失败，退出", "ERROR")
                raise
    raise RuntimeError("请求失败")


def build_raw_headers(cookie: str, company_id: Optional[str] = None) -> dict:
    """构建业务 API 请求头（key 小写风格与旧 phase 内联 headers 一致）。

    各 phase 自制 headers 的场景可用本函数，也可自行拼装；Cookie/traceid 动态生成，
    绝不把 Cookie 打进日志。
    """
    import uuid

    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        "cookie": cookie,
        "host": get_host_header(),
        "referer": get_base("soar_referer"),
        "traceid": str(uuid.uuid4()),
        "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"),
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
    }
    if company_id is not None:
        headers["x-mssw-company-id"] = company_id
    return headers


# ─────────────────────────────────────────────────────────────
# 输出目录（per-user 隔离，skill 根只读）
# ─────────────────────────────────────────────────────────────
def output_dir() -> str:
    """guard 注入的 SKILL_OUTPUT_DIR；缺失时仅开发调试 fallback 到本地临时目录。"""
    d = os.environ.get("SKILL_OUTPUT_DIR")
    if d:
        os.makedirs(d, exist_ok=True)
        return d
    import tempfile

    d = os.path.join(tempfile.gettempdir(), "policy-check")
    os.makedirs(d, exist_ok=True)
    return d


# ─────────────────────────────────────────────────────────────
# Session 缓存（phase1 下发后写入，phase2/phase4 默认读取）
# ─────────────────────────────────────────────────────────────
def session_path() -> str:
    return os.path.join(output_dir(), "last_session.json")


def load_session() -> Optional[Dict[str, Any]]:
    """读取 last_session.json，返回 dict 或 None。"""
    if not os.path.exists(session_path()):
        return None
    try:
        with open(session_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"读取 session 失败: {e}", "WARN")
        return None


def save_session(data: Dict[str, Any]) -> None:
    """写入 last_session.json 到输出目录。"""
    with open(session_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────────────────────
# 候选公司缓存（多候选交互）
# ─────────────────────────────────────────────────────────────
def candidates_path() -> str:
    return os.path.join(output_dir(), "candidates.json")


def save_candidates(candidate_list: list) -> None:
    with open(candidates_path(), "w", encoding="utf-8") as f:
        json.dump(candidate_list, f, ensure_ascii=False, indent=2)


def load_candidates() -> Optional[list]:
    if not os.path.exists(candidates_path()):
        return None
    try:
        with open(candidates_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"读取候选项失败: {e}", "WARN")
        return None


def remove_candidates() -> None:
    try:
        if os.path.exists(candidates_path()):
            os.remove(candidates_path())
    except Exception as e:
        log(f"删除候选项失败: {e}", "WARN")


# ─────────────────────────────────────────────────────────────
# Reports 清理（每次执行前调用，防堆积；语义与旧 clean_reports 一致）
# ─────────────────────────────────────────────────────────────
def clean_reports():
    """清空本用户输出目录下的报告目录（reports/），防报告堆积。

    与旧 clean_reports 语义完全一致：只清 reports/，**绝不清除
    last_session.json / candidates.json** —— 它们是跨 phase 的会话上下文
    （phase1 下发后 phase2/phase4 默认读取），删除会导致会话丢失。
    多候选 candidates.json 由 phase1 选择后自行删除。
    只清自己目录，绝不清他人。
    """
    reports = os.path.join(output_dir(), "reports")
    if os.path.isdir(reports):
        for f in os.listdir(reports):
            try:
                os.remove(os.path.join(reports, f))
                log(f"[清理] 已删除: reports/{f}")
            except Exception as e:
                log(f"[清理] 删除失败 reports/{f}: {e}", "WARN")


def reports_dir() -> str:
    d = os.path.join(output_dir(), "reports")
    os.makedirs(d, exist_ok=True)
    return d
