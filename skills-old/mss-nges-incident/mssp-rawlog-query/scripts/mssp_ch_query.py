#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MSSP 模型日志库查询 —— 通过 ClickHouse 原生 TCP 协议取 GPTrawLog
================================================================
依赖 clickhouse-driver：
    pip install --break-system-packages -i https://mirrors.aliyun.com/pypi/simple clickhouse-driver

数据表: aes_10001_sz_3_tenant_group_name.data_dr_ops_gpt_analysis_log
关键字段: seq, agentId, tenant, GPTrawLog, gptresponseStatus, insertTime,
          runtimeReceiveAt, runtimeFinishedAt, taskcontentCgId, taskcontentAlertId
          GPTrawLog = 模型原始日志(GPT解析结果，JSON 字符串)

支持按不同条件查询：
    1. 按 CGID      --cgid <CGID>
    2. 按告警ID     --alertid <taskcontentAlertId 或名>
    3. 按 seq       --seq <seq>
    4. 自定义 SQL   --sql "..."
    5. 时间范围     --start / --end (默认 2026-08-10 ~ 2026-08-31)

行为:
    - 查询到 1 条：直接打印 GPTrawLog（并解析出关键字段）
    - 查询到多条：打印「共 N 条」，保存最后一条（seq 最大）的 GPTrawLog 到
      --out 指定文件（默认 save_dir/gptrawlog_<criterion>.json），并给出提示
    - 查询到 0 条：打印"无数据"

用法示例:
    # 按 CGID
    python3 mssp_ch_query.py --cgid 17937119307574291111
    # 按告警ID
    python3 mssp_ch_query.py --alertid 270301879910256667
    # 按 seq
    python3 mssp_ch_query.py --seq 1787404803822
    # 自定义 SQL
    python3 mssp_ch_query.py --sql "SELECT GPTrawLog FROM ... WHERE taskcontentCgId='...'"
    # 指定保存文件 / 保存目录
    python3 mssp_ch_query.py --cgid ... --out /path/to/raw.json
    python3 mssp_ch_query.py --cgid ... --save-dir /path/to/dir
