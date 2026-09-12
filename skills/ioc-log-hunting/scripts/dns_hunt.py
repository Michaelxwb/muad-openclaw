# -*- coding: utf-8 -*-
"""
ioc-log-hunting — DNS 表恶意URL反查模块（标准骨架版）

依据 探明结论/DNS表探明：恶意 URL -> DNS(20) queries -> 近3天
该客户哪些 srcIp 主机解析过它(命中数 + 最早/最晚时间)。

支持两种匹配模式(由 --mode 指定，仅单域名):
  exact(默认): filter queries="<完整URL/域名>"    精准匹配整个查询域名
  fuzzy:       filter queries LIKE "%<子串关键词>%"  子串模糊，摸排一批相关子域名/旁路

支持整批域名(多个)切分为有序域名单；每条日志带回 queries 字段，按命中域名重新归组展示：
  - 单个域名按所选 mode；
  - 多个域名合并成一条精确 OR 检索(不逐个查、一次接口归并) — 但翻回日志同时取 queries 列，
    依据每行的 query 值归属到对应输入域名，实现“该主机到底匹配了哪个域名”的分组展示；
  - 同一台主机同时命中多个域名 → 出现在每个命中域名的组下；
  - 无任何命中的输入域名 → 单独单列示警。
  (不依赖 IN：IN 实测恒 0 不可用；用精确子句 OR。)

语句可用性实测(log-search v探明 2026-09):
  IN(...)=总返回0(不可用)；`="a","b"`=0(不可用)；OR(精确子句连结)=可用且并集语义正确；
  AND=可用；单条精确/=与 LIKE 可用。批量查询用 OR，不用 IN。

用法(muad 环境, 登录态由 session-manager 注入):
    python3 dns_hunt.py --company-id 97988530 --url "<完整URL/域名>"              # 单条精确(默认)
    python3 dns_hunt.py --company-id 97988530 --url "<子串关键词>" --mode fuzzy  # 单条模糊子串
    python3 dns_hunt.py --company-id 97988530 --url "a.com b.com,c.com"          # 整批⇒自动OR精确
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import shared  # 本 skill 内置 shared.py: get_cookie/build_headers/get_endpoint/http_json

from shared import get_cookie, get_endpoint, build_headers, http_json

TABLE_DNS = [20]

ASSET_TYPE_CN = {  # 资产类型显示映射
    "server": "服务器",
    "endpoint": "终端",
}
BIT_LEVEL_CN = {  # 业务等级显示映射(L1核心/L2重要/L3一般)
    1: "核心", 2: "重要", 3: "一般",
    "1": "核心", "2": "重要", "3": "一般",
}

MODE_EXACT = "exact"
MODE_FUZZY = "fuzzy"

TOP_SHOW = 20  # 对话侧每组最多展示的主机数(TOP N)，其余完整明细写进 Excel


def _load_defaults():
    cfg_path = os.path.join(_HERE, "..", "config", "api_config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f).get("defaults", {})


def _post(endpoint_key: str, payload: dict, timeout: int = 200) -> dict:
    cookie = get_cookie("mssp")
    url = get_endpoint(endpoint_key, "mssp")
    headers = build_headers(cookie, "mssp")
    resp = http_json("POST", url, headers, payload=payload, timeout=timeout)
    return resp.json()


def _constrain_customer(customer: str) -> list:
    return [{"fieldAlias": "客户", "fieldName": "customer", "fieldOperater": "=", "fieldValue": str(customer)}]


def _split_input(raw: str):
    """把 --url 原始输入切分成多个精确域名(去重、去空、剥离引号)。
    支持空格 / 逗号 / 分号 / 回车 分隔，兼容单值。
    """
    seen, out = set(), []
    for token in str(raw or "").replace(";", " ").replace(",", " ").split():
        v = token.strip().strip('"')
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def _split_ips(raw: str) -> set:
    """把 --exclude-ip 原始输入切分成去重的 IP 集合(去空、剥离引号)。
    支持空格 / 逗号 / 分号 / 回车 分隔，兼容单值；空输入返回空集。
    """
    out = set()
    for token in str(raw or "").replace(";", " ").replace(",", " ").split():
        v = token.strip().strip('"')
        if v:
            out.add(v)
    return out


def build_multi_search_string(domains: list) -> str:
    """多个域名 => 一条精确 OR 检索串: filter queries="a" OR queries="b" ..."""
    return " OR ".join('queries="%s"' % d for d in domains)


def build_search_string(value: str, mode: str) -> str:
    """按匹配模式构造单域名 filter 检索串。

    exact: filter queries="<完整域名>"            精准匹配整个查询
    fuzzy: filter queries LIKE "%<子串关键词>%"      子串模糊(摸排相关子域名/旁路)
    """
    value = str(value or "").strip().strip('"')
    if not value:
        raise ValueError("必须提供非空的 URL/域名(精确) 或 子串关键词(模糊)")
    if mode == MODE_EXACT:
        return 'filter queries="%s"' % value
    if mode == MODE_FUZZY:
        # 关键词移除用户自带的 %(将 % 去掉), 外层统一用 %..% 包裹一次;
        # LIKE 专用以避开 CONTAINS/`*` 通配等不可用算子。
        kw = value.replace("%", "")
        if not kw:
            raise ValueError("模糊匹配关键词不能为空(去掉 %% 后为空)")
        return 'filter queries LIKE "%%%s%%"' % kw
    raise ValueError("未知 mode=%r (可选 %s|%s)" % (mode, MODE_EXACT, MODE_FUZZY))


def ck_count(table: list, customer: str, ss: str, fr: str, to: str) -> int:
    p = {"fromDate": fr, "toDate": to, "tableId": table, "searchString": ss,
         "constrains": _constrain_customer(customer), "quickSearch": {}, "datalakeClusterName": ""}
    d = _post("ck_count", p)
    return int(((d.get("data") or {}).get("total")) or 0)


def fetch_rows(table: list, customer: str, ss: str, fr: str, to: str,
               fetch: int, page_size: int, fields: list, order_field: str = "recordTime"):
    rows_acc, pg = [], 0
    while len(rows_acc) < fetch:
        p = {"fromDate": fr, "toDate": to, "tableId": table, "searchString": ss,
             "fieldList": fields, "pageNo": pg, "pageSize": page_size,
             "order": {order_field: "desc"},
             "constrains": _constrain_customer(customer),
             "quickSearch": {}, "datalakeClusterName": ""}
        d = _post("ck_query_list", p)
        rows = ((d.get("data") or {}).get("condiResults") or [])
        if not rows:
            break
        rows_acc += rows
        pg += 1
        if pg >= 200:
            break
    return rows_acc


def _write_xlsx(customer: str, label: str, rows, domains):
    """把完整明细写成 .xlsx(仅用标准库 + 已装 openpyxl)，返回路径；失败返回空串。
    rows: [(域名/组, ip, (资产组,业务), 命中数, 最早, 最晚)]
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except Exception as e:
        print(f"!! Excel 导出不可用(缺 openpyxl): {e}", flush=True)
        return ""
    try:
        out_dir = shared._output_root()
    except Exception:
        import tempfile
        out_dir = tempfile.gettempdir()
    if not rows:
        return ""
    ts = time.strftime("%Y%m%d_%H%M%S", time.localtime())
    fname = f"ioc-hunt_{customer}_{ts}.xlsx"
    fpath = os.path.join(out_dir, fname)

    wb = Workbook()
    ws = wb.active
    ws.title = "命中主机明细"
    headers = ["恶意域名/组", "主机IP", "主机名", "资产组", "业务", "业务等级", "资产类型", "命中数", "最早时间", "最晚时间", "备注"]
    ws.append(headers)
    hf = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="4472C4")
    for c in ws[1]:
        c.font = hf
        c.fill = fill
        c.alignment = Alignment(horizontal="center")
    for (dname, ip, host, ag, biz, level, atype, n, mn, mx) in rows:
        note = "服务外资产" if ag == "-" else ""
        ws.append([dname, ip, host, ag, biz, level, atype, n, mn, mx, note])
    # 冻结表头 + 列宽
    ws.freeze_panes = "A2"
    widths = [40, 18, 22, 20, 22, 12, 12, 10, 21, 21, 14]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    wb.save(fpath)
    return fpath


