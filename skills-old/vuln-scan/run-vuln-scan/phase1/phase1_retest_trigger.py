#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞复测 Phase 1 Trigger - 扫描任务触发入口（集成到漏扫 skill）

支持两种模式：
  1. 立即执行（无 --start-time）：excute_mode=1
  2. 定时执行（--start-time）：excute_mode=0

Phase 1 下发复测任务后：
  - 立即模式：spawn 后台 Phase 2 进程轮询
  - 定时模式：启动等待进程，target_ts 到期后执行 Phase 2

Phase 2 通过 keyword="漏洞复测" 找到 start_time 最大的 task，再轮询其 status
"""
import sys, argparse, subprocess, os, time, json, re

VULN_SCAN_ROOT = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
if VULN_SCAN_ROOT not in sys.path:
    sys.path.insert(0, VULN_SCAN_ROOT)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from datetime import datetime, timezone, timedelta
import requests
from phase1.phase1_prepare.phase1_company import resolve_company, MultipleCandidatesError

# ─────────────────────────────────────────────────────────────
# 通知
# ─────────────────────────────────────────────────────────────
def notify(content, company_name=""):
    try:
        from shared import send_notification
        send_notification("漏洞复测", "进行中", content, company_name=company_name)
    except Exception as e:
        print(f"[WARNING] 通知发送失败: {e}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────
# Phase 1 前置：确认公司
# ─────────────────────────────────────────────────────────────
def phase1_setup(cookie, company_name_arg):
    corrected_name, company_id = resolve_company(company_name_arg, cookie)
    print(f"[INFO] 确认公司: {corrected_name} ({company_id})")
    return corrected_name, company_id


# ─────────────────────────────────────────────────────────────
# 步骤1：查询处置中/修复失败的漏洞，获取其关联资产IP
# ─────────────────────────────────────────────────────────────
def fetch_target_vuln_ids(company_id: str, cookie: str) -> list:
    """
    查询 vulnerability_status 为处置中和修复失败的漏洞记录，
    提取其漏洞编号（vuln_id）列表，去重后返回。
    返回: vuln_id 字符串列表
    """
    import uuid
    from shared import request_with_retry, extract_cookie_value, log, VULN_LIST_URL

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://soar.sangfor.com.cn",
        "Pragma": "no-cache",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Timezone": "+08:00",
        "X-Csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "Traceid": str(uuid.uuid4()),
    }

    last_time = []

    # 处置中=1, 修复失败=9
    target_statuses = [1, 9]
    all_vuln_ids = []
    offset = 0
    limit = 100

    log(f"[INFO] 查询处置中/修复失败漏洞 (status={target_statuses})...", "INFO")

    while True:
        payload = {
            "order": {},
            "offset": offset,
            "limit": limit,
            "keyword": "",
            "vulnerability_status": target_statuses,
            "dev_id": [],
            "fix_level": -1,
            "src_storage": [],
            "src_type": ["tss"],
            "is_intranet": -1,
            "service_status": 0,
            "vuln_type": -1,
            "is_high_availability": -1,
            "protection_rule": [],
            "asset_list": [],
            "scene_tag": [],
            "scan_method": -1,
            "found_time": [],
            "last_time": last_time,
            "vulnerability_level": -1,
            "company_id": company_id
        }

        try:
            resp = requests.post(VULN_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
            result = resp.json()
        except Exception as e:
            log(f"[ERROR] 查询漏洞列表失败: {e}", "ERROR")
            break

        code = result.get("code")
        if code != 0:
            log(f"[ERROR] API返回code={code}, msg={result.get('msg')}", "ERROR")
            break

        data = result.get("data", {})
        items = data.get("list", [])
        total = data.get("total", 0)

        if offset == 0:
            log(f"[INFO] 漏洞总数: {total}", "INFO")

        for item in items:
            vuln_ids = item.get("id", []) or []
            for vid in vuln_ids:
                if vid:
                    all_vuln_ids.append(vid)

        if len(items) < limit:
            break
        offset += limit

    unique_ids = list(dict.fromkeys(all_vuln_ids))  # 去重保持顺序
    log(f"[INFO] 去重后漏洞编号数: {len(unique_ids)}", "INFO")
    log(f"[DEBUG] vuln_id_list={unique_ids}", "INFO")
    return unique_ids


# ─────────────────────────────────────────────────────────────
# 步骤2：IP → asset_id
# ─────────────────────────────────────────────────────────────
def resolve_asset_ids(company_id: str, cookie: str, ip_list: list) -> list:
    """
    将IP列表通过资产查询API转为asset_id列表。
    复用 init-config/asset_translator.py 的 ip_to_asset_id。
    """
    import sys, os
    init_config_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "init-config")
    if init_config_dir not in sys.path:
        sys.path.insert(0, init_config_dir)
    from asset_translator import ip_to_asset_id

    result = ip_to_asset_id(company_id, ip_list)
    return [aid for aid in result if aid]


# ─────────────────────────────────────────────────────────────
# 步骤3：创建复测任务
# ─────────────────────────────────────────────────────────────
def call_retest_api(cookie: str, company_id: str, vuln_id_list: list, excute_mode: int, start_time: int = 0, cycle_time_start: str = None) -> dict:
    """
    调用漏洞复测下发API。

    Args:
        cookie: Cookie字符串
        company_id: 公司ID
        vuln_id_list: 漏洞编号列表
        excute_mode: 1=立即执行, 0=定时执行
        start_time: 定时模式的开始时间（毫秒时间戳），立即模式填 0
        cycle_time_start: 定时模式的每日执行时间（如 "22:24:13"），立即模式填 None
    """
    from shared import request_with_retry

    url = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/vuln/retest"
    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://soar.sangfor.com.cn",
        "Pragma": "no-cache",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Timezone": "+08:00",
    }

    payload = {
        "company_id": company_id,
        "id_list": vuln_id_list,
        "is_select_all": 0,
        "exclude_list": [],
        "order": {},
        "keyword": "",
        "vulnerability_status": [],
        "dev_id": [],
        "fix_level": -1,
        "src_storage": [],
        "src_type": ["tss"],
        "is_intranet": -1,
        "service_status": 0,
        "vuln_type": -1,
        "is_high_availability": -1,
        "protection_rule": [],
        "asset_list": [],
        "scene_tag": [],
        "scan_method": -1,
        "found_time": [],
        "last_time": [],
        "vulnerability_level": -1,
        "asset_bind_tss_dict": [],
        "excute_mode": excute_mode,
    }

    if excute_mode == 0 and start_time > 0:
        payload["start_time"] = start_time
        if cycle_time_start:
            payload["cycle_time_start"] = cycle_time_start
        payload["cycle_time_end"] = None

    try:
        resp = request_with_retry("POST", url, headers=headers, json=payload)
        if resp is None:
            return {"code": -1, "msg": "网络请求失败"}
        result = resp.json()
        return result
    except requests.exceptions.Timeout:
        return {"code": -1, "msg": "请求超时"}
    except requests.exceptions.ConnectionError:
        return {"code": -1, "msg": "网络连接失败"}
    except Exception as e:
        return {"code": -1, "msg": f"请求异常: {e}"}


def get_dev_id(company_id: str, cookie: str) -> int:
    """获取设备ID"""
    from phase1.phase1_prepare.get_dev_id import get_dev_id as _get_dev_id
    dev_id = _get_dev_id(cookie, company_id)
    return dev_id


# ─────────────────────────────────────────────────────────────
# 后台进程启动（立即模式）
# ─────────────────────────────────────────────────────────────
def spawn_phase2_now(company_id):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "phase2", "phase2_retest_poll.py")
    cmd = [sys.executable, script, "--company-id", company_id]

    env = os.environ.copy()
    env["RETEST_COMPANY"] = company_id
    env["PHASE1_IMMEDIATE_MODE"] = "1"

    creationflags = 0
    if sys.platform == "win32":
        import subprocess as _subprocess
        creationflags = _subprocess.DETACHED_PROCESS | 0x00000008

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        creationflags=creationflags,
    )
    print(f"[INFO] Phase 2 后台进程已启动, pid={proc.pid}", flush=True)


# ─────────────────────────────────────────────────────────────
# 定时等待进程
# ─────────────────────────────────────────────────────────────
def spawn_wait_and_run(target_ts, company_arg, corrected_company_name, delay_minutes):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phase1_retest_wait_and_run.py")
    cmd = [sys.executable, script]

    env = os.environ.copy()
    env["PHASE1_TARGET_TS"] = str(target_ts)
    env["PHASE1_COMPANY"] = company_arg
    env["PHASE1_CORRECTED_NAME"] = corrected_company_name
    env["PHASE1_DELAY"] = str(delay_minutes)

    creationflags = 0
    if sys.platform == "win32":
        import subprocess as _subprocess
        creationflags = _subprocess.DETACHED_PROCESS | 0x00000008

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        creationflags=creationflags,
    )
    print(f"[INFO] 定时等待进程已启动, pid={proc.pid}", flush=True)


# ─────────────────────────────────────────────────────────────
# 主函数
# ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="漏洞复测 Phase 1 Trigger")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--start-time", type=str, default=None, help="定时执行时间")
    args = parser.parse_args()

    from shared import get_cookie, VULN_LIST_URL

    cookie = get_cookie()
    if not cookie:
        notify("❌ 漏洞复测失败！Cookie 无效或已过期")
        sys.exit(1)

    if not args.company:
        print("[X ERROR] 必须指定 --company")
        sys.exit(1)

    # ── 解析公司 ─────────────────────────────────────────────
    try:
        corrected_company_name, company_id = phase1_setup(cookie, args.company)
    except MultipleCandidatesError as e:
        candidates = e.candidates
        lines = [f"🔍 匹配到 {len(candidates)} 个候选公司，请回复编号确认："]
        for i, c in enumerate(candidates, 1):
            lines.append(f"  [{i}] {c['company_name']}")
        notify("\n".join(lines))
        sys.exit(0)

    # ── 解析定时时间 ─────────────────────────────────────────
    user_target_ts_ms = 0      # API payload 用的 start_time（当天零点毫秒）
    wait_target_ts_ms = 0      # 等待进程用的目标时间（真实执行时刻毫秒）
    user_dt = None
    sh_tz = timezone(timedelta(hours=8))

    if args.start_time:
        from phase1.phase1_prepare.vuln_scan_task import suggest_schedule_time
        parsed_ok, parsed_str, err = suggest_schedule_time(args.start_time)
        if err:
            print(f"[X ERROR] {err}", flush=True)
            sys.exit(1)
        if parsed_ok and parsed_str:
            user_dt = datetime.strptime(parsed_str, "%Y-%m-%d %H:%M:%S")
            if user_dt <= datetime.now():
                print(f"[INFO] 定时时间为过去时间，立即执行...", flush=True)
            else:
                # API start_time = 当天 00:00:00 的毫秒时间戳（上海时区）
                day_dt = user_dt.replace(hour=0, minute=0, second=0, microsecond=0)
                day_dt_aware = day_dt.replace(tzinfo=sh_tz)
                user_target_ts_ms = int(day_dt_aware.timestamp() * 1000)
                # 等待进程目标时间 = 用户指定时刻的毫秒时间戳
                user_dt_aware = user_dt.replace(tzinfo=sh_tz)
                wait_target_ts_ms = int(user_dt_aware.timestamp() * 1000)

    # ── 步骤1：查询处置中/修复失败漏洞，提取 vuln_id ───────────
    print(f"[INFO] 步骤1：查询处置中/修复失败漏洞...", flush=True)
    vuln_id_list = fetch_target_vuln_ids(company_id, cookie)
    if not vuln_id_list:
        notify(f"⚠️ 未找到处置中/修复失败的漏洞，跳过复测", corrected_company_name)
        sys.exit(0)
    print(f"[INFO] 待复测漏洞编号数: {len(vuln_id_list)}", flush=True)

    # ── 步骤2：下发复测任务 ─────────────────────────────────────
    excute_mode = 0 if user_target_ts_ms > 0 else 1
    cycle_time_start = user_dt.strftime("%H:%M:%S") if excute_mode == 0 else None
    print(f"[INFO] 步骤2：下发复测任务（excute_mode={excute_mode}）...", flush=True)
    result = call_retest_api(cookie, company_id, vuln_id_list, excute_mode, user_target_ts_ms, cycle_time_start)
    print(f"[DEBUG] call_retest_api 返回: code={result.get('code')}, msg={result.get('msg')}", flush=True)
    code = result.get("code")
    # 1105/1005 = 任务已创建成功（仅有警告信息），正常往后走
    is_warning = code in (1105, 1005)
    if code != 0 and not is_warning:
        err_msg = result.get("msg") or "未知错误"
        notify(f"❌ 复测任务下发失败: {err_msg}", corrected_company_name)
        sys.exit(1)

    if user_target_ts_ms > 0:
        # 定时模式：用真实执行时刻计算 delay，启动后台等待进程
        target_ts_s = wait_target_ts_ms // 1000
        delay_s = target_ts_s - int(time.time())
        delay_minutes = max(0, delay_s // 60)
        spawn_wait_and_run(wait_target_ts_ms, company_id, corrected_company_name, delay_minutes)
        notify(f"✅ 漏洞复测定时任务已就绪：{corrected_company_name}（{len(vuln_id_list)}个漏洞），将在 {parsed_str} 准时执行复测扫描", corrected_company_name)
        print(f"[INFO] 定时复测，约 {delay_minutes} 分钟后执行 Phase 2", flush=True)
        sys.exit(0)
    else:
        # 立即模式：立即启动后台 Phase 2 进程
        print(f"[INFO] 启动后台 Phase 2 进程，立即执行复测扫描...", flush=True)
        spawn_phase2_now(company_id)
        notify(f"✅ 漏洞复测已提交：{corrected_company_name}（{len(vuln_id_list)}个漏洞），Phase 2 轮询已启动", corrected_company_name)
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[X] 用户中断，退出")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        try:
            from shared import send_notification
            send_notification("漏洞复测 Phase 1", "异常", str(e))
        except Exception:
            pass
        raise