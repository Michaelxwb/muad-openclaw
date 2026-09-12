# -*- coding: utf-8 -*-
"""
ioc-log-hunting — TCP 表恶意IP反查模块(IP -> dstIp)

语义：给定一个或多个**恶意IP**，在 SOAR 检索中心 TCP 表(100) 近3天日志里，
匹配 **dstIp 等于该恶意IP** 的所有会话，把"访问过/命中过该恶意IP"的客户主机
(即这些会话的 srcIp) 按恶意IP归类(去重)，输出每台命中数 + 最早/最晚 recordTimestamp，
并反查资产表标注 资产组 + 业务；资产表无此 IP 记为服务外资产。

与 DNS(URL->queries) 的对应关系：
  DNS: 恶意域名命中 `queries`,受影响主机 = 该行 srcIp;
  TCP: 恶意IP   命中 `dstIp` ,受影响主机 = 该行 srcIp。
按用户约定：恶意IP 只匹配 dstIp(外部外联目标/C2)，不做 srcIp 方向检索。

支持整批恶意IP(多个) → 一条 `filter dstIp="a" OR dstIp="b" ...` 精确检索；
按命中 dstIp 把 srcIp 主机重新归组展示；同台主机命中多个恶意IP → 出现在每个IP组下；
无任何命中的输入IP → 单列示警。
```

用法(muad 环境, 登录态由 session-manager 注入):
    python3 tcp_ip_hunt.py --company-id <ID> --ip "1.2.3.4"
    python3 tcp_ip_hunt.py --company-id <ID> --ip "1.2.3.4 5.6.7.8,9.10.11.12"   # 整批精确 OR
    python3 tcp_ip_hunt.py --company-id <ID> --ip "1.2.3.4" --exclude-ip "10.0.0.5"
"""
import argparse
import json
import os
import sys
import time
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import shared  # noqa: E402
from shared import get_cookie, get_endpoint, build_headers, http_json  # noqa: E402

TABLE_TCP = [100]

ASSET_TYPE_CN = {  # 资产类型显示映射
    "server": "服务器",
    "endpoint": "终端",
}
BIT_LEVEL_CN = {  # 业务等级显示映射(L1核心/L2重要/L3一般)
    1: "核心", 2: "重要", 3: "一般",
    "1": "核心", "2": "重要", "3": "一般",
}

TOP_SHOW = 20  # 对话侧每组最多展示的主机数；其余完整明细写 Excel
HIT_FIELD = "dstIp"     # 恶意IP命中字段：dstIp（外部外联目标）
HOST_FIELD = "srcIp"    # 受影响主机字段：srcIp（会话发起的内网主机）
TIME_FIELD = "recordTimestamp"


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


def _split_list(raw: str) -> list:
    """切分输入为去重、去空、剥引号的列表（空格/逗号/分号/回车分隔）。"""
    seen, out = set(), []
    for token in str(raw or "").replace(";", " ").replace(",", " ").split():
        v = token.strip().strip('"')
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def build_search_string(ips: list) -> str:
    """多个恶意IP => filter dstIp="a" OR dstIp="b" ...（精确并集）。"""
    return " OR ".join('%s="%s"' % (HIT_FIELD, ip) for ip in ips)


def ck_count(customer, ss, fr, to):
    p = {"fromDate": fr, "toDate": to, "tableId": TABLE_TCP, "searchString": ss,
         "constrains": _constrain_customer(customer), "quickSearch": {}, "datalakeClusterName": ""}
    d = _post("ck_count", p)
    return int(((d.get("data") or {}).get("total")) or 0)


