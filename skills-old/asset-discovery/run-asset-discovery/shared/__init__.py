#! /usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Shared utilities for asset-discovery.
Common constants, HTTP utilities, cookie helpers, and logging.
"""
import os
import sys
import json
import time
import warnings
import requests
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Optional, Dict, Any

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# =============================================================================
# API Endpoints - 资产发现相关 API
# =============================================================================
# 资产发现任务创建
ASSET_DISCOVERY_TASK_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task"
# 资产发现结果查询
ASSET_RESULT_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/business_info"
# 公司列表
COMPANY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/user/company_simple_info"

# =============================================================================
# Headers 体系
# =============================================================================
BASE_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://soar.sangfor.com.cn/index.html",
}

COMPANY_LIST_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://soar.sangfor.com.cn/index.html",
    "Origin": "https://soar.sangfor.com.cn",
}

DEFAULT_HEADERS = BASE_HEADERS

DOWNLOAD_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://soar.sangfor.com.cn/index.html",
}

# =============================================================================
# Retry Configuration
# =============================================================================
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds

# =============================================================================
# Poll Configuration
# =============================================================================
POLL_INTERVAL = 10  # seconds
MAX_POLL_COUNT = 1080  # 1080 * 10s = 180min（3小时）
DEFAULT_DELAY_MINUTES = 5  # Phase 1 创建后等待 N 分钟再触发 Phase 2

# =============================================================================
# Logging
# =============================================================================
def log(msg: str, level: str = "INFO"):
    """统一日志输出，格式: [时间戳] [级别] 消息"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


# =============================================================================
# HTTP Requests
# =============================================================================
def request_with_retry(method: str, url: str, headers: Dict, timeout: int = 30, **kwargs) -> Optional[requests.Response]:
    """带重试的HTTP请求，若失败则直接退出。使用 Session 复用连接。"""
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
        max_retries=0
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


# =============================================================================
# Cookie Utilities
# =============================================================================
def get_cookie_from_file() -> Optional[str]:
    r"""从 M:\Users\User\Downloads\cookies.txt 读取 Cookie（纯文本字符串）"""
    cookie_file = r"M:\Users\User\Downloads\cookies.txt"
    if os.path.exists(cookie_file):
        with open(cookie_file, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie
    return None


def get_cookie(args_cookie: Optional[str] = None) -> Optional[str]:
    """获取 Cookie：优先顺序 命令行参数 > 环境变量 > 配置文件"""
    if args_cookie:
        if len(args_cookie) < 100:
            print("\n[X ERROR] Cookie 长度不足，可能不完整!", flush=True)
            print(f"  当前长度: {len(args_cookie)} 字符", flush=True)
            sys.exit(1)
        return args_cookie

    cookie = os.environ.get("ASSET_DISCOVERY_COOKIE") or os.environ.get("COOKIE")
    if cookie:
        return cookie

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


# =============================================================================
# Notification Utilities
# =============================================================================
def _get_webhook_url():
    """获取 webhook URL（统一读取 skills/webhook_config.json）"""
    import os as _os
    config_path = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))), "webhook_config.json")
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)["webhook_url"]


def send_notification(phase_name: str = "", status: str = "", detail: str = "", company_name: str = ""):
    """
    发送业务微信群通知

    标准模式（status非空）：phase_name + status + detail 拼接
    话术模式（status为空）：直接发送 detail 内容，不拼接 phase_name 和 status

    Args:
        phase_name: 阶段名称
        status: "成功" / "失败"，空字符串表示话术模式
        detail: 详细信息或话术内容
        company_name: 客户名称，非空时格式化为【资产发现】【客户名】前缀
    """
    try:
        webhook_url = _get_webhook_url()

        # 话术模式：status 为空时，直接发送 detail 内容
        if not status:
            content = detail
        else:
            content = f"{phase_name} {status}：{detail}"
            # 执行过程通知加上【资产发现】【客户名】前缀，话术/报告/最终结果类保持不变
            _result_keywords = ("话术", "报告", "结果", "完成")
            if not any(kw in phase_name for kw in _result_keywords):
                if company_name:
                    content = f"【资产发现】【{company_name}】{content}"
                else:
                    content = f"【资产发现】{content}"

        data = json.dumps({
            "msgtype": "text",
            "text": {"content": content}
        }, ensure_ascii=False).encode("utf-8")
        max_retries = 3
        for attempt in range(max_retries):
            req = urllib.request.Request(webhook_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"})
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode("utf-8"))
                if result.get("errcode") == 0:
                    log(f"[INFO] 通知已发送: {phase_name} {status}", "INFO")
                    return
                if result.get("errcode") == 45009:
                    log(f"[WARNING] 通知频率限制(45009)，60秒后重试 (第{attempt+1}次)", "WARNING")
                    time.sleep(60)
                    continue
                log(f"[WARNING] 通知发送失败: {result}", "WARNING")
                return
        log(f"[WARNING] 通知重试{max_retries}次后仍失败(45009)", "WARNING")
    except Exception as e:
        log(f"[WARNING] 发送通知异常: {e}", "WARNING")