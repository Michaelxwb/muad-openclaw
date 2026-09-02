#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通报事件回函 - 资产台账查询脚本
================================
职责：
  根据 company_id 和源 IP（ip_url_keyword），调用 SOAR 资产台账 API，
  判断该 IP 对应的资产是否属于客户资产。

用法：
  python query_assets.py --company-id 50860486 --ip 172.16.32.4

判定逻辑：
  - 返回 data.total > 0（且 list 非空）→ 有客户资产 → 退出码 0
  - 返回 data.total == 0 → 无客户资产 → 退出码 1
  - 请求失败 / 解析失败 → 退出码 2

输出：
  命中时打印匹配到的资产信息（asset_id / asset / asset_name / asset_type 等）。
"""
import os
import sys
import json
import uuid
import time
from typing import Optional, Dict, Any

import requests
import warnings

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# =============================================================================
# 常量
# =============================================================================
ASSET_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset?_method=GET"

ASSET_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://soar.sangfor.com.cn/index.html",
    "Origin": "https://soar.sangfor.com.cn",
}

MAX_RETRIES = 3
RETRY_DELAY = 5

COOKIE_FILE = r"M:\Users\User\Downloads\cookies.txt"


# =============================================================================
# 工具函数
# =============================================================================
def log(msg: str, level: str = "INFO"):
    timestamp = time.strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


def extract_cookie_value(cookie: str, key: str) -> Optional[str]:
    if not cookie:
        return None
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


def get_cookie() -> Optional[str]:
    cookie = os.environ.get("VULN_SCAN_COOKIE") or os.environ.get("COOKIE")
    if cookie:
        return cookie
    if os.path.exists(COOKIE_FILE):
        with open(COOKIE_FILE, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie
    return None


def request_with_retry(method: str, url: str, headers: Dict, timeout: int = 30, **kwargs) -> Optional[requests.Response]:
    headers = headers.copy()
    cookie = headers.get("Cookie", "")
    if cookie:
        csrf_token = extract_cookie_value(cookie, "csrf_token")
        if csrf_token:
            headers["X-Csrftoken"] = csrf_token

    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=10, max_retries=0)
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    for attempt in range(MAX_RETRIES):
        try:
            if method.upper() == "POST":
                return session.post(url, headers=headers, timeout=timeout, verify=False, **kwargs)
            else:
                return session.get(url, headers=headers, timeout=timeout, verify=False, **kwargs)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError, requests.exceptions.RequestException) as e:
            log(f"请求失败 (尝试 {attempt + 1}/{MAX_RETRIES}) - {e}", "WARNING")
            if attempt < MAX_RETRIES - 1:
                log(f"等待 {RETRY_DELAY}s 后重试...", "INFO")
                time.sleep(RETRY_DELAY)
            else:
                log(f"重试 {MAX_RETRIES} 次后仍然失败", "ERROR")
                raise e
    return None


# =============================================================================
# 资产台账查询
# =============================================================================
def build_payload(company_id: str, ip_url_keyword: str, agent_status: Optional[list] = None) -> Dict[str, Any]:
    """构建资产台账查询 payload，复制用户提供的模板。

    agent_status 用于过滤终端防护组件（EDR）安装状态：
      - None / [] → 不过滤（查全部资产）
      - [0, 1, 2] → 只查已安装 EDR 的资产（参考资产发现 skill）
    """
    if agent_status is None:
        agent_status = []
    return {
        "order": "asc",
        "offset": 0,
        "limit": 10,
        "service_status": [],
        "is_alive": -1,
        "ip_url_keyword": ip_url_keyword,
        "asset_type": [],
        "business_level": [],
        "first_time": [],
        "update_time": [],
        "keyword": "",
        "asset_tag": [],
        "agent_status": agent_status,
        "af_defend_status": "",
        "database": [],
        "middleware": [],
        "os": [],
        "developing_languages": [],
        "development_framework": [],
        "server_port": [],
        "company_id": company_id,
        "asset_group_id": "all",
        "authorization_type": [],
    }


def query_assets(company_id: str, ip_url_keyword: str, cookie: str, agent_status: Optional[list] = None) -> Optional[Dict[str, Any]]:
    """调用资产台账 API，返回完整响应 JSON（解析后的 dict）。"""
    headers = ASSET_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())
    headers["Cache-Control"] = "no-cache"
    headers["Pragma"] = "no-cache"
    headers["Priority"] = "u=1, i"
    headers["Sec-Fetch-Dest"] = "empty"
    headers["Sec-Fetch-Mode"] = "cors"
    headers["Sec-Fetch-Site"] = "same-origin"
    headers["Timezone"] = "+08:00"

    payload = build_payload(company_id, ip_url_keyword, agent_status=agent_status)

    log(f"查询资产台账... company_id={company_id}, ip_url_keyword={ip_url_keyword}, agent_status={agent_status}", "INFO")
    response = request_with_retry("POST", ASSET_URL, headers=headers, json=payload)

    if response is None:
        log("资产台账请求失败", "ERROR")
        return None

    try:
        result = response.json()
        return result
    except Exception:
        log("解析资产台账响应失败", "ERROR")
        return None


def parse_asset_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """从响应中提取 total 和 list，判断是否有客户资产。"""
    if result is None:
        return {"has_asset": False, "error": "请求失败", "total": 0, "list": []}

    if result.get("code") != 0:
        msg = result.get("msg", "Unknown error")
        return {"has_asset": False, "error": f"API 返回错误: {msg}", "total": 0, "list": []}

    data = result.get("data", {})
    total = data.get("total", 0)
    asset_list = data.get("list", [])

    has_asset = total > 0 and len(asset_list) > 0

    return {"has_asset": has_asset, "error": None, "total": total, "list": asset_list}


def format_asset(asset: Dict[str, Any]) -> str:
    """格式化单条资产记录，便于展示。"""
    fields = []
    for key in ("asset", "asset_name", "hostname", "asset_type", "asset_group_name",
                "security_domain", "owner_name", "business_name", "os"):
        val = asset.get(key)
        if val not in (None, ""):
            fields.append(f"{key}={val}")
    return " | ".join(fields)


def check_edr_status(agent_status) -> str:
    """根据单条资产记录里的 agent_status 字段，返回 EDR 安装状态描述。

    取值含义：
      - '' / None → 设备管理中无该资产的 EDR 安装信息
      - '0' → 离线
      - '1' → 在线
      - '2' → 已禁用
      - '3' → 已卸载
    """
    mapping = {
        "": "设备管理中无该资产的EDR安装信息",
        "0": "离线",
        "1": "在线",
        "2": "已禁用",
        "3": "已卸载",
    }
    if agent_status is None:
        agent_status = ""
    agent_status = str(agent_status)
    return mapping.get(agent_status, f"未知状态({agent_status})")



if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="通报回函 - 查询资产台账，判断是否客户资产")
    parser.add_argument("--company-id", type=str, required=True, help="客户公司 ID")
    parser.add_argument("--ip", type=str, required=True, help="源 IP 地址（作为 ip_url_keyword）")
    parser.add_argument("--show-assets", action="store_true", help="命中时打印完整资产列表")
    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        log("Cookie 无效或已过期", "ERROR")
        sys.exit(2)

    result = query_assets(args.company_id, args.ip, cookie)
    parsed = parse_asset_result(result)

    if parsed["error"]:
        log(parsed["error"], "ERROR")
        sys.exit(2)

    if parsed["has_asset"]:
        log(f"✅ 命中客户资产，共 {parsed['total']} 条", "INFO")
        if args.show_assets:
            for asset in parsed["list"]:
                print(f"  - {format_asset(asset)}")

        # 取 list 第一个资产，读其 agent_status 字段判断 EDR 安装状态
        first_asset = parsed["list"][0]
        first_asset_str = format_asset(first_asset)
        agent_status = first_asset.get("agent_status")
        edr_state = check_edr_status(agent_status)
        log(f"EDR 安装状态: {edr_state}（agent_status={agent_status!r}）", "INFO")

        print(f"HAS_ASSET=True")
        print(f"TOTAL={parsed['total']}")
        print(f"FIRST_ASSET={first_asset_str}")
        print(f"EDR_STATUS={edr_state}")
        print(f"AGENT_STATUS={agent_status!r}")
        sys.exit(0)
    else:
        log(f"❌ 未命中客户资产（total={parsed['total']}）", "INFO")
        print(f"HAS_ASSET=False")
        print(f"TOTAL={parsed['total']}")
        sys.exit(1)
