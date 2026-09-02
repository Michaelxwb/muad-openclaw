#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通报事件回函 - 一键生成报告
============================
串联第五步完整流程：输入客户 + 源IP + 通报IoC，生成回函 md 报告。

流程：
    1. 解析公司名 → company_id（phase1_company）
    2. 查询资产台账，判断源IP是否为客户资产 + EDR(agent_status)安装状态（query_assets）
    3. 查询 AF 安全日志（告警日志，含动作）（query_af_logs --log-type security）
    4. 查询 AF 访问日志（不含动作）（query_af_logs --log-type access）
    5. 生成回函 md 报告

用法：
    python generate_reply.py --company "风行天下" --src-ip 39.144.190.29 --ioc "192.168.18.35:49001"
    python generate_reply.py --company "深圳市爱德泰科技股份有限公司" --src-ip 10.1.247.1 --ioc "jdhhbs.biz"
    python generate_reply.py --company X --src-ip X --ioc "1.2.3.4"              # 纯目的IP
"""
import os
import sys
import re
import json
import argparse
from datetime import datetime

# 保证可以 import 相邻目录模块
_HERE = os.path.dirname(os.path.abspath(__file__))
_ASSET_DIR = os.path.join(_HERE, "asset_check")
sys.path.insert(0, _ASSET_DIR)

from phase1_company import get_cookie as asset_cookie, resolve_company  # noqa: E402
from query_assets import query_assets as _query_assets_api, parse_asset_result, check_edr_status  # noqa: E402

# af_log_check 模块
_AF_DIR = os.path.join(_HERE, "af_log_check")
sys.path.insert(0, _AF_DIR)
from query_af_logs import query_af_logs, summarize, default_time_range, is_ip  # noqa: E402

# 深信服情报查询模块
_TI_DIR = os.path.join(_HERE, "sangfor_ti_cloud_search")
sys.path.insert(0, _TI_DIR)
from ti_query import query_ioc  # noqa: E402


def parse_ioc(ioc_raw: str):
    """解析通报IoC，返回 (ioc, dst_port)。

    支持格式：
        "jdhhbs.biz"              -> ("jdhhbs.biz", None)
        "192.168.18.35"           -> ("192.168.18.35", None)
        "192.168.18.35:49001"     -> ("192.168.18.35", "49001")
    """
    ioc_raw = (ioc_raw or "").strip()
    if not ioc_raw:
        raise SystemExit("[X ERROR] 通报IoC不能为空")
    # IP:端口 形式（形如 x.x.x.x:port）
    if ":" in ioc_raw and ioc_raw.count(":") == 1:
        ip_part, port_part = ioc_raw.rsplit(":", 1)
        if is_ip(ip_part) and port_part.isdigit():
            return ip_part, port_part
    return ioc_raw, None


def query_asset_info(company_id, src_ip, cookie):
    """查询资产台账 + EDR 状态，返回 dict。"""
    result = _query_assets_api(str(company_id), src_ip, cookie)
    parsed = parse_asset_result(result)
    info = {
        "has_asset": parsed.get("has_asset", False),
        "total": parsed.get("total", 0),
        "error": parsed.get("error"),
        "first_asset": "",
        "edr_status": "",
        "agent_status": None,
    }
    # 是否安装 EDR 仅在「在台账」的前提下才有意义：
    #   台账命中 → 看第一条资产的 agent_status（0离线/1在线/2已禁用/3已卸载/空=设备管理无EDR安装信息）
    #   台账未命中 → EDR 无法判断，标记为 N/A
    #
    # 资产关键字段（用于固定「事件处理措施第1项」文字模板）：
    #   status            : MSS 服务状态（1=服务内/属于MSS服务资产，0=服务外/不属于）
    #   asset_group_name  : 资产分组
    #   hostname          : 资产名称（可能为空）
    #   asset_type        : 资产类型（server=服务器 / endpoint=终端 / unknown=未知）
    info["status"] = None
    info["hostname"] = None
    info["asset_group_name"] = None
    info["asset_type"] = None
    if parsed.get("has_asset") and parsed.get("list"):
        first = parsed["list"][0]
        from query_assets import format_asset
        info["first_asset"] = format_asset(first)
        agent_status = first.get("agent_status")
        info["agent_status"] = agent_status
        info["edr_status"] = check_edr_status("" if agent_status is None else str(agent_status))
        # 提取固定模板所需的资产字段
        info["status"] = first.get("status")
        info["hostname"] = first.get("hostname") or ""
        info["asset_group_name"] = first.get("asset_group_name") or ""
        info["asset_type"] = first.get("asset_type") or "unknown"
    else:
        # 不在台账 → 无 agent_status 可查，EDR 状态标记为 N/A
        info["agent_status"] = None
        info["edr_status"] = "N/A（未在资产台账，无法判断EDR安装状态）"
    return info


def format_asset_type(asset_type) -> str:
    """将资产类型字段值映射为中文描述。"""
    mapping = {
        "server": "服务器",
        "endpoint": "终端",
        "unknown": "未知",
    }
    if asset_type is None:
        return "未知"
    asset_type = str(asset_type).lower()
    return mapping.get(asset_type, asset_type or "未知")


def build_measure1_text(src_ip: str, asset_info: dict) -> str:
    """生成「事件处理措施」第1项固定文字模板。

    规则（基于资产台账接口 response 的字段）：
      1. 先看资产在不在资产台账（total>0），再看是否属于 MSS 服务资产（status：1=服务内/属于，0=服务外/不属于）；
      2. 资产分组 = asset_group_name；
      3. 资产名称 = hostname（为空则写「资产名称未知」）；
      4. 资产类型 = asset_type（server→服务器 / endpoint→终端 / unknown→未知）。

    句式示例：
      - 在台账且属于MSS服务资产：
        "1.该资产（源IP 10.1.247.1）在资产台账且属于MSS服务资产，资产分组：内网IP范围，资产名称：xxx，资产类型：服务器/终端。"
      - 在台账但不属于MSS服务资产：
        "1.该资产（源IP 10.1.247.1）在资产台账内，但不属于MSS服务资产，资产分组：内网IP范围，资产名称：xxx，资产类型：服务器/终端。"
      - 不在资产台账：
        "1.该资产（源IP 10.1.247.1）不在资产台账内，资产分组：未知，资产名称：未知，资产类型：未知。"
    """
    has_asset = asset_info.get("has_asset", False)

    not_known = "未知"
    if not has_asset:
        return (
            f"1.该资产（源IP {src_ip}）不在资产台账内，"
            f"资产分组：{not_known}，资产名称：{not_known}，资产类型：{not_known}。"
        )

    status = asset_info.get("status")
    in_service = (str(status) == "1")
    service_txt = "在资产台账且属于MSS服务资产" if in_service else "在资产台账内，但不属于MSS服务资产"

    group_name = asset_info.get("asset_group_name") or ""
    group_name_txt = group_name if group_name else "未知"
    hostname = asset_info.get("hostname") or ""
    hostname_txt = hostname if hostname else "未知"
    asset_type_txt = format_asset_type(asset_info.get("asset_type"))

    return (
        f"1.该资产（源IP {src_ip}）{service_txt}，"
        f"资产分组：{group_name_txt}，资产名称：{hostname_txt}，资产类型：{asset_type_txt}。"
    )


def _safe_filename_component(s: str) -> str:
    """将文件名组件中的非法字符替换为下划线，避免写入路径出错。"""
    if not s:
        return ""
    return re.sub(r'[\\/:*?"<>|]', "_", str(s))


def _process_one(company_name, company_id, src_ip, ioc, dst_port,
                 from_date, to_date, max_pages, cookie,
                 output=None, output_params=None, no_params=False, idx=None,
                 docx_suffix=None):
    """处理单条通报：资产/EDR → 情报 → 安全日志 → 访问日志 → 生成 md + docx 参数。

    返回 (md_path, docx_params_path or None, md_text)。
    """
    print("\n" + "=" * 60, flush=True)
    print(f"【第 {idx} 条通报】源IP={src_ip}  IoC={ioc}" + (f":{dst_port}" if dst_port else ""), flush=True)
    print("=" * 60, flush=True)

    # ============ 资产台账 + EDR 状态 ============
    print("\n第2步：资产台账 + EDR 状态", flush=True)
    asset_info = query_asset_info(company_id, src_ip, cookie)
    if asset_info["error"]:
        print(f"[WARNING] 资产台账查询异常: {asset_info['error']}", flush=True)
    if asset_info["has_asset"]:
        print(f"[INFO] ✅ 命中客户资产 (total={asset_info['total']})", flush=True)
        print(f"[INFO] 资产: {asset_info['first_asset']}", flush=True)
        print(f"[INFO] EDR状态: {asset_info['edr_status']} (agent_status={asset_info['agent_status']!r})", flush=True)
    else:
        print(f"[INFO] ❌ 未命中客户资产 (total={asset_info['total']})", flush=True)
        print(f"[INFO] EDR状态: {asset_info['edr_status']}", flush=True)

    # ============ 深信服威胁情报（通报IoC）============
    print("\n第3步：深信服威胁情报查询（通报IoC）", flush=True)
    ti_result = query_ioc(ioc, dst_port)
    print(f"[INFO] 通报IoC: {ti_result['ioc']}", flush=True)
    print(f"[INFO] 信誉: {ti_result['reputation']} (value={ti_result['reputation_value']!r})", flush=True)
    print(f"[INFO] 威胁标签: {ti_result['threat_labels']}", flush=True)
    if ti_result.get('network_type'):
        print(f"[INFO] 网络类型: {ti_result['network_type']}", flush=True)

    # ============ 安全日志（告警日志，含动作）============
    print("\n第4步：AF 安全日志（告警日志，含动作）", flush=True)
    sec_records = query_af_logs(
        company_id=int(company_id), src_ip=src_ip, ioc=ioc,
        dst_port=dst_port, from_date=from_date, to_date=to_date,
        max_pages=max_pages, log_type="security",
    )
    sec_sum = summarize(sec_records)
    print(f"[RESULT] 安全日志: {sec_sum['count']} 条，最早 {sec_sum['earliest']}，最新 {sec_sum['latest']}，动作 {sec_sum['actions']}", flush=True)

    # ============ 访问日志（不含动作）============
    print("\n第5步：AF 访问日志", flush=True)
    acc_records = query_af_logs(
        company_id=int(company_id), src_ip=src_ip, ioc=ioc,
        dst_port=dst_port, from_date=from_date, to_date=to_date,
        max_pages=max_pages, log_type="access",
    )
    acc_sum = summarize(acc_records)
    print(f"[RESULT] 访问日志: {acc_sum['count']} 条，最早 {acc_sum['earliest']}，最新 {acc_sum['latest']}", flush=True)

    # ============ 生成 md 报告 ============
    print("\n第6步：生成回函报告", flush=True)
    if not output:
        reports_dir = os.path.join(_HERE, "..", "reports")
        os.makedirs(reports_dir, exist_ok=True)
        ioc_suffix = _safe_filename_component(ioc)
        output = os.path.join(reports_dir, f"回函_{company_name}_{src_ip}_{ioc_suffix}.md")

    md = build_report(
        company_name=company_name, company_id=company_id,
        src_ip=src_ip, ioc=ioc, dst_port=dst_port,
        from_date=from_date, to_date=to_date,
        asset_info=asset_info, ti_result=ti_result,
        sec_sum=sec_sum, acc_sum=acc_sum,
        measure1_text=build_measure1_text(src_ip, asset_info),
    )

    with open(output, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"[INFO] 报告已写入: {output}", flush=True)

    # ---- 导出 docx 填充参数 JSON（固定文字模板） ----
    params_path = None
    if not no_params:
        measure1_text = build_measure1_text(src_ip, asset_info)
        params = build_docx_params(
            company_name=company_name, src_ip=src_ip, ioc=ioc, dst_port=dst_port,
            from_date=from_date, to_date=to_date,
            asset_info=asset_info, ti_result=ti_result,
            sec_sum=sec_sum, acc_sum=acc_sum, measure1_text=measure1_text,
            docx_suffix=docx_suffix,
        )
        if output_params:
            params_path = output_params
        else:
            reports_dir = os.path.join(_HERE, "..", "reports")
            os.makedirs(reports_dir, exist_ok=True)
            ioc_suffix = _safe_filename_component(ioc)
            params_path = os.path.join(reports_dir, f"docx_params_{src_ip}_{ioc_suffix}.json")
        with open(params_path, "w", encoding="utf-8") as f:
            json.dump(params, f, ensure_ascii=False, indent=2)
        print(f"[INFO] docx 填充参数已写入: {params_path}", flush=True)
        print(f"[INFO] 事件处理措施·第1项: {measure1_text}", flush=True)
    print("\n" + "=" * 60, flush=True)
    print("【回函总结】", flush=True)
    print("=" * 60, flush=True)
    print(md, flush=True)

    return output, params_path, md


def _parse_iocs(args):
    """解析 --ioc / --iocs，返回 [(src_ip, ioc_raw), ...] 有序列表。

    优先级：
      - 若提供 --iocs（JSON数组）：
          * 元素为字符串 → 使用全局 --src-ip
          * 元素为对象 {"src_ip": "...", "ioc": "..."} → 使用各自的 src_ip
      - 否则回退到单条 --ioc + --src-ip。
    """
    if args.iocs:
        raw = json.loads(args.iocs)
        if not isinstance(raw, list) or not raw:
            raise SystemExit("[X ERROR] --iocs 必须是包含至少一个元素的 JSON 数组")
        entries = []
        for item in raw:
            if isinstance(item, str):
                entries.append((args.src_ip, item))
            elif isinstance(item, dict):
                src = item.get("src_ip") or args.src_ip
                ioc = item.get("ioc")
                if not ioc:
                    raise SystemExit(f"[X ERROR] --iocs 条目缺少 ioc 字段: {item}")
                entries.append((src, ioc))
            else:
                raise SystemExit(f"[X ERROR] --iocs 条目必须是字符串或 {{src_ip, ioc}} 对象: {item}")
        return entries
    return [(args.src_ip, args.ioc)]


def main():
    parser = argparse.ArgumentParser(description="通报事件回函 - 一键生成报告")
    parser.add_argument("--company", type=str, required=True, help="客户公司名称")
    parser.add_argument("--src-ip", type=str, required=True, help="通报源IP（--iocs 条目未指定 src_ip 时的默认源IP）")
    parser.add_argument("--ioc", type=str, default=None,
                        help="通报IoC（域名/IP/IP+端口），单条模式使用")
    parser.add_argument("--iocs", type=str, default=None,
                        help='多条通报JSON数组，如 \'["1.2.3.4",{"src_ip":"10.0.0.1","ioc":"bad.com"}]\'。提供后为多报告模式')
    parser.add_argument("--from", dest="from_date", type=str, default=None,
                        help='起始时间，默认7天前')
    parser.add_argument("--to", dest="to_date", type=str, default=None,
                        help='结束时间，默认此刻')
    parser.add_argument("--max-pages", type=int, default=0,
                        help="日志翻页上限（0=遍历全部，默认0）")
    parser.add_argument("--output", type=str, default=None,
                        help="单条模式报告输出 md 文件路径（默认 reports/回函_公司_源IP.md）")
    parser.add_argument("--output-params", type=str, default=None,
                        help="单条模式 docx 填充参数 JSON 导出路径（供 fill_feedback_generic.ps1 消费）")
    parser.add_argument("--no-params", action="store_true",
                        help="不导出 docx 填充参数 JSON")
    args = parser.parse_args()

    # 解析通报条目
    entries = _parse_iocs(args)
    if not entries:
        raise SystemExit("[X ERROR] 未提供通报信息（--ioc 或 --iocs）")
    for src_ip, ioc_raw in entries:
        _, dst_port = parse_ioc(ioc_raw)
        print(f"[INFO] 通报IoC解析: 源IP={src_ip}  目的={parse_ioc(ioc_raw)[0]!r}, 端口={dst_port!r}", flush=True)

    # 时间范围
    from_date = args.from_date
    to_date = args.to_date
    if not from_date or not to_date:
        default_from, default_to = default_time_range()
        from_date = from_date or default_from
        to_date = to_date or default_to

    cookie = asset_cookie()
    if not cookie:
        raise SystemExit("[X ERROR] Cookie 无效或已过期")

    # ============ 1. 解析 company_id ============
    print("\n" + "=" * 60, flush=True)
    print("第1步：解析公司ID", flush=True)
    print("=" * 60, flush=True)
    company_name, company_id = resolve_company(args.company, cookie)
    print(f"[INFO] 公司: {company_name} (company_id={company_id})", flush=True)

    # ============ 逐条生成报告 ============
    multi = len(entries) > 1
    generated = []
    for idx, (src_ip, ioc_raw) in enumerate(entries, start=1):
        ioc, dst_port = parse_ioc(ioc_raw)
        # 多报告模式：不允许 --output / --output-params（路径会互相覆盖）
        if multi and (args.output or args.output_params):
            print(f"[WARNING] 多报告模式下忽略 --output / --output-params（文件名按源IP+IoC自动生成）", flush=True)
        md_path, params_path, md_text = _process_one(
            company_name=company_name, company_id=company_id,
            src_ip=src_ip, ioc=ioc, dst_port=dst_port,
            from_date=from_date, to_date=to_date,
            max_pages=args.max_pages, cookie=cookie,
            output=(None if multi else args.output),
            output_params=(None if multi else args.output_params),
            no_params=args.no_params, idx=idx,
            docx_suffix=(f"{src_ip}_{ioc}" if multi else None),
        )
        generated.append((src_ip, ioc, md_path, params_path))

    if multi:
        print("\n" + "=" * 60, flush=True)
        print(f"【已完成】共生成 {len(generated)} 份回函报告", flush=True)
        print("=" * 60, flush=True)
        for src_ip, ioc, md_path, params_path in generated:
            print(f"- {md_path}", flush=True)
            if params_path:
                print(f"    docx参数: {params_path}", flush=True)


def build_report(company_name, company_id, src_ip, ioc, dst_port,
                 from_date, to_date, asset_info, ti_result, sec_sum, acc_sum,
                 measure1_text=None) -> str:
    """组装回函 md 报告。"""
    lines = []
    lines.append("# 安全事件通报回函")
    lines.append("")
    lines.append(f"- **通报日期**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- **涉及客户**：{company_name}（ID：{company_id}）")
    lines.append(f"- **查询时间范围**：{from_date} 至 {to_date}")
    lines.append("")
    lines.append("## 一、通报信息")
    lines.append("")
    lines.append(f"- **通报源IP**：`{src_ip}`")
    lines.append(f"- **通报IoC**：`{ioc}`" + (f"（目的端口：`{dst_port}`）" if dst_port else "（未指定目的端口）"))
    lines.append(f"- **IoC类型**：" + ("域名" if not is_ip(ioc) else ("目的IP+端口" if dst_port else "目的IP")))
    lines.append("")
    lines.append("## 二、资产归属与EDR状态")
    lines.append("")
    if asset_info["has_asset"]:
        lines.append(f"- **是否在资产台账**：✅ 是（命中 {asset_info['total']} 条资产记录）")
        if asset_info["first_asset"]:
            lines.append(f"- **台账资产信息**：{asset_info['first_asset']}")
    else:
        lines.append(f"- **是否在资产台账**：❌ 否（未命中，total={asset_info['total']}）")
        if asset_info["error"]:
            lines.append(f"- **查询说明**：{asset_info['error']}")
    # EDR 安装状态：仅在台账命中时才有 agent_status 可判断；未命中则 N/A
    lines.append(f"- **EDR安装状态（agent_status）**：{asset_info['edr_status']}")
    if measure1_text:
        lines.append("- **事件处理措施·第1项模板**：" + measure1_text)
    lines.append("")
    lines.append("## 三、深信服威胁情报（通报IoC）")
    lines.append("")
    ti_ioc = ti_result.get("ioc") or ioc
    lines.append(f"- **通报IoC**：`{ti_ioc}`")
    lines.append(f"- **信誉**：{ti_result.get('reputation', '—')}")
    ti_labels = ti_result.get("threat_labels") or []
    if ti_labels:
        lines.append(f"- **威胁标签**：{'、'.join(ti_labels)}")
    else:
        lines.append("- **威胁标签**：无")
    if ti_result.get("network_type"):
        lines.append(f"- **网络类型**：{ti_result['network_type']}")
    if not ti_result.get("reputation_value"):
        lines.append("- **查询说明**：未返回有效信誉结果")
    lines.append("")
    lines.append("## 四、AF 安全日志（告警日志，含动作）")
    lines.append("")
    lines.append(f"- **符合条件条数**：**{sec_sum['count']}** 条")
    lines.append(f"- **最早时间**：{sec_sum['earliest'] or '—'}")
    lines.append(f"- **最新时间**：{sec_sum['latest'] or '—'}")
    if sec_sum["actions"]:
        actions_str = "、".join(f"{k}：{v} 条" for k, v in sec_sum["actions"].items())
        lines.append(f"- **动作分布**：{actions_str}")
    lines.append("")
    lines.append("## 五、AF 访问日志")
    lines.append("")
    lines.append(f"- **符合条件条数**：**{acc_sum['count']}** 条")
    lines.append(f"- **最早时间**：{acc_sum['earliest'] or '—'}")
    lines.append(f"- **最新时间**：{acc_sum['latest'] or '—'}")
    lines.append("")
    lines.append("## 六、结论")
    lines.append("")
    has_asset_txt = "是" if asset_info["has_asset"] else "否"
    edr_txt = asset_info["edr_status"]  # 已在 query_asset_info 中：命中→实际状态，未命中→N/A
    lines.append(f"- **资产归属**：源IP `{src_ip}` 属于客户资产：**{has_asset_txt}**")
    lines.append(f"- **EDR安装状态**：{edr_txt}")
    ti_rep_txt = ti_result.get("reputation", "—")
    lines.append(f"- **深信服情报**：通报IoC `{ti_ioc}` 信誉：{ti_rep_txt}"
                 + (f"；威胁标签：{'、'.join(ti_labels)}" if ti_labels else ""))
    lines.append(f"- **安全日志**：{(str(sec_sum['count']) + ' 条告警记录') if sec_sum['count'] else '未发现相关告警记录'}"
                 f"（动作：{('、'.join(f'{k}:{v}' for k,v in sec_sum['actions'].items())) if sec_sum['actions'] else '无'}）")
    lines.append(f"- **访问日志**：{(str(acc_sum['count']) + ' 条访问记录') if acc_sum['count'] else '未发现相关访问记录'}")
    lines.append("")
    return "\n".join(lines)


def _join_threat_labels(ti_result) -> str:
    """威胁标签中文串."""
    tl = ti_result.get("threat_labels") or []
    return "、".join(tl) if tl else "无"


def _join_actions(sec_sum) -> str:
    """安全日志动作分布串，如 '允许：2729 条' -> '允许'（若单动作）或 '允许、拒绝'."""
    acts = sec_sum.get("actions") or {}
    if not acts:
        return "允许"
    if len(acts) == 1:
        return next(iter(acts))
    return "、".join(f"{k}" for k in acts)


def build_docx_params(company_name, src_ip, ioc, dst_port,
                      from_date, to_date, asset_info, ti_result,
                      sec_sum, acc_sum, measure1_text, docx_suffix=None) -> dict:
    """构建 docx 回函填充参数（固定文字模板）。

    docx_suffix：多报告模式下追加的 IoC 后缀，用于区分生成的正式 docx 文件名，
    避免多条通报互相覆盖（单条模式为 None，不追加）。

    生成 fill_feedback_generic.ps1 消费的 JSON 字段，其中
    m1~m4、sheShiTxt(涉事系统)、safeTxt(安全管理) 按固定句式模板产出，
    以实现每次输出文档文字模板固定。

    注意：按需求事件处理措施只保留 1-4 点，m5（综合研判结论）不再写入
    docx；m5 置空串，填充时用 findM5 匹配并删除模板中对应的占位行。
    """
    ioc_disp = ioc + (f":{dst_port}" if dst_port else "")

    # ---- 涉事系统情况 ----
    she_shi = f"源IP为{src_ip}，外联目标地址为{ioc_disp}。"

    # ---- 事件处理措施 5 步 ----
    m1 = measure1_text

    rep = ti_result.get("reputation", "未知")
    labels = _join_threat_labels(ti_result)
    if ti_result.get("threat_labels"):
        m2 = f"2.经深信服威胁情报平台研判，通报IoC（{ioc_disp}）信誉评级为{rep}，威胁标签为{labels}。"
    else:
        m2 = f"2.经深信服威胁情报平台研判，通报IoC（{ioc_disp}）信誉评级为{rep}，无威胁标签，研判结果正常。"

    sec_n = sec_sum.get("count", 0)
    sec_act = _join_actions(sec_sum)
    sec_from = (sec_sum.get("earliest") or "").strip()
    sec_to = (sec_sum.get("latest") or "").strip()
    if sec_n:
        m3 = (f"3.经查近两周的网络安全日志，该资产与通报IoC存在匹配的安全日志记录，共{sec_n}条，"
              f"动作均为{sec_act}（时间范围{sec_from}至{sec_to}）。")
    else:
        m3 = "3.经查近两周的网络安全日志，该资产与通报IoC未发现匹配的安全日志记录。"

    if not is_ip(ioc):
        ioc_log_txt = "DNS"          # 域名 -> DNS访问日志
        ioc_type_txt = "域名"
    elif dst_port:
        ioc_log_txt = "TCP"          # IP+端口 -> TCP访问日志
        ioc_type_txt = "IP+端口"
    else:
        ioc_log_txt = ""             # 纯IP -> 访问日志
        ioc_type_txt = "IP"
    acc_n = acc_sum.get("count", 0)
    acc_from = (acc_sum.get("earliest") or "").strip()
    acc_to = (acc_sum.get("latest") or "").strip()
    log_kind = f"{ioc_log_txt}访问日志" if ioc_log_txt else "访问日志"
    if acc_n:
        m4 = (f"4.经查近两周的{log_kind}（通报IoC为{ioc_type_txt}），该资产与通报IoC存在匹配的访问日志记录，"
              f"共{acc_n}条（时间范围{acc_from}至{acc_to}）。")
    else:
        m4 = f"4.经查近两周的{log_kind}（通报IoC为{ioc_type_txt}），该资产与通报IoC未发现相关访问日志记录。"

    # m5（综合研判结论）不再写入 docx：按用户要求，事件处理措施只保留 1-4 点。

    # ---- 安全管理情况 ----
    edr = asset_info["edr_status"]
    if asset_info.get("has_asset"):
        agent = asset_info.get("agent_status")
        agent_desc = ""
        if agent is None or str(agent) == "":
            agent_desc = "暂无该资产的EDR安装信息"
        else:
            from query_assets import check_edr_status
            agent_desc = f"EDR状态为{check_edr_status(str(agent))}"
        safe = (f"该资产（源IP {src_ip}）已在资产台账，{agent_desc}，建议尽快部署EDR端点安全防护并加强日常监测。")
    else:
        safe = (f"该资产（源IP {src_ip}）未在资产台账，暂无法确认EDR安装状态，建议尽快纳入资产管理并部署EDR端点安全防护，加强日常监测。")

    return {
        "srcDocx": r"M:\Users\User\Downloads\网络安全事件处理反馈单.docx",
        "dstDocx": (r"M:\Users\User\Downloads\网络安全事件处理反馈单_{company}".format(company=company_name)
                     + (f"_{_safe_filename_component(docx_suffix)}" if docx_suffix else "")
                     + ".docx"),
        "recvUnit": company_name,
        "findSrcTxt": "经查为我司出口防火墙nat出的互联网地址，外连C2 服务器时段为XXX的个人电脑终端使用。",
        "sheShiTxt": she_shi,
        "findM1": "1.通过AF日志定位到通报中外联恶意服务器的电脑终端。",
        "m1": m1,
        "findM2": "2.通过流量分析，暂未发现该终端感染病毒后存在病毒扩散、文件窃取、横向攻击等行为。",
        "m2": m2,
        "findM3": "3.已使用杀毒软件对该终端进行全盘查杀。",
        "m3": m3,
        "findM4": "4.在出口防火墙上对外联恶意IP进行封禁。",
        "m4": m4,
        "findM5": "5.对涉及人员进行网络安全教育，提高网络安全意识。",
        "m5": "",
        "findSafeTxt": "涉事终端为个人电脑终端，已对其进行网络安全教育，并安装杀毒软件，定期开展病毒查杀。",
        "safeTxt": safe,
    }


if __name__ == "__main__":
    main()
