#!/usr/bin/env python3
"""解析 GPTRawLog.json，为推送 skill 提供结构化分析输入。

用法:
 python parse_gptrawlog.py <gptrawlog.json> [--cgid xxx] [-o <输出目录>]

输出（统一事件归档根下自动创建的事件文件夹内）:
 *_分析输入.md — 供分析阅读的结构化摘要
 *_gptInput.json — 供参考的完整 threatList/treeList/virtualEdges 行为数据
 *_基础信息.json — cgid / alertId / agentId 等索引信息
（主机信息不从脚本命令行传入，取前置资产信息文件，见 SKILL.md）
"""

import argparse
import json
import os
import re
import sys


def resolve_archive_root(output_arg=None):
    """解析统一事件归档根（跨用户在各自工作区/账号下都不报路径错）。

    优先级（从高到低）：
      1. 显式传入 -o/--output 参数
      2. 环境变量 EVENT_ARCHIVE_ROOT（如需强制某统一根可注入）
      3. guard 注入的 SKILL_OUTPUT_DIR（Public Skill 运行时 per-user 可写区）下的“事件归档”
      4. 脚本所在技能目录向上推导出的工作区顶层“事件归档”（本地开发）

    返回的根总是可写的统一事件归档根。mssp-event-push-content 的原始
    GPTRawLog、副文件、判定与文案都写入这个根下的同一事件目录。
    """
    if output_arg:
        return os.path.abspath(output_arg)
    env = os.environ.get("EVENT_ARCHIVE_ROOT")
    if env:
        return os.path.abspath(env)
    out = os.environ.get("SKILL_OUTPUT_DIR")
    if out:
        return os.path.join(os.path.abspath(out), "事件归档")
    # 本地/开发：从本脚本位置向上找含 skill-staging|skills 的工作区，取顶层事件归档
    here = os.path.dirname(os.path.abspath(__file__))
    it = os.path.abspath(here)
    while True:
        parent = os.path.dirname(it)
        if parent == it:
            return os.path.join(os.path.expanduser("~"), "事件归档")
        leaf = os.path.basename(it)
        if leaf in ("skills", "skill-staging"):
            return os.path.join(parent, "事件归档")
        it = parent



