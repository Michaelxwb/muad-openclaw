#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Helper: 获取设备ID (dev_id)

调用设备信息API获取dev_id，用于创建扫描任务。
"""
import argparse
import os
import sys
import uuid
import json
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    request_with_retry,
    debug_request,
    get_cookie,
    extract_cookie_value,
)

DEVICE_INFO_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/device_info"


def get_dev_id(cookie: str, company_id: str) -> int:
    """
    获取设备ID (dev_id)
    
    Args:
        cookie: Cookie字符串
        company_id: 公司ID
    
    Returns:
        dev_id: 设备ID
    
    Raises:
        如果获取失败或设备列表为空，输出错误信息并退出程序
    """
    log(f"[INFO] 获取设备信息，company_id: {company_id}", "INFO")
    
    # 使用浏览器完整 Headers
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "cookie": cookie,
        "origin": "https://soar.sangfor.com.cn",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": "https://soar.sangfor.com.cn/index.html",
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
        "x-requested-with": "XMLHttpRequest"
    }
    
    payload = {
        "company_id": company_id
    }
    
    try:
        import requests
        response = requests.post(DEVICE_INFO_URL, headers=headers, json=payload, timeout=30, verify=False)
        
        if response is None:
            log("[X ERROR] 获取设备信息请求失败", "ERROR")
            sys.exit(1)
        
        result = response.json()
        
        if result.get("code") != 0:
            log(f"[X ERROR] API返回错误: {result.get('msg')}", "ERROR")
            sys.exit(1)
        
        data = result.get("data", {})
        device_list = data.get("list", [])
        total = data.get("total", 0)
        
        log(f"[INFO] 设备总数: {total}", "INFO")
        
        if not device_list:
            log(f"[X ERROR] 设备列表为空，请检查公司ID {company_id} 是否有配置设备", "ERROR")
            sys.exit(1)
        
        # 提取第一个设备的dev_id
        first_device = device_list[0]
        dev_id = first_device.get("dev_id")
        dev_name = first_device.get("dev_name", "Unknown")
        
        if not dev_id:
            log(f"[X ERROR] 设备信息中未找到dev_id字段", "ERROR")
            sys.exit(1)
        
        log(f"[OK] 获取到设备: {dev_name}, dev_id: {dev_id}", "INFO")
        return dev_id
        
    except Exception as e:
        log(f"[X ERROR] 获取dev_id异常: {e}", "ERROR")
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="获取设备ID")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie字符串")
    
    args = parser.parse_args()
    
    cookie = get_cookie(args.cookie)
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)
    
    dev_id = get_dev_id(cookie, args.company_id)
    print(f"\nDev ID: {dev_id}")
