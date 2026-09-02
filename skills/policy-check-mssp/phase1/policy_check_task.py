#!/usr/bin/env python3
"""Distribute an MSSP policy-check task using the legacy request contract."""

from typing import Dict, List

from shared import request_json


def distribute_policy_check_task(cookie: str, company_id: str,
                                 dev_id_list: List[int]) -> Dict:
    if not dev_id_list:
        raise ValueError("设备列表为空，无法下发 MSSP 策略检查")
    payload = {"company_id": company_id, "dev_id": dev_id_list}
    return request_json(cookie, "POST", "distribute_task", payload, attempts=1)
