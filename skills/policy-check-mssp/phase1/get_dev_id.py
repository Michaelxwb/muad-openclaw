#!/usr/bin/env python3
"""Fetch all MSSP policy-check devices for one company."""

from typing import Dict, List, Tuple

from shared import request_json


def get_dev_id_list(cookie: str, company_id: str) -> Tuple[List[int], List[Dict]]:
    result = request_json(cookie, "POST", "device_info", {"company_id": company_id})
    data = result.get("data", {})
    devices = data.get("list", [])
    if not isinstance(devices, list) or not devices:
        raise RuntimeError(f"客户 {company_id} 没有可用于策略检查的安全设备")
    total = data.get("total")
    if isinstance(total, int) and total > len(devices):
        raise RuntimeError(f"设备列表不完整: 接口声明 {total} 台，实际返回 {len(devices)} 台")
    dev_ids = [item.get("dev_id") for item in devices if item.get("dev_id") is not None]
    if not dev_ids:
        raise RuntimeError("设备列表中没有有效 dev_id")
    return dev_ids, devices
