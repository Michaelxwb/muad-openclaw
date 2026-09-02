#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Trigger - 扫描任务触发入口

支持两种模式：
  1. 立即执行（无 --start-time）
  2. 定时执行（--start-time）：通过 Windows Task Scheduler 注册计划任务
"""
import sys, argparse, subprocess, os, time, json, re

# 修复：Task Scheduler 环境下 __file__ 解析可能异常，统一用绝对路径
VULN_SCAN_ROOT = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
if VULN_SCAN_ROOT not in sys.path:
    sys.path.insert(0, VULN_SCAN_ROOT)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from datetime import datetime, timezone, timedelta
from phase1.phase1_prepare.phase1_company import MultipleCandidatesError





# ─────────────────────────────────────────────────────────────
# 通知
# ─────────────────────────────────────────────────────────────
def notify(content, company_name=""):
    try:
        from shared import send_notification
        send_notification("漏扫Phase1", "进行中", content, company_name=company_name)
    except Exception as e:
        print(f"[WARNING] 通知发送失败: {e}", file=sys.stderr)

# ─────────────────────────────────────────────────────────────
# Phase 1 前置：确认公司 & 加载配置
# ─────────────────────────────────────────────────────────────
def phase1_setup(cookie, company_name_arg):
    from phase1.phase1_prepare.phase1_company import resolve_company
    from config_manager import get_config

    corrected_name, company_id = resolve_company(company_name_arg, cookie)
    print(f"[INFO] 确认公司: {corrected_name} ({company_id})")
    company_config = get_config(company_id, corrected_name, auto_confirm=True)
    return company_id, corrected_name, company_config

def make_task_name(corrected_company_name: str) -> str:
    """生成标准化的漏扫任务名称：漏扫任务_公司名称_时间字符串"""
    ts = datetime.now().strftime("%Y%m%d%H%M")
    return f"漏扫任务_{corrected_company_name}_{ts}"


def _load_company_export_type(company_id: str) -> int:
    """从公司配置文件读取 export_type"""
    import json
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "companies", f"{company_id}.json"
    )
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f).get("export_type", 0)
        except Exception:
            pass
    return 0

# ─────────────────────────────────────────────────────────────
# Phase 1：获取设备ID & 创建扫描任务
# ─────────────────────────────────────────────────────────────
def run_phase1(cookie, company_id, company_config, task_name, user_start_time=0, company_name=""):
    from phase1.phase1_prepare.get_dev_id import get_dev_id
    from phase1.phase1_prepare.vuln_scan_task import create_vuln_scan_task

    dev_id = get_dev_id(cookie, company_id)
    if not dev_id:
        notify(f"❌ Phase 1 执行失败！获取设备ID失败 company_id={company_id}", company_name)
        sys.exit(1)
    print(f"[OK] 设备ID: {dev_id}")

    result = create_vuln_scan_task(
        cookie=cookie,
        task_name=task_name,
        dev_id=dev_id,
        company_id=company_id,
        asset_list=company_config.get("asset_list"),
        asset_mode=company_config.get("asset_mode"),
        start_time=user_start_time
    )

    _ok_codes = (0, 1105, 1005)
    code = result.get("code")
    success_flag = result.get("success", True)
    # 1105：TSS时间未同步，定时任务仍可下发，仅警告不视为失败
    if code == 1105:
        success_flag = True
    if code not in _ok_codes or not success_flag:
        err_msg = result.get("msg") or result.get("message") or "未知错误"
        notify(f"❌ Phase 1 执行失败！任务创建失败: {err_msg}", company_name)
        sys.exit(1)

    print(f"[OK] 任务创建成功: {result.get('task_name') or task_name}")
    return result

# ─────────────────────────────────────────────────────────────
# 运行 Phase 2-5
# ─────────────────────────────────────────────────────────────
def run_phases2to5(company_id, task_name, company_name=""):
    runner_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "phase2", "phase2_run_through.py")
    cmd = [sys.executable, runner_script, "--company-id", company_id, "--task-name", task_name]

    print(f"[INFO] 执行: {' '.join(cmd)}", flush=True)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode == 0:
            print(f"[OK] Phase 2-5 执行完成")
            sys.exit(0)
        else:
            print(f"[X ERROR] Phase 2-5 失败 (code={r.returncode})")
            print(f"  stdout: {r.stdout[:500] if r.stdout else '(empty)'}")
            print(f"  stderr: {r.stderr[:500] if r.stderr else '(empty)'}")
            stderr_snippet = r.stderr[-500:] if r.stderr else ''
            stdout_snippet = r.stdout[-500:] if r.stdout else ''
            notify(f"❌ Phase 2-5 执行失败 (code={r.returncode})\n--- stderr ---\n{stderr_snippet}\n--- stdout ---\n{stdout_snippet}", company_name)
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"[X ERROR] Phase 2-5 执行超时（1小时）")
        notify(f"⚠️ Phase 2-5 执行超时", company_name)
        sys.exit(1)
    except Exception as e:
        print(f"[X ERROR] Phase 2-5 执行异常: {e}")
        notify(f"❌ Phase 2-5 执行异常: {e}", company_name)
        sys.exit(1)

# ─────────────────────────────────────────────────────────────
# 注册 Windows 计划任务（定时唤醒）
# ─────────────────────────────────────────────────────────────
def spawn_wait_and_run_now(company_id, company_name, task_name):
    """
    立即执行（无定时）：Phase 1 已完成，直接启动后台进程执行 Phase 2-5（无等待）
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "phase2", "phase2_run_through.py")
    cmd = [sys.executable, script, "--company-id", company_id, "--task-name", task_name]

    env = os.environ.copy()
    env["PHASE1_COMPANY"] = company_id
    env["PHASE1_CORRECTED_NAME"] = company_name
    env["PHASE1_TASK_NAME"] = task_name

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

    print(f"[INFO] 后台 Phase 2-5 进程已启动，pid={proc.pid}", flush=True)

