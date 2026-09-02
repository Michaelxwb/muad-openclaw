#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
深信服威胁情报查询封装
======================
统一封装深信服云查接口，支持 域名 / IP / IP+端口 三类 IoC 的信誉与威胁标签查询。

依赖 cloud_query_ioc.py 的 token 获取与基础 HTTP 请求。

用法（作为模块被 generate_reply.py 调用）：
    from ti_query import query_ioc
    res = query_ioc("jdhhbs.biz")            # 域名
    res = query_ioc("140.143.229.64")        # 目的IP
    res = query_ioc("140.143.229.64:49001")  # 目的IP+端口
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cloud_query_ioc as _c

# =============================================================================
# 信誉值含义映射（与深信服云查保持一致）
# =============================================================================
REPUTATION_MAP = {
    "0": "恶意",
    "1": "安全",
    "2": "未知",
    "3": "可疑",
    "": "查询失败",
}

# 信誉值排序（-1 表示失败/未知），用于结果展示时优先给恶意/可疑
_REP_RANK = {"0": 0, "3": 1, "1": 2, "2": 3, "": 4}


def _rep_text(rep_value) -> str:
    """将原始信誉值转为中文描述。"""
    if rep_value is None:
        return "查询失败"
    return REPUTATION_MAP.get(str(rep_value), f"未知({rep_value})")


def parse_ip_threat(record: dict) -> dict:
    """从 IP 云查的单条记录中提取信誉与威胁标签。"""
    ip = record.get("ip", "")
    threat = record.get("threat", {}) or {}
    rep_value = threat.get("reputation", "")
    # 威胁标签可能存在于 threatLabels 或 threatTags（ip/port 两个维度）
    labels = []
    for key in ("threatLabels", "threatTags"):
        tl = threat.get(key, {})
        if isinstance(tl, dict):
            for dim in ("ip", "port"):
                for item in (tl.get(dim) or []):
                    if isinstance(item, str) and item:
                        labels.append(item)
                    elif isinstance(item, dict):
                        for f in ("tag", "label", "name", "family", "category"):
                            v = item.get(f)
                            if v:
                                labels.append(v)
                                break
    # network 信息（如 IDC / 代理）
    network = (record.get("network") or {}).get("networkType", "")
    return {
        "ioc": ip,
        "reputation_value": rep_value,
        "reputation": _rep_text(rep_value),
        "threat_labels": list(dict.fromkeys(labels)),  # 去重保序
        "network_type": network,
    }


def parse_domain_threat(rep_value, tag) -> dict:
    """将域名云查结果（reputation + 标签字符串）整理成统一结构。"""
    return {
        "ioc": "",
        "reputation_value": rep_value,
        "reputation": _rep_text(rep_value),
        "threat_labels": [t for t in str(tag).split("、") if t] if tag else [],
        "network_type": "",
    }


def ip_reputation(ip: str, port: str = None) -> dict:
    """查询 IP（或 IP+端口）信誉与威胁标签。direction=2。"""
    ipinfo = {"ip": ip, "direction": 2}
    if port:
        try:
            ipinfo["port"] = int(port)
        except (TypeError, ValueError):
            ipinfo["port"] = port
    token = _c._get_token()
    url = f"{_c._BASE_URL}/v2/analysis/ip/reputation?_method=GET&token={token}"
    params = _c._build_params(ipsInfo=[ipinfo], types=["cf"])
    result = _c.make_post(url, payload=params)
    if result is None:
        return {"ioc": (f"{ip}:{port}" if port else ip), "reputation_value": "",
                "reputation": "查询失败", "threat_labels": [], "network_type": ""}
    try:
        data = result.json().get("data", [])
        if not data:
            return {"ioc": (f"{ip}:{port}" if port else ip), "reputation_value": "",
                    "reputation": "查询失败", "threat_labels": [], "network_type": ""}
        parsed = parse_ip_threat(data[0])
        # 保证 ioc 显示为原始输入（含端口）
        parsed["ioc"] = f"{ip}:{port}" if port else ip
        return parsed
    except Exception as e:
        return {"ioc": (f"{ip}:{port}" if port else ip), "reputation_value": "",
                "reputation": f"查询失败({e})", "threat_labels": [], "network_type": ""}


def domain_reputation(domain: str) -> dict:
    """查询域名信誉与威胁标签。"""
    try:
        results = _c.domain_v2_repu([domain])
        rep_value, tag = results.get(domain, ("", ""))
        parsed = parse_domain_threat(rep_value, tag)
        parsed["ioc"] = domain
        return parsed
    except Exception as e:
        return {"ioc": domain, "reputation_value": "", "reputation": f"查询失败({e})",
                "threat_labels": [], "network_type": ""}


def is_ip(value: str) -> bool:
    """判断是否 IPv4 地址（纯数字点分四段）。"""
    if not value:
        return False
    parts = value.split(".")
    if len(parts) != 4:
        return False
    return all(p.isdigit() for p in parts)


def query_ioc(ioc: str, dst_port: str = None) -> dict:
    """按 IoC 类型分发查询。

    Args:
        ioc: 目的 IoC（域名 或 IP）
        dst_port: 目的端口（可选，仅 IP 场景生效）
    Returns:
        dict: 包含 ioc / reputation_value / reputation / threat_labels / network_type
    """
    if is_ip(ioc):
        return ip_reputation(ioc, dst_port)
    return domain_reputation(ioc)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="深信服情报自查（开发调试）")
    parser.add_argument("--ioc", required=True, help="IoC（域名/IP/IP+端口）")
    args = parser.parse_args()

    ioc = args.ioc
    port = None
    if ":" in ioc and ioc.count(":") == 1:
        p, port = ioc.rsplit(":", 1)
        if is_ip(p) and port.isdigit():
            ioc, port = p, port

    res = query_ioc(ioc, port)
    print(json.dumps(res, ensure_ascii=False, indent=2))
