#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2 - 资产发现结果汇总

流程：
  Step 1: 轮询资产发现任务，直到完成，获取 task_id
  Step 2: 调用 discover_asset_list 脚本，获取 discover_asset_list
  Step 3: offline_list = asset_list - discover_asset_list（离线资产）
  Step 4: 获取 asset_sum 和 auth_total
  Step 5: 获取安装 EDR 的服务内资产列表（install_aes_list）
  Step 6: 填充话术并发送企微群通知
  Step 7: 离线资产列表单独发送
  Step 8: 未安装终端防护组件的资产列表单独发送

每一步都单独推送企微群进度通知，异常退出前推送报错信息。
"""
import sys
import os
import json
import uuid
import time
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collections import Counter

from shared import (
    log,
    request_with_retry,
    get_cookie,
    send_notification,
    DEFAULT_HEADERS,
    COMPANY_LIST_HEADERS,
)

from phase1.phase1_prepare import (
    fetch_all_asset_ips,
    fetch_task_asset_list,
    get_asset_count,
    resolve_company,
    resolve_company_by_id,
)


ASSET_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset"


# =============================================================================
# 资产格式校验：必须是 IP 或 URL
# =============================================================================
IP_PATTERN = re.compile(
    r"^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}"
    r"(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
)
URL_PATTERN = re.compile(
    r"^https?://[^\s/$.?#].[^\s]*$",
    re.IGNORECASE
)


def is_valid_asset(asset: str) -> bool:
    """判断资产格式是否合法（IP 或 URL）"""
    if not asset or not isinstance(asset, str):
        return False
    asset = asset.strip()
    return bool(IP_PATTERN.match(asset) or URL_PATTERN.match(asset))


# =============================================================================
# 从任务名称解析公司名和公司ID
# =============================================================================
def _resolve_company_from_task_name(task_name: str, cookie: str):
    """
    从任务名称解析公司名和公司ID。
    任务名称格式：资产发现_{公司名}_{时间戳}
    例如：资产发现_托管服务测试_202605280015
    """
    parts = task_name.split("_")
    if len(parts) >= 3 and parts[0] == "资产发现":
        # 格式：资产发现_{公司名}_{时间戳}
        # 公司名可能包含下划线，所以取中间部分
        company_name = "_".join(parts[1:-1])
    elif len(parts) >= 2 and parts[0] == "资产发现":
        company_name = parts[1]
    else:
        raise ValueError(f"无法从任务名称「{task_name}」解析公司名，格式应为「资产发现_公司名_时间戳」")

    _, company_id = resolve_company(company_name, cookie)
    return company_name, company_id


# =============================================================================
# Step 1: 轮询任务直到完成
# =============================================================================
def step1_poll_task(cookie: str, task_name: str, company_id: str, company_name: str = "") -> str:
    """
    轮询资产发现任务，直到完成。
    返回 task_id。
    """
    # 动态导入，避免循环导入
    from phase2.phase2_wait_scan import poll_asset_discovery_task

    task_id = poll_asset_discovery_task(cookie, task_name, company_id, company_name=company_name)

    if not task_id:
        send_notification("轮询资产发现任务", "失败", f"任务「{task_name}」轮询超时或失败", company_name=company_name)
        sys.exit(1)

    log(f"[OK] Step 1 完成，task_id={task_id}", "INFO")
    return task_id


# =============================================================================
# Step 2: 获取 discover_asset_list
# =============================================================================
def step2_get_discover_list(cookie: str, task_name: str, task_id: str, company_id: str, company_name: str = "") -> list:
    """调用 discover_asset_list 脚本，获取该任务发现的资产IP列表"""

    discover_list = fetch_task_asset_list(company_id, task_id, cookie)

    log(f"[OK] Step 2 完成，discover_asset_list={len(discover_list)} 个IP", "INFO")
    return discover_list


# =============================================================================
# Step 3: 获取服务内全部资产IP，计算离线资产 offline_list
# =============================================================================
def step3_get_offline_list(cookie: str, company_id: str, discover_list: list,
                           asset_list: list = None, company_name: str = "") -> list:
    """
    获取服务内全部资产IP，与 discover_list 的差集即为离线资产。

    Args:
        cookie: Cookie
        company_id: 公司ID
        discover_list: 任务发现的资产列表
        asset_list: 可选，从阶段1传递过来的服务内资产列表；若为空则调用脚本获取
        company_name: 客户名称
    """
    # 优先使用阶段1传递的资产列表
    if asset_list is not None:
        log(f"[INFO] 使用阶段1传递的服务内资产列表，共 {len(asset_list)} 个", "INFO")
        raw_asset_list = asset_list
    else:
        raw_asset_list = fetch_all_asset_ips(company_id, cookie)

    # 多重集减法：raw_asset_list 中出现次数减去 discover_list 中的出现次数
    # 例如：IP 在 raw_asset_list 出现 2 次，在 discover_list 出现 1 次 → 离线 1 次
    raw_counter = Counter(raw_asset_list)
    discover_counter = Counter(discover_list)
    offline_counter = raw_counter - discover_counter  # 只保留 count > 0 的元素
    offline_list = sorted(list(offline_counter.elements()))

    log(f"[OK] Step 3 完成，offline_list={len(offline_list)} 个IP: {offline_list}", "INFO")
    return raw_asset_list, offline_list


# =============================================================================
# Step 4: 获取资产数量
# =============================================================================
def step4_get_asset_count(cookie: str, company_id: str, company_name: str = "") -> dict:
    """获取 asset_sum 和 auth_total"""

    count_info = get_asset_count(company_id, cookie)

    log(f"[OK] Step 4 完成，asset_sum={count_info['asset_sum']}, auth_total={count_info['auth_total']}", "INFO")
    return count_info


# =============================================================================
# Step 5: 获取安装 EDR 的服务内资产列表
# =============================================================================
def step5_get_install_aes_list(cookie: str, company_id: str, company_name: str = "") -> list:
    """
    调用 fetch_all_asset_ips，传入 agent_status=[0,1,2]，获取安装了终端防护组件的资产IP列表。
    """

    install_aes_list = fetch_all_asset_ips(company_id, cookie, agent_status=[0, 1, 2])
    log(f"[OK] Step 5 完成，install_aes_list={len(install_aes_list)} 个IP", "INFO")
    return install_aes_list


# =============================================================================
# Step 6: 填充话术并发送企微群通知（第1-5行）
# =============================================================================
def step6_send_message(company_name: str, total_assets: int, offline_count: int,
                        asset_sum: int, auth_total: int, install_aes_num: int):
    """
    填充话术，发送第1-5行到企微群。
    话术首行: 【资产发现】【{company_name}】话术:
    """
    lines = [f"【资产发现】【{company_name}】话术："]
    lines.append("")
    lines.append("资产扫描情况")
    lines.append(f"扫描范围：服务内{total_assets}个资产")

    if offline_count > 0:
        lines.append(f"离线资产：{offline_count}个（建议核查是否被安全设备拦截或已下线）")
    else:
        lines.append("暂未发现离线资产")

    lines.append(f"服务内/已购授权资产：{asset_sum}/{auth_total}，服务资产终端防护组件安装情况：{install_aes_num}/{total_assets}")
    lines.append("详细内容请查阅《XX MSS资产列表》")

    if offline_count > 0:
        lines.append("⚠️请及时核实离线资产使用状态，如确认不再使用，请及时更新资产清单以便监测")

    msg = "\n".join(lines)
    send_notification(detail=msg)
    log(f"[OK] Step 6 完成，话术已发送（第1-5行）", "INFO")


# =============================================================================
# Step 7: 离线资产列表单独发送（第6行）
# =============================================================================
def step7_send_offline_list(offline_list: list, company_name: str = ""):
    """
    离线资产列表单独发送。
    """
    if not offline_list:
        log("[INFO] 无离线资产，跳过第二条消息发送", "INFO")
        return

    offline_ips_str = "、".join(offline_list)
    msg = f"【资产发现】【{company_name}】\n附：离线资产列表：{offline_ips_str}"
    send_notification(detail=msg)
    log(f"[OK] Step 7 完成，离线资产列表已发送", "INFO")


# =============================================================================
# Step 8: 未安装终端防护组件的资产列表单独发送（第7行）
# =============================================================================
def step8_send_not_install_aes_list(valid_asset_list: list, install_aes_list: list, company_name: str = ""):
    """
    计算未安装终端防护组件的资产列表，单独发送。
    """
    not_install_aes_list = [a for a in valid_asset_list if a not in install_aes_list]
    not_install_aes_list = sorted(not_install_aes_list)

    if not not_install_aes_list:
        log("[INFO] 无未安装终端防护组件的资产，跳过发送", "INFO")
        return

    not_install_str = "、".join(not_install_aes_list)
    msg = f"【资产发现】【{company_name}】\n附：未安装终端防护组件的资产列表：{not_install_str}"
    send_notification(detail=msg)
    log(f"[OK] Step 8 完成，未安装终端防护组件的资产列表已发送", "INFO")


# =============================================================================
# 汇总打印
# =============================================================================
def print_summary(company_name: str, task_name: str, task_id: str,
                  service_asset_list: list, discover_list: list,
                  offline_list: list, count_info: dict):
    """打印汇总结果"""
    total_service_assets = len(service_asset_list)
    offline_count = len(offline_list)
    asset_sum = count_info["asset_sum"]
    auth_total = count_info["auth_total"]

    print("\n" + "=" * 60)
    print(f"资产发现结果汇总 - {company_name}")
    print("=" * 60)
    print(f"任务名称: {task_name}")
    print(f"task_id: {task_id}")
    print("")
    print(f"资产数量统计")
    print(f"  服务内资产总数: {total_service_assets}")
    print(f"  任务发现资产（discover_list）: {len(discover_list)}")
    print(f"  离线资产（offline_list）: {offline_count}")
    print(f"  已发现资产（asset_sum）: {asset_sum}")
    print(f"  授权总数（auth_total）: {auth_total}")
    print("")
    if offline_list:
        print(f"离线资产列表：")
        for ip in offline_list:
            print(f"  {ip}")
    else:
        print(f"暂未发现离线资产")
    print("=" * 60)


# =============================================================================
# 主函数
# =============================================================================
def main():
    import argparse

    parser = argparse.ArgumentParser(description="Phase 2 - 资产发现结果汇总")
    parser.add_argument("--task-name", type=str, required=True, help="资产发现任务名称")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--company-id", type=str, help="公司ID")
    parser.add_argument("--asset-list", type=str, default=None,
                        help="阶段1传递的服务内资产列表，JSON格式")
    parser.add_argument("--start-time", type=str, default=None,
                        help="定时启动时间，格式 YYYY-MM-DD HH:MM:SS")
    args = parser.parse_args()

    cookie = get_cookie()
    if not cookie:
        send_notification("Phase 2 执行失败", "失败", "Cookie 无效或已过期")
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    # 解析公司：优先用 args.company_id/args.company，否则从任务名称自动解析
    company_name = None
    company_id = None
    if args.company_id:
        company_id = args.company_id
        company_name, _ = resolve_company_by_id(company_id, cookie)
    elif args.company:
        company_name, company_id = resolve_company(args.company, cookie)
    elif args.task_name:
        # 从任务名称自动解析公司名和公司ID
        company_name, company_id = _resolve_company_from_task_name(args.task_name, cookie)
    else:
        send_notification("Phase 2 执行失败", "失败", "未指定任务名称")
        print("[X ERROR] 必须指定 --task-name")
        sys.exit(1)

    task_name = args.task_name

    # 解析阶段1传递的资产列表
    asset_list_from_phase1 = None
    if args.asset_list:
        try:
            asset_list_from_phase1 = json.loads(args.asset_list)
        except Exception as e:
            log(f"[WARNING] 解析 asset_list 参数失败: {e}，忽略", "WARNING")

    try:
        # ── 通知: 开始轮询 ────────────────────────────────────
        send_notification("资产发现开始轮询", "进行中", f"「{company_name}」开始轮询资产发现任务: {task_name}", company_name=company_name)

        # Step 1: 轮询任务直到完成
        task_id = step1_poll_task(cookie, task_name, company_id, company_name=company_name)

        # Step 2: 获取 discover_asset_list
        discover_list = step2_get_discover_list(cookie, task_name, task_id, company_id, company_name=company_name)

        # Step 3: 获取服务内资产，计算离线资产（优先使用阶段1传递的资产列表）
        valid_asset_list, offline_list = step3_get_offline_list(
            cookie, company_id, discover_list,
            asset_list=asset_list_from_phase1,
            company_name=company_name
        )

        # Step 4: 获取资产数量
        count_info = step4_get_asset_count(cookie, company_id, company_name=company_name)

        # Step 5: 获取安装 EDR 的服务内资产列表
        install_aes_list = step5_get_install_aes_list(cookie, company_id, company_name=company_name)

        # Step 6: 填充话术并发送（第1-5行）
        total_assets = len(valid_asset_list)
        step6_send_message(
            company_name,
            total_assets=total_assets,
            offline_count=len(offline_list),
            asset_sum=count_info['asset_sum'],
            auth_total=count_info['auth_total'],
            install_aes_num=len(install_aes_list)
        )

        # Step 7: 离线资产列表单独发送
        step7_send_offline_list(offline_list, company_name=company_name)

        # Step 8: 未安装终端防护组件的资产列表单独发送
        step8_send_not_install_aes_list(valid_asset_list, install_aes_list, company_name=company_name)

        # 汇总打印
        print_summary(company_name, task_name, task_id, valid_asset_list, discover_list, offline_list, count_info)

        send_notification(
            "资产发现任务完成",
            "成功",
            f"「{company_name}」任务「{task_name}」已完成，"
            f"服务内资产 {total_assets} 个，发现 {len(discover_list)} 个，"
            f"离线 {len(offline_list)} 个。话术已发送至群。",
            company_name=company_name
        )
        log("[OK] Phase 2 执行完成", "INFO")
        sys.exit(0)

    except Exception as e:
        send_notification(
            "资产发现执行异常",
            "失败",
            f"公司：{company_name}，任务「{task_name}」执行异常：{e}",
            company_name=company_name
        )
        log(f"[X ERROR] Phase 2 异常: {e}", "ERROR")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()