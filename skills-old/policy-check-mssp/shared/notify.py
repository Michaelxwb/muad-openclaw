#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""策略检查通知模块（复用漏扫的 webhook_config.json，或者独立配置）"""

import json
import sys
import os
import urllib.request

# 统一读取 skills/webhook_config.json
CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "webhook_config.json")

WEBHOOK_URL = None
if os.path.exists(CONFIG_PATH):
    try:
        WEBHOOK_URL = json.load(open(CONFIG_PATH, encoding="utf-8"))["webhook_url"]
    except Exception:
        pass

if not WEBHOOK_URL:
    print("[WARN] 未找到 webhook 配置，通知功能不可用", file=sys.stderr)


def send_notification(phase: str, status: str, detail: str = "", company_name: str = "") -> bool:
    """发送策略检查阶段通知到企微群；company_name 非空时格式化为【策略检查】【客户名】前缀"""
    if not WEBHOOK_URL:
        return False

    try:
        phase_names = {
            "1": "策略检查-阶段1: 下发检查任务",
            "2": "策略检查-阶段2: 轮询检查状态",
            "3": "策略检查-阶段3: 导出报告",
            "4": "策略检查-阶段4: 生成话术",
        }
        phase_label = phase_names.get(str(phase), f"阶段{phase}")
        content = f"{phase_label}\n状态: {status}"
        if detail:
            content += f"\n详情: {detail}"
        # 执行过程通知加上【策略检查】【客户名】前缀，话术/报告类保持不变
        _result_keywords = ("话术", "报告")
        if not any(kw in phase for kw in _result_keywords):
            if company_name:
                content = f"【策略检查】【{company_name}】{content}"
            else:
                content = f"【策略检查】{content}"

        data = json.dumps({
            "msgtype": "text",
            "text": {"content": content}
        }, ensure_ascii=False).encode("utf-8")

        import time as _time
        max_retries = 3
        for attempt in range(max_retries):
            try:
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
                        print(f"[WARN] 通知频率限制(45009)，60秒后重试 (第{attempt+1}次)", file=sys.stderr)
                        _time.sleep(60)
                        continue
                    print(f"[WARN] 通知发送失败: {result}", file=sys.stderr)
                    return False
            except Exception as e:
                print(f"[WARN] 通知发送异常: {e}", file=sys.stderr)
                return False
        print(f"[WARN] 通知重试{max_retries}次后仍失败(45009)", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[WARN] 通知模板异常: {e}", file=sys.stderr)
        return False


def send_file_to_group(file_path: str, message: str = "") -> bool:
    """
    通过企微 webhook 发送文件消息到群。

    Step 1: 上传临时文件获取 media_id
    Step 2: 发送 file 类型消息

    Args:
        file_path: 本地文件路径
        message: 附加文本说明

    Returns:
        是否成功
    """
    if not WEBHOOK_URL:
        print("[WARN] 未找到 webhook 配置，文件发送不可用", file=sys.stderr)
        return False

    if not os.path.exists(file_path):
        print(f"[WARN] 文件不存在: {file_path}", file=sys.stderr)
        return False

    try:
        file_name = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)

        # 提取 webhook key
        key = WEBHOOK_URL.split("key=")[-1]

        # ── Step 1: 上传文件 ──
        boundary = "----FormBoundary7MA4YWxkTrZu0gW"
        with open(file_path, "rb") as f:
            file_data = f.read()

        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="media"; filename="{file_name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8")
        body += file_data
        body += f"\r\n--{boundary}--\r\n".encode("utf-8")

        upload_url = f"https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key={key}&type=file"
        upload_req = urllib.request.Request(
            upload_url,
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body))
            }
        )
        with urllib.request.urlopen(upload_req, timeout=30) as resp:
            upload_result = json.loads(resp.read().decode("utf-8"))

        if upload_result.get("errcode") != 0:
            print(f"[WARN] 文件上传企微失败: {upload_result}", file=sys.stderr)
            return False

        media_id = upload_result["media_id"]
        print(f"[INFO] 文件上传成功, media_id={media_id}")

        # ── Step 2: 发送文件消息 ──
        content_parts = []
        if message:
            content_parts.append(message)
        content_parts.append(f"文件: {file_name} ({file_size / 1024:.1f} KB)")

        data = json.dumps({
            "msgtype": "file",
            "file": {"media_id": media_id}
        }, ensure_ascii=False).encode("utf-8")

        file_req = urllib.request.Request(
            WEBHOOK_URL,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"}
        )
        with urllib.request.urlopen(file_req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        if result.get("errcode") != 0:
            print(f"[WARN] 文件消息发送失败: {result}", file=sys.stderr)
            return False

        print(f"[INFO] 文件已发送到群: {file_name}")
        return True

    except Exception as e:
        print(f"[WARN] 发送文件异常: {e}", file=sys.stderr)
        return False


def send_text_to_group(content: str) -> bool:
    """
    直接发送纯文本消息到企微群（不走固定格式模板）。
    """
    if not WEBHOOK_URL:
        print("[WARN] 未找到 webhook 配置", file=sys.stderr)
        return False

    if not content:
        return False

    data = json.dumps({
        "msgtype": "text",
        "text": {"content": content}
    }, ensure_ascii=False).encode("utf-8")

    try:
        req = urllib.request.Request(
            WEBHOOK_URL,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("errcode") != 0:
                print(f"[WARN] 文本消息发送失败: {result}", file=sys.stderr)
                return False
            return True
    except Exception as e:
        print(f"[WARN] 发送文本消息异常: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python notify.py <阶段号> <状态> [详情] [公司名]")
        sys.exit(1)

    phase = sys.argv[1]
    status = sys.argv[2]
    detail = sys.argv[3] if len(sys.argv) > 3 else ""
    company_name = sys.argv[4] if len(sys.argv) > 4 else ""
    send_notification(phase, status, detail, company_name=company_name)
