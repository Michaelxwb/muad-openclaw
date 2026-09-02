#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""漏洞扫描阶段通知脚本"""

import json
import sys
import os
import urllib.request

# 读取 webhook 配置
CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "webhook_config.json")
WEBHOOK_URL = json.load(open(CONFIG_PATH, encoding="utf-8"))["webhook_url"]

def send_notification(content: str, company_name: str = ""):
    """发送文本消息到企业微信群；company_name 非空时自动加【客户名】前缀"""
    import time as _time
    # 在内容前面动态插入【客户名】前缀，避免调用方手动拼接
    if company_name and content:
        content = f"【{company_name}】{content}"
    data = json.dumps({
        "msgtype": "text",
        "text": {
            "content": content
        }
    }, ensure_ascii=False).encode("utf-8")
    
    max_retries = 3
    for attempt in range(max_retries):
        req = urllib.request.Request(
            WEBHOOK_URL,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"}
        )
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            if result.get("errcode") == 0:
                return True
            if result.get("errcode") == 45009:
                print(f"通知频率限制(45009)，60秒后重试 (第{attempt+1}次)")
                _time.sleep(60)
                continue
            print(f"通知发送失败: {result}")
            return False
    print(f"通知重试{max_retries}次后仍失败(45009)")
    return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python notify.py <阶段号> <状态> [详情]")
        print("示例: python notify.py 1 成功 任务ID:xxx")
        sys.exit(1)
    
    phase = sys.argv[1]
    status = sys.argv[2]
    detail = sys.argv[3] if len(sys.argv) > 3 else ""
    
    phase_names = {
        "1": "阶段1-创建扫描任务",
        "2": "阶段2-查询扫描状态",
        "3": "阶段3-创建报告任务",
        "4": "阶段4-轮询报告状态",
        "5": "阶段5-下载报告"
    }
    
    phase_name = phase_names.get(phase, f"阶段{phase}")
    
    if status == "成功":
        content = f"✅ {phase_name} {status}！{detail}"
    else:
        content = f"❌ {phase_name} {status}！{detail}"
    
    print(f"发送通知: {content}")
    ok = send_notification(content)
    print(f"发送{'成功' if ok else '失败'}, errcode={0 if ok else '非0'}" if not ok else "", flush=True)
    sys.exit(0 if ok else 1)
