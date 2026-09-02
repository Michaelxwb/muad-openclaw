#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 - 公司信息确认与配置管理

职责：
1. 公司信息确认（company_name, company_id）
2. 配置管理
3. 创建任务确认
"""
import re
import sys
import os
import json
import uuid
from typing import Tuple, Optional, Dict, Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import log, COMPANY_LIST_HEADERS, request_with_retry, extract_cookie_value, get_cookie


class MultipleCandidatesError(Exception):
    """
    匹配到多个候选公司时抛出此异常，携带候选列表。
    phase1_trigger.py 捕获后发送企微消息让用户确认，再重新执行。
    """
    CANDIDATES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "cache", "asset_discovery_candidates.json")

    def __init__(self, candidates):
        self.candidates = candidates
        try:
            os.makedirs(os.path.dirname(self.CANDIDATES_FILE), exist_ok=True)
            with open(self.CANDIDATES_FILE, "w", encoding="utf-8") as f:
                json.dump(candidates, f, ensure_ascii=False, indent=2)
            print(f"[DEBUG] 候选公司已写入: {self.CANDIDATES_FILE}")
        except Exception as ex:
            print(f"[WARNING] 候选公司写入失败: {ex}")
        super().__init__(f"MULTIPLE_CANDIDATES:{len(candidates)}")


class ConfigExistAskError(Exception):
    """
    发现已有配置、但用户未明确说要沿用时抛出此异常。
    携带要询问用户的配置信息，runner层捕获后打印用户提示语并退出。
    """
    def __init__(self, company_name: str, company_id: str, scan_config: Dict[str, Any]):
        self.company_name = company_name
        self.company_id = company_id
        self.scan_config = scan_config
        super().__init__(f"ASK_USER:{company_name}:{company_id}")


COMPANY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/user/company_simple_info"


def fetch_company_list(cookie: str, offset: int = 0, limit: int = 100):
    """从 API 获取客户公司列表（单页）"""
    headers = COMPANY_LIST_HEADERS.copy()
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
        "limit": limit,
        "service_status": 1,
        "my_customer": 0,
        "my_customer_first_handler": 0
    }

    response = request_with_retry("POST", COMPANY_LIST_URL, headers=headers, json=payload)
    if response is None:
        return None

    try:
        result = response.json()
        return result
    except Exception:
        return None


def fetch_all_companies(cookie: str):
    """分页获取全部客户公司列表，直到全部拉完或找到目标"""
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

        if offset == 0:
            log(f"[INFO] 正在获取客户公司列表...", "INFO")

        all_companies.extend(page_list)
        log(f"[INFO] 已获取 {len(all_companies)} 条客户记录（API total={total}）", "INFO")

    # API 的 total 字段不可靠，用 len(page_list) < limit 判断是否到最后一页
        if len(page_list) < limit:
            break
        if offset + limit >= 20000:  # 安全上限（最多 200 页）
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
        sys.exit(1)

    candidates = []
    for c in all_companies:
        company_name = c.get("company_name", "")
        if company_hint in company_name:
            candidates.append({"company_name": company_name, "company_id": c["company_id"]})

    if len(candidates) == 0:
        log(f"[X ERROR] 没有找到包含「{company_hint}」的客户，请确认公司名称。", "ERROR")
        sys.exit(1)

    if len(candidates) == 1:
        confirmed_name = candidates[0]["company_name"]
        confirmed_id = candidates[0]["company_id"]
        log(f"[INFO] 唯一匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    # 精准匹配优先
    exact_matches = [c for c in candidates if c["company_name"] == company_hint]
    if len(exact_matches) == 1:
        confirmed_name = exact_matches[0]["company_name"]
        confirmed_id = exact_matches[0]["company_id"]
        log(f"[INFO] 精准匹配: {confirmed_name} (company_id: {confirmed_id})，自动采用。", "INFO")
        return confirmed_name, confirmed_id

    raise MultipleCandidatesError(candidates)


def resolve_company_by_id(company_id: str, cookie: str) -> Tuple[str, str]:
    """
    根据 company_id 精确查找公司名称（供计划任务触发时使用，避免中文乱码）。
    分页遍历全部公司直到找到匹配。
    返回 (company_name, company_id)。
    """
    all_companies = fetch_all_companies(cookie)
    if all_companies is None:
        log(f"[X ERROR] 获取客户列表失败", "ERROR")
        sys.exit(1)

    for c in all_companies:
        if str(c.get("company_id")) == str(company_id):
            log(f"[INFO] 通过 company_id 匹配: {c['company_name']} (company_id: {c['company_id']})", "INFO")
            return c["company_name"], c["company_id"]

    log(f"[X ERROR] 未找到 company_id={company_id} 的客户", "ERROR")
    sys.exit(1)


def lookup_candidate_by_index(index: int) -> Optional[Dict[str, Any]]:
    """根据用户回复的编号，查找对应的候选公司。index从1开始。"""
    if not os.path.exists(MultipleCandidatesError.CANDIDATES_FILE):
        return None
    try:
        with open(MultipleCandidatesError.CANDIDATES_FILE, "r", encoding="utf-8") as f:
            candidates = json.load(f)
        idx = index - 1
        if 0 <= idx < len(candidates):
            return candidates[idx]
    except Exception:
        pass
    return None


def lookup_candidate_by_name(name: str) -> Optional[Dict[str, Any]]:
    """根据用户回复的公司名称，查找对应的候选公司（精确匹配 company_name）。"""
    if not os.path.exists(MultipleCandidatesError.CANDIDATES_FILE):
        return None
    try:
        with open(MultipleCandidatesError.CANDIDATES_FILE, "r", encoding="utf-8") as f:
            candidates = json.load(f)
        for c in candidates:
            if c["company_name"] == name:
                return c
    except Exception:
        pass
    return None


def config_exists(company_id: str) -> bool:
    """检查配置是否存在"""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "..", "companies", f"{company_id}.json"
    )
    return os.path.exists(config_path)


def manage_config(
    company_id: str,
    company_name: str,
    refresh_config: bool = False,
    config_only: bool = False,
    auto_confirm: bool = False
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """
    管理扫描配置

    Args:
        company_id: 公司ID
        company_name: 公司名称
        refresh_config: 是否强制重新配置
        config_only: 是否仅配置模式（不执行扫描）
        auto_confirm: 是否自动确认（非交互模式）

    Returns:
        (配置字典, 是否为新创建的配置) 或 (None, False)（如果仅配置模式）
    """
    config_exists_flag = config_exists(company_id)

    if refresh_config or not config_exists_flag:
        if not config_exists_flag:
            log(f"[INFO] 未找到 {company_name} 的扫描配置，首次执行，开始创建...", "INFO")
        else:
            log("[INFO] 用户要求重新配置...", "INFO")

        # 从默认配置加载
        default_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "..", "templates", "default_user_config.json"
        )
        with open(default_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        # 保存配置
        companies_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "..", "companies"
        )
        os.makedirs(companies_dir, exist_ok=True)
        config_path = os.path.join(companies_dir, f"{company_id}.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        log(f"[INFO] 配置已保存: {config_path}", "INFO")
        return config, True
    else:
        # 配置存在，自动确认使用
        if auto_confirm:
            log(f"[INFO] 找到 {company_name} 的已有扫描配置，自动确认使用", "INFO")
            config_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "..", "companies", f"{company_id}.json"
            )
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            return config, False
        else:
            # 询问用户是否沿用已有配置
            config_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "..", "companies", f"{company_id}.json"
            )
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            raise ConfigExistAskError(company_name, company_id, config)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Phase 1: 公司信息确认")
    parser.add_argument("--company", type=str, required=True, help="公司名称")
    parser.add_argument("--refresh-config", action="store_true", help="强制重新配置")
    parser.add_argument("--config-only", action="store_true", help="仅配置模式")

    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    company_name, company_id = resolve_company(args.company, cookie)
    print(f"\n确认公司: {company_name} (company_id: {company_id})")

    config, is_new = manage_config(
        company_id,
        company_name,
        refresh_config=args.refresh_config,
        config_only=args.config_only,
        auto_confirm=True
    )

    print(f"\n配置就绪: {config}")
    print(f"新配置: {is_new}")