#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 0 Runner - 扫描前准备阶段

职责：
1. 公司信息确认
2. 配置管理
3. 创建任务确认
"""
import re
import sys
from typing import Tuple, Optional, Dict, Any

import os
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import log, COMPANY_LIST_HEADERS, request_with_retry, debug_request, extract_cookie_value
from config_manager import get_config, config_exists


class MultipleCandidatesError(Exception):
    """
    匹配到多个候选公司时抛出此异常，携带候选列表。
    phase1_trigger.py 捕获后发送企微消息让用户确认，再重新执行。
    """
    def __init__(self, candidates):
        self.candidates = candidates  # list of {company_name, company_id}
        super().__init__(f"MULTIPLE_CANDIDATES:{len(candidates)}")


class ConfigExistAskError(Exception):
    """发现已有配置、但用户未明确说要沿用时抛出此异常。"""
    def __init__(self, company_name: str, company_id: str, scan_config: Dict[str, Any]):
        self.company_name = company_name
        self.company_id = company_id
        self.scan_config = scan_config
        super().__init__(f"ASK_USER:{company_name}:{company_id}")


COMPANY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/user/company_simple_info"


def _notify_error(msg: str):
    try:
        from notify import send_notification
        send_notification(msg)
    except Exception:
        pass


def fetch_company_list(cookie: str, offset: int = 0, limit: int = 100):
    """从 API 获取客户公司列表（单页）。"""
    import uuid
    headers = COMPANY_LIST_HEADERS.copy()
    headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())
    headers["Cache-Control"] = "no-cache"
    headers["Pragma"] = "no-cache"
    headers["Priority"] = "u=1, i"
    headers["Sec-Ch-Ua"] = '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"'
    headers["Sec-Ch-Ua-Mobile"] = "?0"
    headers["Sec-Ch-Ua-Platform"] = '"Windows"'
    headers["Sec-Fetch-Dest"] = "empty"
    headers["Sec-Fetch-Mode"] = "cors"
    headers["Sec-Fetch-Site"] = "same-origin"
    headers["Timezone"] = "+08:00"

    payload = {
        "keyword": "",
        "offset": offset,
        "limit": limit
    }

    log(f"[INFO] 正在获取客户公司列表... (offset={offset})", "INFO")
    response = request_with_retry("POST", COMPANY_LIST_URL, headers=headers, json=payload)

    if response is None:
        log("[X ERROR] 获取客户列表失败", "ERROR")
        debug_request(COMPANY_LIST_URL, headers, payload, cookie)
        return {"code": -1, "data": {"list": []}}

    try:
        result = response.json()
        list_count = len(result.get('data', {}).get('list', []))
        log(f"[INFO] 获取到 {list_count} 条客户记录", "INFO")
        return result
    except Exception:
        log("[X ERROR] 解析客户列表响应失败", "ERROR")
        return {"code": -1, "data": {"list": []}}


def fetch_all_companies(cookie: str):
    """分页获取全部客户公司列表，直到全部拉完。"""
    all_companies = []
    offset = 0
    limit = 100

    while True:
        result = fetch_company_list(cookie, offset=offset, limit=limit)
        if result is None or result.get("code") != 0:
            log(f"[X ERROR] 获取客户列表失败: {result.get('msg', 'Unknown error') if result else '网络错误'}", "ERROR")
            return None

        page_list = result.get("data", {}).get("list", [])
        total = result.get("data", {}).get("total", 0)

        all_companies.extend(page_list)
        log(f"[INFO] 已获取 {len(all_companies)} 条客户记录（API total={total}）", "INFO")

        if len(page_list) < limit:
            break
        if offset + limit >= 20000:
            log(f"[WARNING] 已获取 {len(all_companies)} 条，达到安全上限，停止翻页", "WARNING")
            break
        offset += limit

    return all_companies


def resolve_company(company_hint: str, cookie: str) -> Tuple[str, str]:
    """
    根据用户输入的公司名称，从全量客户列表中匹配，支持翻页遍历。
    返回 (确认后的 company_name, 确认后的 company_id)。
    """
    all_companies = fetch_all_companies(cookie)
    if all_companies is None:
        log(f"[X ERROR] 获取客户列表失败", "ERROR")
        _notify_error(f"❌ 获取客户列表失败")
        sys.exit(1)

    candidates = []
    for c in all_companies:
        company_name = c.get("company_name", "")
        if company_hint in company_name:
            candidates.append({"company_name": company_name, "company_id": c["company_id"]})

    if len(candidates) == 0:
        log(f"[X ERROR] 没有找到包含「{company_hint}」的客户，请确认公司名称。", "ERROR")
        _notify_error(f"❌ 没有找到包含「{company_hint}」的客户，请确认公司名称。")
        sys.exit(1)

    if len(candidates) == 1:
        confirmed_name = candidates[0]["company_name"]
        confirmed_id = candidates[0]["company_id"]
        log(f"[INFO] 唯一匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    # 多条候选：优先取精准匹配
    exact_matches = [c for c in candidates if c["company_name"] == company_hint]
    if len(exact_matches) == 1:
        confirmed_name = exact_matches[0]["company_name"]
        confirmed_id = exact_matches[0]["company_id"]
        log(f"[INFO] 精准匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    raise MultipleCandidatesError(candidates)


def resolve_company_by_id(company_id: str, cookie: str) -> Tuple[str, str]:
    """
    根据 company_id 精确查找公司名称（支持翻页遍历全量客户）。
    返回 (company_name, company_id)。
    """
    all_companies = fetch_all_companies(cookie)
    if all_companies is None:
        log(f"[X ERROR] 获取客户列表失败", "ERROR")
        _notify_error(f"❌ 获取客户列表失败")
        sys.exit(1)

    for c in all_companies:
        if str(c.get("company_id")) == str(company_id):
            log(f"[INFO] 通过 company_id 匹配: {c['company_name']} (company_id: {c['company_id']})", "INFO")
            return c["company_name"], c["company_id"]

    log(f"[X ERROR] 未找到 company_id={company_id} 的客户", "ERROR")
    _notify_error(f"❌ 未找到 company_id={company_id} 的客户")
    sys.exit(1)


def manage_config(
    company_id: str,
    company_name: str,
    refresh_config: bool = False,
    config_only: bool = False,
    auto_confirm: bool = False
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """管理扫描配置"""
    config_exists_flag = config_exists(company_id)

    if refresh_config or not config_exists_flag:
        if not config_exists_flag:
            log(f"[INFO] 未找到 {company_name} 的扫描配置，首次执行，开始创建...", "INFO")
        else:
            log("[INFO] 用户要求重新配置...", "INFO")

        scan_config = get_config(company_id, company_name, auto_confirm=auto_confirm)
        if scan_config is None:
            log("[INFO] 用户取消配置，流程结束", "INFO")
            sys.exit(0)
        return scan_config, True
    else:
        if auto_confirm:
            log(f"[INFO] 找到 {company_name} 的已有扫描配置，自动确认使用", "INFO")
            scan_config = get_config(company_id, company_name, auto_confirm=True)
        else:
            scan_config = get_config(company_id, company_name, auto_confirm=False)
            raise ConfigExistAskError(company_name, company_id, scan_config)

    if config_only:
        log("[INFO] 配置查看/修改完成，退出", "INFO")
        return None, False

    return scan_config, False


def confirm_create_task(auto_confirm: bool = False) -> bool:
    """阶段1结束：确认是否创建扫描任务"""
    log("\n" + "=" * 60, "INFO")
    log("阶段1完成：准备创建扫描任务", "INFO")
    log("=" * 60, "INFO")

    if auto_confirm:
        log("[INFO] 自动确认，进入阶段1：创建扫描任务...", "INFO")
        return True

    try:
        confirm = input("\n确认创建扫描任务并立即执行？(确认=创建并执行 / 取消=不创建): ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n")
        log("[INFO] 用户取消，流程结束", "INFO")
        return False

    if confirm not in ["确认", "确定", "ok", "OK", "yes", "是", "y", "Y"]:
        log("[INFO] 用户取消创建任务，流程结束", "INFO")
        return False

    log("[INFO] 用户确认，进入阶段1：创建扫描任务...", "INFO")
    return True


def phase1_prepare(
    company_hint: str,
    cookie: str,
    refresh_config: bool = False,
    config_only: bool = False,
    auto_confirm: bool = False
) -> Optional[Tuple[str, str, Dict[str, Any]]]:
    """阶段1主入口：扫描前准备"""
    log("=" * 60, "INFO")
    log("阶段1：扫描前准备", "INFO")
    log("=" * 60, "INFO")

    log("\n[步骤1/3] 确认公司信息", "INFO")
    company_name, company_id = resolve_company(company_hint, cookie)
    log(f"[OK] 确认公司: {company_name} (company_id: {company_id})", "INFO")

    log("\n[步骤2/3] 管理扫描配置", "INFO")
    try:
        scan_config, config_is_new = manage_config(company_id, company_name, refresh_config, config_only, auto_confirm)
    except ConfigExistAskError as e:
        raise e
    if scan_config is None:
        return None
    log(f"[OK] 配置就绪", "INFO")

    log("\n[步骤3/3] 确认执行任务", "INFO")
    if config_is_new:
        log("[INFO] 配置已确认，进入阶段1：创建扫描任务...", "INFO")
    else:
        if not confirm_create_task(auto_confirm):
            return None

    return company_name, company_id, scan_config


if __name__ == "__main__":
    import argparse
    from shared import get_cookie

    parser = argparse.ArgumentParser(description="Phase 0: Prepare")
    parser.add_argument("--company", type=str, required=True, help="公司名称")
    parser.add_argument("--refresh-config", action="store_true", help="强制重新配置")
    parser.add_argument("--config-only", action="store_true", help="仅配置模式")

    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        _notify_error("❌ Cookie 无效或已过期")
        sys.exit(1)

    result = phase1_prepare(
        company_hint=args.company,
        cookie=cookie,
        refresh_config=args.refresh_config,
        config_only=args.config_only
    )

    if result:
        company_name, company_id, scan_config = result
        log("\n" + "=" * 60, "INFO")
        log("阶段1完成，准备进入阶段1", "INFO")
        log(f"公司: {company_name} ({company_id})", "INFO")
        log(f"配置: {scan_config}", "INFO")
        log("=" * 60, "INFO")
    else:
        log("阶段1未完成", "INFO")