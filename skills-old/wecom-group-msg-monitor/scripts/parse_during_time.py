#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
时间范围解析脚本

将用户输入的时间范围描述转换为毫秒级时间戳。

支持格式：
  - 最近N天 / 最近N周 / 最近N月 / 最近N小时
  - YYYY-MM-DD ~ YYYY-MM-DD
  - YYYY-MM-DD（单日，当天 00:00 ~ 23:59:59）
  - M月D日 ~ M月D日（当年）
  - 今天 / 昨天 / 本周 / 上周 / 本月 / 上月

用法：
  py parse_during_time.py --range "最近7天"
  py parse_during_time.py --range "2026-07-22 ~ 2026-07-30"
  py parse_during_time.py --start "2026-07-22" --end "2026-07-30"
  py parse_during_time.py --range "最近一个月" --output-file <path>

输出（JSON）：
  {
    "during_time": [1784736000000, 1785427199000],
    "start_str": "2026-07-22 00:00:00",
    "end_str": "2026-07-30 23:59:59"
  }
"""

import sys
import os
import json
import re
import argparse
from datetime import datetime, timedelta, timezone

# 上海时区（UTC+8）
SH_TZ = timezone(timedelta(hours=8))

# 中文数字映射
CN_NUM = {
    "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "半": 0.5,
}


def parse_number(s: str):
    """解析字符串中的数字，支持中文数字（一~十）和阿拉伯数字"""
    s = s.strip()
    if s in CN_NUM:
        return CN_NUM[s]
    return float(s) if '.' in s else int(s)


def now() -> datetime:
    """返回当前上海时间"""
    return datetime.now(SH_TZ)


def date_to_ms(dt: datetime, end_of_day: bool = False) -> int:
    """
    将 datetime 转为毫秒时间戳。
    end_of_day=True 时设为当天 23:59:59.999。
    """
    if end_of_day:
        dt = dt.replace(hour=23, minute=59, second=59, microsecond=999000)
    else:
        dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(dt.timestamp() * 1000)


def str_to_datetime(s: str, default_hour: int = 0) -> datetime:
    """
    解析日期字符串为上海时区 datetime。
    支持: YYYY-MM-DD, YYYY/MM/DD, M月D日, M.D
    """
    s = s.strip()

    # YYYY-MM-DD
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                        default_hour, 0, 0, tzinfo=SH_TZ)

    # YYYY/MM/DD
    m = re.match(r"(\d{4})/(\d{1,2})/(\d{1,2})$", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                        default_hour, 0, 0, tzinfo=SH_TZ)

    # M月D日
    m = re.match(r"(\d{1,2})月(\d{1,2})日$", s)
    if m:
        return datetime(now().year, int(m.group(1)), int(m.group(2)),
                        default_hour, 0, 0, tzinfo=SH_TZ)

    # M.D
    m = re.match(r"(\d{1,2})\.(\d{1,2})$", s)
    if m:
        return datetime(now().year, int(m.group(1)), int(m.group(2)),
                        default_hour, 0, 0, tzinfo=SH_TZ)

    raise ValueError(f"无法解析日期: {s}")


def parse_range(range_str: str) -> dict:
    """
    解析时间范围字符串，返回 {during_time, start_str, end_str}。
    """
    range_str = range_str.strip()
    n = now()

    # ── 相对时间 ──

    # 最近N天 / 近N天 / 过去N天
    m = re.match(r"(?:最近|近|过去)(\d+|[一二两三四五六七八九十半])\s*天", range_str)
    if m:
        days = parse_number(m.group(1))
        start = n - timedelta(days=days)
        end = n - timedelta(days=1)
        return {
            "during_time": [date_to_ms(start), date_to_ms(end, end_of_day=True)],
            "start_str": start.strftime("%Y-%m-%d %H:%M:%S"),
            "end_str": end.strftime("%Y-%m-%d 23:59:59"),
        }

    # 最近N周 / 近N周
    m = re.match(r"(?:最近|近|过去)(\d+|[一二两三四五六七八九十半])\s*周", range_str)
    if m:
        weeks = parse_number(m.group(1))
        start = n - timedelta(weeks=weeks)
        end = n - timedelta(days=1)
        return {
            "during_time": [date_to_ms(start), date_to_ms(end, end_of_day=True)],
            "start_str": start.strftime("%Y-%m-%d %H:%M:%S"),
            "end_str": end.strftime("%Y-%m-%d 23:59:59"),
        }

    # 最近N月 / 近N月
    m = re.match(r"(?:最近|近|过去)(\d+|[一二两三四五六七八九十半])\s*(?:个)?月", range_str)
    if m:
        months = parse_number(m.group(1))
        start = n - timedelta(days=int(months * 30))
        end = n - timedelta(days=1)
        return {
            "during_time": [date_to_ms(start), date_to_ms(end, end_of_day=True)],
            "start_str": start.strftime("%Y-%m-%d %H:%M:%S"),
            "end_str": end.strftime("%Y-%m-%d 23:59:59"),
        }

    # 最近N小时 / 近N小时
    m = re.match(r"(?:最近|近|过去)(\d+|[一二两三四五六七八九十半])\s*(?:个)?小时", range_str)
    if m:
        hours = parse_number(m.group(1))
        start = n - timedelta(hours=hours)
        end = n
        return {
            "during_time": [date_to_ms(start), date_to_ms(end, end_of_day=True)],
            "start_str": start.strftime("%Y-%m-%d %H:%M:%S"),
            "end_str": end.strftime("%Y-%m-%d 23:59:59"),
        }

    # ── 自然语言 ──

    if range_str in ("今天", "今日"):
        return {
            "during_time": [date_to_ms(n), date_to_ms(n, end_of_day=True)],
            "start_str": n.strftime("%Y-%m-%d 00:00:00"),
            "end_str": n.strftime("%Y-%m-%d 23:59:59"),
        }

    if range_str in ("昨天", "昨日"):
        d = n - timedelta(days=1)
        return {
            "during_time": [date_to_ms(d), date_to_ms(d, end_of_day=True)],
            "start_str": d.strftime("%Y-%m-%d 00:00:00"),
            "end_str": d.strftime("%Y-%m-%d 23:59:59"),
        }

    if range_str in ("本周", "这周"):
        monday = n - timedelta(days=n.weekday())
        return {
            "during_time": [date_to_ms(monday), date_to_ms(n, end_of_day=True)],
            "start_str": monday.strftime("%Y-%m-%d 00:00:00"),
            "end_str": n.strftime("%Y-%m-%d 23:59:59"),
        }

    if range_str in ("上周"):
        this_monday = n - timedelta(days=n.weekday())
        last_monday = this_monday - timedelta(days=7)
        last_sunday = this_monday - timedelta(days=1)
        return {
            "during_time": [date_to_ms(last_monday), date_to_ms(last_sunday, end_of_day=True)],
            "start_str": last_monday.strftime("%Y-%m-%d 00:00:00"),
            "end_str": last_sunday.strftime("%Y-%m-%d 23:59:59"),
        }

    if range_str in ("本月", "这个月"):
        first_day = n.replace(day=1)
        return {
            "during_time": [date_to_ms(first_day), date_to_ms(n, end_of_day=True)],
            "start_str": first_day.strftime("%Y-%m-%d 00:00:00"),
            "end_str": n.strftime("%Y-%m-%d 23:59:59"),
        }

    if range_str in ("上月", "上个月"):
        first_day_this_month = n.replace(day=1)
        last_day_last_month = first_day_this_month - timedelta(days=1)
        first_day_last_month = last_day_last_month.replace(day=1)
        return {
            "during_time": [date_to_ms(first_day_last_month),
                            date_to_ms(last_day_last_month, end_of_day=True)],
            "start_str": first_day_last_month.strftime("%Y-%m-%d 00:00:00"),
            "end_str": last_day_last_month.strftime("%Y-%m-%d 23:59:59"),
        }

    # ── 日期范围: YYYY-MM-DD ~ YYYY-MM-DD ──
    m = re.match(
        r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}\.\d{1,2})"
        r"\s*[~～-]\s*"
        r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}\.\d{1,2})$",
        range_str
    )
    if m:
        start_dt = str_to_datetime(m.group(1))
        end_dt = str_to_datetime(m.group(2))
        return {
            "during_time": [date_to_ms(start_dt), date_to_ms(end_dt, end_of_day=True)],
            "start_str": start_dt.strftime("%Y-%m-%d 00:00:00"),
            "end_str": end_dt.strftime("%Y-%m-%d 23:59:59"),
        }

    # ── 单日: YYYY-MM-DD ──
    try:
        dt = str_to_datetime(range_str)
        return {
            "during_time": [date_to_ms(dt), date_to_ms(dt, end_of_day=True)],
            "start_str": dt.strftime("%Y-%m-%d 00:00:00"),
            "end_str": dt.strftime("%Y-%m-%d 23:59:59"),
        }
    except ValueError:
        pass

    raise ValueError(f"无法识别的时间范围: {range_str}")


def main():
    parser = argparse.ArgumentParser(description="时间范围解析为毫秒时间戳")
    parser.add_argument("--range", type=str, default=None, help="时间范围描述（如：最近7天 / 2026-07-22~2026-07-30）")
    parser.add_argument("--start", type=str, default=None, help="开始日期（YYYY-MM-DD，与 --end 搭配）")
    parser.add_argument("--end", type=str, default=None, help="结束日期（YYYY-MM-DD，与 --start 搭配）")
    parser.add_argument("--output-file", type=str, default=None, help="结果输出到文件")
    args = parser.parse_args()

    try:
        if args.start and args.end:
            # --start + --end 模式
            start_dt = str_to_datetime(args.start)
            end_dt = str_to_datetime(args.end)
            result = {
                "during_time": [date_to_ms(start_dt), date_to_ms(end_dt, end_of_day=True)],
                "start_str": start_dt.strftime("%Y-%m-%d 00:00:00"),
                "end_str": end_dt.strftime("%Y-%m-%d 23:59:59"),
            }
        elif args.range:
            result = parse_range(args.range)
        else:
            print("[X ERROR] 必须指定 --range 或 --start/--end", file=sys.stderr)
            sys.exit(1)

    except ValueError as e:
        print(f"[X ERROR] {e}", file=sys.stderr)
        sys.exit(1)

    result_json = json.dumps(result, ensure_ascii=False)
    print(result_json, flush=True)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            f.write(result_json)


if __name__ == "__main__":
    main()
