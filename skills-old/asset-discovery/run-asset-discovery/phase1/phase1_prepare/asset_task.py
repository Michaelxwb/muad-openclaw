#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产发现任务创建脚本

URL: https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task?op=new
立即下发资产发现任务。
"""
import sys
import os
import uuid
import json
from typing import List, Optional, Dict, Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import (
    log,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    DEFAULT_HEADERS,
    send_notification,
)


ASSET_TASK_API_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task"


def create_asset_discovery_task(
    cookie: str,
    task_name: str,
    dev_id: int,
    company_id: str,
    asset_list: List[str],
    conc_num: int = 64,
    scan_type: Optional[Dict[str, Any]] = None,
    excute_mode: int = 1,
    start_time: int = 0
) -> Dict[str, Any]:
    """
    创建设备资产发现任务。

    Args:
        cookie: Cookie 字符串
        task_name: 任务名称
        dev_id: 设备ID
        company_id: 公司ID
        asset_list: 资产IP列表
        conc_num: 并发数，默认 64
        scan_type: 扫描类型配置，默认使用全量扫描配置
        excute_mode: 执行模式，1=立即执行，0=定时执行
        start_time: 定时开始时间（Unix时间戳毫秒），0=立即执行
    """
    if scan_type is None:
        scan_type = {
            "survivability": ["tcp", "icmp"],
            "port_type": "full",
            "system": True,
            "appl_scan": [
                "middleware",
                "database",
                "dev_language",
                "dev_framework",
                "web_appidentify"
            ],
            "device_fingerprint": [
                "equ_type",
                "equ_vendors"
            ]
        }

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())

    # task_type：立即执行=8，定时执行=10
    task_type = 8 if start_time == 0 else 10
    payload = {
        "company_id": company_id,
        "task_name": task_name,
        "task_type": task_type,
        "conc_num": conc_num,
        "dev_id": dev_id,
        "asset_list": list(set(asset_list)),
        "scan_type": scan_type,
        "excute_mode": excute_mode,
        "start_time": start_time,
    }

    log(f"[INFO] 创建设备资产发现任务: {task_name}", "INFO")
    log(f"[INFO] Payload: {json.dumps(payload, ensure_ascii=False, indent=2)}", "INFO")

    response = request_with_retry("POST", ASSET_TASK_API_URL + "?op=new", headers=headers, json=payload)
    if response is None:
        log("[X ERROR] 请求失败", "ERROR")
        return {"code": -1, "msg": "请求失败"}

    try:
        result = response.json()
    except Exception as e:
        log(f"[X ERROR] JSON 解析失败: {e}", "ERROR")
        return {"code": -1, "msg": f"JSON 解析失败: {e}"}

    log(f"[INFO] Response: {json.dumps(result, ensure_ascii=False, indent=2)}", "INFO")

    # code=0 成功；code=1105 警告（定时任务时间同步提示，但任务仍创建成功）
    if result.get("code") == 0:
        log(f"[OK] 资产发现任务创建成功: {task_name}", "INFO")
    elif result.get("code") == 1105:
        # 1105：时间同步警告，任务仍创建成功，不当作错误
        log(f"[WARNING] 资产发现任务已创建（时间同步警告）: {task_name}，msg={result.get('msg', '')}", "WARNING")
    else:
        log(f"[X ERROR] 资产发现任务创建失败: {result.get('msg', 'Unknown error')}", "ERROR")

    return result


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="创建设备资产发现任务")
    parser.add_argument("--task-name", type=str, required=True, help="任务名称")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("--dev-id", type=int, required=True, help="设备ID")
    parser.add_argument("--asset-list", type=str, default="", help="资产IP列表，JSON格式或逗号分隔")
    parser.add_argument("--conc-num", type=int, default=64, help="并发数，默认 64")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie字符串")

    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    # 解析 asset_list
    asset_list = []
    if args.asset_list:
        # 尝试 JSON 格式
        try:
            asset_list = json.loads(args.asset_list)
        except Exception:
            # 逗号分隔格式
            asset_list = [ip.strip() for ip in args.asset_list.split(",") if ip.strip()]

    result = create_asset_discovery_task(
        cookie=cookie,
        task_name=args.task_name,
        dev_id=args.dev_id,
        company_id=args.company_id,
        asset_list=asset_list,
        conc_num=args.conc_num
    )

    if result.get("code") == 0:
        log(f"[OK] 任务创建成功", "INFO")
        log(f"任务ID: {result.get('data', {}).get('task_id', 'N/A')}")
        sys.exit(0)
    else:
        log(f"[X ERROR] 任务创建失败: {result.get('msg', 'Unknown error')}", "ERROR")
        sys.exit(1)