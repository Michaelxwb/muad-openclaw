#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1：下发策略检查任务

Payload: {"company_id":"50655704","dev_infos":[{"dev_id":338434,"dev_type":3,"dev_name":"..."},...]}

muad 改造：登录态/请求统一走 shared。
"""

import sys
import os

import uuid
import time

# 确保 policy-check 根目录在 sys.path 最前面
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
)

POLICY_CHECK_CREATE_URL = get_endpoint("policy_check_create")

# dev_type 字符串→整数映射（新接口要求）
DEV_TYPE_MAP = {
    3: "AF",
    9: "SIP",
    12: "EDR",
}

# 分批大小（CODE_XDR_DEV_NUM_LIMIT = >100，分批用 100 上限）
BATCH_SIZE = 100

# 10048 重试配置
RETRY_ON_10048_MAX = 3
RETRY_ON_10048_INTERVAL = 60  # seconds

# 全局变量，供 _call_create_api 内部使用（与原实现一致）
company_id_global = None


def _build_dev_infos(device_list: list) -> list:
    """
    从 device_list 中提取 dev_infos，跳过不支持的 dev_type，
    将 dev_type 字符串转为新接口要求的整数。
    """
    dev_infos = []
    skipped = []
    for device in device_list:
        dev_id = device.get("dev_id")
        dev_type = device.get("dev_type", "")
        dev_name = device.get("dev_name", "")

        # 跳过无 dev_id 的设备
        if dev_id is None:
            continue

        # 将 dev_type 转为整数
        if dev_type not in DEV_TYPE_MAP:
            skipped.append(f"{dev_type} {dev_name}(dev_id={dev_id})")
            continue

        dev_infos.append({
            "dev_id": dev_id,
            "dev_type": dev_type,
            "dev_name": dev_name,
            "dev_version": device.get("dev_version", ""),
        })

    if skipped:
        log(f"跳过不支持的设备类型: {'; '.join(skipped)}", "WARN")

    return dev_infos


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
        "x-mssw-company-id": company_id_global or "",
    }


def _call_create_api(cookie: str, batch_dev_infos: list) -> list:
    """
    调用一次 /policy_check/create 接口。
    返回该批次下发的 task_ids 列表。
    抛出 RuntimeError（含友好错误信息）或 sys.exit(1) 退出。
    """
    headers = _build_headers(cookie)
    payload = {
        "company_id": company_id_global,  # set before call
        "dev_infos": batch_dev_infos,
    }

    log(f"下发策略检查任务: company_id={payload['company_id']}, 设备数={len(batch_dev_infos)}")

    try:
        response = request_with_retry("POST", POLICY_CHECK_CREATE_URL, headers,
                                      timeout=30, json=payload)
        result = response.json()
        code = result.get("code")

        if code == 0:
            task_ids = result.get("data", {}).get("task_ids", [])
            log(f"策略检查任务下发成功: task_ids={task_ids}")
            return task_ids

        msg = result.get("msg", str(result))

        if code == 10048:
            raise RuntimeError(f"CODE_XDR_TASK_LIMIT: 并发任务数超限(>5), {msg}")
        elif code == 10054:
            log(f"CODE_XDR_DEV_NUM_LIMIT: 单次下发设备数超限(>{BATCH_SIZE}), {msg}", "WARN")
            raise RuntimeError(f"单次下发设备数超限(>{BATCH_SIZE})")
        elif code == 9265:
            raise RuntimeError(f"CODE_MSG_DEV_TYPE_ERROR: dev_type 不在支持枚举范围内, {msg}")
        elif code == 9001:
            raise RuntimeError(f"CODE_PARAM_ERROR: 参数错误, {msg}")
        else:
            raise RuntimeError(f"API 返回错误 code={code}: {msg}")
    except Exception as e:
        if isinstance(e, RuntimeError):
            raise
        raise RuntimeError(f"下发策略检查任务请求异常: {e}") from e


def distribute_policy_check_task(cookie: str, company_id: str, device_list: list) -> list:
    """
    下发策略检查任务。

    将 device_list 按 dev_infos 格式转换，超过 BATCH_SIZE 时自动分批下发，
    遇到 CODE_XDR_TASK_LIMIT(10048) 时自动重试。

    Args:
        cookie: SOAR 平台 Cookie
        company_id: 公司 ID
        device_list: 设备列表（含 dev_id, dev_type, dev_name）

    Returns:
        合并后的 task_ids 列表
    """
    global company_id_global
    company_id_global = company_id

    # Step 1: 构建 dev_infos（含类型过滤）
    dev_infos = _build_dev_infos(device_list)
    if not dev_infos:
        log("设备列表为空或不支持当前所有设备的类型，无法创建策略检查任务", "ERROR")
        raise RuntimeError("设备列表为空或不支持当前所有设备的类型，无法创建策略检查任务")

    # Step 2: 按 BATCH_SIZE 分批下发
    all_task_ids = []
    batches = [dev_infos[i:i + BATCH_SIZE] for i in range(0, len(dev_infos), BATCH_SIZE)]

    log(f"准备下发: 共 {len(dev_infos)} 台设备, 分 {len(batches)} 批(每批{BATCH_SIZE}台)")

    for batch_idx, batch in enumerate(batches, 1):
        task_ids = _call_create_with_retry(cookie, batch, batch_idx, len(batches))
        all_task_ids.extend(task_ids)

    log(f"全部下发完成: 共 {len(all_task_ids)} 个 task_id")
    return all_task_ids


def _call_create_with_retry(cookie: str, batch_dev_infos: list, batch_idx: int, total_batches: int) -> list:
    """调用 _call_create_api，遇到 10048 时按配置重试。"""
    label = f"第{batch_idx}/{total_batches}批" if total_batches > 1 else "单批"
    last_error = None

    for attempt in range(1, RETRY_ON_10048_MAX + 2):  # 1次正常 + RETRY_ON_10048_MAX 次重试
        try:
            log(f"下发 {label}: 尝试第{attempt}次...")
            return _call_create_api(cookie, batch_dev_infos)
        except RuntimeError as e:
            err_str = str(e)
            if "CODE_XDR_TASK_LIMIT" in err_str and attempt <= RETRY_ON_10048_MAX:
                log(f"并发任务数超限, 等待 {RETRY_ON_10048_INTERVAL}s 后重试 (第{attempt}/{RETRY_ON_10048_MAX}次)...", "WARN")
                time.sleep(RETRY_ON_10048_INTERVAL)
                last_error = e
                continue
            else:
                raise

    # 重试用完仍失败
    log(f"{label} 下发失败: 重试 {RETRY_ON_10048_MAX} 次后仍然超限", "ERROR")
    raise RuntimeError(f"{label} 下发失败: {last_error}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="下发策略检查任务")
    parser.add_argument("--company-id", type=str, required=True, help="公司 ID")
    parser.add_argument("--dev-ids", type=str, required=True, help="设备 ID 列表，逗号分隔，如 338434,222067")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")

    args = parser.parse_args()

    cookie = args.cookie or get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    # 命令行模式下构建虚拟 device_list（仅 dev_id，无类型）
    dev_ids = [int(x.strip()) for x in args.dev_ids.split(",") if x.strip()]
    dummy_device_list = [{"dev_id": did, "dev_type": "Unknown", "dev_name": "cli"} for did in dev_ids]

    task_ids = distribute_policy_check_task(cookie, args.company_id, dummy_device_list)
    print(f"\n任务下发完成, task_ids: {task_ids}")
