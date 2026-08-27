#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""事件表中 C2 / 病毒木马的统一分类规则。"""

import re


SEVERE_LABEL = "黑"
GPT_HOST_COMPROMISE = "主机失陷活动"
GPT_VIRUS_TROJAN = "病毒木马活动"
CLASS_C2 = "C2外联"
CLASS_VIRUS_TROJAN = "病毒木马"
CLASSIFICATION_SUFFIX_RE = re.compile(r"[（(](?:C2外联|病毒木马)[）)]$")


def normalize(value):
    return "" if value is None else str(value).strip()


def build_col_map(ws):
    header = [normalize(cell) for cell in next(ws.iter_rows(values_only=True))]
    return {name: i for i, name in enumerate(header) if name}


def find_column(col_map, aliases):
    for alias in aliases:
        if alias in col_map:
            return col_map[alias]
    return None


def extract_severe_entities(raw):
    """提取实体（黑）形式的黑标记实体。"""
    text = normalize(raw)
    if not text:
        return []

    matches = re.findall(r"([^，,、()（）]+?)\s*[（(]\s*([^()（）]+?)\s*[）)]", text)
    return [normalize(entity) for entity, severity in matches if normalize(severity) == SEVERE_LABEL]


def base_gpt_conclusion(value):
    """去掉本规则追加的后缀，保证重复处理不会重复追加。"""
    text = normalize(value)
    return CLASSIFICATION_SUFFIX_RE.sub("", text).strip()


def classify_event(gpt_value, row, columns):
    """返回 C2外联、病毒木马或 None；网络实体优先于文件实体。"""
    base_value = base_gpt_conclusion(gpt_value)
    if base_value not in (GPT_HOST_COMPROMISE, GPT_VIRUS_TROJAN):
        return None

    network_columns = (
        columns.get("external_ip"),
        columns.get("domain"),
    )
    if any(index is not None and len(row) > index and extract_severe_entities(row[index]) for index in network_columns):
        return CLASS_C2

    file_index = columns.get("file")
    if file_index is not None and len(row) > file_index and extract_severe_entities(row[file_index]):
        return CLASS_VIRUS_TROJAN

    return None


def get_classification_columns(col_map):
    return {
        "id": find_column(col_map, ["事件ID", "事件Id", "incident_id", "incidentId", "id", "ID"]),
        "gpt": find_column(col_map, ["GPT研判结论"]),
        "external_ip": find_column(col_map, ["外网IP地址", "外网IP", "外网IP地址(标签)"]),
        "domain": find_column(col_map, ["域名", "外联域名", "域名(标签)"]),
        "file": find_column(col_map, ["文件", "文件MD5", "md5", "file", "文件(标签)"]),
    }


def format_gpt_conclusion(value, classification):
    base_value = base_gpt_conclusion(value)
    if not classification:
        return base_value
    return f"{base_value}（{classification}）"
