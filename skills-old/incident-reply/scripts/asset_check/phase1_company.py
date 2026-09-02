#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通报事件回函 - 公司信息解析脚本
================================
职责：
  根据用户输入的公司名称，调用 SOAR 客户公司列表 API（keyword 搜索），
  匹配并返回对应的 company_id（和标准化后的公司名）。

用法：
  python phase1_company.py --company "公司名"
  输出（stdout 最后两行）：
    COMPANY_ID=xxxxx
    COMPANY_NAME=xxxxx

匹配逻辑：
  1. 用 keyword=公司名 直接搜索（公司列表接口必须传非空 keyword，空值会返回 code=9451 非法操作）
  2. 唯一命中 → 直接返回
  3. 多条命中 → 优先精准匹配（company_name == 输入名）；仍多条则抛 MultipleCandidatesError
  4. 无命中 → 报错退出
"""
import os
import sys
import uuid
import time
from typing import Tuple, Optional, Dict, Any

import requests
import warnings

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


class MultipleCandidatesError(Exception):
    """匹配到多个候选公司时抛出此异常，携带候选列表。"""

    def __init__(self, candidates):
        self.candidates = candidates  # list of {company_name, company_id}
        super().__init__(f"MULTIPLE_CANDIDATES:{len(candidates)}")


# =============================================================================
# 常量
# =============================================================================
COMPANY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/user/company_simple_info"

COMPANY_LIST_HEADERS = {
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
# 公司搜索
# =============================================================================
def search_companies(keyword: str, cookie: str) -> Optional[list]:
    """用 keyword 直接搜索公司列表，返回公司记录列表（list of {company_name, company_id}）。"""
    headers = COMPANY_LIST_HEADERS.copy()
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

    payload = {"keyword": keyword, "offset": 0, "limit": 100}

    log(f"搜索公司: keyword={keyword}", "INFO")
    response = request_with_retry("POST", COMPANY_LIST_URL, headers=headers, json=payload)

    if response is None:
        log("搜索公司请求失败", "ERROR")
        return None

    result = response.json()
    if result.get("code") != 0:
        log(f"搜索公司失败: {result.get('msg', 'Unknown error')} (code={result.get('code')})", "ERROR")
        return None

    data = result.get("data", {})
    company_list = data.get("list", [])
    log(f"搜索到 {len(company_list)} 条公司记录", "INFO")
    return [
        {"company_name": c.get("company_name", ""), "company_id": c.get("company_id", "")}
        for c in company_list
    ]


def resolve_company(company_hint: str, cookie: str) -> Tuple[str, str]:
    """根据公司名称匹配，返回 (company_name, company_id)。"""
    candidates = search_companies(company_hint, cookie)

    if candidates is None:
        log("获取客户列表失败", "ERROR")
        sys.exit(1)

    if len(candidates) == 0:
        log(f"没有找到包含「{company_hint}」的客户，请确认公司名称。", "ERROR")
        sys.exit(1)

    if len(candidates) == 1:
        confirmed_name = candidates[0]["company_name"]
        confirmed_id = candidates[0]["company_id"]
        log(f"唯一匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    exact_matches = [c for c in candidates if c["company_name"] == company_hint]
    if len(exact_matches) == 1:
        confirmed_name = exact_matches[0]["company_name"]
        confirmed_id = exact_matches[0]["company_id"]
        log(f"精准匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    raise MultipleCandidatesError(candidates)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="通报回函 - 解析公司ID")
    parser.add_argument("--company", type=str, required=True, help="公司名称")
    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        log("Cookie 无效或已过期", "ERROR")
        sys.exit(1)

    try:
        company_name, company_id = resolve_company(args.company, cookie)
    except MultipleCandidatesError as e:
        log(f"匹配到多个候选公司: {[(c['company_name'], c['company_id']) for c in e.candidates]}", "ERROR")
        sys.exit(2)

    print(f"COMPANY_ID={company_id}")
    print(f"COMPANY_NAME={company_name}")
