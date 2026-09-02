#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
初始化/修改客户配置流程 - 展示当前配置（步骤1-4）
Windows 下必须以 UTF-8 模式运行，禁止使用默认的 GBK/CP936 编码。
"""
import sys, os
if sys.platform == "win32":
    import io
    for stream in [sys.stdout, sys.stderr]:
        if isinstance(stream, io.TextIOWrapper) and stream != sys.__stdout__:
            stream.reconfigure(encoding="utf-8", errors="replace")

import json

# 路径设置
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_VULN_SCAN = os.path.join(SKILL_ROOT, "run-vuln-scan")
COMPANIES_DIR = os.path.join(RUN_VULN_SCAN, "companies")
TEMPLATES_DIR = os.path.join(RUN_VULN_SCAN, "templates")
INIT_CONFIG_TEMPLATES = os.path.join(SKILL_ROOT, "init-config", "templates")

sys.path.insert(0, RUN_VULN_SCAN)
from shared import get_cookie, log
import urllib.request
import json
from phase1.phase1_prepare.phase1_company import resolve_company


# =============================================================================
# 1. 加载模板和字段映射
# =============================================================================

def _load_field_mapping() -> dict:
    path = os.path.join(INIT_CONFIG_TEMPLATES, "field_mapping.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_display_template() -> str:
    path = os.path.join(INIT_CONFIG_TEMPLATES, "config_display_template.txt")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _load_display_template_ending() -> str:
    path = os.path.join(INIT_CONFIG_TEMPLATES, "config_display_template_ending.txt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return ""


# =============================================================================
# 2. 配置初始化（无配置时复制模板）
# =============================================================================

def ensure_config_exists(company_id: str) -> bool:
    config_path = os.path.join(COMPANIES_DIR, f"{company_id}.json")
    if os.path.exists(config_path):
        return False

    default_path = os.path.join(TEMPLATES_DIR, "default_user_config.json")
    with open(default_path, "r", encoding="utf-8") as f:
        default_config = json.load(f)

    os.makedirs(COMPANIES_DIR, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(default_config, f, ensure_ascii=False, indent=2)

    log(f"新公司配置已创建: {config_path}", "INFO")
    return True


# =============================================================================
# 3. 构建字段映射表
# =============================================================================

def _build_mapping_tables(fm: dict) -> tuple:
    en_key_to_cn = {}
    cn_name_to_info = {}

    for en_key, field_info in fm.items():
        if not isinstance(field_info, dict):
            continue
        cn_name = field_info.get("cn_name", "")
        value_map = field_info.get("value", {})

        if cn_name and en_key:
            en_key_to_cn[en_key] = cn_name
            cn_name_to_info[cn_name] = {
                "en": en_key,
                "values": value_map
            }

    return en_key_to_cn, cn_name_to_info


# =============================================================================
# 4. 翻译配置值
# =============================================================================

def _translate_value(en_key: str, value, fm: dict) -> str:
    if en_key not in fm:
        return str(value)
    value_map = fm[en_key].get("value", {})
    if isinstance(value, str):
        return value_map.get(value, str(value))
    else:
        return value_map.get(str(value)) or value_map.get(value, str(value))


def _generate_modify_hints(raw_config: dict, fm: dict, level1: dict) -> str:
    """
    根据当前配置动态生成修改提示区块。
    规则：
    - 普通字段：配置项中文名：当前值
    - 端口类型为自定义时：追加一行「自定义端口：当前值」
    - 资产模式为指定时：追加一行「指定资产：当前值或为空」
    """
    lines = []

    # 端口扫描策略 → 自定义端口提示
    port_type = raw_config.get("port_type", "")
    if port_type == "diy":
        diy = raw_config.get("diy_port", [])
        lines.append(f"自定义端口：{','.join(map(str, diy)) if diy else '[未配置]'}")

    # 资产范围 → 指定资产提示
    asset_mode = raw_config.get("asset_mode", 0)
    if asset_mode == 1:
        asset_list = raw_config.get("asset_list", [])
        if asset_list:
            lines.append(f"指定资产：{len(asset_list)} 个资产ID（已在下方展示）")
        else:
            lines.append("指定资产：[未配置]")

    # 如果没有特殊字段，显示通用格式
    if not lines:
        return "配置项X：值X"

    # 加上通用格式说明
    base = "\n".join(lines)
    base += "\n配置项X：值X（支持多行）"
    return base


def _translate_one_level(raw: dict, fm: dict) -> dict:
    SKIP_KEYS = {"asset_list", "diy_port", "export_file", "task_type", "port_alive"}
    result = {}
    for key, value in raw.items():
        if key in SKIP_KEYS:
            continue
        result[key] = _translate_value(key, value, fm)
    return result


def _translate_export_file(raw: dict, fm: dict) -> dict:
    export_file = raw.get("export_file", {})
    if not export_file:
        return {}
    return {
        "vul_fix_schema": _translate_value("vul_fix_schema", export_file.get("vul_fix_schema", 0), fm),
        "vul_proof_report": _translate_value("vul_proof_report", export_file.get("vul_proof_report", 0), fm),
    }


def _build_cn_name_to_en_map(fm: dict) -> dict:
    _, cn_name_to_info = _build_mapping_tables(fm)
    return {cn: info["en"] for cn, info in cn_name_to_info.items()}


# =============================================================================
# 5. 组装展示文本（含二级字段）
# =============================================================================

def _merge_into_template(template: str, level1: dict, export_file_level: dict,
                        raw_config: dict, fm: dict) -> str:
    """
    将翻译后的配置值融入展示模板，并追加二级字段展示行。

    二级字段处理规则：
    - diy_port（自定义端口）：仅当 port_type="diy"（自定义端口）且 diy_port 非空时
      在"当前选择：自定义端口"行后追加"自定义端口：[111, 222]"
    - asset_list（资产列表）：仅当 asset_mode=1（指定资产）且 asset_list 非空时
      在"当前选择：指定资产"行后追加"资产列表：[IP1, IP2, ...] ..."
      调用 asset_id_to_ip 将 asset_id 列表转为 IP 列表后展示
    """
    cn_name_to_en = _build_cn_name_to_en_map(fm)

    lines = template.split("\n")
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]
        result.append(line)

        if line.strip().startswith("当前选择：") and line.strip() == "当前选择：":
            # 向上找最近的"配置项N：中文配置名"
            cn_key = None
            for j in range(len(result) - 2, -1, -1):
                prev = result[j].strip()
                if prev.startswith("配置项") and "：" in prev:
                    cn_key = prev.split("：", 1)[1].strip()
                    break

            display_value = ""
            if cn_key and cn_key in cn_name_to_en:
                en_key = cn_name_to_en[cn_key]
                if en_key in level1:
                    display_value = level1[en_key]
                elif en_key in export_file_level:
                    display_value = export_file_level[en_key]

            result[-1] = f"当前选择：{display_value}"

            # 消费下一行空行（如果存在）
            if i + 1 < len(lines) and lines[i + 1].strip() == "":
                i += 1
                result.append(lines[i])

            # 处理二级字段追加，追加后在本行末尾加空行（与下一配置项之间）
            appended = _append_secondary_lines(result, cn_key, en_key, display_value, raw_config, fm)
            if appended:
                # 二级字段紧跟主配置项，两者之间无空行；二级字段之后才加空行
                result.append("")

        i += 1

    return "\n".join(result)


def _append_secondary_lines(result: list, cn_key: str, en_key: str,
                            display_value: str, raw_config: dict, fm: dict) -> bool:
    """
    根据当前配置项的 en_key 和显示值，决定是否追加二级字段行。
    返回是否追加了内容。
    """
    # 端口扫描策略 → 二级：自定义端口
    if en_key == "port_type" and display_value == "自定义端口":
        diy_port = raw_config.get("diy_port", [])
        if diy_port:
            result.append(f"自定义端口：{diy_port}")
            return True
        return False

    # 资产范围 → 二级：资产列表
    elif en_key == "asset_mode" and display_value == "指定资产":
        asset_list = raw_config.get("asset_list", [])
        if asset_list:
            from asset_translator import fetch_all_assets
            company_id = raw_config.get("company_id", "")

            # 当前资产列表的 IP
            from asset_translator import asset_id_to_ip
            ip_list = asset_id_to_ip(company_id, asset_list)
            current_ips = [ip for ip in ip_list if ip]

            if not current_ips:
                return False

            # 全量资产 IP
            all_assets = fetch_all_assets(company_id)
            all_ips = [a["asset"] for a in all_assets if a.get("asset")]

            # 排除的 IP = 全量 - 当前
            excluded_ips = sorted(set(all_ips) - set(current_ips))

            # 展示当前资产列表
            if len(current_ips) <= 5:
                result.append(f"资产列表：{current_ips}")
            else:
                shown = current_ips[:5]
                result.append(f"资产列表：{shown} ... (共 {len(current_ips)} 个资产IP)")

            # 当当前IP数量 >= 全量资产总数的90%时，追加排除列表
            if len(all_ips) > 0 and len(current_ips) / len(all_ips) >= 0.9:
                if excluded_ips:
                    excl_shown = excluded_ips[:5] if len(excluded_ips) > 5 else excluded_ips
                    excl_note = f"，相当于排除掉{excl_shown}... (共 {len(excluded_ips)} 个资产IP)" if len(excluded_ips) > 5 else f"，相当于排除掉{excl_shown} (共 {len(excluded_ips)} 个资产IP)"
                    result[-1] += excl_note
            return True
        return False

    return False


# =============================================================================
# 6. 主入口：展示当前配置
# =============================================================================

def display_current_config(company_name: str, include_ending: bool = True, send_webhook: bool = False, direct_company_id: str = None) -> str:
    """
    展示当前配置。
    include_ending=False 时不拼接 ending。
    send_webhook=True 时通过 webhook 推送到企微群。
    """
    cookie = get_cookie()
    if not cookie:
        return "❌ 未找到 Cookie，请检查 cookies.txt"

    if direct_company_id:
        from phase1.phase1_prepare.phase1_company import resolve_company_by_id
        resolved_name, company_id = resolve_company_by_id(direct_company_id, cookie)
    else:
        resolved_name, company_id = resolve_company(company_name, cookie)
    is_new = ensure_config_exists(company_id)

    config_path = os.path.join(COMPANIES_DIR, f"{company_id}.json")
    with open(config_path, "r", encoding="utf-8") as f:
        raw_config = json.load(f)

    raw_config["company_id"] = company_id

    fm = _load_field_mapping()
    level1 = _translate_one_level(raw_config, fm)
    export_file_level = _translate_export_file(raw_config, fm)

    template = _load_display_template()
    ending = _load_display_template_ending()
    display_text = _merge_into_template(template, level1, export_file_level, raw_config, fm)

    if include_ending and ending:
        display_text += "\n\n" + ending + "\n"

    new_tag = " [新配置已创建]" if is_new else ""

    header = f"""===== 客户配置信息 =====
{resolved_name}{new_tag}