"""

import argparse
import json
import os
import sys
from datetime import datetime

from clickhouse_driver import Client


# 连接与配置集中管理：优先读取 env 覆盖，其次读 config/api_config.json
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_config():
    cfg_path = os.path.join(BASE_DIR, "config", "api_config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


_CFG = _load_config().get("clickhouse", {})


# env 覆盖优先：RAWLOG_CH_HOST / RAWLOG_CH_PORT / RAWLOG_CH_USER / RAWLOG_CH_PASSWORD / RAWLOG_CH_DB
HOST = os.environ.get("RAWLOG_CH_HOST") or _CFG.get("host", "10.150.69.100")
PORT = int(os.environ.get("RAWLOG_CH_PORT") or _CFG.get("port", 30200))
USERNAME = os.environ.get("RAWLOG_CH_USER") or _CFG.get("user", "mssclaw")
PASSWORD = os.environ.get("RAWLOG_CH_PASSWORD") or _CFG.get("password", "")

# 支持的模型日志库（不同租户群各自的 DB）
SUPPORTED_DBS = _CFG.get("dbs") or [
    "aes_10001_sz_3_tenant_group_name",
    "aes_10002_sz_3_tenant_group_name",
    "aes_10003_sz_3_tenant_group_name",
    "aes_10004_sz_3_tenant_group_name",
]

DEFAULT_DB = _CFG.get("default_db") or SUPPORTED_DBS[0]

DATABASE = DEFAULT_DB


def set_database(db):
    """切换查询库（必须在构建 SQL / 连接前调用）。"""
    global DATABASE, TABLE
    DATABASE = db
    TABLE = f"{db}.data_dr_ops_gpt_analysis_log"

COLUMNS = [
    "seq", "agentId", "tenant", "GPTrawLog", "gptresponseStatus",
    "insertTime", "runtimeReceiveAt", "runtimeFinishedAt",
    "CAST(taskcontentCgId AS VARCHAR) AS taskcontentCgId",
    "CAST(taskcontentAlertId AS VARCHAR) AS taskcontentAlertId",
]


def select_all():
    return "SELECT " + ", ".join(COLUMNS) + " FROM " + TABLE


def build_sql(criteria, start="2026-08-10 00:00:00", end="2026-08-31 00:00:00", limit=100):
    """criteria: dict，如 {"taskcontentCgId": "..."} 或 {"seq": 123} 等 (AND 组合)。"""
    where = [
        f"insertTime > toDateTime('{start}', 'Asia/Shanghai')",
        f"insertTime < toDateTime('{end}', 'Asia/Shanghai')",
    ]
    for col, val in criteria.items():
        if isinstance(val, (int, float)):
            where.append(f"{col} = {val}")
        else:
            where.append(f"{col} = '{val}'")
    sql = select_all() + " WHERE " + " AND ".join(where) + f" ORDER BY seq DESC LIMIT {limit}"
    return sql


def pretty_node(d, indent=0, maxlen=200):
    """将 GPTrawLog 的部分关键结构抽取出来做可读展示。"""
    out = []
    pad = "  " * indent
    if isinstance(d, dict):
        for k, v in d.items():
            if k in ("TimeStampMap", "SoftwareInfo", "analysePrompt"):
                continue
            if isinstance(v, (dict, list)):
                if k in ("treeList", "virtualEdges") or (k == "taskContent"):
                    continue
                out.append(f"{pad}{k}:")
                out.append(pretty_node(v, indent + 1, maxlen))
            else:
                s = str(v)
                if len(s) > maxlen:
                    s = s[:maxlen] + f"...[截断共{len(str(v))}字符]"
                out.append(f"{pad}{k}: {s}")
    elif isinstance(d, list):
        for i, it in enumerate(d):
            out.append(f"{pad}[{i}]:")
            out.append(pretty_node(it, indent + 1, maxlen))
    return "\n".join(out)


def parse_rawlog(raw_str):
    """解析 GPTrawLog JSON，若失败返回 (None, err)。"""
    try:
        return json.loads(raw_str), None
    except Exception as e:
        return None, f"GPTrawLog 非合法 JSON: {e}"


def _default_window_days():
    """默认查询窗口：最近 N 天（避免硬编码固定日期导致漏查新事件）。"""
    return _CFG.get("default_window_days", 30)


def _default_start():
    """默认起始 = now - N 天。"""
    from datetime import datetime, timedelta
    return (datetime.now() - timedelta(days=_default_window_days())).strftime("%Y-%m-%d %H:%M:%S")


def _default_end():
    """默认结束 = now。"""
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def main():
    ap = argparse.ArgumentParser(description="MSSP 模型日志库 GPTrawLog 查询")
    ap.add_argument("--db", default=DEFAULT_DB, help="模型日志库 DB（默认 aes_10001...），可选: " + ", ".join(SUPPORTED_DBS))
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument("--cgid", help="按 CGID 查询")
    grp.add_argument("--alertid", help="按告警ID(taskcontentAlertId)查询")
    grp.add_argument("--seq", type=int, help="按 seq 查询")
    grp.add_argument("--sql", help="自定义完整 SQL（覆盖其余条件）")
    ap.add_argument("--start", default=None, help="起始时间（默认最近 %s 天）" % _default_window_days())
    ap.add_argument("--end", default=None, help="结束时间（默认当前时）")
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--out", help="加载最后一条 GPTrawLog 的保存路径")
    ap.add_argument("--save-dir", default=None, help="最后一条 GPTrawLog 默认保存目录")
    ap.add_argument("--no-save", action="store_true", help="查询到多条时不保存，仅打印")
    args = ap.parse_args()

    # 切换到指定 DB
    if args.db not in SUPPORTED_DBS:
        print(f"[错误] 不支持的 DB: {args.db}")
        print(f"  支持: {', '.join(SUPPORTED_DBS)}")
        sys.exit(1)
    set_database(args.db)

    # 构造 SQL（未指定起止时间时使用动态滚动窗口，避免漏查新事件）
    start = args.start or _default_start()
    end = args.end or _default_end()
    if args.sql:
        query = args.sql
        criterion = "custom"
    elif args.cgid:
        query = build_sql({"taskcontentCgId": args.cgid}, start, end, args.limit)
        criterion = f"cgid_{args.cgid}"
    elif args.alertid:
        query = build_sql({"taskcontentAlertId": args.alertid}, start, end, args.limit)
        criterion = f"alertid_{args.alertid}"
    else:  # seq
        query = build_sql({"seq": args.seq}, start, end, args.limit)
        criterion = f"seq_{args.seq}"

    print(f"[连接] {HOST}:{PORT} user={USERNAME} db={DATABASE}")
    client = Client(
        host=HOST, port=PORT, user=USERNAME, password=PASSWORD,
        database=DATABASE, connect_timeout=args.timeout, send_receive_timeout=args.timeout,
        settings={"use_numpy": False},
    )
    try:
        rows, col_types = client.execute(query, with_column_types=True)
        colnames = [c for c, _ in col_types]
        n = len(rows)
        print(f"\n[查询成功] 共 {n} 条")
        print("=" * 80)

        if n == 0:
            print("无数据（该条件下没有搜索到 GPTrawLog）")
            return

        # 按 seq 升序排列，取最后一条（seq 最大 = ORDER BY seq DESC 的第一条）
        # 为稳妥，重新排序取最大 seq
        def seq_key(r):
            try:
                return int(r[colnames.index("seq")])
            except Exception:
                return 0
        rows_sorted = sorted(rows, key=seq_key)
        last = rows_sorted[-1]

        if n > 1:
            print(f"⚠️ 查询到 {n} 条，按需求保存最后一条（seq={last[colnames.index('seq')]}）")
            print("-" * 80)
            print("所有命中的 seq / insertTime / cgId / alertId:")
            for r in rows_sorted:
                rec = {c: v for c, v in zip(colnames, r)}
                print(f"  seq={rec.get('seq')} insertTime={rec.get('insertTime')} "
                      f"cgId={rec.get('taskcontentCgId')} alertId={rec.get('taskcontentAlertId')}")
            print("=" * 80)

        # 最后一条记录
        last_rec = {c: v for c, v in zip(colnames, last)}
        raw_str = last_rec.get("GPTrawLog") or ""
        if isinstance(raw_str, (bytes, bytearray)):
            raw_str = bytes(raw_str).decode("utf-8", "replace")
        raw_str = str(raw_str)

        gpt, parse_err = parse_rawlog(raw_str)
        print(f"\n『最后一条』记录: seq={last_rec.get('seq')}  "
              f"insertTime={last_rec.get('insertTime')}")
        print(f"  alertId={last_rec.get('taskcontentAlertId')}  cgId={last_rec.get('taskcontentCgId')}")
        print(f"  GPTrawLog 长度: {len(raw_str)} 字符  "
              f"(解析: {'✓ 合法JSON' if gpt else '✗ ' + (parse_err or '')})")

        # 展示关键摘要
        if gpt:
            rt = gpt.get("Runtime", {})
            tc = gpt.get("taskContent", {})
            rsp = tc.get("gptResponse", {})
            print("\n『审计摘要』")
            print(f"  模型版本 : {rt.get('AnalysisModelVersion')}  引擎: {rt.get('requester')}")
            print(f"  定性标签 : {rsp.get('threatTag')} / {tc.get('threatType')} / {rsp.get('attacker')}")
            print(f"  事件名称 : {rsp.get('name')}")
            print(f"  AI 分析  : {rsp.get('overview')}")
            dispos = rsp.get("disposeSuggestion")
            if dispos:
                print(f"  处置建议 : {dispos.replace(chr(10), ' | ')[:300]}")
            print(f"  analyseAnswer: {(rt.get('analyseAnswer') or '')[:200]}")

        # 保存最后一条 GPTrawLog
        if n > 1 and not args.no_save:
            if args.out:
                save_path = args.out
            else:
                # 统一可写根：优先 SKILL_OUTPUT_DIR（平台托管规范 per-user 可写区，
                # skill 根只读时仍可写、换用户自动隔离不错位）；否则 skill 根下 rawlog 回退。
                # rawlog 是 fetch 工作文件，存到 <可写根>/rawlog/ 下，不属于统一事件归档本身。
                outdir = os.environ.get("SKILL_OUTPUT_DIR")
                base = outdir or BASE_DIR
                save_dir = args.save_dir or os.path.join(base, "rawlog")
                os.makedirs(save_dir, exist_ok=True)
                save_path = os.path.join(save_dir, f"{criterion}.json")
            with open(save_path, "w", encoding="utf-8") as f:
                f.write(raw_str)
            print(f"\n✅ 已保存最后一条 GPTrawLog 到: {save_path}")
        elif n == 1:
            print("\n（单条记录，按需展示，未自动保存；如需保存可加 --out / --save-dir）")
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
