"""使用既有 MSSP 事件详情与资产接口补齐独立调用所需上下文。"""

import shared


SKILL_NAME = "mssp-event-push-content"
BUSINESS_LEVEL_MAP = {1: "核心", 2: "重要", 3: "一般"}
ASSET_TYPE_MAP = {1: "域名", 2: "IP", 3: "终端", 4: "服务器", 5: "网络设备"}


def first_value(sources, *keys):
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            if value not in (None, ""):
                return value
    return ""


def business_level_cn(value):
    try:
        return BUSINESS_LEVEL_MAP.get(int(str(value).strip()), str(value or ""))
    except (TypeError, ValueError):
        return str(value or "")


def asset_type_cn(value):
    try:
        return ASSET_TYPE_MAP.get(int(str(value).strip()), str(value or ""))
    except (TypeError, ValueError):
        return str(value or "")


def adapter_device_names(asset):
    adapter = asset.get("adapter") if isinstance(asset, dict) else None
    if not isinstance(adapter, dict):
        return ""
    names = []
    for value in adapter.values():
        if isinstance(value, list):
            names.extend(str(item) for item in value if item)
        elif value:
            names.append(str(value))
    return "、".join(dict.fromkeys(names))


def fill_missing(context, values):
    for key, value in values.items():
        if context.get(key) in (None, "") and value not in (None, ""):
            context[key] = value


def detail_values(detail):
    base = detail.get("base_info") if isinstance(detail, dict) else {}
    event = detail.get("event_info") if isinstance(detail, dict) else {}
    sources = [detail, base, event]
    return {
        "company_id": first_value(sources, "company_id", "companyId"),
        "company": first_value(sources, "company_name", "companyName"),
        "event_name": first_value(sources, "event_name", "eventName", "name"),
        "host_ip": first_value(sources, "host_ip", "hostIp", "asset_ip", "assetIp", "ip"),
        "hostname": first_value(sources, "hostname", "host_name", "hostName"),
        "event_status": first_value(sources, "event_status", "eventStatus", "status"),
        "event_time": first_value(sources, "create_time", "createTime", "first_time", "firstTime"),
        "dev_name": first_value(sources, "dev_name", "devName"),
    }


def asset_values(asset):
    return {
        "asset_name": first_value([asset], "asset_name", "asset"),
        "asset_group": first_value([asset], "asset_group_name", "asset_group"),
        "business_name": first_value([asset], "business_name", "business"),
        "business_level": business_level_cn(asset.get("business_level")),
        "asset_type": asset_type_cn(asset.get("asset_type")),
        "hostname": first_value([asset], "hostname", "host_name"),
        "dev_name": adapter_device_names(asset),
        "nges_installed": asset.get("nges_installed"),
    }


def enrich_event_context(event_id, context):
    shared.SKILL_NAME = SKILL_NAME
    cookie = shared.get_cookie()
    detail = shared.get_event_detail(cookie, event_id)
    if not detail:
        raise RuntimeError(f"未能根据事件 ID {event_id} 获取 MSSP 事件详情")
    fill_missing(context, detail_values(detail))
    company_id = str(context.get("company_id") or "").strip()
    host_ip = str(context.get("host_ip") or "").strip()
    if company_id.isdigit() and host_ip:
        asset = shared.get_asset_info(cookie, host_ip, company_id)
        fill_missing(context, asset_values(asset))
    return context