{display_text}"""
    webhook_sent = False

    if send_webhook:
        try:
            import urllib.request
            webhook_config_path = os.path.join(os.path.dirname(SKILL_ROOT), "webhook_config.json")
            with open(webhook_config_path, "r", encoding="utf-8") as wf:
                webhook_url = json.load(wf)["webhook_url"]
            data = json.dumps({"msgtype": "text", "text": {"content": header}}, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(webhook_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                r = json.loads(resp.read().decode("utf-8"))
                if r.get("errcode") == 0:
                    webhook_sent = True
        except Exception:
            pass

    return header, webhook_sent


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python init_config_display.py <公司名称> [--output-file <文件路径>] [--company-id <id>]", flush=True)
        sys.exit(1)

    company_name = sys.argv[1]
    # 支持 --company-id 参数直接指定ID，绕过 resolve_company
    direct_company_id = None
    if "--company-id" in sys.argv:
        idx = sys.argv.index("--company-id")
        if idx + 1 < len(sys.argv):
            direct_company_id = sys.argv[idx + 1]

    # 可选：输出到文件而非 stdout
    output_file = None
    split = False
    include_ending = True
    for arg in sys.argv[2:]:
        if arg == "--no-ending":
            include_ending = False
        elif arg == "--split":
            split = True
        elif arg == "--output-file":
            continue  # handled below

    if "--output-file" in sys.argv:
        idx = sys.argv.index("--output-file")
        if idx + 1 < len(sys.argv):
            output_file = sys.argv[idx + 1]

    # split 模式：主体不含 ending，ending 单独一个文件
    result_include_ending = not split
    result, webhook_sent = display_current_config(company_name, include_ending=result_include_ending,
                                                    send_webhook=True, direct_company_id=direct_company_id)

    if split and output_file:
        # 拆分：主体配置（不含 ending）+ ending 分开写入两个文件
        base = output_file.replace(".txt", "")
        part1_path = base + "_part1.txt"
        part2_path = base + "_part2.txt"
        ending = _load_display_template_ending()
        # 主体不含 ending
        try:
            with open(part1_path, "w", encoding="utf-8") as f:
                f.write(result[0])
                f.flush()
            print(f"[OK] 配置主体已写入: {part1_path}", flush=True)
        except Exception as e:
            print(f"[WARN] 写入配置主体失败: {e}", flush=True)
        # ending 单独一个文件
        try:
            with open(part2_path, "w", encoding="utf-8") as f:
                f.write(ending)
                f.flush()
            print(f"[OK] Ending 已写入: {part2_path}", flush=True)
        except Exception as e:
            print(f"[WARN] 写入 Ending 失败: {e}", flush=True)
    elif output_file:
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(result[0])
                f.flush()
        except Exception as e:
            print(f"[ERROR] 写入配置失败: {e}", flush=True)
            sys.exit(1)
        with open(output_file, 'r', encoding='utf-8') as f:
            verified = f.read()
        if verified == result[0]:
            print(f"[OK] 配置已写入: {output_file}", flush=True)
        else:
            print(f"[ERROR] 写入验证失败，内容长度不匹配", flush=True)
            sys.exit(1)
        if webhook_sent:
            print("[OK] 已通过企微群推送配置", flush=True)
        else:
            print("[WARNING] 企微群推送失败", flush=True)
    else:
        # 未指定文件时走临时文件中转（兼容旧逻辑）
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', delete=False, suffix='.txt') as f:
            f.write(result[0])
            tmp_path = f.name
        with open(tmp_path, 'r', encoding='utf-8') as f:
            verified = f.read()
        import os
        os.remove(tmp_path)
        print(verified, flush=True)
