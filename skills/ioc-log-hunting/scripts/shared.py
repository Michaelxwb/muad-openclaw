# -*- coding: utf-8 -*-
"""
monitor-mssp-events 共享模块。

- 登录态：session-manager 经 MUAD_SESSION_KEY 判定身份后返回登录态文件，
  从中提取 mssp 平台 cookie（沿用 policy-check shared 的约定）。
- 配置：config/api_config.json 集中管理 origin / host_header / endpoints，
  origin 支持环境变量覆盖（MONITOR_MSSP_BASE_URL）。
- 不写凭据到 stdout / 日志。
"""

import json
import os
import subprocess
import sys
import time
import uuid

try:
    import requests
except ImportError:
    requests = None

SKILL_NAME = "ioc-log-hunting"

# 当前仅实现 MSSP（SOAR）
PLATFORM_MSSP = "mssp"

MAX_RETRIES = 3
RETRY_DELAY = 2


def log(msg: str, level: str = "INFO") -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}", file=sys.stderr)


def _load_api_config():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cfg_path = os.path.join(base_dir, "..", "config", "api_config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_host_header() -> str:
    cfg = _load_api_config()
    return str(cfg.get("host_header") or "inner.sangfor.com.cn")


def get_origin(platform: str = PLATFORM_MSSP) -> str:
    cfg = _load_api_config()
    section = cfg.get("platforms", {}).get(platform)
    if not section:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}")
    env_name = section.get("env")
    if env_name:
        env_origin = os.environ.get(env_name)
        if env_origin:
            return env_origin.rstrip("/")
    origin = section.get("origin")
    if not origin:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}.origin")
    return origin.rstrip("/")


def get_referer(platform: str = PLATFORM_MSSP) -> str:
    cfg = _load_api_config()
    section = cfg.get("platforms", {}).get(platform, {})
    ref = section.get("referer_path") or "/index.html"
    if ref.startswith(("http://", "https://")):
        return ref
    return get_origin(platform) + ref


def get_platform_setting(key: str, platform: str = PLATFORM_MSSP):
    """取平台级配置项（如 fixed_csrf_token / timezone）。"""
    cfg = _load_api_config()
    section = cfg.get("platforms", {}).get(platform, {})
    return section.get(key)


def get_endpoint(key: str, platform: str = PLATFORM_MSSP) -> str:
    cfg = _load_api_config()
    section = cfg.get("platforms", {}).get(platform)
    if not section:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}")
    endpoints = section.get("endpoints", {})
    if key not in endpoints:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}.endpoints.{key}")
    value = endpoints[key]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError(f"endpoints.{key} 必须以 '/' 开头或为 http(s):// 完整 URL")
    origin = section.get("origin")
    env_name = section.get("env")
    if env_name and os.environ.get(env_name):
        origin = os.environ[env_name]
    return origin.rstrip("/") + value


def extract_cookie_value(cookie: str, key: str):
    if not cookie:
        return None
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


def get_cookie(platform: str = PLATFORM_MSSP) -> str:
    """经 session-manager 取指定平台 cookie。身份由 guard 注入的 MUAD_SESSION_KEY 决定。"""
    # 测试/登录取向开关：正式运行不设 IOC_LOGIN_SKILL 用自身；草稿未激活时可用已激活 skill 名验证链路
    login_skill = os.environ.get("IOC_LOGIN_SKILL") or SKILL_NAME
    cmd = ["session-manager", "get-state", "--skill-name", login_skill]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        raise RuntimeError(f"调用 session-manager 失败: {e}") from e

    if result.returncode != 0:
        raise RuntimeError(f"获取登录态失败: {(result.stderr or result.stdout or '').strip()}")

    try:
        state = json.loads(result.stdout)
    except Exception as e:
        raise RuntimeError(f"session-manager 输出解析失败: {e}") from e

    session_file = state.get("sessionStateFile")
    if not session_file or not os.path.exists(session_file):
        raise RuntimeError("未获取到登录态文件，请先确认 mssp 平台已绑定并登录")

    try:
        with open(session_file, "r", encoding="utf-8") as f:
            session = json.load(f)
    except Exception as e:
        raise RuntimeError(f"读取登录态文件失败: {e}") from e

    section = (session or {}).get("platforms", {}).get(platform)
    cookies = (section or {}).get("cookies")
    if not isinstance(cookies, list) or not cookies:
        raise RuntimeError(f"登录态缺少 {platform} 平台 cookie")

    pairs = []
    for c in cookies:
        if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("value"), str):
            pairs.append(f"{c['name']}={c['value']}")
    if not pairs:
        raise RuntimeError(f"登录态 {platform} 平台的 cookie 无效")
    return "; ".join(pairs)


