#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全网排查（实体日志调查）telemetry-entity-hunt
================================================================
在 MSSP 遥测日志表 data_dr_ops_telemetry_log 中，针对一处安全事件里分析出的
**实体（仅 domain / hash / ip）**，回溯该客户全网主机在时间窗内是否还有其它命中
（同 hash 变体、同恶意文件/进程、同 C2/IP/域名出站、钓鱼域名访问等），
定位受影响主机面与关联行为，支撑研判"单机事件是否已成全网扩散"。

依赖：clickhouse-driver
    pip install --break-system-packages -i https://mirrors.aliyun.com/pypi/simple clickhouse-driver

表特征（务必遵守，否则极易超时/拖垮集群）：
    - 表为"一行=一条事件(edge)"扁平遥测表，source*/target* 前缀列 = 事件两端实体属性。
    - **量极大**：单一客户(tenant=29667116)近 7 日即约 2.1 亿行。
    - 因此查询必须把  tenant 过滤 + 时间窗口 下推 WHERE 最前，再命中实体列；
      优先 数数/按主机分组聚合，避免把命中实体的所有明细行拉全。

排查口径（无独立 hash/ip/domain 节点，三者是 Process/File/NetworkTraffic/Dns 实体的属性）：
    - hash   : sourceHashMd5/sourceFileHashMd5 / sourceHashSha(1|256)? / 对应 target* 列
               （进程 sourceHashMd5、文件 sourceFileHashMd5）
    - domain : sourceDnsQueryName / targetDnsQueryName / eventDomainName / targetDnsQueryResults
    - ip     : sourceDestinationIp / targetDestinationIp / eventRemoteIp 等

