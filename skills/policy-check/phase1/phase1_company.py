#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 前置：公司确认（策略检查专用）

通过 SOAR API 查询公司列表，匹配用户输入的公司名，返回 company_id。
API: POST http://mssw-inner.sangfor.com.cn:30001/gateway/customer-mgr-service/order/v1/user/customer_statistic?_method=GET

muad 改造：登录态由 shared.get_cookie()（session-manager 代管）提供，
多候选缓存改写到 shared 输出目录（skill 根只读）。
"""

import sys
import os

import uuid

# 确保 policy-check 根目录在 sys.path 最前面，方便 from shared import ...
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)
sys.dont_write_bytecode = True

from shared import (  # noqa: E402
    log,
    get_cookie,
    request_with_retry,
    extract_cookie_value,
    get_endpoint,
    get_base,
    get_host_header,
    save_candidates,
    load_candidates,
    remove_candidates,
)


class MultipleCandidatesError(Exception):
    """多个候选公司时需要用户确认"""

    def __init__(self, message, candidates):
        super().__init__(message)
        self.candidates = candidates

    def get_candidate(self, index: int):
        """按编号获取候选公司"""
        if 1 <= index <= len(self.candidates):
            return self.candidates[index - 1]
        return None


COMPANY_LIST_URL = get_endpoint("company_list")


def _build_headers(cookie: str) -> dict:
    """构建浏览器标准 Headers"""
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "cookie": cookie,
        "host": get_host_header(),
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": get_base("soar_referer"),
        "sec-ch-ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "timezone": "+08:00",
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
    }


def resolve_company(company_name: str, cookie: str = None) -> tuple:
    """
    根据用户输入的模糊公司名，从 SOAR 平台匹配准确公司名和 company_id。
    返回 (corrected_name, company_id)

    匹配规则：
    1. 精确匹配 name → 直接返回
    2. 部分匹配 name → 候选列表
    3. 精确匹配 company_id → 直接返回
    """
    if cookie is None:
        cookie = get_cookie()

    log(f"查询公司: '{company_name}'", "INFO")

    headers = _build_headers(cookie)
    response = request_with_retry("POST", COMPANY_LIST_URL, headers, timeout=30, json={
        "order": "desc",
        "keyword": "",
        "customer_category": 1,
        "company_id": "",
        "offset": 0,
        "limit": 0
    })

    result = response.json()
    if result.get("code") != 0:
        raise RuntimeError(f"公司列表查询失败: {result}")

    companies = result.get("data", {}).get("list", [])
    if not companies:
        raise RuntimeError("公司列表为空")

    log(f"获取到 {len(companies)} 家公司", "INFO")

    # 1. 精确匹配 company_name
    for c in companies:
        if c.get("company_name", "").strip() == company_name.strip():
            log(f"精确匹配: {c['company_name']} ({c['company_id']})", "INFO")
            return c["company_name"], str(c["company_id"])

    # 2. 精确匹配 company_id
    for c in companies:
        if str(c.get("company_id", "")) == company_name.strip():
            log(f"ID 匹配: {c['company_name']} ({c['company_id']})", "INFO")
            return c["company_name"], str(c["company_id"])

    # 3. 部分匹配（company_name 在 company_name 中）
    candidates = []
    for c in companies:
        if company_name.strip().lower() in c.get("company_name", "").strip().lower():
            candidates.append(c)

    if len(candidates) == 1:
        c = candidates[0]
        log(f"模糊匹配(1): {c['company_name']} ({c['company_id']})", "INFO")
        return c["company_name"], str(c["company_id"])

    if len(candidates) > 1:
        # 写入输出目录，等用户选择（skill 根只读）
        candidate_list = [{"name": c["company_name"], "id": str(c["company_id"])} for c in candidates]
        save_candidates(candidate_list)

        msg = f"找到 {len(candidates)} 个匹配公司:\n"
        for i, c in enumerate(candidates, 1):
            msg += f"  [{i}] {c['company_name']} (ID: {c['company_id']})\n"
        msg += f"\n请回复编号(如 1)或完整公司名确认"
        raise MultipleCandidatesError(msg, candidate_list)

    raise RuntimeError(f"未找到匹配 '{company_name}' 的公司")


def resolve_by_selection(selection: str) -> tuple:
    """根据用户回复的编号或完整公司名，从缓存中选择候选公司。"""
    candidates = load_candidates()
    if not candidates:
        raise RuntimeError("无候选缓存，请先输入公司名")

    # 尝试按编号
    try:
        idx = int(selection.strip())
        if 1 <= idx <= len(candidates):
            c = candidates[idx - 1]
            remove_candidates()
            log(f"用户选择[{idx}]: {c['name']} ({c['id']})", "INFO")
            return c["name"], c["id"]
    except ValueError:
        pass

    # 尝试按完整公司名
    for c in candidates:
        if c["name"].strip() == selection.strip():
            remove_candidates()
            log(f"用户选择: {c['name']} ({c['id']})", "INFO")
            return c["name"], c["id"]

    raise RuntimeError(f"无效选择: {selection}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("company", help="公司名或关键词")
    args = parser.parse_args()

    try:
        name, cid = resolve_company(args.company)
        print(f"✅ 确认公司: {name} ({cid})")
    except MultipleCandidatesError as e:
        print(e)
        sys.exit(10)
    except Exception as e:
        print(f"❌ {e}")
        sys.exit(1)
