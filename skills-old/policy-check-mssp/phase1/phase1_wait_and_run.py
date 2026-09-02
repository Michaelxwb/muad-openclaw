#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Wait and Run - 后台等待进程（策略检查）
由 phase1_trigger.py 以 subprocess.Popen(DETACHED_PROCESS) 方式启动

两种模式：
  - 定时模式（target_ts > 0）：等待目标时间 → 执行 Phase 2-4（Phase 1 已在 foreground 完成）
  - 立即模式（target_ts=0）：马上执行 Phase 2-4（Phase 1 已在 foreground 完成）

不受 exec 超时影响
"""
import sys, os, time

sys.dont_write_bytecode = True

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def notify(content, company_name=""):
    try:
        sys.path.insert(0, ROOT_DIR)
        from shared.notify import send_notification
        send_notification(content, company_name=company_name)
    except Exception as e:
        print(f"[WARNING] 通知失败: {e}", file=sys.stderr)


def _run_phase2to4(company_id, company_name):
    """执行 Phase 2-4（直接 import 调用，不另起 subprocess，避免中文编码乱码）"""
    sys.path.insert(0, ROOT_DIR)
    print(f"[INFO] 直接执行 Phase 2-4: company_id={company_id}, company_name={company_name}", flush=True)

    # 保存原始 argv（供 phase2_run_through 内 argparse 解析）
    old_argv = sys.argv[:]
    try:
        sys.argv = ["phase2_run_through.py", "--company-id", company_id, "--company-name", company_name]
        from phase2.phase2_run_through import main as run_phase2_4
        run_phase2_4()
        print("[OK] Phase 2-4 执行完成")
        sys.exit(0)
    except SystemExit as e:
        if e.code == 0:
            print("[OK] Phase 2-4 执行完成")
            sys.exit(0)
        else:
            print(f"[X ERROR] Phase 2-4 失败 (code={e.code})")
            sys.exit(1)
    except Exception as e:
        print(f"[X ERROR] Phase 2-4 异常: {e}")
        notify(f"❌ Phase 2-4 执行异常: {e}", company_name=company_name)
        from shared import clean_reports
        clean_reports()
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        sys.argv = old_argv


def main():
    target_ts = float(os.environ.get("POLICY_TARGET_TS", "0"))
    company_id_arg = os.environ.get("POLICY_COMPANY_ID", "")
    company_name_arg = os.environ.get("POLICY_COMPANY_NAME", "")

    sys.path.insert(0, ROOT_DIR)

    if not company_id_arg or not company_name_arg:
        print("[X ERROR] 缺少参数（POLICY_COMPANY_ID / POLICY_COMPANY_NAME）")
        sys.exit(1)

    # 定时模式：等待目标时间 → 执行 Phase 2-4
    if target_ts > 0:
        mode_tag = "[定时模式]"
        target_ts_s = target_ts
        now = time.time()
        if target_ts_s > now:
            wait_s = target_ts_s - now
            print(f"[INFO] 等待 {wait_s/60:.1f} 分钟，{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(target_ts_s))} 执行 Phase 2-4...")
            time.sleep(wait_s)
        else:
            print(f"[INFO] 目标时间已过，立即执行 Phase 2-4...")
    else:
        print(f"[INFO] [立即模式] 后台进程启动，立即执行")

    print(f"[INFO] 时间到达，执行 Phase 2-4...")
    _run_phase2to4(company_id_arg, company_name_arg)
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
            from shared.notify import send_notification
            send_notification(f"❌ 策略检查定时执行异常: {e}")
        except Exception:
            pass
        raise
