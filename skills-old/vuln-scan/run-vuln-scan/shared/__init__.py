#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Shared utilities for all vuln scan phases.
Common constants, HTTP utilities, cookie helpers, and logging.
"""
import os
import sys
import json
import time
import warnings
import requests
from datetime import datetime
from typing import Optional, Dict, Any

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
# API Endpoints
# =============================================================================
CREATE_TASK_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task"
TASK_LIST_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/task-list"
REPORT_TASK_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/tss/report-export"
REPORT_STATUS_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/report/report_vulns"
REPORT_DOWNLOAD_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/vuln/report-download"
VULN_LIST_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/vuln_list_port_split"
VULN_VERIFY_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/vuln/verification"

# =============================================================================
# Headers 体系
#
# 共三层：
#   BASE_HEADERS        - 所有请求通用（Accept, Accept-Language, Content-Type, UA, X-Requested-With, Referer）
#   COMPANY_LIST_HEADERS - 公司列表 API 专用（BASE + 完整 UA + Origin）
#   DOWNLOAD_HEADERS     - 报告下载专用（Accept:*/*, 无 Content-Type/X-Requested-With）
#
# 使用方式：from shared import DEFAULT_HEADERS / COMPANY_LIST_HEADERS / DOWNLOAD_HEADERS
#           headers = HEADERS_VARIANT.copy()
#           headers["Cookie"] = cookie
#           headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
# =============================================================================
BASE_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://soar.sangfor.com.cn/index.html",
}

# 默认 header = BASE
DEFAULT_HEADERS = BASE_HEADERS

# 公司列表 API 专用：完整 UA + Origin
COMPANY_LIST_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://soar.sangfor.com.cn/index.html",
    "Origin": "https://soar.sangfor.com.cn",
}

# 报告下载专用：Accept:*/*，无 Content-Type/X-Requested-With
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
POLL_INTERVAL = 10  # 10 seconds - safe for Task Scheduler non-interactive mode
MAX_POLL_COUNT_PHASE2 = 180  # 180 * 10s = 10min total
MAX_POLL_COUNT_PHASE4 = 180  # 180 * 10s = 30min total
DEFAULT_DELAY_MINUTES = 30  # Phase 1 创建后等待 N 分钟再触发 Phase 2-5

# =============================================================================
# Default Asset List
# =============================================================================
DEFAULT_ASSET_LIST = []

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
    """带重试的HTTP请求，若失败则直接退出。使用 Session 复用连接。
    自动从 Cookie 中提取 csrf_token 并添加 X-Csrftoken 头。"""
    # 复制 headers 避免修改原始对象
    headers = headers.copy()
    
    # 从 Cookie 中提取 csrf_token 并添加 X-Csrftoken 头
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
# Debug Utilities
# =============================================================================
def debug_request(url: str, headers: Dict, payload: Dict, cookie: str, is_download: bool = False):
    """打印详细的调试信息后退出"""
    print("\n" + "=" * 60, flush=True)
    print("X Request Failed - Debug Info", flush=True)
    print("=" * 60, flush=True)
    print(f"[URL]\n  {url}", flush=True)
    print(f"\n[Request Headers]", flush=True)
    for k, v in headers.items():
        print(f"  {k}: {v}", flush=True)
    if not is_download:
        print(f"\n[Payload]", flush=True)
        print(f"  {json.dumps(payload, ensure_ascii=False, indent=2)}", flush=True)
    print(f"\n[Cookie]\n  {cookie}", flush=True)
    print("=" * 60, flush=True)
    sys.exit(1)


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
    # 1. 命令行参数
    if args_cookie:
        # Validate cookie - check for common d<->x corruption patterns
        # Common pairs in base64: d/x, p/b, i/z, 0/O, 1/l, etc.
        corruption_pairs = [
            ("x", "d"),  # d corrupted to x (most common: xNjAx→dNjAx, xNTky→dNTky, xpbi1z→dpbi1z)
            ("X", "D"),
            ("p", "b"),  # b corrupted to p
            ("P", "B"),
            ("z", "a"),  # a corrupted to z
            ("Z", "A"),
        ]

        detected = []
        for wrong, right in corruption_pairs:
            if wrong in args_cookie and right in args_cookie:
                import re
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
    cookie = os.environ.get("VULN_SCAN_COOKIE") or os.environ.get("COOKIE")
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


# =============================================================================
# Report Task Matching
# =============================================================================
def find_report_task(result: Dict[str, Any], cookie: str, company_id: str) -> Optional[Dict[str, Any]]:
    """从报告列表中查找匹配的报表任务（expert_name + company_id，取 task_time 最大的）"""
    if "data" not in result or "list" not in result.get("data", {}):
        log("  返回数据中没有list", "WARNING")
        return None

    import urllib
    expert_name = urllib.parse.unquote(extract_cookie_value(cookie, "USER_BLESS_META_NAME") or "")
    if not expert_name:
        log("  无法从 Cookie 中提取 USER_BLESS_META_NAME", "WARNING")
        return None

    task_list = result["data"]["list"]
    matched_tasks = []

    for task in task_list:
        # API 返回的 expert_name 是 URL 编码后被 decode 成乱码形式，两边都 URL 解码后比较
        task_expert_name = urllib.parse.unquote(task.get("expert_name", "") or "")
        task_company_id = str(task.get("company_id", ""))
        task_time = task.get("task_time")
        task_id = task.get("task_id", "")

        if task_expert_name != expert_name or task_company_id != company_id:
            continue

        log(f"  [匹配] task_id={task_id}, task_time={task_time}", "INFO")
        matched_tasks.append(task)

    if not matched_tasks:
        log(f"  未找到匹配任务 (expert_name+company_id)", "WARNING")
        return None

    if len(matched_tasks) == 1:
        task = matched_tasks[0]
        log(f"  唯一匹配任务: task_id={task.get('task_id')}, task_time={task.get('task_time')}", "INFO")
        return task

    # 多个匹配，找 task_time 最大的
    latest_task = None
    latest_time = None

    for task in matched_tasks:
        task_time_str = task.get("task_time")
        if task_time_str:
            try:
                task_datetime = datetime.strptime(task_time_str, "%Y-%m-%d %H:%M:%S")
                if latest_time is None or task_datetime > latest_time:
                    latest_time = task_datetime
                    latest_task = task
            except Exception:
                continue

    if latest_task:
        log(f"  task_time 最大任务: task_id={latest_task.get('task_id')}, task_time={latest_task.get('task_time')}", "INFO")
    else:
        latest_task = matched_tasks[0]

    return latest_task


# =============================================================================
# Notification Utilities (moved from vuln_scan_runner.py)
# =============================================================================
def _get_webhook_url():
    """获取 webhook URL"""
    # shared/ is at project_root/shared/, go up to skills/ to reach webhook_config.json
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "webhook_config.json")
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)["webhook_url"]


def send_notification(phase_name: str, status: str, detail: str = "", company_name: str = ""):
    """
    发送业务微信群通知
    Args:
        phase_name: 阶段名称，如"漏扫任务创建失败"
        status: "成功" 或 "失败"
        detail: 详细信息
        company_name: 客户名称，非空时格式化为【漏扫】【客户名】前缀
    """
    try:
        webhook_url = _get_webhook_url()
        content = f"{phase_name} {status}：{detail}"
        # 执行过程通知加上业务前缀，话术/报告/最终结果类保持不变
        _result_keywords = ("话术", "报告", "扫描执行成功")
        if not any(kw in phase_name for kw in _result_keywords):
            business = "复测" if "复测" in phase_name else "漏扫"
            if company_name:
                content = f"【{business}】【{company_name}】{content}"
            else:
                content = f"【{business}】{content}"
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


def send_file_message(file_path: str, message: str = ""):
    """
    通过业务微信 webhook 发送文件消息先上传文件到微信，再发送。
    """
    try:
        webhook_url = _get_webhook_url()

        # Step 1: 上传临时文件到微信
        boundary = "----FormBoundary7MA4YWxkTrZu0gW"
        file_name = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)

        with open(file_path, "rb") as f:
            file_data = f.read()

        body = (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="media"; filename="{file_name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
        body += file_data
        body += f"\r\n--{boundary}--\r\n".encode("utf-8")

        upload_req = urllib.request.Request(
            f"https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key={webhook_url.split('key=')[1]}&type=file",
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body))
            }
        )
        with urllib.request.urlopen(upload_req, timeout=30) as resp:
            upload_result = json.loads(resp.read().decode("utf-8"))

        if upload_result.get("errcode") != 0:
            log(f"[WARNING] 文件上传失败: {upload_result}", "WARNING")
            send_notification("漏扫报告", "发送失败", f"文件: {file_name} (上传失败，可能文件过大)")
            return

        media_id = upload_result["media_id"]
        log(f"[INFO] 文件上传成功, media_id: {media_id}", "INFO")

        # Step 2: 发送文件消息
        if message:
            content = f"{message}\n文件: {file_name} ({file_size / 1024:.1f} KB)"
        else:
            content = f"漏扫报告: {file_name} ({file_size / 1024:.1f} KB)"

        data = json.dumps({
            "msgtype": "file",
            "file": {"media_id": media_id}
        }, ensure_ascii=False).encode("utf-8")
        file_req = urllib.request.Request(webhook_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"})
        with urllib.request.urlopen(file_req, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))

        if result.get("errcode") != 0:
            log(f"[WARNING] 文件消息发送失败: {result}", "WARNING")
        else:
            log(f"[INFO] 文件已发送到群: {file_name}", "INFO")
    except Exception as e:
        log(f"[WARNING] 发送文件异常: {e}", "WARNING")

