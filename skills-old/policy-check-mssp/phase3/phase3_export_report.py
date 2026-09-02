#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 3 — 导出/下载策略检查报告

流程：
  1. POST report API → 获取 file_id
  2. GET download_report?file_id=xxx → 下载 docx 文件
  3. 报告文件推送到企微群

每个关键步骤无论成功失败都会通过企微 webhook 通知。
"""

import sys
import os
import uuid
import json
import subprocess
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# ── 路径 ──
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)

# 复用 vuln-scan shared
VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "vuln_shared", os.path.join(VULNSCAN, "shared", "__init__.py")
)
_vuln_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_vuln_shared)
log = _vuln_shared.log
get_cookie = _vuln_shared.get_cookie
extract_cookie_value = _vuln_shared.extract_cookie_value

import requests

# ── API 端点 ──
GATEWAY_BASE = "https://soar.sangfor.com.cn/gateway/idps"
REPORT_URL = f"{GATEWAY_BASE}/order/v1/tools/task/report"

# 通知脚本
NOTIFY_SCRIPT = os.path.join(POLICY_CHECK_ROOT, "shared", "notify.py")
REPORTS_DIR = os.path.join(POLICY_CHECK_ROOT, "reports")


def notify(step: str, status: str, detail: str = "", company_name: str = ""):
    """发送企微通知"""
    log(f"[通知] {step} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(step, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


def _build_headers(cookie: str, for_download: bool = False) -> dict:
    """构建浏览器标准 Headers"""
    headers = {
        "accept": "*/*" if for_download else "application/json, text/javascript, */*; q=0.01",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "cookie": cookie,
        "origin": "https://soar.sangfor.com.cn",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": "https://soar.sangfor.com.cn/index.html",
        "sec-ch-ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "timezone": "+08:00",
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
    }
    if not for_download:
        headers["content-type"] = "application/json"
    return headers


# ─────────────────────────────────────────────────────────────
# Phase 3 主流程
# ─────────────────────────────────────────────────────────────

def export_report(cookie: str, task_id: str, company_id: str, task_name: str = "", company_name: str = "") -> dict:
    """
    导出并下载策略检查报告。

    Step 1: POST report API 获取 file_id
    Step 2: GET download_report?file_id=xxx 下载 docx 文件

    Args:
        cookie: SOAR 平台 Cookie
        task_id: 任务的 _id
        company_id: 公司 ID
        task_name: 任务名（通知用）

    Returns:
        {
            "ok": True/False,
            "file_id": "xxx",
            "file_path": "C:\\...\\xxx.docx",
            "file_name": "xxx.docx"
        }
    """
    label = f"「{task_name}」(_id={task_id})" if task_name else f"_id={task_id}"

    log("=" * 50)
    log(f"Phase 3: 导出策略检查报告: company_id={company_id}, _id={task_id}")
    log("=" * 50)

    # ── Step 1: 获取下载 URL ──
    step = "3-1"

    headers = _build_headers(cookie, for_download=False)

    payload = {
        "_id": task_id,
        "company_id": company_id,
    }

    try:
        response = requests.post(REPORT_URL, headers=headers, json=payload, timeout=30, verify=False)
        if response is None:
            raise RuntimeError("请求返回为空")

        result = response.json()
        log(f"Step1 返回: code={result.get('code')}, msg={result.get('msg')}")

        if result.get("code") != 0:
            raise RuntimeError(f"API 返回错误: {result.get('msg', result)}")

        data = result.get("data", {})
        relative_url = data.get("url", "")
        if not relative_url:
            raise RuntimeError("未获取到报告下载 URL")

        # 提取 file_id
        file_id = ""
        if "file_id=" in relative_url:
            file_id = relative_url.split("file_id=")[-1]

        log(f"Step1 OK: relative_url={relative_url}, file_id={file_id}")
        notify(step, "进行中", f"正在导出报告，file_id={file_id}", company_name)

    except Exception as e:
        notify(step, "失败", f"报告导出失败: {e}", company_name)
        raise

    # ── Step 2: 下载报告文件 ──
    step = "3-2"

    # 拼接完整下载 URL
    download_url = f"{GATEWAY_BASE}{relative_url}"
    log(f"Step2 下载 URL: {download_url}")

    dl_headers = _build_headers(cookie, for_download=True)

    try:
        dl_response = requests.get(
            download_url,
            headers=dl_headers,
            timeout=120,
            verify=False,
            stream=True,
        )

        if dl_response.status_code != 200:
            raise RuntimeError(f"下载失败, HTTP {dl_response.status_code}: {dl_response.text[:500]}")

        # 从 Content-Disposition 提取文件名
        # 格式: ...filename*=UTF-8''xxx.docx; filename="xxx.docx"
        # 优先用 filename*=（URL 编码的 UTF-8），只取分号前的部分
        from urllib.parse import unquote
        import re as _re

        content_disp = dl_response.headers.get("Content-Disposition", "")
        file_name = ""

        # 1) 尝试 filename*= 部分
        m_star = _re.search(r"filename\*=UTF-8''([^;]+)", content_disp)
        if m_star:
            file_name = unquote(m_star.group(1).strip())

        # 2) 回退到 filename=
        if not file_name:
            m_plain = _re.search(r'filename="?([^";]+)"?', content_disp)
            if m_plain:
                file_name = m_plain.group(1).strip()

        # 3) 清洗文件名中的非法字符（Windows 不允许: \ / : * ? " < > | 以及换行）
        file_name = _re.sub(r'[\\/:*?"<>|\r\n]', '_', file_name)

        if not file_name:
            file_name = f"policy_check_report_{file_id}.docx"

        os.makedirs(REPORTS_DIR, exist_ok=True)
        file_path = os.path.join(REPORTS_DIR, file_name)

        with open(file_path, "wb") as f:
            for chunk in dl_response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        file_size = os.path.getsize(file_path)
        log(f"Step2 OK: 报告下载成功, 文件={file_name}, 大小={file_size / 1024:.1f} KB")

        # ── Step 3: 推送报告文件到企微群 ──
        from shared.notify import send_file_to_group
        step3 = "3-3"

        notify(step, "附件", f"报告文件: {file_name} ({file_size / 1024:.1f} KB)", company_name)
        ok = send_file_to_group(
            file_path,
            f"[策略检查报告] {label}"
        )
        if ok:
            notify(step3, "已完成", f"导出成功: {file_name}，进入阶段4，生成话术", company_name)
        else:
            notify(step3, "失败", f"报告推送失败: {file_name}", company_name)

        # 保存报告信息
        report_info = {
            "_id": task_id,
            "company_id": company_id,
            "task_name": task_name,
            "file_id": file_id,
            "relative_url": relative_url,
            "download_url": download_url,
            "file_name": file_name,
            "file_path": file_path,
            "file_size": file_size,
        }
        info_path = os.path.join(REPORTS_DIR, f"report_info_{task_id}.json")
        with open(info_path, "w", encoding="utf-8") as f:
            json.dump(report_info, f, ensure_ascii=False, indent=2)

        return {
            "ok": True,
            "file_id": file_id,
            "file_path": file_path,
            "file_name": file_name,
            "file_size": file_size,
            "relative_url": relative_url,
            "download_url": download_url,
        }

    except Exception as e:
        notify(step, "失败", f"报告下载失败: {e}", company_name)
        raise


# ─────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="导出并下载策略检查报告")
    parser.add_argument("--task-id", required=True, help="任务的 _id")
    parser.add_argument("--company-id", required=True, help="公司 ID")
    parser.add_argument("--task-name", default="", help="任务名（通知用）")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")
    args = parser.parse_args()

    cookie = args.cookie or get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    try:
        result = export_report(cookie, args.task_id, args.company_id, args.task_name)
        print(f"\n[OK] 策略检查报告导出完成")
        print(f"   file_id:    {result['file_id']}")
        print(f"   file_name:  {result['file_name']}")
        print(f"   file_path:  {result['file_path']}")
        print(f"   file_size:  {result['file_size']} bytes")
    except Exception as e:
        print(f"\n[FAIL] Phase 3 失败: {e}")
        sys.exit(1)
