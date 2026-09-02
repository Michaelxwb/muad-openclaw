#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
企微群聊消息拉取脚本

从 SOAR 平台拉取指定企微群的聊天消息，返回：
  1. data 中所有 msg_content.content 的内容列表
  2. data 中时间最早（msg_time 最小）的那条数据的 message_seq

用法：
  py fetch_and_store.py --wechat-id <id> [--limit 10] [--message-seq <seq>] [--during-start <ms>] [--during-end <ms>] [--keyword <str>] [--cookie-file <path>]

示例：
  py fetch_and_store.py --wechat-id "6578c63b91ebf2932f634404" --limit 10 --message-seq 110738217 --during-start 1784649600000 --during-end 1785427199000
"""

import sys
import os
import json
import uuid
import argparse
import warnings
import requests

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

# SOAR API 端点
FETCH_MSG_URL = "https://soar.sangfor.com.cn/order/v1/wechat/view?_method=POST"

# 请求头模板（不包含动态字段 Cookie / x-csrftoken / traceid）
HEADERS_TEMPLATE = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "origin": "https://soar.sangfor.com.cn",
    "pragma": "no-cache",
    "referer": "https://soar.sangfor.com.cn/index.html",
    "sec-ch-ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "timezone": "+08:00",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
}

# Cookie 默认路径（与漏扫 skill 一致）
DEFAULT_COOKIE_PATH = r"M:\Users\User\Downloads\cookies.txt"


# ─────────────────────────────────────────────────────────────
# Cookie 工具
# ─────────────────────────────────────────────────────────────
def get_cookie(cookie_file: str = None) -> str:
    r"""
    获取 Cookie，完全参考漏扫 skill 的模式：
    1. 优先使用命令行指定的 cookie 文件
    2. 否则从 M:\Users\User\Downloads\cookies.txt 读取
    """
    if cookie_file and os.path.exists(cookie_file):
        with open(cookie_file, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie

    if os.path.exists(DEFAULT_COOKIE_PATH):
        with open(DEFAULT_COOKIE_PATH, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie

    print(f"[X ERROR] 未找到 Cookie 文件（已检查: {cookie_file or '无'}, {DEFAULT_COOKIE_PATH}）", file=sys.stderr)
    sys.exit(1)


def extract_cookie_value(cookie: str, key: str) -> str:
    """从 Cookie 字符串中提取指定 key 的值"""
    if not cookie:
        return ""
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return ""


# ─────────────────────────────────────────────────────────────
# HTTP 请求
# ─────────────────────────────────────────────────────────────
def build_headers(cookie: str) -> dict:
    """
    构建请求头，参考漏扫 skill 模式：
    - Cookie 从 M 盘 cookies.txt 读取
    - x-csrftoken 从 Cookie 中提取 csrf_token 值
    - traceid 用 uuid.uuid4() 生成
    """
    headers = HEADERS_TEMPLATE.copy()
    headers["cookie"] = cookie

    csrf_token = extract_cookie_value(cookie, "csrf_token")
    if csrf_token:
        headers["x-csrftoken"] = csrf_token

    headers["traceid"] = str(uuid.uuid4())

    return headers


def fetch_messages(cookie: str, payload: dict) -> dict:
    """发送 POST 请求拉取群消息"""
    headers = build_headers(cookie)

    session = requests.Session()
    try:
        resp = session.post(
            FETCH_MSG_URL,
            headers=headers,
            json=payload,
            timeout=30,
            verify=False,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        print(f"[X ERROR] HTTP 请求失败: {e}", file=sys.stderr)
        sys.exit(1)


# ─────────────────────────────────────────────────────────────
# 响应处理
# ─────────────────────────────────────────────────────────────
def process_response(response: dict) -> dict:
    """
    处理 API 响应，返回：
      - messages: [{"msg_time": "...", "content": "..."}, ...]，按 msg_time 从小到大排列
      - earliest_message_seq: msg_time 最早的那条数据的 message_seq（翻页用）
    """
    if response.get("code") != 0:
        print(f"[X ERROR] API 返回错误: code={response.get('code')}, msg={response.get('msg')}",
              file=sys.stderr)
        sys.exit(1)

    data = response.get("data", [])
    if not data:
        print("[WARN] 返回的 data 为空列表", file=sys.stderr)
        return {"messages": [], "earliest_message_seq": None}

    # 提取 msg_time + content，并记录最早的 message_seq
    items = []
    earliest_seq = None
    earliest_time = None

    for item in data:
        msg_time = item.get("msg_time", "")
        msg_content = item.get("msg_content", {})
        content_text = msg_content.get("content", "")
        msg_seq = item.get("message_seq")
        user_type = item.get("user_type", "")
        sender = item.get("sender", "")

        items.append({
            "msg_time": msg_time,
            "user_type": user_type,
            "sender": sender,
            "content": content_text,
        })

        if msg_time:
            if earliest_time is None or msg_time < earliest_time:
                earliest_time = msg_time
                earliest_seq = msg_seq

    # 按 msg_time 从小到大排列
    items.sort(key=lambda x: x["msg_time"])

    return {
        "messages": items,
        "earliest_message_seq": earliest_seq,
    }


# ─────────────────────────────────────────────────────────────
# 主函数
# ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="企微群聊消息拉取")
    parser.add_argument("--wechat-id", type=str, required=True, help="企微群 ID")
    parser.add_argument("--limit", type=int, default=10, help="每页消息数（默认 10）")
    parser.add_argument("--message-seq", type=int, default=0, help="起始消息序号")
    parser.add_argument("--during-start", type=int, required=True, help="时间范围起始（毫秒时间戳）")
    parser.add_argument("--during-end", type=int, required=True, help="时间范围结束（毫秒时间戳）")
    parser.add_argument("--keyword", type=str, default="", help="搜索关键词")
    parser.add_argument("--type", type=int, default=0, help="消息类型（默认 0）")
    parser.add_argument("--cookie-file", type=str, default=None, help="Cookie 文件路径（可选）")
    parser.add_argument("--output-file", type=str, default=None, help="结果输出到文件（UTF-8）")
    args = parser.parse_args()

    # 获取 Cookie
    cookie = get_cookie(args.cookie_file)
    if not cookie:
        print("[X ERROR] Cookie 无效", file=sys.stderr)
        sys.exit(1)

    # 构建 payload
    payload = {
        "wechat_id": args.wechat_id,
        "type": args.type,
        "limit": args.limit,
        "during_time": [args.during_start, args.during_end],
        "keyword": args.keyword,
        "message_seq": args.message_seq,
    }

    print(f"[INFO] 请求参数: wechat_id={args.wechat_id}, limit={args.limit}, message_seq={args.message_seq}", flush=True)
    print(f"[INFO] 时间范围: {args.during_start} ~ {args.during_end}", flush=True)

    # 发请求
    response = fetch_messages(cookie, payload)

    # 处理响应
    result = process_response(response)

    # 输出结果：JSON 格式，messages 按时间升序排列
    messages = result["messages"]
    earliest_seq = result["earliest_message_seq"]

    output = json.dumps({
        "messages": messages,
        "earliest_message_seq": earliest_seq,
    }, ensure_ascii=False, indent=2)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            f.write(output)

    print(output, flush=True)

    # 摘要输出到 stderr
    summary = json.dumps({
        "total": len(messages),
        "earliest_message_seq": earliest_seq,
    }, ensure_ascii=False)
    print(f"[RESULT] {summary}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
