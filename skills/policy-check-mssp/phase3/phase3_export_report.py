#!/usr/bin/env python3
"""Phase 3: export and validate the MSSP policy-check DOCX report."""

import argparse
import os
import re
import sys
import tempfile
import zipfile
from urllib.parse import unquote, urlsplit, urlunsplit

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from shared import (
    ActiveRunError,
    RunLock,
    atomic_write_json,
    begin_step,
    emit_json,
    finish_step,
    get_session,
    latest_status,
    origin,
    read_state,
    reports_dir,
    request,
    request_json,
    update_state,
)


def _download_url(relative_url: str) -> str:
    parsed = urlsplit(str(relative_url))
    path = parsed.path
    if not path.startswith("/"):
        path = "/" + path
    if path.startswith("/order/"):
        path = "/gateway/idps" + path
    base = urlsplit(origin())
    return urlunsplit((base.scheme, base.netloc, path, parsed.query, ""))


def _file_id(relative_url: str) -> str:
    from urllib.parse import parse_qs
    return parse_qs(urlsplit(relative_url).query).get("file_id", [""])[0]


def _file_name(content_disposition: str, file_id: str) -> str:
    match = re.search(r"filename\*=UTF-8''([^;]+)", content_disposition, re.IGNORECASE)
    name = unquote(match.group(1).strip()) if match else ""
    if not name:
        match = re.search(r'filename="?([^";]+)"?', content_disposition, re.IGNORECASE)
        name = match.group(1).strip() if match else ""
    name = os.path.basename(re.sub(r'[\\/:*?"<>|\r\n]', "_", name))
    if not name.lower().endswith(".docx"):
        name = f"policy_check_report_{file_id or 'unknown'}.docx"
    return name


def _safe_identifier(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]", "_", str(value))[:120] or "unknown"


def _validate_docx(path: str) -> None:
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise RuntimeError("下载的策略检查报告为空")
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            required = {"[Content_Types].xml", "word/document.xml"}
            if not required.issubset(names) or archive.testzip() is not None:
                raise RuntimeError("下载内容不是完整的 DOCX 报告")
    except zipfile.BadZipFile as exc:
        raise RuntimeError("下载内容不是有效的 DOCX 报告") from exc


def export_report(cookie: str, task_id: str, company_id: str,
                  task_name: str = "") -> dict:
    payload = {"_id": task_id, "company_id": company_id}
    result = request_json(cookie, "POST", "report", payload)
    relative_url = str(result.get("data", {}).get("url") or "")
    if not relative_url:
        raise RuntimeError("MSSP 未返回策略检查报告下载地址")
    file_id = _file_id(relative_url)
    url = _download_url(relative_url)
    response = request(cookie, "GET", url, timeout=120, download=True, stream=True)
    name = _file_name(response.headers.get("Content-Disposition", ""), file_id)
    report_dir = reports_dir(company_id)
    destination = os.path.join(report_dir, name)
    _write_response(response, destination)
    info = {
        "_id": task_id, "company_id": company_id, "task_name": task_name,
        "file_id": file_id, "relative_url": relative_url, "download_url": url,
        "file_name": name, "file_path": destination, "file_size": os.path.getsize(destination),
    }
    info_name = f"report_info_{_safe_identifier(task_id)}.json"
    atomic_write_json(os.path.join(report_dir, info_name), info)
    return {"ok": True, **info}


def _write_response(response, destination: str) -> None:
    fd, temp_path = tempfile.mkstemp(prefix=".report-", dir=os.path.dirname(destination))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        _validate_docx(temp_path)
        os.replace(temp_path, destination)
        os.chmod(destination, 0o600)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def run_phase3(task_id: str = "", company_id: str = "",
               task_name: str = "") -> dict:
    latest = read_state() or {}
    resolved_company = str(company_id or latest.get("company_id") or "")
    if not resolved_company:
        raise ValueError("缺少 company_id，请先执行 Phase 2 或显式传入")
    with RunLock(resolved_company):
        begin_step("phase3", resolved_company)
        try:
            state = read_state(resolved_company) or {}
            resolved_task = str(task_id or state.get("task_id") or "")
            resolved_name = str(task_name or state.get("task_name") or "")
            if not resolved_task or not resolved_company:
                raise ValueError("缺少 task_id 或 company_id，请先执行 Phase 2 或显式传入")
            result = export_report(
                get_session(), resolved_task, resolved_company, resolved_name,
            )
            update_state(
                resolved_company,
                current_phase="phase3", task_id=resolved_task,
                company_id=resolved_company, task_name=resolved_name,
                report_path=result["file_path"], report_exported=True,
            )
            finish_step(company_id=resolved_company)
            return result
        except Exception as exc:
            finish_step("failed", str(exc), resolved_company)
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 3：单独导出 MSSP 策略检查报告")
    parser.add_argument("--task-id")
    parser.add_argument("--company-id")
    parser.add_argument("--task-name", default="")
    args = parser.parse_args()
    try:
        emit_json(run_phase3(args.task_id or "", args.company_id or "", args.task_name))
        return 0
    except ActiveRunError as exc:
        emit_json({"ok": False, "error": str(exc), "latest": exc.state}, error=True)
        return 3
    except Exception as exc:
        emit_json({"ok": False, "error": str(exc),
                   "latest": latest_status(args.company_id or "")}, error=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
