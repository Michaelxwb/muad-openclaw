#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2 - 查询资产发现结果

流程：
  1. 获取资产数量（asset_sum + auth_total）
  2. 保存结果
  3. 企微通知结果
"""
import sys
import os
import json
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    send_notification,
    COMPANY_LIST_HEADERS,
    DEFAULT_HEADERS,
)


ASSET_COUNT_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset_manage/auth_total"
ASSET_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset"


# =============================================================================
# Step 1: 获取资产数量
# =============================================================================
def fetch_asset_count(company_id: str, cookie: str) -> dict:
    """获取资产数量，返回 asset_sum 和 auth_total"""
    url = f"{ASSET_COUNT_API_URL}?company_id={company_id}"

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())
    headers["Origin"] = "https://soar.sangfor.com.cn"
    headers["Sec-Fetch-Site"] = "same-origin"
    headers["Sec-Fetch-Mode"] = "cors"
    headers["Sec-Fetch-Dest"] = "empty"

    log(f"[INFO] 获取资产数量: company_id={company_id}", "INFO")

    response = request_with_retry("GET", url, headers=headers)
    if response is None:
        log("[X ERROR] 请求失败", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    try:
        result = response.json()
    except Exception as e:
        log(f"[X ERROR] JSON 解析失败: {e}", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    if result.get("code") != 0:
        log(f"[X ERROR] API 返回错误: {result.get('msg', 'Unknown')}", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    data = result.get("data", {})
    asset_sum = data.get("asset_sum", 0)
    auth_total = data.get("auth_total", 0)

    log(f"[OK] asset_sum={asset_sum}, auth_total={auth_total}", "INFO")
    return {"asset_sum": asset_sum, "auth_total": auth_total}


# =============================================================================
# Step 2: 分页拉取资产IP列表（用于保存详细结果）
# =============================================================================
def fetch_asset_ips(company_id: str, cookie: str, limit: int = 100) -> list:
    """分页拉取全部资产IP列表"""
    headers = COMPANY_LIST_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())

    all_ips = []
    offset = 0

    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "service_status": [1],
            "is_alive": -1,
            "ip_url_keyword": "",
            "asset_type": [],
            "business_level": [],
            "first_time": [],
            "update_time": [],
            "keyword": "",
            "asset_tag": [],
            "agent_status": [],
            "af_defend_status": "",
            "database": [],
            "middleware": [],
            "os": [],
            "developing_languages": [],
            "development_framework": [],
            "server_port": [],
            "company_id": company_id,
            "asset_group_id": "all"
        }

        response = request_with_retry("POST", ASSET_API_URL, headers=headers, json=payload)
        if response is None:
            log(f"[ERROR] 请求资产列表失败", "ERROR")
            break

        result = response.json()
        if result.get("code") != 0:
            log(f"[ERROR] API 返回错误: {result}", "ERROR")
            break

        data = result.get("data", {})
        asset_list = data.get("list", [])
        total = data.get("total", 0)

        for item in asset_list:
            ip = item.get("asset", "")
            if ip:
                all_ips.append(ip)

        if offset + limit >= total:
            log(f"[INFO] 资产IP列表获取完成，共 {len(all_ips)} 条", "INFO")
            break

        offset += limit

    return all_ips


# =============================================================================
# Step 3: 保存结果
# =============================================================================
def save_result(company_id: str, company_name: str, count_info: dict, asset_list: list) -> str:
    """保存结果到缓存文件"""
    result_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cache")
    os.makedirs(result_dir, exist_ok=True)

    result_file = os.path.join(result_dir, f"assets_{company_id}.json")
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump({
            "company_id": company_id,
            "company_name": company_name,
            "asset_sum": count_info["asset_sum"],
            "auth_total": count_info["auth_total"],
            "asset_ips": asset_list,
            "asset_count": len(asset_list)
        }, f, ensure_ascii=False, indent=2)

    log(f"[OK] 结果已保存: {result_file}", "INFO")
    return result_file


# =============================================================================
# 企微通知
# =============================================================================
def notify_result(company_name: str, count_info: dict, asset_list: list):
    """发送企微群通知"""
    asset_sum = count_info["asset_sum"]
    auth_total = count_info["auth_total"]

    content = (
        f"【资产发现】【{company_name}】\n"
        f"资产数量统计\n"
        f"  已发现资产（asset_sum）：{asset_sum}\n"
        f"  授权总数（auth_total）：{auth_total}\n"
        f"  本次拉取IP列表（共 {len(asset_list)} 个）\n"
    )

    for ip in asset_list[:20]:
        content += f"  {ip}\n"
    if len(asset_list) > 20:
        content += f"  ... 还有 {len(asset_list) - 20} 个IP\n"

    content += f"详细结果已保存"

    send_notification(detail=content)
    log(f"[OK] 企微通知已发送", "INFO")


# =============================================================================
# 打印摘要
# =============================================================================
def print_summary(company_name: str, count_info: dict, asset_list: list):
    """打印结果摘要"""
    asset_sum = count_info["asset_sum"]
    auth_total = count_info["auth_total"]

    print("\n" + "=" * 60)
    print(f"资产发现结果 - {company_name}")
    print("=" * 60)
    print(f"📊 资产数量统计")
    print(f"  已发现资产（asset_sum）：{asset_sum}")
    print(f"  授权总数（auth_total）：{auth_total}")
    print(f"")
    print(f"📋 资产IP列表（共 {len(asset_list)} 个）：")
    for ip in asset_list[:20]:
        print(f"  {ip}")
    if len(asset_list) > 20:
        print(f"  ... 还有 {len(asset_list) - 20} 个IP")
    print("=" * 60)


# =============================================================================
# 主函数
# =============================================================================
def main():
    import argparse
    from phase1.phase1_prepare import resolve_company, resolve_company_by_id

    parser = argparse.ArgumentParser(description="Phase 2 - 查询资产发现结果")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--company-id", type=str, help="公司ID")
    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        send_notification("资产发现 Phase 2 失败", "失败", "Cookie 无效或已过期")
        sys.exit(1)

    # 解析公司
    if args.company_id:
        company_id = args.company_id
        company_name, _ = resolve_company_by_id(company_id, cookie)
    elif args.company:
        company_name, company_id = resolve_company(args.company, cookie)
    else:
        print("[X ERROR] 必须指定 --company 或 --company-id")
        sys.exit(1)

    # Step 1: 获取资产数量（asset_sum + auth_total）
    log(f"[INFO] 获取资产数量...", "INFO")
    count_info = fetch_asset_count(company_id, cookie)

    # Step 2: 分页拉取资产IP列表
    log(f"[INFO] 拉取资产IP列表...", "INFO")
    asset_list = fetch_asset_ips(company_id, cookie)

    # Step 3: 保存结果
    result_file = save_result(company_id, company_name, count_info, asset_list)

    # 打印摘要
    print_summary(company_name, count_info, asset_list)

    # 企微通知
    notify_result(company_name, count_info, asset_list)

    log(f"[OK] Phase 2 执行完成", "INFO")
    sys.exit(0)


if __name__ == "__main__":
    main()