def spawn_wait_and_run(target_ts, company_arg, corrected_company_name, task_name, delay_minutes):
    """
    启动 phase1_wait_and_run.py 后台进程（不阻塞主进程）
    与 Phase 2-5 的 subprocess.run 模式一致：继承父进程环境，可访问 M: 盘
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phase1_wait_and_run.py")
    cmd = [sys.executable, script]

    env = os.environ.copy()
    env["PHASE1_TARGET_TS"] = str(target_ts)
    env["PHASE1_COMPANY"] = company_arg
    env["PHASE1_CORRECTED_NAME"] = corrected_company_name
    env["PHASE1_TASK_NAME"] = task_name
    env["PHASE1_DELAY"] = str(delay_minutes)

    # Windows 上 start_new_session=True 需要 creationflags 配合
    # DETACHED_PROCESS = 0x00000008，可以让子进程完全脱离父进程控制
    creationflags = 0
    if sys.platform == "win32":
        import subprocess as _subprocess
        creationflags = _subprocess.DETACHED_PROCESS | 0x00000008  # DETACHED_PROCESS + CREATE_NEW_CONSOLE

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        creationflags=creationflags,
    )

    print(f"[INFO] 后台等待进程已启动，pid={proc.pid}")

# ─────────────────────────────────────────────────────────────
# 主函数
# ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Phase 1 Trigger")
    parser.add_argument("--company-id", type=str, help="直接指定公司ID，跳过确认")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--name", type=str, help="任务名称（已废弃，任务名自动生成）")
    parser.add_argument("--delay-minutes", type=int, default=None, help="Phase 2-5 延迟分钟数（默认从 shared 读取）")
    parser.add_argument("--start-time", type=str, default=None, help="定时执行时间")
    args = parser.parse_args()

    from shared import get_cookie, DEFAULT_DELAY_MINUTES
    cookie = get_cookie()
    delay_minutes = args.delay_minutes if args.delay_minutes is not None else DEFAULT_DELAY_MINUTES
    if not cookie:
        notify("❌ Phase 1 执行失败！Cookie 无效或已过期")
        sys.exit(1)

    # ── 统一捕获多候选异常（发送给企微后退出0）─────────────────────
    try:
        from phase1.phase1_prepare.phase1_company import MultipleCandidatesError
    except ImportError:
        MultipleCandidatesError = None

    target_ts = 0  # 默认立即执行（定时时间在解析定时参数时赋值）

    # ── 直接指定公司ID（企微回复ID触发）───────────────────────────
    if args.company_id:
        from phase1.phase1_prepare.phase1_company import resolve_company_by_id
        from config_manager import get_config
        company_name, _ = resolve_company_by_id(args.company_id, cookie)
        print(f"[INFO] 直接指定公司: {company_name} ({args.company_id})")
        company_config = get_config(args.company_id, company_name, auto_confirm=True)
        if target_ts == 0:
            task_name = make_task_name(company_name)
            print(f"[INFO] Phase 1: 公司={company_name}, 任务={task_name}")
            result = run_phase1(cookie, args.company_id, company_config, task_name, company_name=company_name)
            saved_task_name = result.get("task_name") or task_name
            notify(f"✅ Phase 1 执行成功！任务={saved_task_name}，{delay_minutes}分钟后开始扫描", company_name)
            print(f"[INFO] 等待 {delay_minutes} 分钟后执行 Phase 2-5...", flush=True)
            time.sleep(delay_minutes * 60)
            run_phases2to5(args.company_id, saved_task_name, company_name)
            sys.exit(0)
        # 定时模式
        task_name = make_task_name(company_name)
        spawn_wait_and_run(target_ts, args.company_id, company_name, task_name, delay_minutes)
        notify(f"✅ 定时任务已就绪：漏扫 {company_name}，将在 {datetime.fromtimestamp(target_ts).strftime('%Y-%m-%d %H:%M')} 准时执行", company_name)
        sys.exit(0)

    # ── 新建任务 ─────────────────────────────────────────────
    if not args.company:
        print("[X ERROR] 必须指定 --company")
        sys.exit(1)

    # 解析定时时间（资产发现风格：完整 datetime → 毫秒时间戳）
    user_target_ts_ms = 0
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
                user_dt_aware = user_dt.replace(tzinfo=sh_tz)
                user_target_ts_ms = int(user_dt_aware.timestamp() * 1000)
                print(f"[INFO] 定时任务：start_time={user_target_ts_ms} ({parsed_str})", flush=True)
        else:
            print(f"[X ERROR] 无法识别的时间: {args.start_time}", flush=True)
            sys.exit(1)

    # Phase 1 立即执行（API payload 里带 start_time + cycle_time_start）
    from phase1.phase1_prepare.phase1_company import resolve_company
    from config_manager import get_config
    cookie = get_cookie()
    if not cookie:
        notify("❌ Phase 1 执行失败！Cookie 无效或已过期")
        sys.exit(1)
    try:
        corrected_company_name, company_id = resolve_company(args.company, cookie)
    except MultipleCandidatesError as e:
        candidates = e.candidates
        lines = [f"🔍 匹配到 {len(candidates)} 个候选公司，请回复编号或完整公司名确认："]
        for i, c in enumerate(candidates, 1):
            lines.append(f"  [{i}] {c['company_name']}")
        notify("\n".join(lines))
        sys.exit(0)
    print(f"[INFO] 确认公司: {corrected_company_name} ({company_id})")
    company_config = get_config(company_id, corrected_company_name, auto_confirm=True)
    task_name = make_task_name(corrected_company_name)
    print(f"[INFO] Phase 1: 公司={corrected_company_name}, 任务={task_name}")
    result = run_phase1(cookie, company_id, company_config, task_name, user_start_time=user_target_ts_ms, company_name=corrected_company_name)
    saved_task_name = task_name
    if result.get("code") not in (0, 1105, 1005):
        err_msg = result.get("msg") or result.get("message") or "未知错误"
        notify(f"❌ Phase 1 执行失败！任务创建失败: {err_msg}", corrected_company_name)
        sys.exit(1)
    # 1105/1005 = 任务已创建成功（仅有警告信息），正常往后走
    is_warning = result.get("code") in (1105, 1005)
    task_id = result.get("data", {}).get("task_id") if is_warning else None
    if is_warning:
        notify(f"✅ Phase 1 执行成功！任务={saved_task_name}（{result.get('msg', '')}，task_id={task_id or '待确认'}）", corrected_company_name)
    else:
        notify(f"✅ Phase 1 执行成功！任务={saved_task_name}", corrected_company_name)

    if user_target_ts_ms > 0:
        # 定时模式：计算 delay，写断点，启动后台进程等 target_ts 到期
        target_ts_s = user_target_ts_ms // 1000
        delay_s = target_ts_s - int(time.time())
        delay_minutes = max(0, delay_s // 60)
        spawn_wait_and_run(user_target_ts_ms, company_id, corrected_company_name, saved_task_name, delay_minutes)
        display_time = datetime.fromtimestamp(target_ts_s, tz=sh_tz).strftime("%Y-%m-%d %H:%M:%S")
        notify(f"✅ 定时任务已就绪：漏扫 {corrected_company_name}，将在 {display_time} 准时执行 Phase 2-5", corrected_company_name)
        print(f"[INFO] 漏扫任务 {saved_task_name} 已创建，定时 {display_time}，约 {delay_minutes} 分钟后执行 Phase 2-5", flush=True)
        sys.exit(0)
    else:
        # 立即模式
        print(f"[INFO] 启动后台进程，直接执行 Phase 2-5...", flush=True)
        spawn_wait_and_run_now(company_id, corrected_company_name, saved_task_name)
        sys.exit(0)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[X] 用户中断，退出")
        sys.exit(0)
    except SystemExit:
        raise
    except MultipleCandidatesError as e:
        from shared.notify import send_notification
        candidates = e.candidates
        lines = [f"🔍 匹配到 {len(candidates)} 个候选公司，请回复编号或完整公司名确认："]
        for i, c in enumerate(candidates, 1):
            lines.append(f"  [{i}] {c['company_name']}")
        send_notification("\n".join(lines))
        sys.exit(0)
    except Exception as e:
        try:
            from shared.notify import send_notification
            send_notification(f"❌ Phase 1 执行中断（未捕获异常）: {e}")
        except Exception:
            pass
        raise