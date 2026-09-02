#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 后台等待脚本（供定时任务调用）
用于定时执行时，等待指定时间后执行 Phase 2

两种模式：
  - 立即模式（PHASE1_IMMEDIATE_MODE=1）：Phase 1 已完成，等 delay 分钟后执行 Phase 2
  - 定时模式（target_ts > 0）：等目标时间到达，再等 delay 分钟后执行 Phase 2
"""
import sys
import os
import time
import json
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import get_cookie, DEFAULT_DELAY_MINUTES
from phase1.phase1_prepare import fetch_all_asset_ips

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    target_ts = int(os.environ.get("PHASE1_TARGET_TS", "0"))   # 毫秒时间戳（完整 datetime）
    company_id = os.environ.get("PHASE1_COMPANY", "")
    company_name = os.environ.get("PHASE1_CORRECTED_NAME", "")
    task_name = os.environ.get("PHASE1_TASK_NAME", "")
    immediate_mode = os.environ.get("PHASE1_IMMEDIATE_MODE", "0") == "1"

    # target_ts 已是完整 datetime 毫秒时间戳，直接转换显示
    sh_tz = timezone(timedelta(hours=8))
    target_sec = target_ts / 1000
    actual_target_dt = datetime.fromtimestamp(target_sec, tz=sh_tz)
    actual_target_ts = int(actual_target_dt.timestamp())   # 秒时间戳
    display_time = actual_target_dt.strftime("%Y-%m-%d %H:%M:%S")

    mode_tag = "[立即模式]" if immediate_mode else "[定时模式]"
    print(f"[INFO] 后台进程启动 {mode_tag}，target={actual_target_ts} ({display_time})", flush=True)

    # 立即模式：Phase 1 已完成，立即执行 Phase 2
    if immediate_mode:
        _run_phase2(company_id, task_name)
        sys.exit(0)

    # 定时模式：等 target 时间到达后立即执行 Phase 2（无额外 delay）
    now = int(time.time())
    if actual_target_ts > now:
        wait = actual_target_ts - now
        print(f"[INFO] 等待 {wait/60:.1f} 分钟后执行...")
        time.sleep(wait)
    else:
        print(f"[INFO] 时间已到，立即执行...")

    _run_phase2(company_id, task_name)


def _run_phase2(company_id: str, task_name: str):
    """执行 Phase 2（直接 import 调用，不另起 subprocess）"""
    cookie = get_cookie()
    if not cookie:
        print("[X ERROR] Cookie 无效", flush=True)
        sys.exit(1)

    try:
        asset_list = fetch_all_asset_ips(company_id, cookie)
    except Exception as e:
        print(f"[X ERROR] 获取资产列表失败: {e}", flush=True)
        sys.exit(1)

    asset_list_json = json.dumps(asset_list, ensure_ascii=False)
    print(f"[INFO] 直接执行 Phase 2: company_id={company_id}, task_name={task_name}", flush=True)

    old_argv = sys.argv[:]
    try:
        sys.argv = ["phase2_run_through.py", "--company-id", company_id,
                     "--task-name", task_name, "--asset-list", asset_list_json]
        from phase2.phase2_run_through import main as run_phase2
        run_phase2()
        print("[OK] Phase 2 执行完成")
        sys.exit(0)
    except SystemExit as e:
        if e.code == 0:
            sys.exit(0)
        else:
            print(f"[X ERROR] Phase 2 失败: exit_code={e.code}")
            sys.exit(e.code)
    except Exception as e:
        import traceback
        print(f"[X ERROR] Phase 2 异常: {e}")
        traceback.print_exc()
        sys.exit(1)
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    main()