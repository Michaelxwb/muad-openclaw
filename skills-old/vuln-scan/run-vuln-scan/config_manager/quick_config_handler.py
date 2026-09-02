#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快速配置处理器 - 一次性展示，只输入修改项
"""
import os
import sys
import re
import json
from typing import Dict, Any, Optional

from .config_structure import build_config_structure, get_default_config
from .input_parser import validate_ip


def print_header(title: str):
    """打印标题"""
    print(f"\n{'='*70}")
    print(f"{title}")
    print(f"{'='*70}")


def print_section(title: str):
    """打印小节标题"""
    print(f"\n{'-'*70}")
    print(f"{title}")
    print(f"{'-'*70}")


def show_config_template(structure: Dict, config: Dict):
    """显示配置模板，标记默认值和当前选择"""
    print("\n这是第一次执行该客户的漏扫任务，请进行客户配置：\n")
    
    for idx, (field, field_def) in enumerate(structure.items(), 1):
        print(f"{idx}. {field_def['display_name']}:")
        
        current_value = config.get(field)
        for opt in field_def['options']:
            markers = []
            if opt['is_default']:
                markers.append("[默认]")
            if current_value == opt['actual_value']:
                markers.append("<- 当前选择")
            
            marker_str = " ".join(markers) if markers else ""
            print(f"   {opt['display_num']}. {opt['display_name']} {marker_str}")
        
        print()


def parse_config_input(user_input: str, structure: Dict) -> Dict[str, Any]:
    """
    解析用户输入的配置修改 - 使用配置项名称匹配
    支持格式：
    - "确认" -> 使用全部默认
    - "资产范围:指定组/IP" -> 修改单个配置
    - "资产范围:指定组/IP;并发选择:高" -> 修改多个配置
    """
    if not user_input or user_input.strip() in ["确认", "确定", "ok", "yes", "是", "y"]:
        return {}
    
    changes = {}
    
    # 分割多个配置项（用 ; 或 ；分隔）
    segments = re.split(r'[;；]', user_input)
    
    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue
        
        # 尝试解析 "字段:选项"
        if ':' in segment or '：' in segment:
            segment = segment.replace('：', ':')
            parts = segment.split(':', 1)
            field_hint = parts[0].strip()
            option_hint = parts[1].strip()
            
            # 找到对应的字段 - 按名称匹配
            target_field = None
            for field, field_def in structure.items():
                if field_hint in field_def['display_name'] or field_def['display_name'] in field_hint:
                    target_field = field
                    break
            
            if target_field:
                field_def = structure[target_field]
                # 找到对应的选项 - 按名称匹配
                for opt in field_def['options']:
                    if option_hint in opt['display_name'] or opt['display_name'] in option_hint:
                        changes[target_field] = opt['actual_value']
                        break
    
    return changes


def input_asset_detail(asset_type_display: str) -> Dict[str, Any]:
    """
    输入资产详情
    
    Args:
        asset_type_display: 资产类型显示名称
    
    Returns:
        资产详情字典
    """
    print_header(f"配置资产详情 - {asset_type_display}")
    
    asset_type = "specific" if "指定" in asset_type_display and "排除" not in asset_type_display else "except"
    
    print("\n[提示]")
    print("  - 资产组：输入业务系统名称，如\"Web服务器\"、\"数据库\"")
    print("  - IP地址：支持单个IP或CIDR网段")
    print("  - 多个值用逗号分隔")
    
    groups = []
    ips = []
    
    # 输入资产组
    print_section("资产组（可选）")
    try:
        group_input = input("请输入资产组名称，多个用逗号分隔: ").strip()
    except (EOFError, KeyboardInterrupt):
        group_input = ""
    
    if group_input:
        groups = [g.strip() for g in group_input.split(",") if g.strip()]
        print(f"[OK] 已输入 {len(groups)} 个资产组")
    else:
        print("[跳过] 未输入资产组")
    
    # 输入IP
    print_section("IP地址（可选）")
    while True:
        try:
            ip_input = input("请输入IP地址，多个用逗号分隔: ").strip()
        except (EOFError, KeyboardInterrupt):
            ip_input = ""
        
        if not ip_input:
            print("[跳过] 未输入IP地址")
            break
        
        ip_list = [ip.strip() for ip in ip_input.split(",") if ip.strip()]
        invalid_ips = []
        for ip in ip_list:
            if not validate_ip(ip):
                invalid_ips.append(ip)
        
        if invalid_ips:
            print(f"[ERROR] 以下IP格式无效: {', '.join(invalid_ips)}")
            print("[提示] 正确格式：192.168.1.1 或 10.0.0.0/24")
            continue
        
        ips = ip_list
        print(f"[OK] 已输入 {len(ips)} 个IP地址")
        break
    
    return {
        "asset_type": asset_type,
        "group": groups,
        "ip": ips
    }


def quick_config_dialog(company_id: str, company_name: str) -> Optional[Dict[str, Any]]:
    """
    快速配置对话框 - 一次性展示，只输入修改项
    
    Args:
        company_id: 公司ID
        company_name: 公司名称
    
    Returns:
        配置字典，或 None（如果用户取消）
    """
    print(f"\n正在为 [{company_name}] 配置漏扫任务...")
    
    structure = build_config_structure()
    config = get_default_config()
    
    # 步骤1：显示完整模板
    print_header("漏扫任务配置模板")
    show_config_template(structure, config)
    
    # 输入说明
    print("="*70)
    print("\n[输入格式]")
    print('  - 直接输入 "确认" 使用所有默认配置')
    print('  - 修改单个配置："资产范围:指定组/IP"')
    print('  - 修改多个配置："资产范围:指定组/IP;并发选择:高"')
    print("\n[配置项名称]")
    print("  - 资产范围: 全部资产 / 指定组/IP / 排除指定组/IP后的全部资产")
    print("  - fuzz测试: 禁用 / 启用")
    print("  - 漏洞评估: 全量评估")
    print("  - 并发选择: 高 / 中 / 低")
    print("  - 端口扫描策略: 常用端口 / 全局端口")
    print("="*70)
    
    # 步骤2：获取用户输入
    print("\n请输入配置（确认/修改）: ")
    try:
        import sys
        user_input = sys.stdin.readline().strip()
    except (EOFError, KeyboardInterrupt):
        print("\n[取消] 用户取消配置")
        return None
    
    # 解析用户输入
    changes = parse_config_input(user_input, structure)
    
    # 应用修改
    for field, value in changes.items():
        config[field] = value
    
    if changes:
        print(f"\n[OK] 已应用修改: {', '.join([structure[k]['display_name'] for k in changes.keys()])}")
    else:
        print("\n[OK] 使用所有默认配置")
    
    # 步骤3：如果选择了指定/排除资产，需要输入资产详情
    asset_mode_value = config.get("asset_mode")
    asset_mode_display = ""
    for opt in structure["asset_mode"]["options"]:
        if opt["actual_value"] == asset_mode_value:
            asset_mode_display = opt["display_name"]
            break
    
    if asset_mode_display in ["指定组/IP", "排除指定组/IP后的全部资产"]:
        asset_detail = input_asset_detail(asset_mode_display)
        config["asset_detail"] = asset_detail
    
    # 步骤4：显示最终配置预览
    print_header("配置完成预览")
    
    print(f"\n客户：{company_name}")
    print(f"任务名称：{company_id}_{int(__import__('time').time())}")
    
    print(f"\n配置摘要：")
    for idx, (field, field_def) in enumerate(structure.items(), 1):
        current_value = config.get(field)
        current_display = "未知"
        is_changed = field in changes
        
        for opt in field_def['options']:
            if current_value == opt['actual_value']:
                current_display = opt['display_name']
                break
        
        change_marker = " [已修改]" if is_changed else ""
        print(f"  [{idx}] {field_def['display_name']}：{current_display}{change_marker}")
    
    # 显示资产详情
    if config.get("asset_detail"):
        asset_detail = config["asset_detail"]
        print(f"\n  [资产详情]")
        print(f"     类型：{asset_detail.get('asset_type', 'N/A')}")
        if asset_detail.get("group"):
            print(f"     资产组：{', '.join(asset_detail['group'])}")
        if asset_detail.get("ip"):
            print(f"     IP地址：{', '.join(asset_detail['ip'])}")
    
    # 保存配置
    print(f"\n配置预览已生成（未写入文件）")
    return config
