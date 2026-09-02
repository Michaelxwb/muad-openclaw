#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 3: Create report export task"""

import os
import sys
import json
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    DEFAULT_HEADERS,
    REPORT_TASK_URL,
    request_with_retry,
    send_notification,
)
from .phase3_fallback_report import phase3_fallback_report_task


def load_company_config(company_id: str) -> dict:
    """Load company config from config_manager/companies/{company_id}.json"""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config_manager", "companies", f"{company_id}.json"
    )
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def phase3_create_report_task(cookie: str, task_id: str, company_id: str, company_name: str = "") -> Optional[str]:
    log("=" * 50, "INFO")
    log("Phase 3: Create report task", "INFO")
    log("=" * 50, "INFO")

    url = f"{REPORT_TASK_URL}?_method=POST"
    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie

    # 从公司配置读取报告相关参数
    config = load_company_config(company_id)
    payload = {
        "export_type": config.get("export_type", 0),
        "vul_level_flag": config.get("vul_level_flag", 0),
        "export_file": {
            "vul_fix_schema": config.get("vul_fix_schema", 1),
            "vul_proof_report": config.get("vul_proof_report", 1),
        },
        "is_multi": config.get("is_multi", 0),
        "include_unnecessary": config.get("include_unnecessary", 1),
        "task_id": task_id,
        "company_id": company_id,
    }

    log(f"Phase 3 Payload: {payload}", "INFO")
    log(f"Using scan task ID: {task_id}", "INFO")

    try:
        response = request_with_retry("POST", url, headers=headers, json=payload)

        if response is None:
            log("X HTTP request failed → 触发 Fallback（无新增漏洞，导出处置中/修复失败）", "WARNING")
            return phase3_fallback_report_task(cookie, company_id)

        try:
            result = response.json()
            log(f"Response: {result}", "INFO")

            if result.get("code") != 0:
                log(f"X API code={result.get('code')} → 触发 Fallback（无新增漏洞，导出处置中/修复失败）", "WARNING")
                return phase3_fallback_report_task(cookie, company_id)

            report_task_id = result.get("data", {}).get("md5_index")
            log(f"OK Report task created! report_task_id={report_task_id}", "INFO")
            return report_task_id
        except Exception:
            log("X JSON parse error → 触发 Fallback（无新增漏洞，导出处置中/修复失败）", "WARNING")
            return phase3_fallback_report_task(cookie, company_id)

    except Exception as e:
        log(f"X Request exception: {e} → 触发 Fallback（无新增漏洞，导出处置中/修复失败）", "WARNING")
        return phase3_fallback_report_task(cookie, company_id)