#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量拉取企微群聊消息脚本

根据 {wechat_id: customer} dict 和 during_time，循环调 fetch_and_store.py 核心逻辑，
拉取所有客户的所有群聊消息，按 msg_time 升序排列。

用法：
  py batch_fetch.py --wechat-map '{"6477ad93...": "五洲传播出版社", "644a75...": "中国水利水电第九工程局有限公司"}' --during-start 1784649600000 --during-end 1785427199000 [--limit 100] [--output-file <path>]

输出（JSON）：
{
  "<wechat_id>": {
    "customer": "五洲传播出版社",
    "messages": [
      {"msg_time": "2026-07-22 09:00:00", "content": "xxx"},
      {"msg_time": "2026-07-22 10:00:00", "content": "yyy"}
    ]
  },
  ...
}
"""

import sys
import os
import json
import uuid
import argparse
import warnings
import requests

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

FETCH_MSG_URL = "https://soar.sangfor.com.cn/order/v1/wechat/view?_method=POST"
DEFAULT_COOKIE_PATH = r"M:\Users\User\Downloads\cookies.txt"
DEFAULT_LIMIT = 100

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


def get_cookie(cookie_file: str = None) -> str:
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
    print("[X ERROR] 未找到 Cookie 文件", file=sys.stderr)
    sys.exit(1)


def extract_cookie_value(cookie: str, key: str) -> str:
    if not cookie:
        return ""
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return ""


def build_headers(cookie: str) -> dict:
    headers = HEADERS_TEMPLATE.copy()
    headers["cookie"] = cookie
    csrf_token = extract_cookie_value(cookie, "csrf_token")
    if csrf_token:
        headers["x-csrftoken"] = csrf_token
    headers["traceid"] = str(uuid.uuid4())
    return headers


def fetch_one_page(cookie: str, wechat_id: str, message_seq: int,
                   during_start: int, during_end: int, limit: int = 100) -> tuple:
    """
    拉取一页群消息。返回 (messages_list, earliest_message_seq)。
    messages_list 为 [{msg_time, content}, ...] 列表，已按 msg_time 升序。
    """
    headers = build_headers(cookie)
    payload = {
        "wechat_id": wechat_id,
        "type": 0,
        "limit": limit,
        "during_time": [during_start, during_end],
        "keyword": "",
        "message_seq": message_seq,
    }

    try:
        resp = requests.post(FETCH_MSG_URL, headers=headers, json=payload, timeout=30, verify=False)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        print(f"[X ERROR] wechat_id={wechat_id} HTTP 请求失败: {e}", file=sys.stderr)
        return [], message_seq

    if data.get("code") != 0:
        print(f"[WARN] wechat_id={wechat_id} API 返回异常: code={data.get('code')}, msg={data.get('msg')}", file=sys.stderr)
        return [], message_seq

    items = data.get("data", [])
    if not items:
        return [], None

    # 提取 msg_time + content
    messages = []
    earliest_seq = None
    earliest_time = None

    for item in items:
        msg_time = item.get("msg_time", "")
        msg_content = item.get("msg_content", {})
        content_text = msg_content.get("content", "")
        msg_seq = item.get("message_seq")
        user_type = item.get("user_type", "")
        sender = item.get("sender", "")

        messages.append({
            "msg_time": msg_time,
            "user_type": user_type,
            "sender": sender,
            "content": content_text,
        })

        if msg_time:
            if earliest_time is None or msg_time < earliest_time:
                earliest_time = msg_time
                earliest_seq = msg_seq

    # 按 msg_time 升序
    messages.sort(key=lambda x: x["msg_time"])

    return messages, earliest_seq


def merge_sorted(existing: list, new_msgs: list) -> list:
    """合并两个按 msg_time 升序的列表，保持升序。"""
    merged = existing + new_msgs
    merged.sort(key=lambda x: x["msg_time"])
    return merged


def fetch_all_for_wechat(cookie: str, wechat_id: str,
                         during_start: int, during_end: int,
                         limit: int = 100) -> list:
    """
    拉取某个 wechat_id 在指定时间范围内的全部消息。
    循环翻页直到返回为空，返回按 msg_time 升序排列的消息列表。
    """
    all_messages = []
    message_seq = 0

    while True:
        print(f"[INFO] wechat_id={wechat_id}: 拉取 page (message_seq={message_seq})", flush=True)
        page_messages, next_seq = fetch_one_page(
            cookie, wechat_id, message_seq, during_start, during_end, limit
        )

        if not page_messages:
            print(f"[INFO] wechat_id={wechat_id}: 无更多消息，停止拉取", flush=True)
            break

        all_messages = merge_sorted(all_messages, page_messages)
        print(f"[INFO] wechat_id={wechat_id}: 本页 {len(page_messages)} 条，累计 {len(all_messages)} 条", flush=True)

        if next_seq is None or next_seq == message_seq:
            print(f"[INFO] wechat_id={wechat_id}: message_seq 未变化，停止拉取", flush=True)
            break

        message_seq = next_seq

    return all_messages


def main():
    parser = argparse.ArgumentParser(description="批量拉取企微群聊消息")
    parser.add_argument("--wechat-map", type=str, default=None,
                        help='JSON 格式的 {wechat_id: customer} dict，或 JSON 文件路径')
    parser.add_argument("--wechat-map-file", type=str, default=None,
                        help='{wechat_id: customer} 的 JSON 文件路径（与 --wechat-map 二选一）')
    parser.add_argument("--during-start", type=int, required=True, help="时间范围起始（毫秒时间戳）")
    parser.add_argument("--during-end", type=int, required=True, help="时间范围结束（毫秒时间戳）")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"每页消息数（默认 {DEFAULT_LIMIT}）")
    parser.add_argument("--cookie-file", type=str, default=None, help="Cookie 文件路径（可选）")
    parser.add_argument("--output-file", type=str, default=None, help="结果输出到文件")
    args = parser.parse_args()

    # 解析 wechat_id -> customer 映射
    raw_map = args.wechat_map
    if args.wechat_map_file:
        with open(args.wechat_map_file, "r", encoding="utf-8") as f:
            raw_map = f.read()

    if not raw_map:
        print("[X ERROR] 必须指定 --wechat-map 或 --wechat-map-file", file=sys.stderr)
        sys.exit(1)

    try:
        wechat_map = json.loads(raw_map)
    except json.JSONDecodeError as e:
        print(f"[X ERROR] wechat-map JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    if not wechat_map:
        print("[WARN] wechat_map 为空，无需拉取", file=sys.stderr)
        result = {}
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        sys.exit(0)

    cookie = get_cookie(args.cookie_file)
    if not cookie:
        print("[X ERROR] Cookie 无效", file=sys.stderr)
        sys.exit(1)

    print(f"[INFO] 开始批量拉取，共 {len(wechat_map)} 个客户", flush=True)
    print(f"[INFO] 时间范围: {args.during_start} ~ {args.during_end}", flush=True)
    print(f"[INFO] 每页 {args.limit} 条", flush=True)

    # 外层循环：遍历每个 wechat_id
    customer_wechat_msg_dict = {}

    for wechat_id, customer_name in wechat_map.items():
        print(f"[INFO] ===== 拉取客户: {customer_name} (wechat_id={wechat_id}) =====", flush=True)

        # 初始化
        customer_wechat_msg_dict[wechat_id] = {
            "customer": customer_name,
            "messages": [],
        }

        # 内层循环：翻页拉取该客户全部消息
        all_messages = fetch_all_for_wechat(
            cookie, wechat_id,
            args.during_start, args.during_end,
            args.limit,
        )

        customer_wechat_msg_dict[wechat_id]["messages"] = all_messages
        print(f"[INFO] 客户 {customer_name}: 共拉取 {len(all_messages)} 条消息", flush=True)

    # 输出
    result_json = json.dumps(customer_wechat_msg_dict, ensure_ascii=False, indent=2)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            f.write(result_json)

    # stdout 可能因 GBK 编码失败，改用 sys.stdout.buffer 写 UTF-8
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        print(result_json, flush=True)
    except Exception:
        # fallback: 只写文件，stdout 输出摘要
        print(f"[INFO] 结果已写入 {args.output_file}", flush=True)

    # 摘要
    summary = {
        "total_customers": len(customer_wechat_msg_dict),
        "details": {wid: len(v["messages"]) for wid, v in customer_wechat_msg_dict.items()},
    }
    print(f"[RESULT] {json.dumps(summary, ensure_ascii=False)}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
