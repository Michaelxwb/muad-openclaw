#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 5: Download report"""

import os
import sys
import time
from datetime import datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    DEFAULT_HEADERS,
    REPORT_DOWNLOAD_URL,
    MAX_RETRIES,
    RETRY_DELAY,
    debug_request,
)

import requests


def _export_type_label(export_type: int) -> str:
    """将 export_type 数值映射为中文标签"""
    return {0: "业务维度", 1: "资产维度", 2: "责任人维度"}.get(export_type, f"未知({export_type})")


def phase5_download_report(
    cookie: str,
    report_task_id: str,
    company_id: str,
    company_name: str = "",
    export_type: int = 0,
) -> Optional[str]:
    log("=" * 50, "INFO")
    log("Phase 5: Download report", "INFO")
    log("=" * 50, "INFO")

    url = f"{REPORT_DOWNLOAD_URL}?task_id={report_task_id}&company_id={company_id}"
    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["Accept"] = "*/*"

    download_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    os.makedirs(download_dir, exist_ok=True)

    # 直接生成最终文件名
    now = datetime.now()
    date_str = now.strftime("%Y%m%d")
    time_str = now.strftime("%H%M%S")
    export_label = _export_type_label(export_type)
    file_name = f"{company_name}-{export_label}-漏洞报告-{date_str}-{time_str}.zip"
    save_path = os.path.join(download_dir, file_name)

    log(f"Save path: {save_path}", "INFO")

    try:
        for attempt in range(MAX_RETRIES):
            try:
                response = requests.get(url, headers=headers, timeout=300, verify=False, stream=True)
                break
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                    requests.exceptions.SSLError, requests.exceptions.RequestException) as e:
                attempt_num = attempt + 1
                log(f"  Attempt {attempt_num}/{MAX_RETRIES} failed - {e}", "WARNING")
                if attempt < MAX_RETRIES - 1:
                    log(f"  Waiting {RETRY_DELAY}s before retry...", "INFO")
                    time.sleep(RETRY_DELAY)
                else:
                    log(f"  X All {MAX_RETRIES} retry attempts failed, exit\", \"ERROR")
                    debug_request(url, headers, {}, cookie, is_download=True)
                    return None

        if response.status_code != 200:
            debug_request(url, headers, {}, cookie, is_download=True)

        with open(save_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        file_size = os.path.getsize(save_path)
        log(f"OK Report downloaded! Size: {file_size/1024/1024:.2f} MB", "INFO")
        log(f"OK 报告已保存: {file_name}", "INFO")
        return save_path

    except Exception as e:
        debug_request(url, headers, {}, cookie, is_download=True)
        return None