def load_input(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    if not raw:
        print("错误: 文件为空", file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        line = next((l for l in raw.split("\n") if l.strip()), None)
        if not line:
            print("错误: 无法解析文件", file=sys.stderr)
            sys.exit(1)
        outer = json.loads(line)
        data = json.loads(outer["GPTrawLog"]) if isinstance(outer.get("GPTrawLog"), str) else outer
    return data


def extract_tree_list(data):
    """从 Runtime.analysePrompt 中提取 '事件json文件\\n' 后的 JSON"""
    ap = data.get("Runtime", {}).get("analysePrompt", "")
    marker = "事件json文件\n"
    idx = ap.find(marker)
    if idx == -1:
        return {"error": "未找到 '事件json文件' 标记"}
    try:
        return json.loads(ap[idx + len(marker):])
    except json.JSONDecodeError as e:
        return {"error": f"JSON 解析失败: {e}", "raw": ap[idx + len(marker):][:500]}


def parse_analyse_answer(text):
    """解析 analyseAnswer：识别标签、定性标签 JSON、入口信息 JSON、处置建议"""
    tag = None
    if re.search(r"black\s+TAG", text, re.IGNORECASE):
        tag = "black"
    elif re.search(r"gray\s+TAG", text, re.IGNORECASE):
        tag = "gray"
    elif re.search(r"white\s+TAG", text, re.IGNORECASE):
        tag = "white"

    qual = {}
    m = re.search(r"#\s*定性标签\s*\n\s*(\{.*?\})", text, re.DOTALL)
    if m:
        try:
            qual = json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    entry = {}
    m = re.search(r"##\s*入口信息.*?\n(\{.*?\})", text, re.DOTALL)
    if m:
        try:
            entry = json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    dispose = []
    m = re.search(r"#\s*处置建议\s*\n(.*?)(?:\n#|\Z)", text, re.DOTALL)
    if m:
        dispose = [l.strip() for l in m.group(1).split("\n") if l.strip()]

    return {
        "tag": tag,
        "qualitative": qual,
        "entry": entry,
        "dispose_suggestions": dispose,
    }


def collect_entities(gpt_input):
    """返回 (ti_entities, event_entities)：
    - ti_entities: threatList 中命中情报的实体 —— 推送时复核并按需生成 TI 截图的对象
    - event_entities: 行为树（treeList）中出现但未命中情报的实体 —— 默认不调用情报接口
    """
    ti_entities = []
    seen = set()
    for t in gpt_input.get("threatList", []):
        m = re.match(r"\s*(IP|URL|域名|文件hash|md5|邮箱|SHA256)\s+([^\s：]+)\s*[:：](.*)", t)
        if m:
            key = m.group(1).lower() + "|" + m.group(2).lower()
            if key not in seen:
                seen.add(key)
                ti_entities.append({"kind": m.group(1), "value": m.group(2).strip(), "info": m.group(3).strip()})

    event_entities = []
    seen_e = set()

    def walk(nodes):
        for n in nodes:
            if n.get("type") == "network ip" and n.get("destinationIp"):
                key = "ip|" + n["destinationIp"].lower()
                if key not in seen_e:
                    seen_e.add(key)
                    event_entities.append({"kind": "IP", "value": n["destinationIp"],
                                           "info": f"端口 {n.get('destinationPort', '-')} {n.get('protocol', '')}".strip()})
            if n.get("type") == "network dns" and n.get("dnsQueryName"):
                key = "dns|" + n["dnsQueryName"].lower()
                if key not in seen_e:
                    seen_e.add(key)
                    event_entities.append({"kind": "域名", "value": n["dnsQueryName"],
                                           "info": f"解析 {n.get('dnsQueryResults', '-')}".strip()})
            if n.get("type") == "file" and n.get("hash"):
                key = "md5|" + n["hash"].lower()
                if key not in seen_e:
                    seen_e.add(key)
                    event_entities.append({"kind": "md5", "value": n["hash"], "info": n.get("path", "")})
            walk(n.get("children", []))

    walk(gpt_input.get("treeList", []))
    return ti_entities, event_entities


def walk_nodes(nodes, indent=0, lines=None):
    """缩进文本树，标注关键字段"""
    if lines is None:
        lines = []
    for n in nodes:
        ntype = n.get("type", "")
        action = n.get("action", "")
        ts = n.get("createTime", "")
        label = []
        if ntype == "process":
            label.append(n.get("filePath", ""))
            if n.get("originalFileName") and n.get("originalFileName") != os.path.basename(n.get("filePath", "")):
                label.append(f"[原名 {n.get('originalFileName')}]")
            if n.get("signatureType"):
                label.append(f"[{n.get('signatureType')} {n.get('signatureName','')}]")
            if n.get("hash"):
                label.append(f"[md5:{n.get('hash')}]")
            if n.get("commandLine"):
                label.append(f"cmd: {n.get('commandLine')}")
        elif ntype == "network ip":
            label.append(f"{n.get('destinationIp')}:{n.get('destinationPort')} [{n.get('protocol')}]")
            if n.get("iocFamily"):
                label.append(f"[ioc:{n.get('iocCategory')}/{n.get('iocFamily')}]")
        elif ntype == "network dns":
            label.append(f"{n.get('dnsQueryName')} -> {n.get('dnsQueryResults','')}")
        elif ntype == "file":
            label.append(n.get("path", ""))
            if n.get("hash"):
                label.append(f"[md5:{n.get('hash')}]")
        elif ntype == "registry":
            label.append(f"{n.get('keyName','')} = {n.get('valueData','')}".strip())
        elif ntype == "scheduled job":
            label.append(n.get("taskName", n.get("procPath", "")))
            if n.get("taskFreq"):
                label.append(f"[频率:{n.get('taskFreq')}]")
        elif ntype == "service":
            label.append(f"{n.get('serviceName','')} cmd:{n.get('serviceCmd','')}".strip())
        else:
            label.append(str(n.get("type", "")))
        indent_str = " " * indent + ("└─ " if indent else "")
        lines.append(f"{indent_str}{ntype}{'(' + action + ')' if action else ''} {ts} {' '.join(label)}")
        walk_nodes(n.get("children", []), indent + 1, lines)
    return lines


def main():
    # Windows 控制台默认 GBK，stdout 重定向到 UTF-8，避免中文乱码
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="解析 GPTRawLog.json，生成推送 skill 的分析输入")
    parser.add_argument("file", help="GPTRawLog.json 路径")
    parser.add_argument("-o", "--output", default=None,
                        help="可选输出目录（缺省自动解析统一事件归档根，见 resolve_archive_root）")
    parser.add_argument("--cgid", help="手动指定 CGID（可选）")
    parser.add_argument("--event-dir", help="事件文件夹名（默认自动生成：{YYYYMMDDHHMMSS}_{事件名}）")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"错误: 文件不存在 - {args.file}", file=sys.stderr)
        sys.exit(1)
    args.output = resolve_archive_root(args.output)
    os.makedirs(args.output, exist_ok=True)

    data = load_input(args.file)
    rt = data.get("Runtime", {})
    task = data.get("taskContent", {})
    gpt_input = extract_tree_list(data)
    answer_raw = rt.get("analyseAnswer", "")
    answer = parse_analyse_answer(answer_raw)
    gpt_resp = task.get("gptResponse", {})
    ti_entities, event_entities = collect_entities(gpt_input)

    cgid = args.cgid or task.get("cgId", "")
    event_name = gpt_resp.get("name") or (answer.get("qualitative") or {}).get("攻击者", "") or "安全事件"
    finished = rt.get("FinishedAt", "")

    stamp = re.sub(r"\D", "", (finished or "")[:19])[:14]
    if len(stamp) < 14:
        stamp = finished or "unknown"
    prefix = stamp

    # 事件文件夹：每个事件的所有上游文件归档于此（过程文件不丢弃）
    event_dir = args.event_dir or f"{stamp}_{event_name}"
    event_dir = re.sub(r'[\\/:*?"<>|]', "_", event_dir)  # 去除非法路径字符
    out_root = os.path.join(args.output, event_dir)
    os.makedirs(out_root, exist_ok=True)

    # ── 基础信息
    basic = {
        "cgId": cgid,
        "alertId": task.get("alertId", ""),
        "agentId": data.get("agentId", ""),
        "taskId": data.get("taskId", ""),
        "AIID": rt.get("AIID", ""),
        "事件名称": event_name,
        "FinishedAt": rt.get("FinishedAt", ""),
        "tenantId": data.get("tenantId", ""),
    }

    # ── 研判摘要（gptResponse，结构化） ──
    analysis = gpt_resp.get("analysis", [])
    dispose_done = gpt_resp.get("disposeSuggestion", "")
    malicious_entities = gpt_resp.get("maliciousEntities", [])
    me_desc = []
    for me in malicious_entities:
        if me.get("hashTi"):
            h = me["hashTi"]
            me_desc.append(f"恶意文件: {h.get('fileName','')} ({h.get('filePath','')}) md5:{h.get('md5','')} threatType:{h.get('label',{}).get('threatType','')}")
        if me.get("ipTi"):
            ip = me["ipTi"]
            fams = "、".join(f"{l.get('category','')}/{l.get('family','')}" for l in ip.get("label", []))
            me_desc.append(f"恶意IP: {ip.get('ip','')} [{fams}] 位置:{ip.get('location',{}).get('province','')}")

    md = []
    md.append("# GPTRawLog 分析输入\n")
    md.append(f"## 基本信息\n")
    md.append(f"- **事件名称**: {event_name}")
    md.append(f"- **GPT研判标签**: {answer['tag'] or '未知'}")
    md.append(f"- **CGID**: {cgid}")
    md.append(f"- **AlertID**: {task.get('alertId','')}")
    md.append(f"- **AgentID**: {data.get('agentId','')}")
    md.append(f"- **事件时间**: {rt.get('FinishedAt','')}")
    md.append(f"- **AIID**: {rt.get('AIID','')}")

    if answer.get("qualitative"):
        q = answer["qualitative"]
        md.append(f"- **定性标签**: 攻击者[{q.get('攻击者','')}] 手法[{q.get('攻击手法','')}] 意图[{q.get('攻击意图','')}]")
    md.append("")

    md.append("## 初步研判（analyseAnswer）\n")
    md.append(answer_raw.strip() + "\n")

    md.append("## 结构化研判（gptResponse.analysis）\n")
    if analysis:
        for a in analysis:
            md.append(f"### {a.get('title','')}")
            md.append(a.get("explain", ""))
            for ev in (a.get("evidence") or []):
                md.append(f"- {ev.get('type','')}: {ev.get('desc','')}")
            md.append("")
    else:
        md.append("（无）\n")

    md.append("## 威胁情报命中（threatList）\n")
    md.append("> 以下实体来自 GPTRawLog 的威胁情报命中；后续基于解析结果复核，按需调用 ti-redirect-analyze 生成截图\n")
    if ti_entities:
        for e in ti_entities:
            md.append(f"- {e['kind']} `{e['value']}`：{e['info']}")
    else:
        md.append("（无）\n")

    md.append("## 事件其他实体（行为树中未命中情报）\n")
    md.append("> 默认不调用情报接口；如需调查，手动指定实体\n")
    if event_entities:
        for e in event_entities:
            md.append(f"- {e['kind']} `{e['value']}`：{e['info']}")
    else:
        md.append("（无）\n")

    md.append("## 恶意实体（根因/入口）\n")
    if me_desc:
        for d in me_desc:
            md.append(f"- {d}")
        if answer.get("entry"):
            e = answer["entry"]
            md.append(f"- 入口: {e.get('入口名','')} / 动作: {e.get('动作','')} / 根因实体: {e.get('根因实体','')}")
    md.append("")

    md.append("## 终端GPT处置建议（供参考，人工确认后转为已处置/待处置）\n")
    md.append(dispose_done.strip() or "（无）")
    md.append("")

    md.append("## 进程树概览\n```")
    md.extend(walk_nodes(gpt_input.get("treeList", [])))
    md.append("```\n")

    # ── 写文件（全部写入事件文件夹，过程文件不丢弃） ──
    p = os.path.join(out_root, prefix)

    # 原始 GPTRawLog 副本归档进事件文件夹
    import shutil
    shutil.copy2(args.file, os.path.join(out_root, os.path.basename(args.file)))

    with open(p + "_分析输入.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    with open(p + "_gptInput.json", "w", encoding="utf-8") as f:
        json.dump(gpt_input, f, ensure_ascii=False, indent=2)
    with open(p + "_基础信息.json", "w", encoding="utf-8") as f:
        json.dump(basic, f, ensure_ascii=False, indent=2)

    print(f"事件文件夹: {out_root}")
    print(f" {os.path.basename(p)}_分析输入.md")
    print(f" {os.path.basename(p)}_gptInput.json")
    print(f" {os.path.basename(p)}_基础信息.json")
    print(f" {os.path.basename(args.file)}（原始日志副本）")
    print(f"判定标签: {answer['tag']} | 事件: {event_name}")


if __name__ == "__main__":
    main()
