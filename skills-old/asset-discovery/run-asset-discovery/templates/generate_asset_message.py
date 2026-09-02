#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产发现话术模板生成器

根据资产扫描结果，生成标准话术。
"""
import sys
import os

TEMPLATE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "templates", "asset_discovery_message.txt"
)


def load_template() -> str:
    with open(TEMPLATE_FILE, "r", encoding="utf-8") as f:
        return f.read()


def fill_asset_discovery_message(
    total_assets: int,
    offline_assets: list,
    asset_sum: int,
    auth_total: int,
    edr_install_rate: float = None,
    no_edr_asset_names: str = None,
    offline_asset_list: list = None
) -> str:
    """
    生成资产发现话术。

    Args:
        total_assets: 扫描范围内服务内资产数量
        offline_assets: 离线资产IP列表
        asset_sum: 已发现资产数（asset_sum）
        auth_total: 授权总数（auth_total）
        edr_install_rate: EDR安装率（%），可选
        no_edr_asset_names: 未安装EDR的资产名称列表，可选
        offline_asset_list: 离线资产列表（用于附），可选
    """
    template = load_template()

    # 填充扫描范围
    template = template.replace("{X}", str(total_assets))

    # 填充离线资产（有离线资产 or 暂未发现离线资产）
    if offline_assets:
        offline_count = len(offline_assets)
        template = template.replace(
            "{暂未发现离线资产} 或 {离线资产：Y个（建议核查是否被安全设备拦截或已下线）}",
            f"离线资产：{offline_count}个（建议核查是否被安全设备拦截或已下线）"
        )
    else:
        template = template.replace(
            "{暂未发现离线资产} 或 {离线资产：Y个（建议核查是否被安全设备拦截或已下线）}",
            "暂未发现离线资产"
        )

    # 填充服务内/已购授权资产
    template = template.replace("服务内/已购授权资产：A/B", f"服务内/已购授权资产：{asset_sum}/{auth_total}")

    # 填充 EDR 安装率
    if edr_install_rate is not None and no_edr_asset_names:
        template = template.replace(
            "服务资产EDR安装率C%，未安装EDR的服务资产为D等业务系统，",
            f"服务资产EDR安装率{edr_install_rate}%，未安装EDR的服务资产为{no_edr_asset_names}等业务系统，"
        )
    else:
        template = template.replace(
            "服务资产EDR安装率C%，未安装EDR的服务资产为D等业务系统，\n⚠ 请及时核实离线资产使用状态，如确认不再使用，请更新资产清单以便监测",
            "服务资产EDR安装情况请查阅《XX MSS资产列表》\n⚠ 请及时核实离线资产使用状态，如确认不再使用，请更新资产清单以便监测"
        )

    # 填充离线资产列表（附）
    if offline_asset_list:
        offline_ips = ", ".join(offline_asset_list[:10])
        if len(offline_asset_list) > 10:
            offline_ips += f" ... 还有 {len(offline_asset_list) - 10} 个"
        template = template.replace(
            "附：{离线资产列表：E}",
            f"附：离线资产列表：{offline_ips}"
        )
    else:
        template = template.replace("附：{离线资产列表：E}", "")

    return template


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="生成资产发现话术")
    parser.add_argument("--total", type=int, required=True, help="服务内资产总数")
    parser.add_argument("--offline", type=str, default="", help="离线资产，逗号分隔")
    parser.add_argument("--asset-sum", type=int, required=True, help="已发现资产数")
    parser.add_argument("--auth-total", type=int, required=True, help="授权总数")
    args = parser.parse_args()

    offline_assets = [ip.strip() for ip in args.offline.split(",") if ip.strip()] if args.offline else []

    result = fill_asset_discovery_message(
        total_assets=args.total,
        offline_assets=offline_assets,
        asset_sum=args.asset_sum,
        auth_total=args.auth_total
    )
    print(result)