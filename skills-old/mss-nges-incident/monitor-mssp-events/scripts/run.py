# -*- coding: utf-8 -*-
"""
monitor-mssp-events 主脚本。

流程：
1. 拉取用户明确指定的**时间范围**内、状态为【未处置/处置中/定期跟进】的 MSSP 事件表。
   时间范围二选一：指定起止（--start/--end）或最近 N 小时（--hours）。
2. 不做事件去重：范围内查到多少事件就展示多少。
3. 对每个事件：取 event_id，查 alarm_list 告警标题（含"通过xxx"的）用于分类；
   从事件表返回值提取 IOC（ioc_grouped/ioc_value），精简分段展示。
4. 汇总资产信息 + 终端GPT判定，输出到 stdout。

用法：
  # 指定起止时间（YYYY-MM-DD HH:MM，或毫秒时间戳）
  python3 scripts/run.py --company-id <数字 company_id> --start "2026-09-04 10:00" --end "2026-09-08 10:00"
  # 最近 N 小时
  python3 scripts/run.py --company-id <数字 company_id> --hours 96
"""

import argparse
import calendar
import datetime
import json
import sys
import time
import unicodedata

import shared

# 资产类型编码 -> 中文
ASSET_TYPE_MAP = {1: "终端", 2: "服务器"}
BUSINESS_LEVEL_MAP = {1: "核心", 2: "重要", 3: "一般"}

# 只查询以下处置状态的事件：inited=未处置 / disposal=处置中 / suspend=定期跟进
QUERY_EVENT_STATUS = ["inited", "disposal", "suspend"]

# 处置状态枚举 -> 中文（展示用，使用者可直接读懂的值）
EVENT_STATUS_CN = {
    "inited": "未处置",
    "disposal": "处置中",
    "suspend": "定期跟进",
}

