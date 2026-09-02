#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞复测 Phase 1 定时等待进程
由 phase1_retest_trigger.py 以 subprocess.Popen(DETACHED_PROCESS) 方式启动

两种模式：
  - 立即模式（PHASE1_IMMEDIATE_MODE=1）：等 delay 后执行 Phase 2
  - 定时模式（target_ts > 0）：等待目标时间 → 执行 Phase 2

不受 exec 超时影响，有完整 M: 盘访问权限
"""
import sys, os, time, json

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def notify(content, company_name=""):
    try:
        sys.path.insert(0, ROOT_DIR)
        from shared import send_notification
        send_notification("漏洞复测", "进行中", content, company_name=company_name)
    except Exception as e:
        print(f"[WARNING] 通知失败: {e}", file=sys.stderr)


def _run_phase2(company_id, company_name=""):
    """执行 Phase 2 轮询（直接 import 调用，不另起 subprocess）"""
    sys.path.insert(0, ROOT_DIR)
    print(f"[INFO] 直接执行 Phase 2: company_id={company_id}", flush=True)

    old_argv = sys.argv[:]
    try:
        sys.argv = ["phase2_retest_poll.py", "--company-id", company_id, "--company-name", company_name]
        from phase2.phase2_retest_poll import main as run_phase2
        run_phase2()
        print("[OK] Phase 2 执行完成")
        sys.exit(0)
    except SystemExit as e:
        if e.code == 0:
            print("[OK] Phase 2 执行完成")
            sys.exit(0)
        else:
            print(f"[X ERROR] Phase 2 失败 (code={e.code})")
            notify(f"Phase 2 执行失败 (code={e.code})", company_name)
            sys.exit(1)
    except Exception as e:
        print(f"[X ERROR] Phase 2 异常: {e}")
        notify(f"Phase 2 执行异常: {e}", company_name)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        sys.argv = old_argv


def main():
    target_ts = int(os.environ.get("PHASE1_TARGET_TS", "0"))
    company_arg = os.environ.get("PHASE1_COMPANY", "")
    corrected_company_name = os.environ.get("PHASE1_CORRECTED_NAME", "")

    sys.path.insert(0, ROOT_DIR)
    from shared import DEFAULT_DELAY_MINUTES
    delay_minutes = int(os.environ.get("PHASE1_DELAY", str(DEFAULT_DELAY_MINUTES)))
    immediate_mode = os.environ.get("PHASE1_IMMEDIATE_MODE", "0") == "1"

    if not company_arg:
        print("[X ERROR] 缺少参数")
        sys.exit(1)

    mode_tag = "[立即模式]" if immediate_mode else "[定时模式]"
    print(f"[INFO] 后台进程启动 {mode_tag}，target={target_ts}", flush=True)

    # 立即模式：等 delay 后执行 Phase 2
    if immediate_mode:
        print(f"[INFO] 立即模式：等 {delay_minutes} 分钟后执行 Phase 2...")
        time.sleep(delay_minutes * 60)
        _run_phase2(company_arg, corrected_company_name)
        sys.exit(0)

    # 定时模式：等待目标时间 → 执行 Phase 2
    now = time.time()
    target_ts_s = target_ts / 1000
    if target_ts_s > now:
        wait_s = target_ts_s - now
        print(f"[INFO] 等待 {wait_s/60:.1f} 分钟，{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(target_ts_s))} 执行 Phase 2...")
        time.sleep(wait_s)
    else:
        print(f"[INFO] 目标时间已到或已过，立即执行 Phase 2...")

    print(f"[INFO] 时间到达，执行 Phase 2...")
    _run_phase2(company_arg, corrected_company_name)
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
            send_notification("漏洞复测定时执行", "异常", str(e))
        except Exception:
            pass
        raise