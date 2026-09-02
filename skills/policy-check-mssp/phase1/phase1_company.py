#!/usr/bin/env python3
"""Resolve an MSSP company name while preserving the legacy matching rules."""

import json
import os
import tempfile
from typing import Dict, List, Tuple

from shared import cache_dir, request_json


class MultipleCandidatesError(RuntimeError):
    def __init__(self, candidates: List[Dict]):
        super().__init__(f"找到 {len(candidates)} 个匹配客户，请确认后重新提交")
        self.candidates = candidates


def _company_values(company: Dict) -> Tuple[str, str]:
    name = company.get("company_name") or company.get("name") or ""
    company_id = company.get("company_id") or company.get("id") or ""
    return str(name).strip(), str(company_id).strip()


def _candidate_path() -> str:
    return os.path.join(cache_dir(), "phase1_candidates.json")


def _write_candidates(candidates: List[Dict]) -> None:
    fd, temp_path = tempfile.mkstemp(prefix=".candidates-", dir=cache_dir())
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(candidates, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, _candidate_path())
        os.chmod(_candidate_path(), 0o600)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def query_companies(cookie: str, keyword: str) -> List[Dict]:
    payload = {
        "order": "asc", "offset": 0, "limit": 20, "keyword": keyword,
        "share_ids": [], "delivery_channel_id": [], "service_code": [],
        "industry": [], "industry_segmentation": [], "customer_type": [],
        "customer_stratification": [], "protection_type": [], "service_group": [],
        "delivery_method": [], "platform_type": [], "service_status": 0,
        "my_customer": 0,
    }
    result = request_json(cookie, "POST", "customer_search", payload)
    companies = result.get("data", {}).get("list", [])
    if not isinstance(companies, list) or not companies:
        raise RuntimeError("MSSP 客户列表为空")
    return companies


def resolve_company(company_input: str, cookie: str) -> Tuple[str, str]:
    query = str(company_input).strip()
    if not query:
        raise ValueError("客户名称不能为空")
    companies = query_companies(cookie, query)
    normalized = [(*_company_values(item), item) for item in companies]
    for name, company_id, _ in normalized:
        if name == query or company_id == query:
            return name, company_id
    matches = [(name, company_id) for name, company_id, _ in normalized if query.lower() in name.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        candidates = [{"name": name, "id": company_id} for name, company_id in matches]
        _write_candidates(candidates)
        raise MultipleCandidatesError(candidates)
    raise RuntimeError(f"未找到匹配客户: {query}")


def resolve_by_selection(selection: str) -> Tuple[str, str]:
    try:
        with open(_candidate_path(), "r", encoding="utf-8") as handle:
            candidates = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("没有可用的客户候选记录") from exc
    text = str(selection).strip()
    if text.isdigit() and 1 <= int(text) <= len(candidates):
        chosen = candidates[int(text) - 1]
        os.unlink(_candidate_path())
        return str(chosen["name"]), str(chosen["id"])
    for candidate in candidates:
        if str(candidate.get("name", "")).strip() == text:
            os.unlink(_candidate_path())
            return str(candidate["name"]), str(candidate["id"])
    raise RuntimeError(f"无效的客户候选选择: {text}")