def build_headers(cookie: str, platform: str = PLATFORM_MSSP) -> dict:
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "cookie": cookie,
        "host": get_host_header(),
        "referer": get_referer(platform),
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-Requested-With": "XMLHttpRequest",
    }
    # CSRF 头：从 cookie 提取的动态 X-Csrftoken / x-csrf-token
    csrf = extract_cookie_value(cookie, "csrf_token")
    if csrf:
        headers["X-Csrftoken"] = csrf
    # MSSP 平台固定头：X-CSRFToken + timezone
    if platform == PLATFORM_MSSP:
        fixed = get_platform_setting("fixed_csrf_token", platform)
        tz = get_platform_setting("timezone", platform) or "+08:00"
        if fixed:
            headers["X-CSRFToken"] = fixed
        headers["timezone"] = tz
    return headers


def search_customers(cookie: str, keyword: str, limit: int = 20, platform: str = PLATFORM_MSSP) -> list:
    """按关键词模糊搜索当前登录态**在线**客户。

    返回 data.list（仅 service_status=1 的在线客户），每项含 company_id / company_name / pms_customer_name。
    已过滤：已过期、未上线的客户（service_status=1 即在线）；展示层的疑似非正式客户再二次排除。
    真实响应结构：{"code":0,"data":{"list":[{company_id,company_name,pms_customer_name,...}]}}
    """
    keyword = str(keyword or "").strip()
    if not keyword:
        raise ValueError("客户搜索必须提供非空关键词")
    if not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("客户搜索 limit 必须是 1 到 100 的整数")
    url = get_endpoint("customer_search", platform)
    headers = build_headers(cookie, platform)
    payload = {
        "order": "asc", "offset": 0, "limit": limit, "keyword": keyword,
        "share_ids": [], "delivery_channel_id": [], "service_code": [], "industry": [],
        "industry_segmentation": [], "customer_type": [], "customer_stratification": [],
        "protection_type": [], "service_group": [], "delivery_method": [], "platform_type": [],
        "service_status": 1, "my_customer": 0,  # 1=在线客户，过滤过期/未上线
    }
    resp = http_json("POST", url, headers, payload=payload)
    try:
        data = resp.json()
    except Exception as e:
        log(f"customer_search 响应解析失败: {e}", "ERROR")
        return []
    if not isinstance(data, dict) or data.get("code") != 0:
        log(f"customer_search 返回异常 code={data.get('code') if isinstance(data, dict) else '?'}", "WARNING")
        return []
    body = data.get("data") or {}
    lst = body.get("list") if isinstance(body, dict) else None
    if not isinstance(lst, list):
        return []
    # 展示层二次排除疑似非正式客户（影子/学员实训/测试等）
    no_show_kw = ("[影子]", "学员实训", "（学员实训）", "测试")
    return [
        c for c in lst
        if isinstance(c, dict)
        and not any(k in str(c.get("company_name") or "") for k in no_show_kw)
    ]


def pick_exact_customer(customers: list, keyword: str):
    if not isinstance(customers, list) or not customers:
        return None
    if len(customers) == 1:
        return customers[0]
    kw = (keyword or "").strip()
    for c in customers:
        if not isinstance(c, dict):
            continue
        cands = [c.get("company_name"), c.get("pms_customer_name"), c.get("company_id")]
        if any((str(x or "").strip() == kw) for x in cands):
            return c
    return None


def get_event_detail(cookie: str, event_id: str, platform: str = PLATFORM_MSSP) -> dict:
    """获取单个事件的详情。返回 data（dict），失败/异常返回空 dict。

    真实响应结构：{"code":0,"data":{"base_info":{...}, ...}}。
    关键字段：data.base_info.device_type（69=NGES设备）、dev_name、platform_type。
    """
    event_id = str(event_id or "").strip()
    if not event_id:
        return {}
    url = get_endpoint("event_detail", platform)
    headers = build_headers(cookie, platform)
    payload = {"event_id": event_id}
    try:
        resp = http_json("POST", url, headers, payload=payload)
        data = resp.json()
    except Exception as e:
        log(f"event_detail 查询失败 (event_id={event_id}): {e}", "WARNING")
        return {}
    if not isinstance(data, dict) or data.get("code") != 0:
        log(f"event_detail 返回异常 code={data.get('code') if isinstance(data, dict) else '?'} (event_id={event_id})", "WARNING")
        return {}
    body = data.get("data")
    return body if isinstance(body, dict) else {}


def get_event_nges(cookie: str, event_id: str, platform: str = PLATFORM_MSSP):
    """判断事件是否来自 NGES（杀毒引擎）设备。返回 (is_nges, device_type, dev_name)。

    依据：事件详情 base_info.device_type == 69 即为 NGES 设备。
    dev_name 如 "SaaS_NGES"（NGES）/ "STA_001"（STA）/ "SIP_001"（SIP）。
    """
    detail = get_event_detail(cookie, event_id, platform)
    base = detail.get("base_info") if isinstance(detail, dict) else None
    if not isinstance(base, dict):
        return False, None, ""
    raw_dt = base.get("device_type")
    try:
        dt = int(raw_dt) if raw_dt is not None and raw_dt != "" else None
    except (TypeError, ValueError):
        dt = None
    dev = base.get("dev_name") or ""
    is_nges = (dt == 69)
    return is_nges, dt, dev


