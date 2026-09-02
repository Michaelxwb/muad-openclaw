# -*- coding: utf-8 -*-
"""
monitor-mssp-events 主脚本。

流程：
1. 拉取用户明确指定的最近 N 分钟 MSSP 事件表（create_time 毫秒时间戳区间）。
2. 对每个新增事件，取 event_id，查 alarm_list，取全部告警标题（含"通过xxx"的）。
3. 汇总资产信息（资产名称/业务名称/业务等级/资产类型/设备覆盖/主机IP）+ 终端GPT判定，输出到 stdout。

用法：
  python3 scripts/run.py --company-id <平台返回的数字 company_id> --minutes <positive_minutes>
"""

import argparse
import sys
import time
import unicodedata

import shared

# 资产类型编码 -> 中文
ASSET_TYPE_MAP = {1: "终端", 2: "服务器"}
BUSINESS_LEVEL_MAP = {1: "核心", 2: "重要", 3: "一般"}


def now_ms() -> int:
    return int(time.time() * 1000)


def positive_minutes(value: str) -> int:
    """解析正整数监控时长，拒绝空值、零和负数。"""
    try:
        minutes = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("监控时长必须是正整数分钟") from exc
    if minutes <= 0:
        raise argparse.ArgumentTypeError("监控时长必须大于 0 分钟")
    return minutes


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
        "event_status": [],
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
    """解析并强制收集客户与监控时长，缺一项则不允许进入业务流程。"""
    parser = argparse.ArgumentParser(description="监控指定客户的 MSSP 平台事件")
    parser.add_argument(
        "--minutes", type=positive_minutes, required=True,
        help="必填：监控最近 N 分钟，必须是正整数",
    )
    parser.add_argument(
        "--company-id", dest="company_ids", action="append",
        type=company_id_value, required=True,
        help="必填：平台返回的数字 company_id，可重复传入多个客户",
    )
    return parser.parse_args(argv)


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


def format_report(minutes: int, customers: dict, rows: list, failed_customers: list) -> str:
    """生成固定字段顺序的高密度聊天输出。"""
    customer_names = "、".join(display_value(name) for name in customers)
    title = f"MSSP 事件监控结果（最近 {minutes} 分钟 · {len(customers)} 个客户）"
    summary = [
        ("监控客户", f"{len(customers)}个（{customer_names}）"),
        ("监控窗口", f"最近{minutes}分钟"),
        ("新增事件", f"{len(rows)}个（已按事件ID去重）"),
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
        ]
        lines.extend(aligned_field(label, value) for label, value in fields)
        lines.extend(format_alarm_lines(row))
        lines.append(aligned_field("事件分类", row.get("classification")))
    lines.append("结论：以上事件已按佐证数据完整度分类；字段为“-”表示平台本次未返回该信息。")
    return "\n".join(lines)


def main():
    args = parse_args()
    minutes = args.minutes
    start_ms = now_ms() - minutes * 60 * 1000
    end_ms = now_ms()

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

    reminded = shared.load_reminded()

    all_rows = []
    failed_customers = []  # 查询失败的客户（不误报为“无事件”）
    for cname, cid in customers.items():
        shared.log(f"[{cname}({cid})] 拉取事件表: 最近 {minutes} 分钟")
        cids = cid if isinstance(cid, list) else [cid]
        events = fetch_event_table(cookie, start_ms, end_ms, company_ids=cids)
        if events is None:
            shared.log(f"[{cname}] 事件表查询失败，跳过该客户", "WARNING")
            failed_customers.append(cname)
            continue
        for ev in events:
            eid = _get(ev, "event_id", "eventId", "id")
            ename = _get(ev, "event_name", "eventName", "name")
            if not eid or eid in reminded:
                continue  # 已提醒过，去重
            host_ip = _get(ev, "host_ip")
            e_company_id = cid
            # 事件分类逻辑：
            #   1) 先看事件数据源是否 NGES（base_info.device_type==69）
            #   2) NGES 数据源：根据 alarm_list 是否含“通过”区分终端 GPT 与杀毒引擎事件
            #   3) 非 NGES 数据源：根据主机是否安装 NGES 生成完整分类描述
            is_nges_src, device_type, dev_name = shared.get_event_nges(cookie, eid)
            asset_info = shared.get_asset_info(cookie, host_ip, e_company_id)
            if device_type is None:
                # 事件详情获取失败，无法判断数据源，标记为“详情获取失败”而非误判场景
                classification = "关键数据缺失，暂无法完成事件分类"
                is_gpt = False
                pass_titles = []
                all_titles = []
                nges_installed = bool(asset_info.get("nges_installed"))
            elif is_nges_src:
                # NGES 数据源：查告警“通过”区分 终端GPT / 杀毒引擎
                is_gpt, pass_titles, all_titles = get_alarm_info(cookie, eid)
                nges_installed = True  # NGES 设备自身即已覆盖
                classification = (
                    "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）"
                    if is_gpt else "杀毒引擎上报事件"
                )
            else:
                # 非 NGES 数据源：不查告警“通过”，用主机IP查是否被NGES覆盖
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
                "is_gpt": is_gpt,
                "device_type": device_type,
                "is_nges_src": is_nges_src,
                "nges_installed": nges_installed,
                "classification": classification,
                "pass_titles": pass_titles,
                "all_titles": all_titles,
            })

    print(format_chat_output(format_report(minutes, customers, all_rows, failed_customers)))

    # 标记本次已提醒
    now = now_ms()
    for r in all_rows:
        reminded[r["event_id"]] = now
    shared.save_reminded(reminded)


if __name__ == "__main__":
    main()
