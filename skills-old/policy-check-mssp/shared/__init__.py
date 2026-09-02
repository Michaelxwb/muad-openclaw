#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""策略检查（policy-check）共享模块"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import ssl

# 项目根目录
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# Cookie 获取
# ─────────────────────────────────────────────────────────────

def get_cookie() -> str:
    """获取 SOAR 平台 Cookie，优先级：环境变量 > cookies.txt"""
    # 1. 环境变量
    for key in ("POLICY_CHECK_COOKIE", "VULN_SCAN_COOKIE", "COOKIE"):
        val = os.environ.get(key)
        if val:
            return val

    # 2. 候选文件
    candidates = [
        r"M:\Users\User\Downloads\cookies.txt",
        os.path.join(POLICY_CHECK_ROOT, "cookie.txt"),
    ]
    for fp in candidates:
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8") as f:
                cookie = f.read().strip()
            if cookie:
                return cookie

    raise RuntimeError("未找到 Cookie，请将 Cookie 放入 M:\\Users\\User\\Downloads\\cookies.txt 或设置环境变量 POLICY_CHECK_COOKIE")


# ─────────────────────────────────────────────────────────────
# HTTP 请求
# ─────────────────────────────────────────────────────────────

def request_with_retry(url: str, payload: dict = None, method: str = "POST",
                       cookie: str = None, max_retries: int = 3, timeout: int = 30) -> dict:
    """带重试的 HTTP 请求，返回解析后的 JSON"""
    if cookie is None:
        cookie = get_cookie()

    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cookie": cookie,
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
    }

    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    last_err = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            last_err = e
            body = e.read().decode("utf-8", errors="ignore")
            log(f"HTTP {e.code}: {body[:500]}", "WARN")
            if e.code in (401, 403):
                break  # 不重试
        except Exception as e:
            last_err = e
            log(f"请求异常 (attempt {attempt+1}/{max_retries}): {e}", "WARN")

        if attempt < max_retries - 1:
            time.sleep(2 ** attempt)

    raise RuntimeError(f"请求失败: {last_err}")


# ─────────────────────────────────────────────────────────────
# Reports 清理
# ─────────────────────────────────────────────────────────────

def clean_reports():
    """清空 reports 目录（每次执行前/后调用，避免残留文件堆积）"""
    import glob
    reports_dir = os.path.join(POLICY_CHECK_ROOT, "reports")
    if not os.path.isdir(reports_dir):
        return
    for f in glob.glob(os.path.join(reports_dir, "*")):
        try:
            os.remove(f)
            log(f"[清理] 已删除: {os.path.basename(f)}", "INFO")
        except Exception as e:
            log(f"[清理] 删除失败 {os.path.basename(f)}: {e}", "WARN")


# ─────────────────────────────────────────────────────────────
# 日志
# ─────────────────────────────────────────────────────────────

def log(msg: str, level: str = "INFO"):
    """带时间戳的日志输出"""
    from datetime import datetime
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────
# 通知
# ─────────────────────────────────────────────────────────────

def send_notification(phase: str, status: str, detail: str = "", company_name: str = "") -> bool:
    """发送企微通知"""
    try:
        from shared.notify import send_notification as _notify
        return _notify(phase, status, detail, company_name=company_name)
    except Exception:
        # 回退：尝试直接发送
        try:
            config_path = os.path.join(os.path.dirname(POLICY_CHECK_ROOT), "webhook_config.json")
            if os.path.exists(config_path):
                webhook_url = json.load(open(config_path, encoding="utf-8"))["webhook_url"]
                phase_names = {
                    "1": "策略检查-阶段1: 下发检查任务",
                    "2": "策略检查-阶段2: 轮询检查状态",
                    "3": "策略检查-阶段3: 导出报告",
                    "4": "策略检查-阶段4: 生成话术",
                }
                phase_label = phase_names.get(str(phase), f"阶段{phase}")
                content = f"{phase_label}\n状态: {status}"
                if detail:
                    content += f"\n详情: {detail}"
                data = json.dumps({"msgtype": "text", "text": {"content": content}}, ensure_ascii=False).encode("utf-8")
                req = urllib.request.Request(webhook_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"})
                with urllib.request.urlopen(req) as resp:
                    pass
                return True
        except Exception:
            pass
    return False