def get_asset_info(cookie: str, host_ip: str, company_id: str, platform: str = PLATFORM_MSSP) -> dict:
    """按主机 IP 和客户 ID 查询资产，返回首条资产及 NGES 覆盖信息。"""
    host_ip = str(host_ip or "").strip()
    company_id = str(company_id or "").strip()
    if not host_ip or any(char in host_ip for char in "\r\n"):
        return {}
    if not company_id.isdigit():
        raise ValueError("资产查询只接受平台返回的数字 company_id")
    url = get_endpoint("asset_query", platform)
    headers = build_headers(cookie, platform)
    payload = {
        "order": "asc", "offset": 0, "limit": 10, "service_status": [], "is_alive": -1,
        "ip_url_keyword": host_ip, "asset_type": [], "business_level": [], "first_time": [],
        "update_time": [], "keyword": "", "asset_tag": [], "agent_status": [],
        "af_defend_status": "", "database": [], "middleware": [], "os": [],
        "developing_languages": [], "development_framework": [], "server_port": [],
        "company_id": company_id, "asset_group_id": "all", "authorization_type": [],
    }
    try:
        resp = http_json("POST", url, headers, payload=payload)
        data = resp.json()
    except Exception as e:
        log(f"asset_query 查询失败 (ip={host_ip}): {e}", "WARNING")
        return {}
    if not isinstance(data, dict) or data.get("code") != 0:
        log(f"asset_query 返回异常 code={data.get('code') if isinstance(data, dict) else '?'} (ip={host_ip})", "WARNING")
        return {}
    body = data.get("data") or {}
    lst = body.get("list") if isinstance(body, dict) else None
    if not isinstance(lst, list) or not lst:
        return {}
    assets = [asset for asset in lst if isinstance(asset, dict)]
    if not assets:
        return {}
    asset = dict(assets[0])
    asset["nges_installed"] = any(
        isinstance(item.get("adapter"), dict) and bool(item["adapter"].get("NGES"))
        for item in assets
    )
    return asset

def customer_display(c) -> str:
    """客户可读名称：优先 company_name，PMS 名不同则附注。"""
    name = str(c.get("company_name") or "")
    pms = str(c.get("pms_customer_name") or "")
    if pms and pms != "-" and pms != name:
        return f"{name}（{pms}）"
    return name


def _output_root() -> str:
    """可写输出/状态根目录：guard 注入的 SKILL_OUTPUT_DIR；缺失（本地/开发调试）回退到系统临时目录。

    Public Skill 运行时 skill 根目录是**只读挂载**，`state/` 不可写，所以事件去重等
    运行时可变状态统一写到 `SKILL_OUTPUT_DIR`（per-user 隔离，随用户持久）。
    """
    d = os.environ.get("SKILL_OUTPUT_DIR")
    if d:
        os.makedirs(d, exist_ok=True)
        return d
    import tempfile

    d = os.path.join(tempfile.gettempdir(), "monitor-mssp-events")
    os.makedirs(d, exist_ok=True)
    return d


def _state_dir() -> str:
    """事件去重状态目录。优先环境覆盖，其次输出根下的 state/。"""
    d = os.environ.get("MONITOR_STATE_DIR")
    if d:
        os.makedirs(d, exist_ok=True)
        return d
    d = os.path.join(_output_root(), "state")
    os.makedirs(d, exist_ok=True)
    return d


def _state_path() -> str:
    """去重状态文件路径（写 SKILL_OUTPUT_DIR/state）。"""
    return os.path.join(_state_dir(), "reminded_events.json")


def load_reminded() -> dict:
    """加载已提醒记录：{event_id: remind_ts_ms}。文件不存在视为空。"""
    path = _state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        log(f"读取去重状态失败: {e}", "WARNING")
        return {}


def save_reminded(reminded: dict) -> None:
    """持久化已提醒记录。最多保留 7 天内的 event_id，防止无限增长。"""
    now = int(time.time() * 1000)
    cutoff = now - 7 * 24 * 3600 * 1000
    pruned = {k: v for k, v in reminded.items() if v and v >= cutoff}
    path = _state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(pruned, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log(f"写入去重状态失败: {e}", "WARNING")


def http_json(method: str, url: str, headers: dict, payload=None, timeout: int = 30):
    if requests is None:
        raise RuntimeError("缺少 requests 依赖")
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            if method.upper() == "GET":
                resp = requests.get(url, headers=headers, timeout=timeout, verify=False)
            else:
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout, verify=False)
            return resp
        except Exception as e:  # noqa: BLE001
            last_exc = e
            log(f"请求失败 (尝试 {attempt + 1}/{MAX_RETRIES}) - {e}", "WARNING")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
    raise last_exc