def dns_hunt(customer: str, raw: str, mode: str = MODE_EXACT, exclude_ips: str = ""):
    dft = _load_defaults()
    days = dft.get("search_days", 3)
    cap = dft.get("host_cap_warn", 10000)
    page_size = dft.get("page_size", 300)

    # 排除 IP 集合：命中里出现这些 srcIp 一律过滤掉，视为无命中
    excluded = _split_ips(exclude_ips)

    # 切分域名去重
    domains = _split_input(raw)
    if not domains:
        raise ValueError("--url 必须给出至少一个域名")

    # 单域名 → 按所选 mode(exact/fuzzy)；多域名 → 自动精确 OR
    batch = len(domains) > 1
    if batch:
        ss = "filter " + build_multi_search_string(domains)
        content = "%d 个域名" % len(domains)
    else:
        ss = build_search_string(domains[0], mode)
        content = domains[0]

    now = time.time()
    to = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    fr = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - days * 86400))

    label = "批量 OR 精确" if batch else ("精确" if mode == MODE_EXACT else "模糊(LIKE 子串)")
    print(f"[DNS] 客户={customer}  内容={content}  匹配={label}  窗口近{days}天 {fr} ~ {to}", flush=True)
    if batch:
        print(f"[域名] " + " ".join(domains), flush=True)
    print(f"[filter] {ss}", flush=True)
    total = ck_count(TABLE_DNS, customer, ss, fr, to)
    print(f"[ckCount] 该内容匹配日志总数 = {total}", flush=True)

    warn = total > cap
    if warn:
        print(f"!! 命中 {total} 条 > {cap}: 访问量过大，该内容可能并非真恶意，请复核。翻取前 {cap} 条做主机去重。", flush=True)
    fetch = cap if warn else total

    # 翻回 srcIp / recordTime / queries —— queries 供多域名分组归属
    rows = fetch_rows(TABLE_DNS, customer, ss, fr, to, max(fetch, 1), page_size,
                      ["recordTime", "srcIp", "queries"])

    # 排除指定 srcIp：命中里带这些 IP 直接过滤，视为无命中
    if excluded:
        before = len(rows)
        rows = [r for r in rows if (r.get("srcIp") or "") not in excluded]
        print(f"--exclude-ip 排除 {len(excluded)} 个IP: 过滤掉 {before - len(rows)} 条日志(命中IP被排除视为无命中)", flush=True)

    def _agg(hosts, r):
        ip = r.get("srcIp")
        rt = r.get("recordTime") or ""
        if not ip:
            return
        b = hosts[ip]
        b["n"] += 1
        if rt:
            if b["mn"] == "9" or rt < b["mn"]:
                b["mn"] = rt
            if b["mx"] == "0" or rt > b["mx"]:
                b["mx"] = rt

    # 分组容器：批次多域名→每域名一组；单域名→整组(None 键)
    group_by_dom = {}
    if batch:
        for d in domains:
            group_by_dom[d] = defaultdict(lambda: {"n": 0, "mn": "9", "mx": "0"})
    else:
        group_by_dom[None] = defaultdict(lambda: {"n": 0, "mn": "9", "mx": "0"})

    for r in rows:
        q = (r.get("queries") or "").strip()
        if batch:
            key = q if q in group_by_dom else None
            if key is not None:
                _agg(group_by_dom[key], r)
        else:
            _agg(group_by_dom[None], r)

    # 全集(用于资产反查与整体去重统计)
    all_hosts = defaultdict(lambda: {"n": 0, "mn": "9", "mx": "0"})
    for r in rows:
        _agg(all_hosts, r)

    # 逐个 srcIp 反查资产表：标注 主机名/业务/业务等级/资产类型/资产组；空显示 -；资产表完全无此IP记为服务外
    try:
        from shared import get_asset_info
        cookie = get_cookie("mssp")
    except Exception:
        get_asset_info = None
        cookie = None

    def _asset_line(ip):
        """返回该 ip 的资产富信息 dict；资产表无此IP则 out=True。"""
        if ip in ip_asset:
            return ip_asset[ip]
        out = {"out": False, "host": "-", "biz": "-", "level": "-", "atype": "-", "ag": "-"}
        if get_asset_info:
            try:
                info = get_asset_info(cookie, ip, customer)
                if info:
                    out["host"] = (str(info.get("hostname") or "").strip() or str(info.get("device_name") or "").strip()) or "-"
                    out["biz"] = (str(info.get("business_name") or "").strip()) or "-"
                    lv = info.get("business_level")
                    out["level"] = BIT_LEVEL_CN.get(lv, BIT_LEVEL_CN.get(str(lv or ""), "-"))
                    at = (str(info.get("asset_type") or "").strip())
                    out["atype"] = ASSET_TYPE_CN.get(at, at or "-")
                    out["ag"] = (str(info.get("asset_group_name") or "").strip()) or "-"
                else:
                    out["out"] = True
            except Exception:
                out["out"] = True
        else:
            out["out"] = True
        ip_asset[ip] = out
        return out

    ip_asset = {}
    for ip in all_hosts:
        _asset_line(ip)

    def _disp(a):
        return not a.get("out", False)

    # ---- 收集全量结构化明细(供 Excel)，与展示同维度 ----
    def _line(ip, st, a):
        mn = st["mn"] if st["mn"] != "9" else "-"
        mx = st["mx"] if st["mx"] != "0" else "-"
        if _disp(a):
            host = f"{a['host']:<18}"[:18]
            return f"  {ip:<16} 主机={host} 资产组={a['ag']:<6} 业务={a['biz']:<12} 等级={a['level']:<4} 类型={a['atype']:<10} 命中{st['n']:>6}  最早 {mn}  最晚 {mx}"
        return f"  {ip:<16} 服务外资产    命中{st['n']:>6}  最早 {mn}  最晚 {mx}"

    if batch:
        groups = [(d, group_by_dom[d]) for d in domains if group_by_dom[d]]
    else:
        groups = [("单条", group_by_dom[None])]

    excel_rows = []
    for dname, hosts in groups:
        for ip, st in sorted(hosts.items(), key=lambda x: -x[1]["n"]):
            a = _asset_line(ip)
            mn = st["mn"] if st["mn"] != "9" else "-"
            mx = st["mx"] if st["mx"] != "0" else "-"
            excel_rows.append((dname, ip, a["host"], a["ag"], a["biz"], a["level"], a["atype"], st["n"], mn, mx))

    # 对话侧仅打印每组 Top TOP_SHOW，其余指向 Excel；Excel 保留全量
    print(f"\n== 近{days}天{label}与内容交互过的客户主机 (实际翻取{len(rows)}条/去重{len(all_hosts)}台) ==", flush=True)
    if batch:
        for d in domains:
            hosts = group_by_dom[d]
            if not hosts:
                continue
            order = sorted(hosts.items(), key=lambda x: -x[1]["n"])
            if len(order) <= TOP_SHOW:
                head = order
                hid = 0
            else:
                head, hid = order[:TOP_SHOW], len(order) - TOP_SHOW
            print(f"\n[命中域名] {d}  (去重 {len(hosts)} 台, 另附 Excel 全量明细)", flush=True)
            for ip, st in head:
                print(_line(ip, st, _asset_line(ip)), flush=True)
            if hid:
                print(f"  ... 其余 {hid} 台见 Excel", flush=True)
        nohit = [d for d in domains if not group_by_dom[d]]
        if nohit:
            print("\n[无命中域名] " + ", ".join(nohit), flush=True)
    else:
        hosts = group_by_dom[None]
        if not hosts:
            print("  无命中。", flush=True)
        else:
            order = sorted(hosts.items(), key=lambda x: -x[1]["n"])
            if len(order) <= TOP_SHOW:
                head, hid = order, 0
            else:
                head, hid = order[:TOP_SHOW], len(order) - TOP_SHOW
            for ip, st in head:
                print(_line(ip, st, _asset_line(ip)), flush=True)
            if hid:
                print(f"  ... 其余 {hid} 台见 Excel", flush=True)

    xlsx = ""
    if len(all_hosts) > TOP_SHOW:
        # 仅当去重命中 srcIp >20 时才导出 Excel（≤20 直接对话全量给结论，不生成）
        xlsx = _write_xlsx(customer, label, excel_rows, domains if batch else [domains[0]])
        if xlsx:
            print(f"\n[Excel] 完整明细已导出: {xlsx}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--company-id", required=True, help="客户数字ID")
    ap.add_argument("--url", required=True,
                    help="域名输入：单个=exact完整URL或fuzzy子串关键词(配合--mode)；多个(空格/逗号/分号/换行分隔)=自动OR精确整批 查询")
    ap.add_argument("--mode", default=MODE_EXACT, choices=[MODE_EXACT, MODE_FUZZY],
                    help="仅单域名时生效: exact=精确(默认) / fuzzy=LIKE子串模糊。多域名自动精确OR，忽略本参数。")
    ap.add_argument("--exclude-ip", default="",
                    help="要排除的主机IP，可多个(空格/逗号/分号分隔)。命中结果里带这些srcIp一律过滤，视为无命中。")
    args = ap.parse_args()
    dns_hunt(args.company_id, args.url, args.mode, args.exclude_ip)


if __name__ == "__main__":
    main()
