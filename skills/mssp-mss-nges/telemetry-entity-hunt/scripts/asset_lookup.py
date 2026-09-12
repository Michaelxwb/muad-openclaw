# -*- coding: utf-8 -*-
"""
telemetry-entity-hunt 资产查询模块（MSSP 资产库）。

职责：拿到「全网排查」阶段得到的 agentId（agent_id）后，去 MSSP 资产库
（asset-mgr-service/order/v1/asset）按 agentId 查询该实体命中的终端资产，
从该 agentId 对应的**多条**资产记录中选出**最相关、信息最全、最新**的一条，
并返回该资产的**全部字段**，供最终输出「全网排查命中xx终端 + 终端资产详情」。

选择规则（依次比较）：
  1. 存活优先：is_alive=1（在线）优于 is_alive=0；
  2. 信息完整度：非空字段数量（含 hostname/os/mac/owner/business_name 等关键字段加权）；
  3. 最新：update_time 越大越新。
  第 1 条优先，其次第 2 条，最后第 3 条。

登录态：复用 monitor-mssp-events 的 session-manager 约定（cookie 由平台代管，不落盘）。
"""
import json
import os
import sys

# 复用老平台共享模块（session / http / 端点）
_SHARED_DIR = "/opt/openclaw-skills/monitor-mssp-events/scripts"
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)

import shared  # noqa: E402

# 资产类型编码 -> 中文（与 monitor-mssp-events 保持一致）
ASSET_TYPE_CN = {"endpoint": "终端", "server": "服务器", "1": "终端", "2": "服务器"}
BUSINESS_LEVEL_CN = {1: "核心", 2: "重要", 3: "一般", "1": "核心", "2": "重要", "3": "一般"}

# 关键字段权重（信息完整度评分时，关键字段权重更高）
KEY_FIELDS = {
    "hostname": 3, "asset": 3, "os": 2, "mac_address": 2,
    "business_name": 2, "business_level": 1, "asset_owner_name": 1,
    "asset_owner_mobile": 1, "asset_group_name": 1, "asset_type": 1,
}


def _fetch_assets_by_agent(cookie: str, agent_id: str, company_id: str):
    """按 agentId 查询资产列表，返回原始 list（可能多条）。"""
    url = shared.get_endpoint("asset_query")
    headers = shared.build_headers(cookie)
    payload = {
        "order": "asc", "offset": 0, "limit": 50, "service_status": [], "is_alive": -1,
        "ip_url_keyword": "", "asset_type": [], "business_level": [], "first_time": [],
        "update_time": [], "keyword": str(agent_id).strip(), "asset_tag": [], "agent_status": [],
        "af_defend_status": "", "database": [], "middleware": [], "os": [],
        "developing_languages": [], "development_framework": [], "server_port": [],
        "company_id": str(company_id).strip(), "asset_group_id": "all", "authorization_type": [],
    }
    resp = shared.http_json("POST", url, headers, payload=payload)
    data = resp.json()
    if not isinstance(data, dict) or data.get("code") != 0:
        raise RuntimeError(
            f"asset_query 返回异常 code={data.get('code') if isinstance(data, dict) else '?'}"
        )
    body = data.get("data") or {}
    lst = body.get("list") if isinstance(body, dict) else None
    return [a for a in lst if isinstance(a, dict)] if isinstance(lst, list) else []


def _info_score(asset: dict) -> int:
    """信息完整度评分：非空字段计数 + 关键字段加权。"""
    score = 0
    for k, v in asset.items():
        if v in (None, "", [], {}):
            continue
        score += 1 + KEY_FIELDS.get(k, 0)
    return score


def pick_best_asset(assets):
    """从同一 agentId 的多条资产中选出最相关、信息最全、最新的一条。

    返回 (asset_dict, reason_str)。
    """
    if not assets:
        return None, ""
    scored = []
    for a in assets:
        alive = 1 if str(a.get("is_alive")) == "1" else 0
        score = _info_score(a)
        try:
            upd = int(a.get("update_time") or 0)
        except (TypeError, ValueError):
            upd = 0
        scored.append((alive, score, upd, a))
    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    best = scored[0][3]
    reasons = []
    if len(assets) > 1:
        reasons.append(f"共 {len(assets)} 条资产，按存活>信息完整度>最新筛选")
    if scored[0][0] == 1:
        reasons.append("在线")
    reasons.append(f"信息完整度={scored[0][1]}")
    return best, "；".join(reasons)


def describe_short(asset: dict) -> str:
    """一句话摘要：例如 “192.168.55.160（DESKTOP-E3PL0DT / 终端 / Windows）”。"""
    if not asset:
        return "未知终端"
    at = asset.get("asset_type", "")
    at_cn = ASSET_TYPE_CN.get(str(at), str(at))
    parts = [asset.get("asset") or "—"]
    extra = "/".join(x for x in [asset.get("hostname"), at_cn, asset.get("os")] if x)
    return f"{parts[0]}（{extra}）" if extra else parts[0]


def describe_asset(asset: dict) -> str:
    """把单条资产整理成可读的多行中文摘要（含全部关键信息）。"""
    if not asset:
        return "（未查询到该终端资产信息）"
    at = asset.get("asset_type", "")
    at_cn = ASSET_TYPE_CN.get(str(at), str(at))
    bl = asset.get("business_level")
    bl_cn = BUSINESS_LEVEL_CN.get(bl, bl)
    lines = [
        f"  - 资产IP：{asset.get('asset') or '—'}",
        f"  - 主机名：{asset.get('hostname') or '—'}",
        f"  - 资产类型：{at_cn}（{at}）",
        f"  - 操作系统：{asset.get('os') or '—'}",
        f"  - MAC：{asset.get('mac_address') or '—'}",
        f"  - 业务名称：{asset.get('business_name') or '—'}",
        f"  - 业务等级：{bl_cn}",
        f"  - 资产分组：{asset.get('asset_group_name') or '—'}",
        f"  - 存活状态：{'在线' if str(asset.get('is_alive')) == '1' else '离线'}",
        f"  - 责任人：{asset.get('asset_owner_name') or '—'}（{asset.get('asset_owner_mobile') or '无手机'}）",
        f"  - agentId：{asset.get('agent_id') or '—'}",
        f"  - 首次发现：{asset.get('first_time') or '—'}",
        f"  - 最近更新：{asset.get('update_time') or '—'}",
    ]
    return "\n".join(lines)


def query_asset_for_agent(agent_id: str, company_id: str):
    """对外主入口：按 agentId + company_id 查询并选出最佳资产，返回 dict（含 selected+all）。"""
    agent_id = str(agent_id or "").strip()
    company_id = str(company_id or "").strip()
    if not agent_id:
        raise ValueError("agentId 不能为空")
    if not company_id.isdigit():
        raise ValueError("company_id 必须是平台返回的数字 ID")
    cookie = shared.get_cookie()
    assets = _fetch_assets_by_agent(cookie, agent_id, company_id)
    best, reason = pick_best_asset(assets)
    return {
        "agent_id": agent_id,
        "company_id": company_id,
        "total": len(assets),
        "selected": best,
        "select_reason": reason,
        "all": assets,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="按 agentId 查询 MSSP 终端资产（选最全最新一条）")
    ap.add_argument("agent_id")
    ap.add_argument("--company-id", required=True)
    a = ap.parse_args()
    res = query_asset_for_agent(a.agent_id, a.company_id)
    print(json.dumps(res, ensure_ascii=False, indent=2))
