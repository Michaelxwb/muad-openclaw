#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
步骤6：写入配置到 {company_id}.json
"""
import json
import os
import re
from typing import Tuple, List

SKILL_ROOT = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan"
RUN_VULN_SCAN = fr"{SKILL_ROOT}\run-vuln-scan"
INIT_CONFIG_TEMPLATES = fr"{SKILL_ROOT}\init-config\templates"
INIT_CONFIG_ROOT = fr"{SKILL_ROOT}\init-config"

import sys
sys.path.insert(0, RUN_VULN_SCAN)
sys.path.insert(0, INIT_CONFIG_ROOT)

from asset_translator import ip_to_asset_id, fetch_all_assets
from asset_fetch import fetch_assets_by_tag
from shared import get_cookie, log
import urllib.request


def _load_field_mapping() -> dict:
    path = fr"{INIT_CONFIG_TEMPLATES}\field_mapping.json"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_config(company_id: str) -> dict:
    config_path = fr"{RUN_VULN_SCAN}\companies\{company_id}.json"
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_config(company_id: str, config: dict):
    config_path = fr"{RUN_VULN_SCAN}\companies\{company_id}.json"
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def _build_value_map(fm: dict) -> dict:
    """构建 {英文key: {中文值: 数字值}}"""
    result = {}
    for en_key, info in fm.items():
        if isinstance(info, dict) and "value" in info and isinstance(info["value"], dict):
            result[en_key] = info["value"]
    return result


def _expand_cidr(cidr: str) -> list:
    """将 CIDR 或 IP 展开为独立 IP 列表"""
    parts = cidr.split("/")
    ip_str = parts[0]
    prefix = int(parts[1]) if len(parts) == 2 else 32

    ip_parts = [int(p) for p in ip_str.split(".")]
    ip_int = (ip_parts[0] << 24) | (ip_parts[1] << 16) | (ip_parts[2] << 8) | ip_parts[3]

    if prefix == 32:
        start = end = ip_int
    else:
        mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
        start = ip_int & mask
        end = start | (~mask & 0xFFFFFFFF)

    if prefix <= 30:
        start += 1
        end -= 1

    return [f"{(i >> 24) & 0xFF}.{(i >> 16) & 0xFF}.{(i >> 8) & 0xFF}.{i & 0xFF}"
            for i in range(start, end + 1) if start <= end]


def _write_asset_list(config: dict, company_id: str, item: dict) -> dict:
    """
    处理指定资产写入。
    - 先处理 service_tags（安全托管服务/网站监测服务），通过 fetch_assets_by_tag 获取IP
    - 展开 CIDR 为独立 IP 列表
    - 判断是排除还是包含
    - 调用 ip_to_asset_id 转换为 asset_id 列表
    """
    elements = item["num_value"]
    is_exclude = item.get("is_exclude", False)
    service_tags = item.get("service_tags", [])

    all_input_ips = []

    # 处理服务标签：调用资产查询 API 获取对应 tag 的资产 IP
    for stag in service_tags:
        cookie = get_cookie()
        if not cookie:
            raise RuntimeError(f"无法获取 Cookie，不能查询{stag['name']}的资产列表")
        tag_ips = fetch_assets_by_tag(
            company_id=company_id,
            cookie=cookie,
            asset_tag=[stag["tag_id"]]
        )
        log(f"[INFO] {stag['name']} (tag={stag['tag_id']}) 获取到 {len(tag_ips)} 个资产IP", "INFO")
        all_input_ips.extend(tag_ips)

    # 处理普通 IP/CIDR/URL 元素
    for elem in elements:
        expanded = _expand_cidr(elem)
        all_input_ips.extend(expanded)

    all_input_ips = list(set(all_input_ips))

    all_assets = fetch_all_assets(company_id)
    all_ips = [a["asset"] for a in all_assets if a.get("asset")]

    if is_exclude:
        remaining_ips = sorted(set(all_ips) - set(all_input_ips))
        target_ips = remaining_ips
    else:
        target_ips = all_input_ips

    asset_ids = ip_to_asset_id(company_id, target_ips)
    asset_ids = [aid for aid in asset_ids if aid]

    config["asset_list"] = asset_ids
    return config


# ---------------------------------------------------------------------------
# 主写入逻辑
# ---------------------------------------------------------------------------

def write_config(company_id: str, parsed_lines: list) -> Tuple[bool, str]:
    """
    将解析后的配置写入 {company_id}.json。

    parsed_lines: [{field_en, raw_value, num_value, is_special, special_type, is_exclude}, ...]
    """
    config = _load_config(company_id)
    fm = _load_field_mapping()
    en_to_values = _build_value_map(fm)

    for item in parsed_lines:
        field_en = item["field_en"]
        is_special = item.get("is_special", False)

        if is_special:
            if item["special_type"] == "diy_port":
                config["diy_port"] = item["num_value"]
            elif item["special_type"] == "asset_list":
                config = _write_asset_list(config, company_id, item)
        else:
            if field_en in ("vul_fix_schema", "vul_proof_report"):
                if "export_file" not in config:
                    config["export_file"] = {}
                config["export_file"][field_en] = item["num_value"]
            else:
                config[field_en] = item["num_value"]

    # 清理相关字段：如果本次输入切换为非自定义端口，清空 diy_port；
    # 如果切换为非指定资产，清空 asset_list
    for item in parsed_lines:
        field_en = item["field_en"]
        if field_en == "port_type":
            port_type_val = item.get("num_value", "")
            if isinstance(port_type_val, str) and port_type_val not in ("diy", "自定义端口"):
                config["diy_port"] = []
        elif field_en == "asset_mode":
            asset_mode_val = item.get("num_value", 0)
            if isinstance(asset_mode_val, int) and asset_mode_val != 1:
                config["asset_list"] = []

    _save_config(company_id, config)
    return True, ""


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python step6_write.py <公司名称> <修改行>", flush=True)
        sys.exit(1)

    company_name = sys.argv[1]
    raw_input = sys.argv[2]

    from phase1.phase1_prepare.phase1_company import resolve_company
    from shared import get_cookie
    cookie = get_cookie()
    _, company_id = resolve_company(company_name, cookie)

    from step5_validate import validate_and_parse_input
    current_config = _load_config(company_id)
    is_valid, error_msg, parsed_lines = validate_and_parse_input(raw_input, current_config, company_id)

    if not is_valid:
        print("校验失败: " + error_msg, flush=True)
        sys.exit(1)

    ok, err = write_config(company_id, parsed_lines)
    if not ok:
        print("写入失败: " + err, flush=True)
        sys.exit(1)

    print("[OK] 配置已写入", flush=True)

    # ---- 通过 webhook 发送配置到企微群 ----
    try:
        # 重新加载写入后的配置，生成展示文本后发送
        import importlib
        import init_config_display
        importlib.reload(init_config_display)
        display_text, _ = init_config_display.display_current_config(company_name, include_ending=False, send_webhook=False)

        # 直接从 SKILL_ROOT 定位 webhook_config.json，避免 __file__ 路径漂移
        webhook_config_path = os.path.join(os.path.dirname(SKILL_ROOT), "webhook_config.json")
        with open(webhook_config_path, "r", encoding="utf-8") as wf:
            webhook_url = json.load(wf)["webhook_url"]
        data = json.dumps({
            "msgtype": "text",
            "text": {"content": display_text}
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(webhook_url, data=data,
                                    headers={"Content-Type": "application/json; charset=utf-8"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            r = json.loads(resp.read().decode("utf-8"))
            if r.get("errcode") == 0:
                print("[OK] 已通过企微群推送配置", flush=True)
            else:
                print(f"[WARNING] 企微群推送失败: {r}", flush=True)
    except Exception as e:
        print(f"[WARNING] 企微群推送异常: {e}", flush=True)
