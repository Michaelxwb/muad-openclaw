#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
输入解析模块
处理用户输入的配置修改和资产详情
"""
import re
from typing import Dict, Any, Tuple
from .config_structure import build_config_structure, load_chinese_field_mapping


def parse_config_input(user_input: str) -> Tuple[bool, Dict[str, Any], str]:
    """
    解析用户输入的配置修改
    
    返回: (是否成功, {field: value_info, ...}, 错误信息)
    格式示例: "资产范围：2；fuzz测试：2" 或 "1:2;2:2"
    """
    structure = build_config_structure()
    
    if not user_input or not user_input.strip():
        return False, {}, "输入不能为空"
    
    user_input = user_input.strip()
    
    # 检查是否是"确认"
    if user_input in ["确认", "确定", "ok", "OK", "yes", "是"]:
        return True, {}, ""
    
    fields = list(structure.keys())
    updates = {}
    
    # 支持两种分隔符
    parts = re.split(r'[；;]', user_input)
    
    for part in parts:
        part = part.strip()
        if not part:
            continue
        
        matched = False
        
        # 格式1: "资产范围：2" 或 "资产范围:2" 或 "资产范围：指定组/IP"
        for field, field_def in structure.items():
            if part.startswith(field_def["display_name"]):
                # 提取值部分
                value_match = re.search(r'[:：]\s*(.+)', part)
                if value_match:
                    user_value_str = value_match.group(1).strip()
                    
                    # 尝试按编号匹配
                    try:
                        user_num = int(user_value_str)
                        for opt in field_def["options"]:
                            if opt["display_num"] == user_num:
                                updates[field] = {
                                    "actual_value": opt["actual_value"],
                                    "display_name": opt["display_name"],
                                    "display_num": opt["display_num"]
                                }
                                matched = True
                                break
                    except ValueError:
                        # 按名称匹配
                        for opt in field_def["options"]:
                            if opt["display_name"] == user_value_str:
                                updates[field] = {
                                    "actual_value": opt["actual_value"],
                                    "display_name": opt["display_name"],
                                    "display_num": opt["display_num"]
                                }
                                matched = True
                                break
                    
                    if not matched:
                        valid = ", ".join([f"{o['display_num']}={o['display_name']}" for o in field_def["options"]])
                        return False, {}, f"'{field_def['display_name']}' 的值 '{user_value_str}' 无效，有效选项: {valid}"
                    break
        
        if not matched:
            # 格式2: "1:2" 或 "1：2"（配置编号:选项编号）
            num_match = re.match(r'^(\d+)\s*[:：]\s*(\d+)$', part)
            if num_match:
                field_num = int(num_match.group(1))
                opt_num = int(num_match.group(2))
                
                if 1 <= field_num <= len(fields):
                    field = fields[field_num - 1]
                    field_def = structure[field]
                    
                    for opt in field_def["options"]:
                        if opt["display_num"] == opt_num:
                            updates[field] = {
                                "actual_value": opt["actual_value"],
                                "display_name": opt["display_name"],
                                "display_num": opt["display_num"]
                            }
                            matched = True
                            break
                    
                    if not matched:
                        valid = ", ".join([f"{o['display_num']}={o['display_name']}" for o in field_def["options"]])
                        return False, {}, f"配置项 [{field_num}] 的值 '{opt_num}' 无效，有效选项: {valid}"
                else:
                    return False, {}, f"配置项编号 '{field_num}' 超出范围，有效范围: 1-{len(fields)}"
        
        if not matched:
            return False, {}, f"无法解析输入: '{part}'"
    
    return True, updates, ""


def validate_ip(ip: str) -> bool:
    """验证IP地址格式（支持IPv4和CIDR）"""
    ipv4_pattern = r'^(\d{1,3}\.){3}\d{1,3}(/\d{1,2})?$'
    if not re.match(ipv4_pattern, ip):
        return False
    parts = ip.split('/')[0].split('.')
    for part in parts:
        if int(part) > 255:
            return False
    return True


def parse_asset_input(user_input: str) -> Tuple[bool, Dict[str, Any], str]:
    """
    解析资产组/IP输入
    格式: 资产组：xx,yy；IP：aa,bb
    """
    if not user_input or not user_input.strip():
        return False, {}, "输入不能为空"
    
    user_input = user_input.strip()
    result = {"group": [], "ip": []}
    
    parts = re.split(r'[；;]', user_input)
    
    has_group = False
    has_ip = False
    
    for part in parts:
        part = part.strip()
        if not part:
            continue
        
        # 匹配资产组
        group_match = re.match(r'资产组\s*[:：]\s*(.+)', part, re.IGNORECASE)
        if group_match:
            group_str = group_match.group(1).strip()
            groups = [g.strip() for g in re.split(r'[,，、]', group_str) if g.strip()]
            result["group"] = groups
            has_group = True
            continue
        
        # 匹配IP
        ip_match = re.match(r'IP\s*[:：]\s*(.+)', part, re.IGNORECASE)
        if ip_match:
            ip_str = ip_match.group(1).strip()
            ips = [i.strip() for i in re.split(r'[,，、]', ip_str) if i.strip()]
            
            invalid_ips = []
            for ip in ips:
                if not validate_ip(ip):
                    invalid_ips.append(ip)
            
            if invalid_ips:
                return False, {}, f"以下IP格式无效: {', '.join(invalid_ips)}"
            
            result["ip"] = ips
            has_ip = True
            continue
        
        return False, {}, f"无法解析: '{part}'，请使用格式: 资产组：xx,yy；IP：aa,bb"
    
    if not has_group and not has_ip:
        return False, {}, "请至少填写资产组或IP"
    
    return True, result, ""
