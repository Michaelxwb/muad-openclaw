#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 4: Poll report generation"""

import os
import sys
import json
import time
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    DEFAULT_HEADERS,
    REPORT_STATUS_URL,
    POLL_INTERVAL,
    MAX_POLL_COUNT_PHASE4,
    request_with_retry,
    find_report_task,
)

def phase4_wait_report(cookie: str, task_id: str, company_id: str) -> Optional[str]:
    log("=" * 50, "INFO")
    log("Phase 4: Wait for report generation", "INFO")
    log(f"Using scan task ID: {task_id}", "INFO")
    log("=" * 50, "INFO")

    log("  Waiting 30s before polling report status...", "INFO")
    time.sleep(30)

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie

    end_time = datetime.now().strftime("%Y-%m-%d")
    start_time = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    for i in range(MAX_POLL_COUNT_PHASE4):
        current_loop = i + 1
        log(f"========== Loop {current_loop}/{MAX_POLL_COUNT_PHASE4} ==========", "INFO")

        payload = {
            "order": "asc",
            "offset": 0,
            "limit": 20,
            "keyword": "",
            "start_time": start_time,
            "end_time": end_time,
            "template_name": []
        }

        log(f"  Phase 4 Payload: {payload}", "INFO")

        try:
            response = request_with_retry("POST", REPORT_STATUS_URL, headers=headers, json=payload)

            if response is None:
                log("  X HTTP request failed, exit", "ERROR")
                return None

            try:
                result = response.json()
                log(f"  API response: code={result.get('code')}, msg={result.get('msg', '')}", "INFO")

                if result.get("code") != 0:
                    log(f"  API error: {result.get('msg', 'Unknown')}, exit", "ERROR")
                    return None

                report_task = find_report_task(result, cookie, company_id)

                if report_task:
                    task_status = report_task.get("task_status")
                    status_map = {
                        0: "Waiting",
                        1: "Waiting for generation",
                        2: "Completed",
                        3: "Generating",
                        4: "Failed"
                    }
                    status_text = status_map.get(task_status, f"Unknown({task_status})")

                    log(f"  Report status: {task_status} ({status_text})", "INFO")

                    if task_status == 2:
                        log("OK Report generated!", "INFO")
                        return report_task.get("task_id")
                    elif task_status == 4:
                        log("X Report generation failed", "ERROR")
                        return None
                    else:
                        log("  Report generating...", "INFO")
                else:
                    log("  No matching report task found", "INFO")

                if current_loop == MAX_POLL_COUNT_PHASE4:
                    log("X Max poll count reached, report not ready, exit", "ERROR")
                    return None

                log(f"  Waiting {POLL_INTERVAL}s before next poll...", "INFO")
                time.sleep(POLL_INTERVAL)

            except Exception as e:
                log(f"  JSON parse error: {e}", "WARNING")
                if current_loop == MAX_POLL_COUNT_PHASE4:
                    log("X Max poll count reached, report not ready, exit", "ERROR")
                    return None
                log(f"  Waiting {POLL_INTERVAL}s before retry...", "INFO")
                time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  Request exception: {e}", "WARNING")
            if current_loop == MAX_POLL_COUNT_PHASE4:
                log("X Max poll count reached, report not ready, exit", "ERROR")
                return None
            log(f"  Waiting {POLL_INTERVAL}s before retry...", "INFO")
            time.sleep(POLL_INTERVAL)

    log("X Poll timeout, report not ready", "ERROR")
    return None
