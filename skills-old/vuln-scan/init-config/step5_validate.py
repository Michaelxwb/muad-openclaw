#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
步骤5：接收用户输入并校验
"""
import re
import json
from typing import Tuple, List, Optional

SKILL_ROOT = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan"
INIT_CONFIG_TEMPLATES = fr"{SKILL_ROOT}\init-config\templates"
RUN_VULN_SCAN = fr"{SKILL_ROOT}\run-vuln-scan"
sys_import = __import__("sys")
sys_import.path.insert(0, RUN_VULN_SCAN)


def _load_field_mapping() -> dict:
    path = fr"{INIT_CONFIG_TEMPLATES}\field_mapping.json"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_config(company_id: str) -> dict:
    companies_dir = fr"{RUN_VULN_SCAN}\companies"
    config_path = fr"{companies_dir}\{company_id}.json"
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _build_cn_name_to_en_map(fm: dict) -> dict:
    """构建 {中文配置名: 英文key} 映射"""
    result = {}
    for en_key, info in fm.items():
        if isinstance(info, dict) and "cn_name" in info:
            result[info["cn_name"]] = en_key
    # 反向 section 中文key名 → 英文key（en_name 字段）
    for cn_key, info in fm.items():
        if isinstance(info, dict) and "en_name" in info:
            result[cn_key] = info["en_name"]
    return result


def _build_value_map(fm: dict) -> dict:
    """构建 {英文key: {中文值: 数字值}}（从反向 section）"""
    result = {}
    for cn_key, info in fm.items():
        if isinstance(info, dict) and "en_name" in info and "value" in info:
            en_key = info["en_name"]
            if isinstance(info["value"], dict):
                result[en_key] = info["value"]  # {'高': 1, '中': 2, '低': 3}
    return result


def _build_reverse_value_map(fm: dict) -> dict:
    """构建 {英文key: {数字key字符串: 中文值}}"""
    result = {}
    for en_key, info in fm.items():
        if isinstance(info, dict) and "value" in info and isinstance(info["value"], dict):
            result[en_key] = info["value"]  # {"0": "禁用", "1": "启用"}
    return result


# ----------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _fuzzy_match(query: str, target: str) -> bool:
    """
    模糊匹配：容忍1个错别字（插入/删除/替换）
    基于编辑距离算法
    """
    if query == target:
        return True
    # 去除空格后比较
    q_clean = query.replace(" ", "").replace("\t", "")
    t_clean = target.replace(" ", "").replace("\t", "")
    if q_clean == t_clean:
        return True
    return _edit_distance(q_clean, t_clean) <= 1


def _edit_distance(s1: str, s2: str) -> int:
    """计算两个字符串之间的最小编辑距离（只考虑插入/删除/替换）"""
    m, n = len(s1), len(s2)
    if m == 0:
        return n
    if n == 0:
        return m
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i-1] == s2[j-1] else 1
            dp[i][j] = min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
    return dp[m][n]


def _normalize_input(raw_text: str) -> str:
    """
    规范化输入：
    - 中文冒号→英文冒号
    - 中逗号→英文逗号
    - 多空格→单空格
    """
    text = raw_text
    text = text.replace('\u3000', ' ')  # 全角空格
    text = text.replace('\uff1a', ':')  # 全角冒号
    text = text.replace('\uff0c', ',')  # 全角逗号
    text = text.replace('  ', ' ')      # 连续两个空格
    # 重复直到没有连续空格
    while '  ' in text:
        text = text.replace('  ', ' ')
    return text.strip()


def _build_all_cn_names(fm: dict) -> list:
    """
    从 field_mapping.json 中提取所有中文配置名（中英文key名）
    用于模糊匹配提示
    """
    cn_names = []
    for en_key, info in fm.items():
        if isinstance(info, dict):
            if "cn_name" in info and info["cn_name"]:
                cn_names.append(info["cn_name"])
            if "en_name" in info and info["en_name"]:
                cn_names.append(en_key)  # 中文key名
    return cn_names


def _find_similar_cn_names(query: str, fm: dict, threshold: float = 0.6) -> list:
    """
    找到与 query 相似的配置名（用于提示）
    使用字符重叠率作为简单相似度
    """
    all_names = _build_all_cn_names(fm)
    q_clean = query.replace(' ', '')
    similar = []
    for name in all_names:
        n_clean = name.replace(' ', '')
        # 计算字符重叠率
        overlap = sum(1 for c in q_clean if c in n_clean) / max(len(q_clean), len(n_clean))
        if overlap >= threshold:
            similar.append(name)
    return similar[:3]  # 最多返回3个


def _is_valid_ip(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(p) <= 255 for p in parts)
    except ValueError:
        return False


def _is_valid_cidr(cidr: str) -> bool:
    parts = cidr.split("/")
    if len(parts) != 2:
        return False
    if not _is_valid_ip(parts[0]):
        return False
    try:
        prefix = int(parts[1])
        return 0 <= prefix <= 32
    except ValueError:
        return False


def _expand_cidr(cidr: str) -> list:
    """将 CIDR 展开为独立 IP 列表"""
    if not _is_valid_cidr(cidr):
        return [cidr] if _is_valid_ip(cidr) else []
    ip_str, prefix_str = cidr.split("/")
    prefix = int(prefix_str)
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



# ---------------------------------------------------------------------------
# 主校验逻辑
# ---------------------------------------------------------------------------

def validate_and_parse_input(
    raw_text: str,
    current_config: dict,
    company_id: str
) -> Tuple[bool, str, List[dict]]:
    """
    校验用户输入。

    Returns:
        (is_valid, error_message, parsed_lines)
        is_valid=True, error_message="", parsed_lines=[{field_en, value}, ...]
        is_valid=False, error_message=错误描述, parsed_lines=[]
    """
    if not raw_text.strip():
        return False, "输入不能为空", []

    fm = _load_field_mapping()
    cn_to_en = _build_cn_name_to_en_map(fm)
    en_to_values = _build_value_map(fm)  # {en_key: {cn_value: num_value}}

    raw_text = _normalize_input(raw_text)
    lines = [l.strip() for l in raw_text.strip().split("\n") if l.strip()]
    if not lines:
        return False, "输入不能为空", []

    parsed = []  # [{field_en, raw_value, is_special, special_data}, ...]

    for line in lines:
        # 支持 "配置项X：值" 或 "配置项X 值" 格式
        if "：" in line:
            parts = line.split("：", 1)
        elif ":" in line:
            parts = line.split(":", 1)
        else:
            # 尝试中文配置名直接匹配
            # 如果没有分隔符，可能是纯中文配置名直接跟值（中间有空格）
            # 例如 "fuzz测试 启用" 或 "fuzz测试:启用"
            # 这里要求必须有分隔符
            return False, f"格式错误，每行需为「配置项：值」，当前行：「{line}」", []

        field_cn = parts[0].strip()
        value_raw = parts[1].strip() if len(parts) > 1 else ""

        if not field_cn or not value_raw:
            return False, f"格式错误，需为「配置项：值」，当前行：「{line}」", []

        # 匹配字段名（支持模糊匹配）
        # 先精确匹配 cn_to_en 中的中文配置名（普通字段）
        matched_en = None
        if field_cn in cn_to_en:
            matched_en = cn_to_en[field_cn]
        else:
            # 模糊匹配：支持1个错别字（中文配置名）
            best_dist = 999
            best_cn = None
            for cn_name in cn_to_en:
                dist = _edit_distance(field_cn, cn_name)
                if dist <= 1 and dist < best_dist:
                    best_dist = dist
                    best_cn = cn_name
                    break  # 找到第一个编辑距离<=1的直接返回
            if best_cn:
                matched_en = cn_to_en[best_cn]

        # 特殊处理（独立字段，不在 cn_to_en 中）
        if field_cn == "自定义端口":
            return _validate_diy_port(value_raw, current_config, parsed, lines)
        elif field_cn == "指定资产":
            return _validate_asset_list(value_raw, current_config, parsed, lines, company_id, fm)
        elif field_cn == "排除指定资产":
            return _validate_asset_list("排除" + value_raw, current_config, parsed, lines, company_id, fm)

        if matched_en is None:
            # 找不到配置项 → 提供相似字段提示
            similar = _find_similar_cn_names(field_cn, fm)
            if similar:
                return False, f"未找到配置项「{field_cn}」，您是否要输入：「{similar[0]}」", []
            return False, f"未找到配置项「{field_cn}」", []

        # ---- 重复字段名校验 ----
        for prev in parsed:
            if prev["field_en"] == matched_en:
                return False, f"配置项「{field_cn}」输入重复了", []

        # ---- 特殊字段处理 ----
        if matched_en == "__diy_port__":
            return _validate_diy_port(value_raw, current_config, parsed, lines)

        if matched_en == "__asset_list__":
            return _validate_asset_list(value_raw, current_config, parsed, lines, company_id, fm)

        # ---- export_file 嵌套字段 ----
        if matched_en in ("vul_fix_schema", "vul_proof_report"):
            # 写入到 export_file 嵌套 dict
            value_map = en_to_values[matched_en]
            if value_raw not in value_map:
                valid_options = ", ".join(value_map.keys())
                return False, f"配置项「{field_cn}」的有效值包括：{valid_options}，请检查您的输入", []
            parsed.append({
                "field_en": matched_en,
                "raw_value": value_raw,
                "num_value": value_map[value_raw],
                "is_special": False,
                "nested_export": True
            })
            continue

        # ---- 普通字段校验 ----
        if matched_en not in en_to_values:
            # 找不到映射关系时不暴露 field_mapping.json，只提示
            return False, f"配置项「{field_cn}」的有效值包括：{', '.join(list(en_to_values.keys())[:5])}...，请检查您的输入", []

        value_map = en_to_values[matched_en]  # {中文值: 数字值}
        if value_raw not in value_map:
            valid_options = ", ".join(value_map.keys())
            return False, f"配置项「{field_cn}」的有效值包括：{valid_options}，请检查您的输入", []

        parsed.append({
            "field_en": matched_en,
            "raw_value": value_raw,
            "num_value": value_map[value_raw],
            "is_special": False,
            "nested_export": False
        })

    return True, "", parsed


def _validate_diy_port(value_raw: str, current_config: dict, parsed: list, lines: list) -> Tuple[bool, str, list]:
    """
    校验自定义端口输入。
    条件：port_type 必须是 "自定义端口"（当前配置或本轮其他行输入）
    值格式：80,443（逗号分隔，每项 0-65535）
    """
    # 检查 port_type 是否为自定义
    port_type_cn = None
    for p in parsed:
        if p["field_en"] == "port_type":
            port_type_cn = p["raw_value"]
            break

    current_port_type = current_config.get("port_type", "")

    if port_type_cn != "自定义端口" and current_port_type != "diy" and current_port_type != "自定义端口":
        return False, "自定义端口只能在「端口扫描策略」选择「自定义端口」时使用", []

    # 解析端口值
    ports_str = value_raw.split(",")
    valid_ports = []
    for p in ports_str:
        p = p.strip()
        if not p.isdigit():
            return False, f"端口号必须是 0-65535 的整数，当前：「{p}」", []
        port_int = int(p)
        if port_int > 65535:
            return False, f"端口号必须在 0-65535 范围内，当前：「{p}」", []
        valid_ports.append(port_int)

    parsed.append({
        "field_en": "diy_port",
        "raw_value": value_raw,
        "num_value": valid_ports,
        "is_special": True,
        "special_type": "diy_port"
    })
    return True, "", parsed


def _is_valid_url(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    url = url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return False
    # 简单检查：必须有域名前缀
    rest = url.split("://", 1)[1] if "://" in url else url
    return bool(rest) and " " not in rest


def _validate_asset_list(value_raw: str, current_config: dict, parsed: list, lines: list, company_id: str, fm: dict) -> Tuple[bool, str, list]:
    """
    校验指定资产输入。
    条件：asset_mode 必须是 "指定资产"（当前配置或本轮其他行输入）
    值格式：1.1.1.1,2.2.2.2,3.3.3.0/24 或 排除1.1.1.1,2.2.2.2
    """
    # 检查 asset_mode
    asset_mode_cn = None
    for p in parsed:
        if p["field_en"] == "asset_mode":
            asset_mode_cn = p["raw_value"]
            break

    current_asset_mode = current_config.get("asset_mode", "")

    if asset_mode_cn != "指定资产" and current_asset_mode != 1:
        return False, "指定资产只能在「资产范围」选择「指定资产」时使用", []

    # 判断是否为排除模式
    is_exclude = False
    value_clean = value_raw
    if value_raw.startswith("排除"):
        is_exclude = True
        value_clean = value_raw[2:].strip()  # 去掉"排除"前缀

    # 同时支持 ASCII 逗号 和 中文顿号 作为分隔符
    for sep in ["，", "、"]:
        if sep in value_clean:
            value_clean = value_clean.replace(sep, ",")
    elements = [e.strip() for e in value_clean.split(",") if e.strip()]
    if not elements:
        return False, "指定资产不能为空", []

    # 分离服务标签和普通资产元素
    service_tags = []  # [{name, tag_id}, ...]
    normal_elements = []
    for elem in elements:
        if elem == "安全托管服务":
            service_tags.append({"name": "安全托管服务", "tag_id": 3})
        elif elem == "网站监测服务":
            service_tags.append({"name": "网站监测服务", "tag_id": 20})
        elif _is_valid_ip(elem) or _is_valid_cidr(elem) or _is_valid_url(elem):
            normal_elements.append(elem)
        else:
            return False, f"指定资产中每个元素应为 IP、IP段（如 1.1.1.1 或 3.3.3.0/24）、URL、安全托管服务或网站监测服务，当前：「{elem}」", []

    parsed.append({
        "field_en": "asset_list",
        "raw_value": value_raw,
        "num_value": normal_elements,
        "is_special": True,
        "special_type": "asset_list",
        "is_exclude": is_exclude,
        "service_tags": service_tags
    })
    return True, "", parsed