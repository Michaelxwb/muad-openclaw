#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通报事件回函 - AF 安全日志 / 访问日志查询脚本

查询 AF 上是否存在目标 IoC（domain / 目的IP / 目的IP+端口）的安全日志和访问日志。

接口（复制自外联流量识别 skill，同一数据湖接口）：
    POST https://soar.sangfor.com.cn/gateway/log-search-center-service/datalake/v1/ckQueryList

数据表：
    tableId=56 —— AF 安全日志表（与外联流量识别 tableId=56 为同一张表）

说明：
    - 本脚本为查询框架，payload 构造逻辑待补充（tableId/字段/searchString 已参数化）。
    - 支持三类目的 IoC：domain / 目的IP / 目的IP+端口

用法：
    python query_af_logs.py --company-id <company_id> --ip <源IP> --ioc <目的IoC> [options]
"""
import os
import sys
import json
import time
import uuid
import argparse
import warnings
from datetime import datetime, timedelta

import requests

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

# =============================================================================
# Constants
# =============================================================================
QUERY_URL = "https://soar.sangfor.com.cn/gateway/log-search-center-service/datalake/v1/ckQueryList"
COOKIE_FILE = r"M:\Users\User\Downloads\cookies.txt"
TABLE_ID = [56]          # AF 安全日志表 ID（与外联流量识别同一张表）
FIELD_LIST = ["recordTime", "srcIp", "dstPort", "dstIp", "srcMac", "action", "dnsQueries"]
# 访问日志表字段（不含 action）
FIELD_LIST_NO_ACTION = ["recordTime", "srcIp", "dstPort", "dstIp", "srcMac", "queries", "dnsQueries"]
DEFAULT_PAGE_SIZE = 60

MAX_RETRIES = 3
RETRY_DELAY = 5

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Origin": "https://soar.sangfor.com.cn",
    "Referer": "https://soar.sangfor.com.cn/ui-analyze/index.html?",
    "Sec-Ch-Ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


# =============================================================================
# Cookie 读取
# =============================================================================
def get_cookie_from_file() -> str:
    """从 M:\\Users\\User\\Downloads\\cookies.txt 读取 Cookie 字符串"""
    if os.path.exists(COOKIE_FILE):
        with open(COOKIE_FILE, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie
    raise SystemExit(f"[X ERROR] Cookie 文件不存在或为空: {COOKIE_FILE}")


def extract_cookie_value(cookie: str, key: str):
    """从 Cookie 字符串中提取指定 key 的值"""
    if not cookie:
        return None
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


# =============================================================================
# HTTP
# =============================================================================
def request_page(cookie: str, payload: dict) -> dict:
    """请求单页数据，带重试。"""
    headers = HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(QUERY_URL, headers=headers, json=payload, timeout=30, verify=False)
            return resp.json()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError, requests.exceptions.RequestException) as e:
            print(f"[WARNING] 请求失败 (尝试 {attempt + 1}/{MAX_RETRIES}) - {e}", flush=True)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
            else:
                raise
    return {}


# =============================================================================
# 主流程
# =============================================================================

AF_TABLE_CONF = {
    "table_id": TABLE_ID,
    "field_list": FIELD_LIST,
    "search_string": "",  # AF 安全日志表过滤表达式（待补充）
    "extra_constrains": [],
}

# 访问日志表配置（不含 action 字段）
ACCESS_IP_TABLE_CONF = {
    "table_id": [100],            # 目的 IP / IP+端口 场景
    "field_list": FIELD_LIST_NO_ACTION,
    "search_string": "",
    "extra_constrains": [],
}
ACCESS_DNS_TABLE_CONF = {
    "table_id": [20],             # 域名场景
    "field_list": FIELD_LIST_NO_ACTION,
    "search_string": "",
    "extra_constrains": [],
}


def build_payload(company_id: int, from_date: str, to_date: str,
                  page_no: int, page_size: int, search_string: str = "",
                  table_conf: dict = None) -> dict:
    """构造查询 payload（严格匹配抓包格式）"""
    table_conf = table_conf or AF_TABLE_CONF
    constrains = [
        {
            "fieldAlias": "客户",
            "fieldName": "customer",
            "fieldOperater": "=",
            "fieldValue": str(company_id),
        }
    ]
    constrains.extend(table_conf.get("extra_constrains", []))

    return {
        "searchString": search_string,
        "fromDate": from_date,
        "toDate": to_date,
        "tableId": table_conf["table_id"],
        "constrains": constrains,
        "quickSearch": {},
        "fieldList": table_conf["field_list"],
        "datalakeClusterName": "",
        "pageNo": page_no,
        "pageSize": page_size,
        "order": {},
    }


def _fetch_pages(company_id: int, from_date: str, to_date: str,
                 table_conf: dict, search_string: str = None,
                 max_pages: int = 3, page_size: int = DEFAULT_PAGE_SIZE,
                 cookie: str = None, parser=None) -> list:
    """通用的分页拉取逻辑。"""
    if not cookie:
        cookie = get_cookie_from_file()

    records = []
    page_no = 0
    while True:
        if search_string is None:
            _search = table_conf.get("search_string", "")
        else:
            _search = search_string
        payload = build_payload(company_id, from_date, to_date, page_no, page_size,
                               search_string=_search, table_conf=table_conf)
        result = request_page(cookie, payload)

        # 数据湖异常(code=9601)等偶发错误：重试该页，避免静默中断导致条数不完整
        retries = 0
        max_page_retries = 3
        while result.get("code") == 9601 and retries < max_page_retries:
            retries += 1
            print(f"[WARNING] 第 {page_no} 页数据湖异常(9601)，第 {retries}/{max_page_retries} 次重试...", flush=True)
            time.sleep(RETRY_DELAY)
            result = request_page(cookie, payload)

        code = result.get("code")
        if code != 0:
            print(f"[X ERROR] 接口返回错误 code={code}, msg={result.get('msg')}", flush=True)
            break

        data = result.get("data", {}) or {}
        page_records = data.get("condiResults", []) or []

        for rec in page_records:
            if parser:
                records.append(parser(rec))
            else:
                records.append(dict(rec))

        print(f"[INFO] 第 {page_no} 页: 获取 {len(page_records)} 条 (累计 {len(records)} 条)", flush=True)

        if len(page_records) < page_size:
            print("[INFO] 本页数据不足一页，已到末尾，停止", flush=True)
            break
        if max_pages and page_no + 1 >= max_pages:
            print(f"[INFO] 达到页数上限 max_pages={max_pages}，停止翻页", flush=True)
            break

        page_no += 1

    return records


def _af_parser(rec: dict) -> dict:
    """AF 安全日志单条记录解析"""
    return {
        "recordTime": rec.get("recordTime"),
        "srcIp": rec.get("srcIp"),
        "srcMac": rec.get("srcMac"),
        "dstIp": rec.get("dstIp"),
        "dstPort": rec.get("dstPort"),
        "action": rec.get("action"),
        "dnsQueries": rec.get("dnsQueries"),
        "queries": rec.get("queries"),
    }


# =============================================================================
# searchString 构造
# =============================================================================
def is_ip(value: str) -> bool:
    """判断一个字符串是否形如 IPv4 地址（纯数字点分四段）。"""
    if not value:
        return False
    parts = value.split(".")
    if len(parts) != 4:
        return False
    return all(p.isdigit() for p in parts)


def build_search_string(src_ip: str, ioc: str, dst_port: str = None, log_type: str = "security") -> str:
    """构造 searchString 过滤表达式，兼容目的 IP 与域名两种场景。

    目的 IP 场景（安全日志/访问日志一致）：
        filter srcIp=39.144.190.29 AND dstIp=192.168.18.35
        filter srcIp=39.144.190.29 AND dstIp=192.168.18.35 AND dstPort=49001

    域名场景：
        安全日志(security)：filter srcIp=10.1.247.1 AND dnsQueries="jdhhbs.biz"
        访问日志(access) ：filter srcIp=10.1.247.1 AND queries="jdhhbs.biz"

    若原始输入不含目的端口，则不加 AND dstPort=... 条件。
    """
    if is_ip(ioc):
        parts = [f"filter srcIp={src_ip} AND dstIp={ioc}"]
        if dst_port:
            parts.append(f" AND dstPort={dst_port}")
    else:
        field = "queries" if log_type == "access" else "dnsQueries"
        parts = [f'filter srcIp={src_ip} AND {field}="{ioc}"']
    return "".join(parts)


def query_af_logs(company_id: int, src_ip: str, ioc: str,
                  dst_port: str = None, from_date: str = None, to_date: str = None,
                  max_pages: int = 0, page_size: int = DEFAULT_PAGE_SIZE,
                  cookie: str = None, log_type: str = "security") -> list:
    """查询 AF 安全日志 / 访问日志中符合「源IP + 目的IoC(+端口)」条件的记录。

    Args:
        company_id: 客户 ID
        src_ip: 通报源 IP
        ioc: 目的 IoC（目的 IP 或域名）
        dst_port: 目的端口（可选，仅 IP 场景生效，缺省不过滤端口）
        from_date / to_date: 时间范围，默认 7 天前 -> 此刻
        max_pages: 最多页数，0=遍历全部
        log_type: security=安全日志(tableId 56)；access=访问日志
                 （域名→tableId 20，目的IP/IP+端口→tableId 100）
    Returns:
        list[dict]: 原始记录
    """
    if not from_date or not to_date:
        default_from, default_to = default_time_range()
        from_date = from_date or default_from
        to_date = to_date or default_to

    search_string = build_search_string(src_ip, ioc, dst_port, log_type)

    if log_type == "access":
        # 访问日志：域名→tableId 20；目的IP/IP+端口→tableId 100
        table_conf = ACCESS_DNS_TABLE_CONF if not is_ip(ioc) else ACCESS_IP_TABLE_CONF
    else:
        # 安全日志：一律 tableId 56
        table_conf = AF_TABLE_CONF

    return _fetch_pages(
        company_id, from_date, to_date,
        table_conf=table_conf,
        search_string=search_string,
        max_pages=max_pages, page_size=page_size, cookie=cookie,
        parser=_af_parser,
    )


# =============================================================================
# 结果汇总
# =============================================================================
ACTION_MAP = {0: "未知", 1: "允许", 2: "拒绝"}


def summarize(records: list) -> dict:
    """汇总查询结果：总条数、最早/最新时间、动作分布。"""
    if not records:
        return {
            "count": 0,
            "earliest": None,
            "latest": None,
            "actions": {},
        }

    times = [r.get("recordTime") for r in records if r.get("recordTime")]
    earliest = min(times) if times else None
    latest = max(times) if times else None

    action_count = {}
    for r in records:
        a = r.get("action")
        try:
            a = int(a)
        except (TypeError, ValueError):
            a = None
        key = ACTION_MAP.get(a, f"未知({a})")
        action_count[key] = action_count.get(key, 0) + 1

    return {
        "count": len(records),
        "earliest": earliest,
        "latest": latest,
        "actions": action_count,
    }


def default_time_range():
    """默认取近两周(15天) -> 此刻"""
    now = datetime.now()
    to_date = now.strftime("%Y-%m-%d %H:%M:%S")
    from_date = (now - timedelta(days=15)).strftime("%Y-%m-%d %H:%M:%S")
    return from_date, to_date


def main():
    parser = argparse.ArgumentParser(description="AF 安全日志 / 访问日志查询")
    parser.add_argument("--company-id", type=int, required=True, help="客户ID")
    parser.add_argument("--src-ip", type=str, required=True, help="通报源IP")
    parser.add_argument("--ioc", type=str, required=True, help="目的IoC（目的IP或域名）")
    parser.add_argument("--dst-port", type=str, default=None, help="目的端口（可选，仅IP场景）")
    parser.add_argument("--log-type", type=str, default="security",
                        choices=["security", "access"],
                        help="日志类型：security=安全日志(tableId 56，含action)；access=访问日志(域名→20，IP→100，无action)，默认 security")
    parser.add_argument("--from", dest="from_date", type=str, default=None,
                        help='起始时间 "YYYY-MM-DD HH:MM:SS"，默认7天前')
    parser.add_argument("--to", dest="to_date", type=str, default=None,
                        help='结束时间 "YYYY-MM-DD HH:MM:SS"，默认此刻')
    parser.add_argument("--max-pages", type=int, default=0, help="最多拉取页数（0=遍历全部）")
    parser.add_argument("--output", type=str, default=None, help="输出 JSON 文件路径")
    args = parser.parse_args()

    from_date = args.from_date
    to_date = args.to_date
    if not from_date or not to_date:
        default_from, default_to = default_time_range()
        from_date = from_date or default_from
        to_date = to_date or default_to

    search_string = build_search_string(args.src_ip, args.ioc, args.dst_port, args.log_type)
    table_id_desc = ("20" if not is_ip(args.ioc) else "100") if args.log_type == "access" else "56"
    print(f"[INFO] 日志类型: {args.log_type} (tableId={table_id_desc})", flush=True)
    print(f"[INFO] 查询时间范围: {from_date} -> {to_date}", flush=True)
    print(f"[INFO] 客户ID: {args.company_id}", flush=True)
    print(f"[INFO] 过滤条件: {search_string}", flush=True)

    records = query_af_logs(
        company_id=args.company_id,
        src_ip=args.src_ip,
        ioc=args.ioc,
        dst_port=args.dst_port,
        from_date=from_date,
        to_date=to_date,
        max_pages=args.max_pages,
        log_type=args.log_type,
    )

    summary = summarize(records)
    print("\n" + "=" * 50, flush=True)
    print("[结果汇总]", flush=True)
    print("=" * 50, flush=True)
    print(f"符合条件数据条数: {summary['count']}", flush=True)
    print(f"最早时间: {summary['earliest']}", flush=True)
    print(f"最新时间: {summary['latest']}", flush=True)
    if args.log_type == "security":
        print(f"动作分布: {summary['actions'] if summary['actions'] else '（无数据）'}", flush=True)

    if summary["count"]:
        print("\n[样例] 前 10 条：", flush=True)
        for rec in records[:10]:
            dst_desc = rec.get("dstIp") or rec.get("dnsQueries") or rec.get("queries") or "-"
            if rec.get("dstIp") and rec.get("dstPort"):
                dst_desc = f"{rec.get('dstIp')}:{rec.get('dstPort')}"
            if args.log_type == "security":
                act = rec.get("action")
                try:
                    act = ACTION_MAP.get(int(act), f"未知({act})")
                except (TypeError, ValueError):
                    act = "未知"
                print(f"  {rec.get('recordTime')} | action={act} | src={rec.get('srcIp')} -> dst={dst_desc}", flush=True)
            else:
                print(f"  {rec.get('recordTime')} | src={rec.get('srcIp')} -> dst={dst_desc}", flush=True)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        print(f"\n[INFO] 已写入: {args.output}", flush=True)


if __name__ == "__main__":
    main()
