#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产处理脚本
- 获取全部资产列表（支持分页）
- 根据asset_type筛选asset_id
- 生成asset_list
"""
import json
import re
import sys
import os
import uuid

# 添加父目录到路径
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from shared import (
    log, request_with_retry, get_cookie_from_file, 
    extract_cookie_value, DEFAULT_HEADERS
)

# API endpoint
BUSINESS_INFO_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/business_info"


def is_valid_ip(ip_str):
    """验证是否为有效的IP地址"""
    # IPv4 pattern
    ipv4_pattern = r'^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'
    return bool(re.match(ipv4_pattern, ip_str.strip()))


def parse_asset_input(input_str):
    """
    解析用户输入的资产列表字符串
    格式: 资产组：xx,yy；IP：aa,bb
    返回: {group: [xx, yy], ip: [aa, bb]}
    """
    result = {"group": [], "ip": []}
    
    # 匹配资产组部分
    group_match = re.search(r'资产组[：:]([^；;]*)', input_str)
    if group_match:
        group_str = group_match.group(1).strip()
        if group_str:
            result["group"] = [g.strip() for g in group_str.split(',') if g.strip()]
    
    # 匹配IP部分
    ip_match = re.search(r'IP[：:]([^；;]*)', input_str, re.IGNORECASE)
    if ip_match:
        ip_str = ip_match.group(1).strip()
        if ip_str:
            result["ip"] = [ip.strip() for ip in ip_str.split(',') if ip.strip()]
    
    return result


def validate_ips(ip_list):
    """
    验证IP列表中的每个IP是否有效
    返回: (is_valid, invalid_ips)
    """
    invalid_ips = []
    for ip in ip_list:
        if not is_valid_ip(ip):
            invalid_ips.append(ip)
    return len(invalid_ips) == 0, invalid_ips


def get_all_assets(company_id, cookie):
    """
    获取全部资产列表（支持分页）
    返回: list of asset dicts
    """
    all_assets = []
    offset = 0
    limit = 500
    
    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())
    
    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "company_id": company_id
        }
        
        log(f"[INFO] 获取资产列表: offset={offset}, limit={limit}", "INFO")
        
        try:
            response = request_with_retry("POST", BUSINESS_INFO_URL, headers=headers, json=payload)
            
            if response is None:
                log("[ERROR] 获取资产列表失败", "ERROR")
                break
            
            result = response.json()
            
            if result.get("code") != 0:
                log(f"[ERROR] API错误: {result.get('msg', 'Unknown')}", "ERROR")
                break
            
            data = result.get("data", {})
            asset_list = data.get("list", [])
            total = data.get("total", 0)
            
            all_assets.extend(asset_list)
            log(f"[INFO] 获取到 {len(asset_list)} 条资产，累计 {len(all_assets)}/{total}", "INFO")
            
            # 检查是否获取完毕
            if offset + limit >= total:
                log(f"[INFO] 资产列表获取完成，共 {len(all_assets)} 条", "INFO")
                break
            
            # 更新offset继续获取
            offset += limit
            
        except Exception as e:
            log(f"[ERROR] 请求异常: {e}", "ERROR")
            break
    
    return all_assets


def filter_assets_specific(all_assets, group_list, ip_list):
    """
    specific模式：匹配指定资产组和IP的资产
    返回: asset_id_list
    """
    asset_id_list = []
    
    for asset in all_assets:
        business_name = asset.get("business_name", "")
        asset_ip = asset.get("asset", "")
        
        # 检查是否匹配资产组
        matched_group = any(group in business_name for group in group_list) if group_list else False
        
        # 检查是否匹配IP
        matched_ip = asset_ip in ip_list if ip_list else False
        
        # 如果匹配组或IP，添加asset_id
        if matched_group or matched_ip:
            asset_id_list.append(asset.get("asset_id"))
    
    return asset_id_list


def filter_assets_except(all_assets, group_list, ip_list):
    """
    except模式：排除指定资产组和IP的资产
    返回: asset_id_list
    """
    asset_id_list = []
    
    for asset in all_assets:
        business_name = asset.get("business_name", "")
        asset_ip = asset.get("asset", "")
        
        # 检查是否匹配资产组
        matched_group = any(group in business_name for group in group_list) if group_list else False
        
        # 检查是否匹配IP
        matched_ip = asset_ip in ip_list if ip_list else False
        
        # 如果不匹配组且不匹配IP，添加asset_id
        if not matched_group and not matched_ip:
            asset_id_list.append(asset.get("asset_id"))
    
    return asset_id_list


def process_asset_selection(asset_selection, company_id):
    """
    处理资产选择，生成asset_list
    
    asset_selection格式:
    {
        "asset_type": "specific" | "except",
        "group": ["xx", "yy"],
        "ip": ["aa", "bb"]
    }
    
    返回: asset_id_list 或 None（出错时）
    """
    asset_type = asset_selection.get("asset_type")
    group_list = asset_selection.get("group", [])
    ip_list = asset_selection.get("ip", [])
    
    # 获取cookie
    cookie = get_cookie_from_file()
    if not cookie:
        log("[ERROR] 无法读取Cookie", "ERROR")
        return None
    
    # 获取全部资产
    log("[INFO] 开始获取全部资产列表...", "INFO")
    all_assets = get_all_assets(company_id, cookie)
    
    if not all_assets:
        log("[WARNING] 未获取到任何资产", "WARNING")
        return []
    
    log(f"[INFO] 共获取 {len(all_assets)} 条资产，开始筛选...", "INFO")
    
    # 根据asset_type筛选
    if asset_type == "specific":
        asset_id_list = filter_assets_specific(all_assets, group_list, ip_list)
        log(f"[INFO] specific模式：匹配到 {len(asset_id_list)} 条资产", "INFO")
    elif asset_type == "except":
        asset_id_list = filter_assets_except(all_assets, group_list, ip_list)
        log(f"[INFO] except模式：排除后剩余 {len(asset_id_list)} 条资产", "INFO")
    else:
        log(f"[ERROR] 未知的asset_type: {asset_type}", "ERROR")
        return None
    
    return asset_id_list


def update_config_with_assets(company_id, asset_selection):
    """
    更新配置文件，添加asset_list字段
    """
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "companies",
        f"{company_id}.json"
    )
    
    # 读取现有配置
    if not os.path.exists(config_path):
        log(f"[ERROR] 配置文件不存在: {config_path}", "ERROR")
        return None
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    # 处理资产选择，获取asset_id_list
    asset_id_list = process_asset_selection(asset_selection, company_id)
    
    if asset_id_list is None:
        log("[ERROR] 处理资产选择失败", "ERROR")
        return None
    
    # 更新配置
    config["asset_list"] = asset_id_list
    
    # 保存配置
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    
    log(f"[INFO] 配置已更新，asset_list包含 {len(asset_id_list)} 条资产", "INFO")
    log(f"[INFO] 配置文件: {config_path}", "INFO")
    
    return config


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="资产处理器")
    parser.add_argument("--parse-input", type=str, help="解析资产输入字符串")
    parser.add_argument("--validate-ips", type=str, help="验证IP列表（逗号分隔）")
    parser.add_argument("--company-id", type=str, help="公司ID")
    parser.add_argument("--asset-selection", type=str, help="资产选择JSON字符串")
    parser.add_argument("--update-config", action="store_true", help="更新配置文件")
    
    args = parser.parse_args()
    
    if args.parse_input:
        result = parse_asset_input(args.parse_input)
        print(json.dumps(result, ensure_ascii=False))
    
    if args.validate_ips:
        ip_list = [ip.strip() for ip in args.validate_ips.split(',') if ip.strip()]
        is_valid, invalid_ips = validate_ips(ip_list)
        if is_valid:
            print(json.dumps({"valid": True}, ensure_ascii=False))
        else:
            print(json.dumps({"valid": False, "invalid_ips": invalid_ips}, ensure_ascii=False))
    
    if args.update_config and args.company_id and args.asset_selection:
        asset_selection = json.loads(args.asset_selection)
        update_config_with_assets(args.company_id, asset_selection)
