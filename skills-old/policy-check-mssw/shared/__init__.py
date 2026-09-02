#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""策略检查（policy-check）共享模块

提供 Cookie 获取、HTTP 请求、日志、报告清理、企微通知等公共能力。
所有 phase 文件统一通过 `from shared import ...` 复用本模块。
"""

import os
import sys
import json
import time
import re
import warnings
import urllib.request
from datetime import datetime
from typing import Optional, Dict, Any

import requests

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# 项目根目录
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# 重试 / 轮询 常量
# ─────────────────────────────────────────────────────────────
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds


# ─────────────────────────────────────────────────────────────
# 日志
# ─────────────────────────────────────────────────────────────
def log(msg: str, level: str = "INFO"):
    """统一日志输出，格式: [HH:MM:SS] [LEVEL] msg"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────
# API 端点配置
# ─────────────────────────────────────────────────────────────
_API_CONFIG_CACHE: Optional[Dict[str, Any]] = None
_API_CONFIG_PATH = os.path.join(POLICY_CHECK_ROOT, "config", "api_config.json")


def load_api_config(force_reload: bool = False) -> Dict[str, Any]:
    """读取 config/api_config.json，结果在进程内缓存。

    修改接口地址只需改 api_config.json，无需动业务代码。
    若文件不存在或解析失败，直接抛 RuntimeError 提示用户。
    """
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
    """取顶层 origin（soar 平台域名），endpoints 里的相对路径会基于它拼接。"""
    cfg = load_api_config()
    origin = cfg.get("origin")
    if not origin:
        raise KeyError("api_config.json 缺少顶层 origin 配置项")
    return origin.rstrip("/")


def get_endpoint(key: str) -> str:
    """便捷取 endpoints[key] 并与 origin 拼接成完整 URL。

    endpoints 中存相对路径（以 / 开头），origin 提供域名前缀。
    若值本身已是完整 URL（http/https 开头），则原样返回不做拼接。
    """
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


def get_wecom(key: str) -> str:
    """便捷取 wecom[key]，如 upload_media。"""
    cfg = load_api_config()
    wecom = cfg.get("wecom", {})
    if key not in wecom:
        raise KeyError(f"api_config.json 缺少 wecom.{key} 配置项")
    return wecom[key]


# ─────────────────────────────────────────────────────────────
# Cookie 工具
# ─────────────────────────────────────────────────────────────
def get_cookie_from_file() -> Optional[str]:
    """从配置文件指定的 Cookie 文件读取 Cookie

    优先从 api_config.json 的 cookie_file 字段读取路径，
    JSON 格式（含 cookieString 字段）
    """
    # 1. 从配置文件读取路径
    cfg = load_api_config()
    cookie_file = cfg.get("cookie_file")
    if cookie_file and os.path.exists(cookie_file):
        try:
            with open(cookie_file, "r", encoding="utf-8") as f:
                raw = f.read().strip()
            if not raw:
                raise ValueError("Cookie 文件内容为空")
            # 尝试 JSON 解析（xdr_cookies.json 格式）
            if raw.startswith("{"):
                data = json.loads(raw)
                cookie = data.get("cookieString") or data.get("cookie")
                if cookie:
                    return cookie
            # 纯文本格式
            return raw
        except Exception as e:
            log(f"读取配置文件指定的 Cookie 文件失败: {e}", "WARN")
    return None


def get_cookie(args_cookie: Optional[str] = None) -> Optional[str]:
    """获取 Cookie：优先顺序 命令行参数 > 环境变量 > 配置文件

    args_cookie 非空时会校验：
      - 字符混淆（d/x、p/b、z/a 等常见复制错误）
      - 长度不足（<100 字符）
    出现以上情况直接 sys.exit(1) 提示用户重新复制。
    """
    # 1. 命令行参数
    if args_cookie:
        corruption_pairs = [
            ("x", "d"),  # d corrupted to x
            ("X", "D"),
            ("p", "b"),  # b corrupted to p
            ("P", "B"),
            ("z", "a"),  # a corrupted to z
            ("Z", "A"),
        ]
        detected = []
        for wrong, right in corruption_pairs:
            if wrong in args_cookie and right in args_cookie:
                wrong_count = len(re.findall(rf'{wrong}[A-Za-z0-9+/]{{2}}={{0,2}}', args_cookie))
                right_count = len(re.findall(rf'{right}[A-Za-z0-9+/]{{2}}={{0,2}}', args_cookie))
                if wrong_count > 0 and wrong_count > right_count:
                    detected.append(f"'{wrong}'->'{right}' ({wrong_count} time(s))")
        if detected:
            print("\n[X ERROR] 检测到 Cookie 复制错误 (字符混淆)!", flush=True)
            print(f"  可能情况: {', '.join(detected)}", flush=True)
            print("  建议: 重新从浏览器开发者工具复制完整 Cookie，不要使用搜索/替换", flush=True)
            sys.exit(1)
        if len(args_cookie) < 100:
            print("\n[X ERROR] Cookie 长度不足，可能不完整!", flush=True)
            print(f"  当前长度: {len(args_cookie)} 字符", flush=True)
            sys.exit(1)
        return args_cookie

    # 2. 环境变量
    cookie = os.environ.get("POLICY_CHECK_COOKIE") or os.environ.get("COOKIE")
    if cookie:
        return cookie

    # 3. 配置文件
    return get_cookie_from_file()