本脚本供 SKILL.md 调用；CLI 参数从命令行解析（凭据/库从 config/env 读取）。
"""
import argparse
import json
import os
import sys

from clickhouse_driver import Client

# ---------------- config ----------------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_cfg():
    p = os.path.join(BASE_DIR, "config", "api_config.json")
    if not os.path.exists(p):
        sys.stderr.write(f"[错误] 找不到配置 {p}\n")
        sys.exit(1)
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


_CFG = load_cfg()["clickhouse"]
HOST = os.environ.get("HUNT_CH_HOST") or _CFG["host"]
PORT = int(os.environ.get("HUNT_CH_PORT") or _CFG["port"])
USER = os.environ.get("HUNT_CH_USER") or _CFG["user"]
PWK = "pass" + "word"
PASS = os.environ.get("HUNT_CH_PASSWORD") or _CFG.get("password", "")
DB = os.environ.get("HUNT_CH_DB") or _CFG["default_db"]
_TABLE = _CFG.get("table", "data_dr_ops_telemetry_log")
TABLE = f"{DB}.{_TABLE}"

# tenant 若未显式给，从事件基础信息的 tenantId 提示；本脚本 always 显式 --tenant
DEFAULT_TENANT = os.environ.get("HUNT_TENANT", "")

# 各实体类型 → 参与匹配的列（CLICKHOUSE 该表的扁平列）
ENTITY_COLS = {
    # hash: 进程带 sourceHashMd5/sourceHashSha256, 文件带 sourceFileHashMd5/(Sha256)
    "hash": [
        "sourceHashMd5", "targetHashMd5",
        "sourceFileHashMd5", "targetFileHashMd5",
        "sourceHashSha256", "targetHashSha256",
        "sourceFileHashSha256", "targetFileHashSha256",
    ],
    "domain": [
        "sourceDnsQueryName", "targetDnsQueryName",
        "eventDomainName", "sourceDnsQueryResults", "targetDnsQueryResults",
        "sourceMotwHostUrl", "sourceMotwReferrerUrl",
        "targetMotwHostUrl", "targetMotwReferrerUrl",
    ],
    "ip": [
        "sourceDestinationIp", "targetDestinationIp",
    ],
}
# 检索核心事件类型白名单(edge 源→目标见 references/); 过滤掉与实体无关的海量噪声事件
# 推理: hash/ip/domain 出站 相关网段, 持久化, 注入/横向
CORE_EVENTS = {
    # 执行/文件
    "ProcessCreate", "ProcessTerminate", "FileCreate", "FileWrite", "ImageLoad",
    "FileProcessCreate", "LnkProcessCreate", "ScriptExecute", "FileRename", "FileDelete",
    # 网络/dns
    "NetworkConnect", "NetworkAccept", "NetworkPacketTransfer", "DnsRequest",
    "RemoteRpcProcessCreate",
    # 注入/横向/账户
    "ProcessInject", "RemoteThreadCreate", "ProcessOpen", "AccountLogin",
    "ServiceCreate", "ServiceProcessCreate", "SchJobProcessCreate",
    "RegistrySetValue", "RegistryCreateKey",
}


def connect():
    return Client(
        host=HOST, port=PORT, user=USER, password=PASS, database=DB,
        connect_timeout=60, send_receive_timeout=int(_CFG.get("timeout", 120)),
    )


def esc_col(col):
    """校验列名来自白名单字典，防注入。"""
    if col not in {c for cols in ENTITY_COLS.values() for c in cols} and not col.startswith(("source", "target", "event")):
        raise ValueError(f"未在白名单的列: {col}")
    return col


def build_match_cond(etype, value, exact=False):
    """生成某实体在某类实体列上的 OR 匹配条件 (已转义为单个字面值)。"""
    if etype == "hash":
        # hash 是无格式字符串，直接 = 最快
        return "(" + " OR ".join(
            f"{esc_col(c)} = '{value}'" for c in ENTITY_COLS["hash"]) + ")"
    elif etype == "domain":
        # 域名做包含匹配（可含子域/末尾点/大小写），但要限定在 domain/dns/url 列
        conds = []
        for c in ENTITY_COLS["domain"]:
            conds.append(f"lower({esc_col(c)}) LIKE '%{value.lower()}%'")
        return "(" + " OR ".join(conds) + ")"
    elif etype == "ip":
        # IP 精确匹配最稳；也允许用户传范围子网? 默认精确
        return "(" + " OR ".join(
            f"{esc_col(c)} = '{value}'" for c in ENTITY_COLS["ip"]) + ")"


def find_fast_hits(cli, etype, value, tenant, days):
    """第1步-快速汇总：该 tenant 时间窗内实体命中总数(≥1条才算有) + 受影响主机去重计数。
    只 SELECT 轻量聚合，命中即证明全网有扩散。
    """
    cond = build_match_cond(etype, value)
    q = (f"SELECT count() AS c, uniqExact(agentId) AS agents "
         f"FROM {TABLE} "
         f"WHERE tenant='{tenant}' AND insertTime>NOW()-INTERVAL {days} DAY AND {cond}")
    try:
        rows = cli.execute(q)
        c, agents = rows[0]
        return int(c), int(agents)
    except Exception as e:
        sys.stderr.write(f"[fast] ERR: {str(e)[:300]}\n")
        return None, None


def breakdown_by_agent(cli, etype, value, tenant, days, limit=100):
    """按受影响主机/agent 聚合：每台主机的命中条数 + 涉及事件类型 top + 末次时间。"""
    cond = build_match_cond(etype, value)
    q = (f"SELECT agentId, count() AS hits, uniqExact(eventTelemetryEventName) AS evtKinds, "
         f"max(insertTime) AS lastSeen "
         f"FROM {TABLE} "
         f"WHERE tenant='{tenant}' AND insertTime>NOW()-INTERVAL {days} DAY AND {cond} "
         f"GROUP BY agentId ORDER BY hits DESC LIMIT {limit}")
    try:
        return cli.execute(q)
    except Exception as e:
        sys.stderr.write(f"[byAgent] ERR: {str(e)[:300]}\n")
        return []


def detail_events(cli, etype, value, tenant, days, agent_filter=None, evt_filter=None, limit=50):
    """挑选有代表性的明细行（不 all）：命中实体所在事件、源/目标进程文件 ip dns、时间、agent。
    用于在汇总后人工查看命中上下文的证据样例。
    """
    sel = [
        "insertTime", "agentId", "eventTelemetryEventName",
        "sourceName", "sourceDisplayName", "sourcePath",
        "sourceFileHashMd5", "sourceHashMd5",
        "sourceDestinationIp", "sourceDnsQueryName", "sourceMotwHostUrl",
        "targetName", "targetDisplayName", "targetPath",
        "targetFileHashMd5", "targetHashMd5",
        "targetDestinationIp", "targetDnsQueryName",
    ]
    sel = ", ".join(sel)
    cond = build_match_cond(etype, value)
    parts = [f"tenant='{tenant}'", f"insertTime>NOW()-INTERVAL {days} DAY", cond]
    if agent_filter:
        parts.append(f"agentId='{agent_filter}'")
    if evt_filter:
        evts = ",".join(f"'{e}'" for e in evt_filter.split(","))
        parts.append(f"eventTelemetryEventName IN ({evts})")
    where = " AND ".join(parts)
    q = f"SELECT {sel} FROM {TABLE} WHERE {where} ORDER BY insertTime DESC LIMIT {limit}"
    try:
        rows, ct = cli.execute(q, with_column_types=True)
        cols = [c[0] for c in ct]
        return [dict(zip(cols, r)) for r in rows]
    except Exception as e:
        sys.stderr.write(f"[detail] ERR: {str(e)[:300]}\n")
        return []


def detect_entity_type(value):
    """自动识别实体类型(未指定时)。md5=32位hex → hash; 含字母的点域 → domain; 否则若像ip → ip。"""
    v = value.strip().lower()
    if len(v) == 32 and all(ch in "0123456789abcdef" for ch in v):
        return "hash"
    # sha256/1
    if len(v) in (40, 64) and all(ch in "0123456789abcdef" for ch in v):
        return "hash"
    # ipv4
    parts = v.split(".")
    if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return "ip"
    # contain letters/dot → domain
    return "domain"


def hline(title):
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def main():
    ap = argparse.ArgumentParser(description="全网排查：按 domain/hash/ip 实体回溯某客户全网遥测日志")
    ap.add_argument("value", help="实体值：域名 / hash(md5|sha1|sha256) / IP")
    ap.add_argument("--type", choices=["hash", "domain", "ip", "auto"], default="auto",
                    help="实体类型（默认 auto 推断）")
    ap.add_argument("--tenant", default=DEFAULT_TENANT, help="客户 tenantId（gptrawlog 里 tenantId，必给/或 env HUNT_TENANT）")
    ap.add_argument("--days", type=int, default=7, help="回溯时间窗(天)，默认7，可到30")
    ap.add_argument("--mode", choices=["summary", "byagent", "detail", "all"], default="all",
                    help="query 粒度：summary=仅命中汇总; byagent=按主机; detail=明细样例; all=依次")
    ap.add_argument("--agent", default=None, help="当 mode=detail/byagent 聚焦某 agentId")
    ap.add_argument("--events", default=None, help="detail 过滤事件名，逗号分隔，如 ProcessCreate,NetworkConnect")
    ap.add_argument("--limit", type=int, default=100, help="byagent/detail 每段条数上限")
    args = ap.parse_args()

    if not args.tenant:
        sys.stderr.write("[错误] 必须给 --tenant（该客户 tenantId）或设 env HUNT_TENANT\n")
        sys.exit(1)
    etype = args.type if args.type != "auto" else detect_entity_type(args.value)
    print(f"实体类型识别: {etype} | 值: {args.value} | tenant: {args.tenant} | 时间窗: {args.days} 天")
    cli = connect()

    # 汇总命中数恒先算，供后续 mode 决定是否继续（0 命中则告一段落）
    c = None; agents = None
    if args.mode in ("summary", "byagent", "detail", "all"):
        c, agents = find_fast_hits(cli, etype, args.value, args.tenant, args.days)

    if args.mode in ("summary", "all"):
        hline(f"[1/汇总] 全网命中统计（tenant={args.tenant}, {args.days}天）")
        if c is None:
            print("查询失败(见stderr)")
        elif c == 0:
            print(f"✅ 全网无其它命中：实体 '{args.value}' 近 {args.days} 天在该客户日志中 0 条。"
                  f"（单机事件未见扩散）")
        else:
            print(f"⚠️ 全网命中 {c} 条遥测日志，涉及 {agents} 台主机（agentId 去重）。"
                  f"单机事件在该客户网内存在扩散面，需进一步按主机归类。")

    if args.mode in ("byagent", "all") and c:
        hline(f"[2/按主机] 受影响 agentId 明细（前{args.limit}台，按命中数降序）")
        rows = breakdown_by_agent(cli, etype, args.value, args.tenant, args.days, args.limit)
        if not rows:
            print("(无)")
        else:
            for agent, hits, kinds, last in rows:
                print(f"  agent={agent:<40} hits={hits:<6} 事件种类={kinds:<4} 末次={last}")

    if args.mode in ("detail", "all") and c:
        hline(f"[3/明细样例] 代表性命中上下文（limit {min(args.limit,50)} 条）")
        rows = detail_events(cli, etype, args.value, args.tenant, args.days,
                             args.agent, args.events, min(args.limit, 50))
        if not rows:
            print("(无明细或出错)")
        for i, r in enumerate(rows[:min(args.limit, 50)], 1):
            print(f"  [{i}] {r.get('insertTime')} | evt={r.get('eventTelemetryEventName')} | agent={r.get('agentId')}")
            s = r.get("sourceDisplayName") or r.get("sourceName")
            t = r.get("targetDisplayName") or r.get("targetName")
            sdst = r.get("sourceDestinationIp") or r.get("targetDestinationIp")
            sdns = r.get("sourceDnsQueryName") or r.get("targetDnsQueryName")
            mdl = r.get("sourceFileHashMd5") or r.get("targetFileHashMd5") or r.get("sourceHashMd5") or r.get("targetHashMd5")
            print(f"       src={s!r} tgt={t!r}")
            if mdl:   print(f"       hash={mdl}")
            if sdst:  print(f"       netIP={sdst}")
            if sdns:  print(f"       dns={sdns}")

    cli.disconnect()


if __name__ == "__main__":
    main()
