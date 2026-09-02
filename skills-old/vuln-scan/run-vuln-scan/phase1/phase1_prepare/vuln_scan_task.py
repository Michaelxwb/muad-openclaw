#!/usr/bin/env python3
"""
Vuln Scan Task Creator - Phase 1: Create scan task
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import re
import warnings
warnings.filterwarnings('ignore', message='Unverified HTTPS request')

import argparse
import json
import time
import traceback
import uuid
import requests
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from shared import (
    DEFAULT_HEADERS,
    COMPANY_LIST_HEADERS,
    DEFAULT_ASSET_LIST,
    request_with_retry,
    get_cookie,
    get_cookie_from_file,
    extract_cookie_value,
    log,
    debug_request,
)

# Import notification module
try:
    from notify import send_notification
    NOTIFY_AVAILABLE = True
except ImportError:
    NOTIFY_AVAILABLE = False


def notify_exit(phase, status, detail=''):
    """Send notification then exit. status: '成功' or '失败'"""
    if NOTIFY_AVAILABLE:
        phase_names = {
            "1": "阶段1-创建扫描任务",
            "2": "阶段2-查询扫描状态",
            "3": "阶段3-创建报告任务",
            "4": "阶段4-轮询报告状态",
            "5": "阶段5-下载报告"
        }
        name = phase_names.get(phase, f"阶段{phase}")
        emoji = "✅" if status == "成功" else "❌"
        content = f"{emoji} {name} {status}！{detail}" if detail else f"{emoji} {name} {status}！"
        try:
            send_notification(content)
        except Exception:
            pass
    sys.exit(0 if status == "成功" else 1)

API_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task"
OP_PARAM = "op=new"


# =============================================================================
# 客户公司信息解析（API获取 + 用户确认）
# =============================================================================

COMPANY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/user/company_simple_info"


def fetch_company_list(cookie: str) -> Dict[str, Any]:
    """从 API 获取客户公司列表，返回完整响应字典。"""
    headers = COMPANY_LIST_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())

    payload = {
        "id_ignore": True,
        "service_status": 1,
        "offset": 0,
        "limit": 100,
        "my_customer": 0,
        "my_customer_first_handler": 0,
        "keyword": ""
    }

    log("[INFO] 正在获取客户公司列表...", "INFO")
    response = request_with_retry("POST", COMPANY_LIST_URL, headers=headers, json=payload)

    if response is None:
        log("[X ERROR] 获取客户列表失败", "ERROR")
        debug_request(COMPANY_LIST_URL, headers, payload, cookie)
        return {"code": -1, "data": {"list": []}}

    try:
        result = response.json()
        log(f"[INFO] 获取到 {result.get('data', {}).get('total', 0)} 条客户记录", "INFO")
        return result
    except Exception:
        log("[X ERROR] 解析客户列表响应失败", "ERROR")
        return {"code": -1, "data": {"list": []}}


def resolve_company(company_hint: str, cookie: str) -> Tuple[Optional[str], Optional[str]]:
    """
    根据用户输入的公司名称，从 API 获取客户列表，匹配后让用户确认。
    返回 (确认后的 company_name, 确认后的 company_id)。
    """
    result = fetch_company_list(cookie)
    if result.get("code") != 0 or not result.get("data", {}).get("list"):
        log(f"[X ERROR] 获取客户列表失败或为空: {result.get('msg', 'Unknown error')}", "ERROR")
        notify_exit("1", "失败", "获取客户列表失败")

    company_list = result["data"]["list"]

    candidates = [
        {"company_name": c["company_name"], "company_id": c["company_id"]}
        for c in company_list
        if company_hint in c.get("company_name", "")
    ]

    log(f"[INFO] 匹配到 {len(candidates)} 条候选记录:", "INFO")
    for i, c in enumerate(candidates, 1):
        log(f"  [{i}] {c['company_name']} (company_id: {c['company_id']})", "INFO")

    if len(candidates) == 0:
        log(f"[X ERROR] 没有找到包含「{company_hint}」的客户，请确认公司名称。", "ERROR")
        notify_exit("1", "失败", f"未找到客户: {company_hint}")

    if len(candidates) == 1:
        confirmed_name = candidates[0]["company_name"]
        confirmed_id = candidates[0]["company_id"]
        log(f"[INFO] 唯一匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    log("[INFO] 请选择确认的客户公司（输入编号，如 1）:", "INFO")
    while True:
        try:
            choice = input("请输入编号: ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(candidates):
                confirmed_name = candidates[idx]["company_name"]
                confirmed_id = candidates[idx]["company_id"]
                log(f"[INFO] 已确认: {confirmed_name} (company_id: {confirmed_id})", "INFO")
                break
            else:
                log(f"[WARNING] 编号超出范围，请输入 1~{len(candidates)}", "WARNING")
        except ValueError:
            log("[WARNING] 请输入有效数字编号", "WARNING")

    return confirmed_name, confirmed_id


# =============================================================================
# 中文自然时间解析器
# =============================================================================

def parse_cn_datetime(text: str) -> Tuple[Optional[datetime], str]:
    text = text.strip()
    now = datetime.now()
    is_tomorrow = False
    base_date = now.date()

    if re.match(r"^(明天|明日|明个)", text):
        base_date = (now + timedelta(days=1)).date()
        text = re.sub(r"^(明天|明日|明个)", "", text)
    elif re.match(r"^(今晚|今夜|今个)", text):
        base_date = now.date()
        text = re.sub(r"^(今晚|今夜|今个)", "", text)
    elif re.match(r"^(今天|今日)", text):
        base_date = now.date()
        text = re.sub(r"^(今天|今日)", "", text)

    period_words = ["凌晨", "早上", "上午", "中午", "下午", "晚上", "傍晚", "一点", "半点"]
    period_offset = {
        "凌晨": 0,
        "早上": 0,
        "上午": 0,
        "中午": 0,
        "下午": +12,
        "晚上": +12,
        "傍晚": +12,
    }
    matched_period = None
    for pw in period_words:
        if text.startswith(pw):
            matched_period = pw
            text = text[len(pw):]
            break

    hour, minute = None, None

    m = re.match(r"^(\d{1,2})[点:](\d{1,2})(?:分)?半", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = 30
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    m = re.match(r"^(\d{1,2})点半", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = 30
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    m = re.match(r"^(\d{1,2})点?一刻", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = 15
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    m = re.match(r"^(\d{1,2})[点:](\d{2})(?!\))", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = int(m.group(2))
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    m = re.match(r"^(\d{1,2})(?:点|时)", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = 0
        text = text[m.end():]
        residual = text.strip()
        if residual.startswith("半"):
            minute = 30
            text = residual[1:]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    return None, text


def parse_month_day_time(text: str) -> Tuple[Optional[datetime], str]:
    """
    Handle pure date formats like '5月7日', '5月7日13点', '5月7日13:00', '5月7日18:00'
    where the year is the current year (or next year if the date has passed).
    Returns (datetime, residual_text).
    """
    m = re.match(r"^(\d{1,2})月(\d{1,2})日", text)
    if not m:
        return None, text

    month = int(m.group(1))
    day = int(m.group(2))
    text = text[m.end():]

    now = datetime.now()
    try:
        dt = datetime(now.year, month, day)
    except ValueError:
        return None, text

    # If the date is in the past, advance to next year
    if dt <= now:
        try:
            dt = datetime(now.year + 1, month, day)
        except ValueError:
            return None, text

    # Parse optional time suffix: 13点30分 / 13:30 / 13点 / 13时
    # Try two-part pattern first (hour + minute)
    hour_minute_match = re.match(r"^(\d{1,2})[点:](\d{1,2})(?:分)?", text)
    if hour_minute_match:
        hour = int(hour_minute_match.group(1))
        minute = int(hour_minute_match.group(2))
        text = text[hour_minute_match.end():]
        try:
            dt = dt.replace(hour=hour, minute=minute)
        except ValueError:
            return None, text
    else:
        # Try bare hour-only pattern: 10点 / 13时
        bare_hour_match = re.match(r"^(\d{1,2})(?:点|时)", text)
        if bare_hour_match:
            hour = int(bare_hour_match.group(1))
            text = text[bare_hour_match.end():]
            try:
                dt = dt.replace(hour=hour, minute=0)
            except ValueError:
                return None, text
        else:
            # Just date without time -> default to 00:00, will be checked after
            dt = dt.replace(hour=0, minute=0)

    # If result is not in the future (e.g. date was today but no time specified), add 1 day
    if dt <= now:
        dt = dt + timedelta(days=1)
        dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)

    return dt, text


def suggest_schedule_time(raw_input: str) -> Tuple[bool, Optional[str], Optional[str]]:
    text = raw_input.strip()
    immediate_keywords = ["现在", "立刻", "马上", "立即", "尽快", "赶紧"]
    for kw in immediate_keywords:
        if kw in text:
            return False, None, None

    dt, residual = parse_cn_datetime(text)
    if dt is not None:
        residual = re.sub(r"^[\s.，,。]+$", "", residual).strip()
        if residual and len(residual) > 4:
            return True, None, f"无法识别的时间表达: {raw_input}"
        if dt <= datetime.now():
            dt += timedelta(days=1)
        return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None

    # Handle pure month-day dates: 5月7日, 5月7日13点, 5月7日18:00, 5月8日14:00
    dt, residual = parse_month_day_time(text)
    if dt is not None:
        residual = re.sub(r"^[\s.，,。]+$", "", residual).strip()
        if residual and len(residual) > 4:
            return True, None, f"无法识别的时间表达: {raw_input}"
        return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None

    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(text, fmt)
            if dt <= datetime.now():
                dt += timedelta(days=1)
            return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None
            return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None
        except ValueError:
            pass

    return False, None, None


# =============================================================================
# 公司名称解析
# =============================================================================

def parse_company_name(text: str) -> Tuple[Optional[str], str]:
    if not text:
        return None, ""
    text = text.strip()
    company = None

    m = re.match(r"客户名称[：:\s]*([^\s，,。]+)", text)
    if m:
        company = m.group(1).rstrip("，,。")
        text = text[m.end():].strip()
        return company, text

    for prefix in ["帮", "对", "为", "给"]:
        pattern = rf"{prefix}([^\s，,。]+公司)执行"
        m = re.search(pattern, text)
        if m:
            company = m.group(1).rstrip("，,。")
            text = re.sub(re.escape(m.group(0)), "", text).strip()
            return company, text

    m = re.search(r"([^\s，,。]+公司)的漏扫", text)
    if m:
        company = m.group(1).rstrip("，,。")
        text = re.sub(re.escape(m.group(0)), "", text).strip()
        return company, text

    m = re.search(r"([^\s，,。]+公司)(?:的漏扫|漏扫)?", text)
    if m:
        candidate = m.group(1).rstrip("，,。")
        if candidate and not re.search(r"[点午早晚凌晨]", candidate):
            company = candidate
            text = re.sub(re.escape(m.group(0)), "", text).strip()
            return company, text

    return None, text


def require_company_name(raw_input: str) -> str:
    company, residual = parse_company_name(raw_input)
    if company:
        return company

    _, no_time_text = suggest_schedule_time(raw_input)
    if no_time_text is None:
        log("[X ERROR] 未检测到客户名称，请明确告知要执行漏扫的客户公司名称。", "ERROR")
        log("[INFO] 正确示例：", "INFO")
        log("  客户名称: xx公司", "INFO")
        log("  帮xx公司执行漏扫任务", "INFO")
        log("  执行xx公司的漏扫任务", "INFO")
        sys.exit(1)

    company, _ = parse_company_name(no_time_text)
    if company:
        return company

    log("[X ERROR] 未检测到客户名称，请明确告知要执行漏扫的客户公司名称。", "ERROR")
    log("[INFO] 正确示例：", "INFO")
    log("  客户名称: xx公司", "INFO")
    log("  帮xx公司执行漏扫任务", "INFO")
    log("  执行xx公司的漏扫任务", "INFO")
    sys.exit(1)


# =============================================================================
# 核心业务逻辑
# =============================================================================

def build_request_payload(
    task_name: str,
    asset_list: Optional[List[str]],
    dev_id: int,
    company_id: str,
    start_time: int = 0,
    asset_mode: int = 0
) -> Dict[str, Any]:
    """从公司配置构造 payload，dev_id/company_id/asset_mode 禁止硬编码"""
    from .payload_builder import build_task_payload
    # task_type：立即执行=1，定时执行=3
    task_type = 1 if start_time == 0 else 3
    return build_task_payload(
        company_id=company_id,
        dev_id=dev_id,
        user_start_time=start_time,
        task_name=task_name,
        asset_list=asset_list,
        asset_mode=asset_mode,
        task_type=task_type
    )


def create_vuln_scan_task(
    cookie: str,
    task_name: str,
    asset_list: Optional[List[str]],
    dev_id: int,
    company_id: str,
    start_time: int = 0,
    asset_mode: int = 0
) -> Dict[str, Any]:
    """dev_id 和 company_id 禁止硬编码，必须由调用方传入真实值"""
    url = f"{API_URL}?{OP_PARAM}"

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie

    payload = build_request_payload(task_name, asset_list, dev_id, company_id, start_time, asset_mode)

    is_scheduled = start_time > 0
    log(f"Creating scan task...", "INFO")
    log(f"  Task: {task_name}", "INFO")
    log(f"  Mode: {'Scheduled' if is_scheduled else 'Immediate'}", "INFO")
    if is_scheduled:
        ts_sec = start_time if start_time < 1e12 else start_time // 1000
        scheduled_dt = datetime.fromtimestamp(ts_sec).strftime("%Y-%m-%d %H:%M:%S")
        log(f"  Scheduled time: {scheduled_dt}", "INFO")
    log(f"  URL: {url}", "INFO")

    try:
        response = request_with_retry("POST", url, headers=headers, json=payload)

        if response is None:
            log(f"X 请求完全失败，退出", "ERROR")
            debug_request(url, headers, payload, cookie)
            return {"code": -1, "error": "Request failed after retries"}

        log(f"Response status: {response.status_code}")

        try:
            result = response.json()
            log(f"Response: {json.dumps(result, ensure_ascii=False, indent=2)}")

            if result.get("code") not in (0, 1105, 1005):
                error_msg = result.get("msg") or result.get("message") or "Unknown error"
                log(f"API error: {error_msg}", "ERROR")
                return result
            # 1105/1005 = 定时任务创建成功（仅有警告），直接返回，让调用方决定如何处理
            return result
        except json.JSONDecodeError as e:
            log(f"JSON decode error: {e}", "ERROR")
            debug_request(url, headers, payload, cookie, response.text)
            return {"code": -1, "error": f"JSON decode failed: {e}"}

    except requests.exceptions.Timeout as e:
        log(f"Request timeout: {e}", "ERROR")
        debug_request(url, headers, payload, cookie)
        return {"code": -1, "error": f"Timeout: {e}"}
    except requests.exceptions.ConnectionError as e:
        log(f"Connection error: {e}", "ERROR")
        debug_request(url, headers, payload, cookie)
        return {"code": -1, "error": f"Connection error: {e}"}
    except requests.exceptions.RequestException as e:
        log(f"Request error: {e}", "ERROR")
        debug_request(url, headers, payload, cookie)
        return {"code": -1, "error": f"Request failed: {e}"}
    except Exception as e:
        log(f"Unexpected error: {e}", "ERROR")
        debug_request(url, headers, payload, cookie)
        return {"code": -1, "error": f"Unexpected: {e}"}


# =============================================================================
# 主入口
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Vuln Scan Task Creator - Phase 1")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie string")
    parser.add_argument("-n", "--name", type=str, default=None, help="Task name")
    parser.add_argument("-a", "--asset-list", type=str, default=None, help="Asset list, comma separated")
    parser.add_argument("--dev-id", type=int, default=1198050, help="Device ID")
    parser.add_argument("--company-id", type=str, default=None, help="Company ID")
    parser.add_argument("--start-time", type=str, default=None,
                        help="Schedule time")
    parser.add_argument("--company", type=str, default=None, help="Company name")
    parser.add_argument("-t", "--target", type=str, default=None, help="Scan target")

    args = parser.parse_args()

    start_time = 0
    raw_time_input = args.start_time or (args.target or "")
    if raw_time_input:
        is_scheduled, parsed_str, err = suggest_schedule_time(raw_time_input)
        if err:
            log(f"[X ERROR] {err}", "ERROR")
            sys.exit(1)
        if is_scheduled and parsed_str:
            dt = datetime.strptime(parsed_str, "%Y-%m-%d %H:%M:%S")
            start_time = int(dt.timestamp())
            log(f"[INFO] 定时任务: {raw_time_input} -> {parsed_str}", "INFO")

    company = args.company
    if not company:
        if args.name:
            company, _ = parse_company_name(args.name)
        if not company and args.target:
            company, _ = parse_company_name(args.target)

    if not company:
        log("[X ERROR] 无法识别客户名称。请明确告知要执行漏扫的客户公司名称。", "ERROR")
        log("[INFO] 正确示例：", "INFO")
        log("  客户名称: xx公司", "INFO")
        log("  帮xx公司执行漏扫任务", "INFO")
        log("  执行xx公司的漏扫任务", "INFO")
        log("  --company xx公司", "INFO")
        notify_exit("1", "失败", "无法识别客户名称")

    log(f"[INFO] 客户名称: {company}", "INFO")

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("Please provide cookie via -c parameter", "ERROR")
        notify_exit("1", "失败", "Cookie未提供")

    confirmed_name, confirmed_company_id = resolve_company(company, cookie)
    company = confirmed_name
    log(f"[INFO] 确认公司: {company}, company_id: {confirmed_company_id}", "INFO")

    if not args.name:
        timestamp = int(datetime.now().timestamp())
        suffix = f"_{args.target}" if args.target else ""
        args.name = f"{company}_漏扫_{timestamp}{suffix}"
        log(f"[INFO] 任务名称: {args.name}", "INFO")
    else:
        log(f"[INFO] 任务名称: {args.name}", "INFO")

    asset_list = None
    if args.asset_list:
        asset_list = [x.strip() for x in args.asset_list.split(",") if x.strip()]
        log(f"Using custom asset list: {asset_list}")
    else:
        log(f"Using default asset list")

    log("=" * 60, "INFO")
    log("Phase 1: Create scan task", "INFO")
    log("=" * 60, "INFO")

    result = create_vuln_scan_task(
        cookie=cookie,
        task_name=args.name,
        asset_list=asset_list,
        dev_id=args.dev_id,
        company_id=confirmed_company_id,
        start_time=start_time
    )

    if result.get("code") == 0:
        log(f"Task created successfully!", "INFO")
        if start_time > 0:
            log(f"Scheduled task will execute at: {datetime.fromtimestamp(start_time).strftime('%Y-%m-%d %H:%M:%S')}", "INFO")
        log(f"Use task_name '{args.name}' in Phase 2 to get task_id", "INFO")
        if NOTIFY_AVAILABLE:
            notify_exit("1", "成功", f"任务: {args.name}")
    else:
        error_msg = result.get("message") or result.get("error", "Unknown error")
        log(f"Task creation failed: {error_msg}", "ERROR")
        log(f"Full response: {json.dumps(result, ensure_ascii=False)}", "DEBUG")
        notify_exit("1", "失败", error_msg)


if __name__ == "__main__":
    main()
