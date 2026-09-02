#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配置处理器
处理配置的加载、保存、交互式配置创建和修改
"""
import sys
import os
import json
from typing import Dict, Any, Optional

from .config_structure import build_config_structure
from .input_parser import parse_config_input, parse_asset_input
from .asset_processor import process_asset_detail

# 配置文件存储目录
CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "companies")


def ensure_config_dir():
    """确保配置目录存在"""
    if not os.path.exists(CONFIG_DIR):
        os.makedirs(CONFIG_DIR)
        print(f"[INFO] 创建配置目录: {CONFIG_DIR}")


def get_config_path(company_id: str) -> str:
    """获取配置文件路径"""
    ensure_config_dir()
    return os.path.join(CONFIG_DIR, f"{company_id}.json")


def config_exists(company_id: str) -> bool:
    """检查配置是否存在"""
    config_path = get_config_path(company_id)
    return os.path.exists(config_path)


def load_config(company_id: str) -> Dict[str, Any]:
    """加载已有配置，文件不存在则抛异常（不走默认配置）"""
    config_path = get_config_path(company_id)
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
            print(f"[INFO] 已加载配置: {config_path}")
            return config
    except Exception as e:
        raise RuntimeError(f"加载配置失败: {e}")


def save_config(company_id: str, config: Dict[str, Any], process_assets: bool = True):
    """保存配置到文件

    Args:
        company_id: 公司ID
        config: 配置字典
        process_assets: 是否处理资产详情生成asset_list(默认True)
    """
    config_path = get_config_path(company_id)
    try:
        # 如果 asset_mode 为 0(全部资产),asset_list 必须为空列表
        if config.get("asset_mode") == 0:
            config["asset_list"] = []
        elif process_assets and config.get("asset_detail"):
            # 处理资产详情,生成asset_list
            print("\n[INFO] 正在处理资产详情,生成资产列表...")
            asset_list = process_asset_detail(company_id, config["asset_detail"])
            config["asset_list"] = asset_list
            print(f"[INFO] 已生成资产列表,共 {len(asset_list)} 个资产")

        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        print(f"[INFO] 配置已保存: {config_path}")
    except Exception as e:
        print(f"[ERROR] 保存配置失败: {e}")


def display_config(config: Dict[str, Any], is_first_time: bool = False):
    """展示配置项"""
    structure = build_config_structure()

    if is_first_time:
        print("\n" + "=" * 64)
        print("这是第一次执行该客户的漏扫任务,所以需要您进行客户配置")
        print("=" * 64)
    else:
        print("\n" + "=" * 64)
        print("  当前配置")
        print("=" * 64)

    idx = 1
    for field, field_def in structure.items():
        current_value = config.get(field)

        print(f"\n{idx}. {field_def['display_name']}:")

        # 列出所有选项
        for opt in field_def["options"]:
            default_marker = " [默认]" if opt["is_default"] else ""

            # 判断是否是当前选择
            is_selected = False
            if current_value is not None:
                # 处理 asset_mode 的特殊情况
                if field == "asset_mode" and current_value == 1:
                    asset_detail = config.get("asset_detail")
                    if asset_detail:
                        if asset_detail.get("asset_type") == "specific" and opt["display_name"] == "指定组/IP":
                            is_selected = True
                        elif asset_detail.get("asset_type") == "except" and opt["display_name"] == "排除指定组/IP后的全部资产":
                            is_selected = True
                    elif opt["actual_value"] == current_value:
                        is_selected = True
                elif opt["actual_value"] == current_value:
                    is_selected = True

            selected_marker = " ← 当前选择" if is_selected else ""
            print(f" {opt['display_num']}. {opt['display_name']}{default_marker}{selected_marker}")

        idx += 1

    # 显示资产详情(如果有)
    asset_detail = config.get("asset_detail")
    if asset_detail:
        print(f"\n  资产详情:")
        print(f"    类型: {asset_detail.get('asset_type', 'N/A')}")
        if asset_detail.get("group"):
            print(f"    资产组: {', '.join(asset_detail['group'])}")
        if asset_detail.get("ip"):
            print(f"    IP地址: {', '.join(asset_detail['ip'])}")

    print("\n" + "=" * 64)
    print("\n[输入说明]")
    print('  - 输入 "确认" 使用当前配置')
    print('  - 修改单个配置:"资产范围:2" 或 "1:2"')
    print('  - 修改多个配置:"资产范围:2;并发选择:1" 或 "1:2;4:1"')
    print("  - 配置项编号:1=资产范围, 2=fuzz测试, 3=漏洞评估, 4=并发选择, 5=端口扫描策略")
    print("=" * 64)


def input_asset_detail(display_name: str) -> Dict[str, Any]:
    """
    交互式输入资产组/IP详情
    """
    asset_type = "specific" if display_name == "指定组/IP" else "except"

    print("\n" + "=" * 50)
    print(f"  配置资产详情 - {display_name}")
    print("=" * 50)
    print("请填写资产组和IP,格式如下:")
    print("  资产组:xx,yy;IP:aa,bb")
    print("  示例1: 资产组:Web服务器,数据库;IP:192.168.1.1,192.168.1.2")
    print("  示例2: 资产组:测试环境;IP:10.0.0.0/24")
    print("  示例3: IP:192.168.1.1,192.168.1.2")
    print("  示例4: 资产组:生产环境")
    print("=" * 50)

    while True:
        try:
            user_input = input("\n请输入: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            print("[INFO] 用户取消输入,返回空配置")
            return {"asset_type": asset_type, "group": [], "ip": []}

        success, result, error_msg = parse_asset_input(user_input)

        if not success:
            print(f"\n[X ERROR] {error_msg}")
            print("[INFO] 请按正确格式输入\n")
            continue

        print("\n" + "-" * 40)
        print("  配置确认")
        print("-" * 40)
        print(f"  资产类型: {display_name} ({asset_type})")
        if result["group"]:
            print(f"  资产组: {', '.join(result['group'])}")
        if result["ip"]:
            print(f"  IP地址: {', '.join(result['ip'])}")
        print("-" * 40)

        try:
            confirm = input("\n确认以上配置?(确认/重新输入): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            break

        if confirm in ["确认", "确定", "ok", "OK", "yes", "是"]:
            result["asset_type"] = asset_type
            return result

    return {"asset_type": asset_type, "group": [], "ip": []}


def interactive_config(company_id: str, company_name: str, force_refresh: bool = False) -> Dict[str, Any]:
    """
    交互式配置管理

    Args:
        company_id: 公司ID
        company_name: 公司名称
        force_refresh: 是否强制刷新配置(即使已存在)

    Returns:
        最终配置字典
    """
    exists = config_exists(company_id)
    structure = build_config_structure()

    if exists and not force_refresh:
        print("[INFO] 找到已有配置")
        return load_config(company_id)

    if exists:
        config = load_config(company_id)
        print(f"[INFO] 正在刷新配置: {company_name}")
    else:
        config = get_default_config()
        print(f"[INFO] 正在创建新配置: {company_name}")

    # 交互循环
    first_display = True
    while True:
        display_config(config, is_first_time=first_display)
        first_display = False

        print('\n请输入指令(见上方【输入说明】):')

        try:
            user_input = input("\n请输入: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            print("[INFO] 用户取消配置,使用默认配置")
            break

        success, updates, error_msg = parse_config_input(user_input)

        if not success:
            print(f"\n[X ERROR] 输入格式错误: {error_msg}")
            print('[INFO] 请按正确格式输入\n')
            continue

        if not updates:
            print("[INFO] 用户确认使用当前配置")
            break

        # 应用更新
        for field, value_info in updates.items():
            actual_value = value_info["actual_value"]
            display_name = value_info["display_name"]

            config[field] = actual_value
            field_display = structure[field]["display_name"]
            print(f"[INFO] 修改配置: {field_display} -> {display_name}")

            # 资产范围特殊处理
            if field == "asset_mode":
                if display_name in ["指定组/IP", "排除指定组/IP后的全部资产"]:
                    asset_detail = input_asset_detail(display_name)
                    config["asset_detail"] = asset_detail
                    print("[INFO] 已配置资产详情")
                elif display_name == "全部资产":
                    config["asset_detail"] = None

        save_config(company_id, config)

        print("\n配置已更新！")
        try:
            continue_input = input("是否继续修改其他配置?(是/否): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            break

        if continue_input not in ["是", "yes", "y", "Y", "继续"]:
            break

    # 处理资产详情,生成 asset_list
    if config.get("asset_detail"):
        print("\n[INFO] 正在处理资产详情,生成资产列表...")
        asset_list = process_asset_detail(company_id, config["asset_detail"])
        config["asset_list"] = asset_list
        print(f"[INFO] 已生成资产列表,共 {len(asset_list)} 个资产")

    save_config(company_id, config)

    # 最终展示
    print("\n" + "=" * 64)
    print("  最终配置")
    print("=" * 64)

    idx = 1
    for field, field_def in structure.items():
        current_value = config.get(field)
        current_display = "未知"
        for opt in field_def["options"]:
            if current_value == opt["actual_value"]:
                current_display = opt["display_name"]
                break
        print(f"\n{idx}. {field_def['display_name']}: {current_display}")
        idx += 1

    asset_detail = config.get("asset_detail")
    if asset_detail:
        print(f"\n  资产详情:")
        print(f"    类型: {asset_detail.get('asset_type', 'N/A')}")
        if asset_detail.get("group"):
            print(f"    资产组: {', '.join(asset_detail['group'])}")
        if asset_detail.get("ip"):
            print(f"    IP地址: {', '.join(asset_detail['ip'])}")
        print(f"\n  生成的资产列表: {len(config.get('asset_list', []))} 个资产")

    print("\n" + "=" * 64 + "\n")

    return config


def get_config(company_id: str, company_name: str, auto_confirm: bool = False) -> Dict[str, Any]:
    """
    获取配置的主入口。
    如果配置不存在：从 default_user_config.json 复制，保存为 {company_id}.json，
    然后让用户确认是否执行（不进入交互配置）。用户确认后返回该配置；
    用户要修改时调用 interactive_config() 进入交互配置流程。
    """
    if not config_exists(company_id):
        print(f"[INFO] 未找到 {company_name} 的配置文件，使用默认配置")
        # 从 default_user_config.json 加载默认配置
        default_user_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "templates", "default_user_config.json"
        )
        try:
            with open(default_user_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            print(f"[INFO] 已加载默认配置: {default_user_path}")
        except Exception as e:
            print(f"[X ERROR] 加载默认配置失败: {e}")
            sys.exit(1)

        # 保存为 {company_id}.json
        save_config(company_id, config, process_assets=True)
        print(f"[INFO] 默认配置已保存为: companies/{company_id}.json")

        # auto_confirm=True 时，直接使用默认配置
        if auto_confirm:
            print(f"[INFO] 自动确认使用默认配置")
            return config

        # 向用户确认：是否使用该默认配置执行
        print("\n" + "=" * 64)
        print(f"  {company_name} - 默认配置")
        print("=" * 64)
        _print_default_config_summary(config)
        print("=" * 64)
        print('输入 "确认" 使用此配置立即执行扫描；')
        print('输入 "修改" 重新进入交互式配置流程；')
        print('输入 "取消" 退出。')
        print("=" * 64)

        while True:
            try:
                user_input = input("请输入: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n")
                print("[INFO] 用户取消，流程结束")
                sys.exit(0)

            if user_input in ["确认", "确定", "ok", "OK", "yes", "是", "y", "Y"]:
                print("[INFO] 用户确认使用默认配置")
                return config
            elif user_input in ["修改", "重新配置", "重新", "配置"]:
                print("[INFO] 用户要求修改配置，进入交互配置流程...")
                return interactive_config(company_id, company_name, force_refresh=True)
            else:
                print('[INFO] 输入无效，请输入"确认"、"修改"或"取消"')

    return load_config(company_id)


def _print_default_config_summary(config: Dict[str, Any]):
    """打印默认配置的简要摘要（不进入交互）"""
    structure = build_config_structure()
    idx = 1
    for field, field_def in structure.items():
        current_value = config.get(field)
        current_display = "未知"
        for opt in field_def["options"]:
            if current_value == opt["actual_value"]:
                current_display = opt["display_name"]
                break
        print(f"  {idx}. {field_def['display_name']}: {current_display}")
        idx += 1
    if config.get("asset_detail"):
        ad = config["asset_detail"]
        print(f"  资产详情: {ad.get('asset_type')}")
        if ad.get("group"):
            print(f"    资产组: {', '.join(ad['group'])}")
        if ad.get("ip"):
            print(f"    IP地址: {', '.join(ad['ip'])}")