# IOC 分段展示的中文名与顺序（对应 ioc_grouped 的键）
IOC_SECTIONS = ["url", "ip", "domain", "md5", "sha256", "sha1"]
IOC_SECTION_CN = {
    "url": "URL",
    "ip": "IP",
    "domain": "域名",
    "md5": "MD5",
    "sha256": "SHA256",
    "sha1": "SHA1",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def positive_hours(value: str) -> int:
    """解析正整数小时数（最近 N 小时），拒绝空值、零和负数。"""
    try:
        hours = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("最近小时数必须是正整数") from exc
    if hours <= 0:
        raise argparse.ArgumentTypeError("最近小时数必须大于 0 小时")
    return hours


def parse_dt_ms(value: str) -> int:
    """把时间入参解析为毫秒时间戳。支持两种格式：
    - 纯数字：视为毫秒时间戳直接返回
    - 'YYYY-MM-DD HH:MM[:SS]'：按东八区解析
    """
    text = str(value or "").strip()
    if not text:
        raise argparse.ArgumentTypeError("不能为空时间")
    if text.isdigit():
        return int(text)
    fmt = "%Y-%m-%d %H:%M:%S" if len(text) >= 19 else "%Y-%m-%d %H:%M"
    try:
        dt = datetime.datetime.strptime(text, fmt)
    except ValueError as exc:
        allowed = "YYYY-MM-DD HH:MM 或 YYYY-MM-DD HH:MM:SS 或毫秒时间戳"
        raise argparse.ArgumentTypeError(f"时间格式无法识别，支持: {allowed}") from exc
    # 按东八区（无时区偏移）解释为 UTC 毫秒
    return int(calendar.timegm(dt.timetuple()) * 1000)


def company_id_value(value: str) -> str:
    """解析平台 company_id，只接受非空数字 ID。"""
    company_id = str(value or "").strip()
    if not company_id or not company_id.isdigit():
        raise argparse.ArgumentTypeError("company_id 必须是平台返回的数字 ID")
    return company_id


def fetch_event_table(cookie: str, start_ms: int, end_ms: int, company_ids=None, limit: int = 100):
    """拉取时间段内的事件表。返回事件列表（list）。

    真实响应结构：{"msg":"成功","code":0,"data":{"total":N,"list":[{event_id,event_name,...}]}}
    接口要求**完整查询体**（含 company_id / order / offset / limit / create_time 等），
    仅传 create_time 会返回 code 9064 无效的输入。
    """
    if not company_ids:
        raise ValueError("必须明确指定至少一个客户 company_id")
    if not isinstance(start_ms, int) or not isinstance(end_ms, int) or end_ms <= start_ms:
        raise ValueError("事件查询时间窗口必须是递增的整数毫秒时间戳")
    if not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("事件查询 limit 必须是 1 到 100 的整数")
    url = shared.get_endpoint("event_table")
    headers = shared.build_headers(cookie)
    raw_ids = company_ids if isinstance(company_ids, list) else [company_ids]
    cids = [str(company_id).strip() for company_id in raw_ids]
    if any(not company_id.isdigit() for company_id in cids):
        raise ValueError("事件查询只接受平台返回的数字 company_id")
    payload = {
        "order": {},
        "offset": 0,
        "limit": limit,
        "asset_type": -1,
        "hw_status": -1,
        "protection_type": [],
        "company_id": [str(c) for c in cids],
        "create_time": [start_ms, end_ms],
        "event_name": "",
        "event_id": "",
        "handler_name": "",
        "task_name": "",
        "fuzzy_search": "",
        "event_status": list(QUERY_EVENT_STATUS),
        "host_ip": "",
        "hostname": "",
        "judgment": [],
        "latest_time": [],
        "manage_type": [],
        "more_search": "",
        "my_customer": 0,
        "priority": "all",
        "risk_level": [],
        "screen_tag": "",
        "service_status": [],
        "dst_ip": "",
        "src_ip": "",
        "tag": "",
        "flow_service_level": [],
        "service_group_id_list": [],
        "my_event": 0,
        "expired_customer": 0,
        "is_default": 1,
        "event_grading_tags": [],
    }
    resp = shared.http_json("POST", url, headers, payload=payload)
    try:
        data = resp.json()
    except Exception as e:
        shared.log(f"event_table 响应解析失败: {e}", "ERROR")
        return None
    if not isinstance(data, dict) or data.get("code") != 0:
        shared.log(f"event_table 返回异常: code={data.get('code') if isinstance(data, dict) else '?'} msg={data.get('msg') if isinstance(data, dict) else str(data)[:200]}", "WARNING")
        return None
    body = data.get("data") or {}
    events = body.get("list") if isinstance(body, dict) else None
    return events if isinstance(events, list) else []


def _get(e, *keys, default=""):
    """按多个候选键取字段值，返回字符串。"""
    if not isinstance(e, dict):
        return default
    for k in keys:
        v = e.get(k)
        if v is not None:
            if isinstance(v, (dict, list)):
                v = json_dumps(v)
            return str(v)
    return default


def json_dumps(v) -> str:
    import json
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


def event_status_cn(val) -> str:
    """把处置状态枚举值转换为使用者可读的中文；未知/缺失返回空交由上层显示‘-’。

    inited=未处置 / disposal=处置中 / suspend=定期跟进。
    """
    if val is None:
        return ""
    text = str(val or "").strip()
    return EVENT_STATUS_CN.get(text, "")


def asset_type_cn(val) -> str:
    """把平台返回的数字或英文资产类型转换为中文。"""
    if val is None or val == "":
        return ""
    text = str(val).strip()
    text_map = {"endpoint": "终端", "terminal": "终端", "server": "服务器"}
    if text.lower() in text_map:
        return text_map[text.lower()]
    try:
        n = int(val)
        return ASSET_TYPE_MAP.get(n, str(val))
    except (TypeError, ValueError):
        return str(val)


def business_level_cn(val) -> str:
    """把资产接口返回的业务等级编码转换为中文，未知值视为缺失。"""
    if val is None or val == "":
        return ""
    try:
        return BUSINESS_LEVEL_MAP.get(int(str(val).strip()), "")
    except (TypeError, ValueError):
        return ""


def get_alarm_info(cookie: str, event_id: str):
    """查告警列表。返回 (is_gpt, pass_titles, all_titles)。

    - is_gpt: 是否有任一告警标题含"通过"（终端GPT生成）
    - pass_titles: 所有含"通过"的告警标题列表
    - all_titles: 全部告警标题列表
    真实响应结构：{"data":{"list":[{title,tags,...}]}}
    """
    event_id = str(event_id or "").strip()
    if not event_id:
        raise ValueError("告警查询必须提供非空 event_id")
    url = shared.get_endpoint("alarm_list")
    headers = shared.build_headers(cookie)
    payload = {"order": {"latest_time": "desc"}, "offset": 0, "limit": 10, "event_id": event_id}
    resp = shared.http_json("POST", url, headers, payload=payload)
    try:
        data = resp.json()
    except Exception as e:
        shared.log(f"alarm_list 响应解析失败: {e}", "ERROR")
        return False, [], []
    if not isinstance(data, dict):
        return False, [], []
    body = data.get("data") or {}
    alarms = body.get("list") if isinstance(body, dict) else None
    if not isinstance(alarms, list):
        return False, [], []
    all_titles = []
    pass_titles = []
    for alarm in alarms:
        if isinstance(alarm, dict):
            title = alarm.get("title")
            if isinstance(title, str) and title.strip():
                all_titles.append(title.strip())
                if "通过" in title:
                    pass_titles.append(title.strip())
    return (len(pass_titles) > 0), pass_titles, all_titles


def parse_args(argv=None):
    """解析并强制收集：客户 + 时间范围（指定起止 或 最近小时，二选一）。

    时间范围二选一：
      --start + --end  指定明确起止时间（YYYY-MM-DD HH:MM 或毫秒戳），两者成对出现；
      --hours          最近 N 小时。
    两者不得同时给；两者都未给则报错。
    """
    parser = argparse.ArgumentParser(description="监控指定客户的 MSSP 平台事件")
    parser.add_argument(
        "--start", type=parse_dt_ms, default=None,
        help="可选：查询起始（YYYY-MM-DD HH:MM 或毫秒戳），需与 --end 成对",
    )
    parser.add_argument(
        "--end", type=parse_dt_ms, default=None,
        help="可选：查询结束（YYYY-MM-DD HH:MM 或毫秒戳），需与 --start 成对",
    )
    parser.add_argument(
        "--hours", type=positive_hours, default=None,
        help="可选：查询最近 N 小时",
    )
    parser.add_argument(
        "--company-id", dest="company_ids", action="append",
        type=company_id_value, required=True,
        help="必填：平台返回的数字 company_id，可重复传入多个客户",
    )
    args = parser.parse_args(argv)
    has_range = (args.start is not None) or (args.end is not None)
    if has_range:
        if args.start is None or args.end is None:
            parser.error("--start 与 --end 必须成对提供")
        if args.end <= args.start:
            parser.error("--end 必须晚于 --start")
        args.mode = "range"
        if args.hours is not None:
            parser.error("--hours 与 --start/--end 只能二选一")
    else:
        if args.hours is None:
            parser.error("必须给出时间范围：指定起止(--start/--end) 或 最近小时(--hours)")
        args.mode = "hours"
        args.start = now_ms() - args.hours * 3600 * 1000
        args.end = now_ms()
    return args


def resolve_confirmed_company_ids(cookie: str, company_ids: list) -> dict:
    """按已确认 ID 精确回查平台完整名称，返回 {完整名称: 数字 company_id}。"""
    customers = {}
    for company_id in company_ids:
        candidates = shared.search_customers(cookie, company_id)
        customer = next(
            (candidate for candidate in candidates
             if str(candidate.get("company_id") or "").strip() == company_id),
            None,
        )
        full_name = str((customer or {}).get("company_name") or "").strip()
        if not full_name:
            raise RuntimeError(f"平台未返回 company_id={company_id} 对应的完整客户名称")
        if full_name in customers and customers[full_name] != company_id:
            raise RuntimeError(f"平台返回重复客户名称：{full_name}")
        customers[full_name] = company_id
    return customers


def display_value(value) -> str:
    """统一输出字段：空值使用短横线，其他值转为单行文本。"""
    text = str(value or "").replace("\n", " ").replace("|", "/").strip()
    return text or "-"


def display_width(value: str) -> int:
    """计算代码块中中英文混排文本的大致显示宽度。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in value)


def aligned_field(label: str, value, label_width: int = 24) -> str:
    """生成冒号对齐的单行字段。"""
    padding = " " * max(1, label_width - display_width(label))
    return f"{label}{padding}: {display_value(value)}"


def format_alarm_lines(row: dict, label_width: int = 24) -> list:
    """存在关联告警时逐条输出；没有告警时省略整个字段。"""
    titles = row.get("all_titles") or row.get("pass_titles") or []
    if not titles:
        return []
    label = "关联告警"
    lines = [f"{label}{' ' * max(1, label_width - display_width(label))}:"]
    for title in titles:
        lines.append(" " * (label_width + 2) + f"- {display_value(title)}")
    lines.append(" " * (label_width + 2) + f"共{len(titles)}条关联告警")
    return lines


def _ioc_entries_with_name(grouped) -> list:
    """针对于带 virus_name 的 md5/文件类：逐条生成 '病毒名 : hash' 紧凑展示。
    同时兼容 url/ip/domain（多为纯值）。返回 [(中文分段, entries)]，空段不返回。
    """
    result = []
    for key in IOC_SECTIONS:
        val = grouped.get(key) if isinstance(grouped, dict) else None
        if val is None:
            continue
        items = val if isinstance(val, list) else [val]
        cn = IOC_SECTION_CN.get(key, key)
        seg = []
        for it in items:
            if isinstance(it, dict):
                primary = it.get(key) or it.get("value") or it.get("info")
                text = str(primary or "").strip()
                if not text:
                    continue
                virus = str(it.get("virus_name") or "").strip()
                seg.append(f"{virus} : {text}" if virus else text)
            else:
                text = str(it or "").strip()
                if text:
                    seg.append(text)
        if seg:
            result.append((cn, seg))
    return result


def fmt_ioc_lines(row: dict, label_width: int = 24) -> list:
    """IOC 精简分段展示。只展示有内容的分类，例如：

    IOC                    :
                             [md5] 蠕虫病毒名 : ba22e982...

    优先用 ioc_grouped（结构化带病毒名）；缺 ioc_grouped 时用 ioc_value 兜底（拼接为一段）。
    无任何 IOC 时省略整个字段。
    """
    grouped = row.get("ioc_grouped")
    segments = _ioc_entries_with_name(grouped)
    label = "IOC"
    if not segments:
        # 兜底：直接展示 ioc_value（字符串或列表）
        raw = row.get("ioc_value")
        if raw is None:
            return []
        vals = raw if isinstance(raw, list) else [raw]
        texts = [str(v).strip() for v in vals if str(v or "").strip()]
        if not texts:
            return []
        lines = [f"{label}{' ' * max(1, label_width - display_width(label))}:"]
        for t in texts:
            lines.append(" " * (label_width + 2) + f"- {t}")
        return lines
    lines = [f"{label}{' ' * max(1, label_width - display_width(label))}:"]
    for cn, entries in segments:
        for e in entries:
            lines.append(" " * (label_width + 2) + f"[{cn}] {e}")
    return lines


def adapter_device_names(asset: dict) -> str:
    """从资产 adapter 字段提取设备覆盖名称。"""
    adapter = asset.get("adapter") if isinstance(asset, dict) else None
    if not isinstance(adapter, dict):
        return ""
    names = []
    for product, devices in adapter.items():
        if not isinstance(devices, list):
            continue
        for device in devices:
            name = device.get("dev_name") if isinstance(device, dict) else ""
            names.append(str(name or product))
    return "、".join(dict.fromkeys(names))


def format_chat_output(report: str) -> str:
    """用一个 Markdown 代码块包裹最终聊天输出。"""
    return f"```\n{report}\n```"


def format_report(window: str, customers: dict, rows: list, failed_customers: list) -> str:
    """生成固定字段顺序的高密度聊天输出。window 为中文时间窗口描述（如‘最近4天’/‘2026-09-04~09-08’）。"""
    customer_names = "、".join(display_value(name) for name in customers)
    title = f"MSSP 事件监控结果（{window} · {len(customers)} 个客户）"
    summary = [
        ("监控客户", f"{len(customers)}个（{customer_names}）"),
        ("监控窗口", window),
        ("查询事件", f"{len(rows)}个（状态：未处置/处置中/定期跟进）"),
    ]
    if failed_customers:
        failed = "、".join(display_value(name) for name in failed_customers)
        summary.insert(2, ("查询失败客户", failed))
    lines = [title, "=" * 56]
    lines.extend(aligned_field(label, value) for label, value in summary)
    if not rows:
        lines.append("结论：监控窗口内未发现可推送的新事件。" if not failed_customers
                     else "结论：存在客户查询失败，不能据此确认无新增事件。")
        return "\n".join(lines)

    lines.append("事件明细")
    for index, row in enumerate(rows, 1):
        if index > 1:
            lines.append("-" * 56)
        lines.append(f"事件 {index}")
        fields = [
            ("客户", row.get("company")),
            ("事件 ID", row.get("event_id")),
            ("事件名", row.get("event_name")),
            ("主机 IP", row.get("host_ip")),
            ("主机名称", row.get("hostname")),
            ("资产名称", row.get("asset_name")),
            ("资产组", row.get("asset_group")),
            ("业务名称", row.get("business_name")),
            ("业务等级", row.get("business_level")),
            ("资产类型", row.get("asset_type")),
            ("设备覆盖", row.get("dev_name")),
            ("处置状态", event_status_cn(row.get("event_status"))),
        ]
        lines.extend(aligned_field(label, value) for label, value in fields)
        lines.extend(fmt_ioc_lines(row))
        lines.extend(format_alarm_lines(row))
        lines.append(aligned_field("事件分类", row.get("classification")))
    lines.append("结论：以上事件已按佐证数据完整度分类；字段为“-”表示平台本次未返回该信息。")
    return "\n".join(lines)


def _fmt_dt(ms: int) -> str:
    """毫秒转为'YYYY-MM-DD HH:MM'可读时间（东八区，无时区偏移）。"""
    try:
        return datetime.datetime.utcfromtimestamp(ms / 1000.0).strftime("%Y-%m-%d %H:%M")
    except (OverflowError, OSError, ValueError):
        return str(ms)


def window_desc(mode: str, args) -> str:
    """生成标题/监控窗口用的中文时间范围描述。"""
    if mode == "range":
        return f"{_fmt_dt(args.start)} ~ {_fmt_dt(args.end)}"
    return f"最近{args.hours}小时"


def main():
    args = parse_args()
    start_ms = args.start
    end_ms = args.end

    shared.log("正在获取 MSSP 登录态...")
    cookie = shared.get_cookie()
    if not cookie:
        shared.log("获取登录态失败", "ERROR")
        sys.exit(1)

    try:
        customers = resolve_confirmed_company_ids(cookie, args.company_ids)
    except RuntimeError as exc:
        shared.log(str(exc), "ERROR")
        sys.exit(1)

    all_rows = []
    failed_customers = []  # 查询失败的客户（不误报为“无事件”)
    for cname, cid in customers.items():
        shared.log(f"[{cname}({cid})] 拉取事件表: {window_desc(args.mode, args)}")
        cids = cid if isinstance(cid, list) else [cid]
        events = fetch_event_table(cookie, start_ms, end_ms, company_ids=cids)
        if events is None:
            shared.log(f"[{cname}] 事件表查询失败，跳过该客户", "WARNING")
            failed_customers.append(cname)
            continue
        for ev in events:
            eid = _get(ev, "event_id", "eventId", "id")
            ename = _get(ev, "event_name", "eventName", "name")
            if not eid:
                continue  # 无事件 ID 不在范围内也忽略（非去重，是缺少必需ID）
            host_ip = _get(ev, "host_ip")
            e_company_id = cid
            # 事件分类逻辑：
            #   1) 先看事件数据源是否 NGES（base_info.device_type==69）
            #   2) NGES 数据源：根据 alarm_list 是否含“通过”区分终端 GPT 与杀毒引擎事件
            #   3) 非 NGES 数据源：根据主机是否安装 NGES 生成完整分类描述
            is_nges_src, device_type, dev_name = shared.get_event_nges(cookie, eid)
            asset_info = shared.get_asset_info(cookie, host_ip, e_company_id)
            if device_type is None:
                classification = "关键数据缺失，暂无法完成事件分类"
                is_gpt = False
                pass_titles = []
                all_titles = []
                nges_installed = bool(asset_info.get("nges_installed"))
            elif is_nges_src:
                is_gpt, pass_titles, all_titles = get_alarm_info(cookie, eid)
                nges_installed = True
                classification = (
                    "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）"
                    if is_gpt else "杀毒引擎上报事件"
                )
            else:
                is_gpt = False
                pass_titles = []
                all_titles = []
                nges_installed = bool(asset_info.get("nges_installed"))
                classification = (
                    "数据源非NGES事件，但主机安装了NGES"
                    if nges_installed else "数据源非NGES事件，同时主机未安装NGES"
                )
            all_rows.append({
                "company": cname,
                "event_id": eid,
                "event_name": ename,
                "asset_name": _get(asset_info, "asset_name", "asset") or _get(ev, "asset_name", "assetName", "asset"),
                "asset_group": _get(asset_info, "asset_group_name") or _get(ev, "asset_group_name", "assetGroupName", "asset_group"),
                "business_name": _get(asset_info, "business_name") or _get(ev, "business_name", "businessName", "business"),
                "business_level": business_level_cn(asset_info.get("business_level")),
                "asset_type": asset_type_cn(asset_info.get("asset_type") or ev.get("asset_type")),
                "dev_name": adapter_device_names(asset_info) or _get(ev, "dev_name") or dev_name,
                "host_ip": host_ip,
                "hostname": _get(asset_info, "hostname") or _get(ev, "hostname", "host_name", "hostName"),
                "event_status": _get(ev, "event_status"),
                "ioc_value": ev.get("ioc_value") if isinstance(ev, dict) else None,
                "ioc_grouped": ev.get("ioc_grouped") if isinstance(ev, dict) else None,
                "is_gpt": is_gpt,
                "device_type": device_type,
                "is_nges_src": is_nges_src,
                "nges_installed": nges_installed,
                "classification": classification,
                "pass_titles": pass_titles,
                "all_titles": all_titles,
            })

    desc = window_desc(args.mode, args)
    print(format_chat_output(format_report(desc, customers, all_rows, failed_customers)))


if __name__ == "__main__":
    main()