def extract_cookie_value(cookie: str, key: str) -> Optional[str]:
    """从 Cookie 字符串中提取指定 key 的值"""
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
def request_with_retry(method: str, url: str, headers: Dict, timeout: int = 30,
                       **kwargs) -> Optional[requests.Response]:
    """带重试的 HTTP 请求，返回 requests.Response。

    - 使用 Session 复用连接
    - 自动从 headers['Cookie'] 中提取 csrf_token 并注入 X-Csrftoken
    - 失败重试 MAX_RETRIES 次，超过后抛出原异常
    """
    headers = headers.copy()
    cookie = headers.get("Cookie", "")
    if cookie:
        csrf_token = extract_cookie_value(cookie, "csrf_token")
        if csrf_token:
            headers["X-Csrftoken"] = csrf_token

    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=10,
        pool_maxsize=10,
        max_retries=0,
    )
    session.mount('https://', adapter)
    session.mount('http://', adapter)

    for attempt in range(MAX_RETRIES):
        try:
            if method.upper() == "POST":
                response = session.post(url, headers=headers, timeout=timeout, verify=False, **kwargs)
            else:
                response = session.get(url, headers=headers, timeout=timeout, verify=False, **kwargs)
            return response
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError, requests.exceptions.RequestException) as e:
            attempt_num = attempt + 1
            log(f"请求失败 (尝试 {attempt_num}/{MAX_RETRIES}) - {e}", "WARNING")
            if attempt < MAX_RETRIES - 1:
                log(f"等待 {RETRY_DELAY}s 后重试...", "INFO")
                time.sleep(RETRY_DELAY)
            else:
                log(f"X 重试 {MAX_RETRIES} 次后仍然失败，退出", "ERROR")
                raise e
    return None


# ─────────────────────────────────────────────────────────────
# Session 缓存（phase1 下发后写入，phase2/phase4 默认读取）
# ─────────────────────────────────────────────────────────────
SESSION_CACHE_PATH = os.path.join(POLICY_CHECK_ROOT, "cache", "last_session.json")


def load_session() -> Optional[Dict[str, Any]]:
    """读取 cache/last_session.json，返回 dict 或 None。"""
    if not os.path.exists(SESSION_CACHE_PATH):
        return None
    try:
        with open(SESSION_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"读取 session 失败: {e}", "WARN")
        return None


def save_session(data: Dict[str, Any]) -> None:
    """写入 cache/last_session.json。"""
    os.makedirs(os.path.dirname(SESSION_CACHE_PATH), exist_ok=True)
    with open(SESSION_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────────────────────
# Reports 清理
# ─────────────────────────────────────────────────────────────
def clean_reports():
    """清空 reports 目录（每次执行前/后调用，避免残留文件堆积）"""
    import glob
    reports_dir = os.path.join(POLICY_CHECK_ROOT, "reports")
    if not os.path.isdir(reports_dir):
        return
    for f in glob.glob(os.path.join(reports_dir, "*")):
        try:
            os.remove(f)
            log(f"[清理] 已删除: {os.path.basename(f)}", "INFO")
        except Exception as e:
            log(f"[清理] 删除失败 {os.path.basename(f)}: {e}", "WARN")


# ─────────────────────────────────────────────────────────────
# 通知
# ─────────────────────────────────────────────────────────────
def send_notification(phase: str, status: str, detail: str = "", company_name: str = "") -> bool:
    """发送企微通知（优先委托给 shared.notify，失败时回退到直接 HTTP）"""
    try:
        from shared.notify import send_notification as _notify
        return _notify(phase, status, detail, company_name=company_name)
    except Exception:
        try:
            config_path = os.path.join(os.path.dirname(POLICY_CHECK_ROOT), "webhook_config.json")
            if os.path.exists(config_path):
                webhook_url = json.load(open(config_path, encoding="utf-8"))["webhook_url"]
                phase_names = {
                    "1": "策略检查-阶段1: 下发检查任务",
                    "2": "策略检查-阶段2: 轮询检查状态",
                    "4": "策略检查-阶段4: 生成话术",
                }
                phase_label = phase_names.get(str(phase), f"阶段{phase}")
                content = f"{phase_label}\n状态: {status}"
                if detail:
                    content += f"\n详情: {detail}"
                data = json.dumps({"msgtype": "text", "text": {"content": content}},
                                  ensure_ascii=False).encode("utf-8")
                req = urllib.request.Request(
                    webhook_url, data=data,
                    headers={"Content-Type": "application/json; charset=utf-8"},
                )
                with urllib.request.urlopen(req) as resp:
                    pass
                return True
        except Exception:
            pass
    return False