def fetch_rows(customer, ss, fr, to, fetch, page_size, fields):
    rows_acc, pg = [], 0
    while len(rows_acc) < fetch:
        p = {"fromDate": fr, "toDate": to, "tableId": TABLE_TCP, "searchString": ss,
             "fieldList": fields, "pageNo": pg, "pageSize": page_size,
             "order": {TIME_FIELD: "desc"},
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


def _write_xlsx(customer, label, rows_groups, ips):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    if not rows_groups:
        return ""
    out_dir = shared._output_root()
    ts = time.strftime("%Y%m%d_%H%M%S", time.localtime())
    fpath = os.path.join(out_dir, f"tcp-ioc-hunt_{customer}_{ts}.xlsx")
    wb = Workbook()
    ws = wb.active
    ws.title = "命中主机明细"
    ws.append(["恶意IP(dstIp)", "主机IP(srcIp)", "主机名", "资产组", "业务", "业务等级", "资产类型", "命中数", "最早时间", "最晚时间", "备注"])
    hf = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="C00000")
    for c in ws[1]:
        c.font = hf
        c.fill = fill
        c.alignment = Alignment(horizontal="center")
    for (ipd, src, host, ag, biz, level, atype, n, mn, mx) in rows_groups:
        note = "服务外资产" if ag == "-" and not len(rows_groups) else ""
        ws.append([ipd, src, host, ag, biz, level, atype, n, mn, mx, note])
    ws.freeze_panes = "A2"
    for i, w in enumerate([18, 18, 22, 20, 22, 10, 10, 10, 21, 21, 14], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    wb.save(fpath)
    return fpath


def tcp_ip_hunt(customer, raw_ips, exclude_ips=""):
    dft = _load_defaults()
    days = dft.get("search_days", 3)
    cap = dft.get("host_cap_warn", 10000)
    page_size = dft.get("page_size", 300)

    ips = _split_list(raw_ips)
    excluded = set(_split_list(exclude_ips))
    if not ips:
        raise ValueError("--ip 必须给出至少一个恶意 IP")

    ss = "filter " + build_search_string(ips)
    now = time.time()
    to = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    fr = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - days * 86400))

    label_ips = " ".join(ips) if len(ips) > 1 else ips[0]
    print(f"[TCP] 客户={customer}  恶意IP={label_ips}  命中字段={HIT_FIELD}(dstIp)  受影响主机={HOST_FIELD}(srcIp)  窗口近{days}天 {fr} ~ {to}", flush=True)
    print(f"[filter] {ss}", flush=True)
    total = ck_count(customer, ss, fr, to)
    print(f"[ckCount] 会话日志总数 = {total}", flush=True)

    warn = total > cap
    if warn:
        print(f"!! 命中 {total} 条 > {cap}: 访问量过大,请复核; 翻取前 {cap} 条", flush=True)
    fetch = cap if warn else total

    fields = ["recordTimestamp", "srcIp", "dstIp"]
    rows = fetch_rows(customer, ss, fr, to, max(fetch, 1), page_size, fields)

    if excluded:
        before = len(rows)
        rows = [r for r in rows if (r.get("srcIp") or "") not in excluded]
        print(f"--exclude-ip 排除 {len(excluded)} 个IP: 过滤 {before - len(rows)} 条日志", flush=True)

    def _agg(hosts, r):
        ip = r.get(HOST_FIELD)
        rt = str(r.get(TIME_FIELD) or "")
        if not ip:
            return
        b = hosts[ip]
        b["n"] += 1
        # recordTimestamp 用字符串比较（秒级整数字符串也按字典序成立）
        if rt:
            if b["mn"] == "9" or rt < b["mn"]:
                b["mn"] = rt
            if b["mx"] == "0" or rt > b["mx"]:
                b["mx"] = rt

    # 按命中 dstIp 归类 srcIp
    group_by_ip = {}
    for ip in ips:
        group_by_ip[ip] = defaultdict(lambda: {"n": 0, "mn": "9", "mx": "0"})
    for r in rows:
        hit = r.get(HIT_FIELD) or ""
        if hit in group_by_ip:
            _agg(group_by_ip[hit], r)

    # 全量(资产+整体去重)
    all_hosts = defaultdict(lambda: {"n": 0, "mn": "9", "mx": "0"})
    for r in rows:
        _agg(all_hosts, r)

    # 资产反查（增强：主机名/业务/业务等级/资产类型/资产组；资产表无记录标记为外部服务忽略项 None）
    def _asset_line(ip):
        """返回该 ip 的资产富信息 dict；资产表无此IP则返回 {"out": True}。"""
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

    try:
        from shared import get_asset_info
        cookie = get_cookie("mssp")
    except Exception:
        get_asset_info = None
        cookie = None
    ip_asset = {}
    for ip in all_hosts:
        _asset_line(ip)

    def _disp(a):
        return not a.get("out", False)

    def _line(src, st, a):
        mn = st["mn"] if st["mn"] != "9" else "-"
        mx = st["mx"] if st["mx"] != "0" else "-"
        if _disp(a):
            host, bp = a["host"], a["biz"]
            host_pad = f"{host:<20}"[:20]
            return f"  {src:<16} 主机={host_pad} 资产组={a['ag']:<6} 业务={bp:<12} 等级={a['level']:<4} 类型={a['atype']:<10} 命中{st['n']:>6}  最早 {mn}  最晚 {mx}"
        return f"  {src:<16} 服务外资产    命中{st['n']:>6}  最早 {mn}  最晚 {mx}"

    excel_rows = []
    for hit_ip in ips:
        hosts = group_by_ip[hit_ip]
        for src, st in sorted(hosts.items(), key=lambda x: -x[1]["n"]):
            a = _asset_line(src)
            ag = a["ag"]
            mn = st["mn"] if st["mn"] != "9" else "-"
            mx = st["mx"] if st["mx"] != "0" else "-"
            excel_rows.append((hit_ip, src, a["host"], ag, a["biz"], a["level"], a["atype"], st["n"], mn, mx))

    print(f"\n== 近{days}天 命中恶意IP(dstIp) 的客户主机(srcIp) (翻取{len(rows)}条/去重{len(all_hosts)}台) ==", flush=True)
    for hit_ip in ips:
        hosts = group_by_ip[hit_ip]
        if not hosts:
            print(f"\n[命中IP] {hit_ip}  近{days}天无命中 srcIp 主机", flush=True)
            continue
        order = sorted(hosts.items(), key=lambda x: -x[1]["n"])
        if len(order) <= TOP_SHOW:
            head, hid = order, 0
        else:
            head, hid = order[:TOP_SHOW], len(order) - TOP_SHOW
        print(f"\n[命中IP] {hit_ip}  (去重 {len(hosts)} 台)", flush=True)
        for src, st in head:
            print(_line(src, st, _asset_line(src)), flush=True)
        if hid:
            print(f"  ... 其余 {hid} 台见 Excel", flush=True)

    if len(all_hosts) > TOP_SHOW:
        xlsx = _write_xlsx(customer, "TCP-IP", excel_rows, ips)
        if xlsx:
            print(f"\n[Excel] 完整明细已导出: {xlsx}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--company-id", required=True, help="客户数字ID")
    ap.add_argument("--ip", required=True, help="恶意IP(命中dstIp),可多个(空格/逗号/分号分隔)")
    ap.add_argument("--exclude-ip", default="", help="要排除的 srcIp,可多个(空格/逗号/分号)")
    args = ap.parse_args()
    tcp_ip_hunt(args.company_id, args.ip, args.exclude_ip)


if __name__ == "__main__":
    main()
