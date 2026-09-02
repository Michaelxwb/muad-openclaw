#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执行阶段2-5（供 Task Scheduler 定时任务调用）"""
import sys, os, argparse
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import log, get_cookie
from phase2 import phase2_wait_scan
from phase3 import phase3_create_report_task
from phase4 import phase4_wait_report
from phase5 import phase5_download_report
from shared import send_notification, send_file_message
from phase3.phase3_fetch_vuln_list import phase3_fetch_vuln_list as phase3_fetch_all_vuln_lists
from phase3.phase3_audit_vuln import phase3_audit_vulns


def _extract_company_name(task_name: str) -> str:
    """从 task_name 提取公司名，格式: 漏扫任务_公司名_时间戳"""
    import re
    # 匹配 漏扫任务_公司名_12位时间戳（YYYYMMDDHHMM）
    m = re.match(r'^漏扫任务_(.+)_\d{12}$', task_name)
    if m:
        return m.group(1)
    return task_name


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

def main():
    parser = argparse.ArgumentParser(description="Phase 2-5 执行")
    parser.add_argument("--task-name", type=str, required=True)
    parser.add_argument("--company-id", type=str, required=True)
    args = parser.parse_args()

    cookie = get_cookie()
    company_id = args.company_id
    task_name = args.task_name

    print(f"任务名称: {task_name}")
    print(f"公司ID: {company_id}")
    print()

    try:
        _run_phases(cookie, company_id, task_name)
    except KeyboardInterrupt:
        print("\n[X] 用户中断，退出")
    except SystemExit:
        raise
    except Exception as e:
        try:
            send_notification("漏扫 Phase 2-5", "执行中断", f"未捕获异常: {e}", company_name=_extract_company_name(task_name))
        except:
            pass
        raise


def _run_phases(cookie, company_id, task_name):
    company_name = _extract_company_name(task_name)
    # ========== Phase 2: 轮询扫描状态 ==========
    log("=" * 50, "INFO")
    log("Phase 2: Poll scan completion", "INFO")
    log("=" * 50, "INFO")
    try:
        task_id = phase2_wait_scan(cookie, task_name, company_id, company_name=company_name)
    except Exception as e:
        send_notification("Phase 2", "执行失败", f"扫描轮询异常: {e}", company_name=company_name)
        raise
    if not task_id:
        send_notification("Phase 2", "执行失败", f"扫描未完成（{task_name}）", company_name=company_name)
        log("X 扫描未完成，退出", "ERROR")
        sys.exit(1)
    log(f"task_id: {task_id}", "INFO")

    # ========== Phase 3: 审核漏洞 + 创建报告任务 ==========
    log("=" * 50, "INFO")
    log("Phase 3: Audit vulns + Create report task", "INFO")
    log("=" * 50, "INFO")
    send_notification("Phase 3", "执行中", "开始审核漏洞并创建报告任务", company_name=company_name)

    # Step 1: 获取漏洞列表（原理扫描 + 版本对比）
    log("[Step 1] 获取漏洞列表...", "INFO")
    try:
        vuln_result = phase3_fetch_all_vuln_lists(company_id, cookie)
    except Exception as e:
        send_notification("Phase 3", "执行失败", f"获取漏洞列表异常: {e}", company_name=company_name)
        raise
    # 不再因漏洞数为0而退出——创建报告导出任务的请求是否成功才是关键
    if vuln_result:
        log(f"[Step 1] 获取到漏洞列表: {vuln_result}", "INFO")
    else:
        log("[Step 1] 漏洞列表为空，但继续执行报告导出（Step 3）", "INFO")

    # Step 2: 审核漏洞
    log("[Step 2] 审核漏洞...", "INFO")
    try:
        audit_result = phase3_audit_vulns(company_id, cookie)
    except Exception as e:
        send_notification("Phase 3", "执行失败", f"审核漏洞异常: {e}", company_name=company_name)
        raise
    log(f"[Step 2] 审核结果: {audit_result}", "INFO")

    # Step 3: 创建报告导出任务
    log("[Step 3] 创建报告导出任务...", "INFO")
    try:
        md5_index = phase3_create_report_task(cookie, task_id, company_id, company_name=company_name)
    except Exception as e:
        send_notification("Phase 3", "执行失败", f"创建报告任务异常: {e}", company_name=company_name)
        raise
    if not md5_index:
        send_notification("Phase 3", "执行失败", f"报告任务创建失败（task_id={task_id}）", company_name=company_name)
        log("X 报告任务创建失败，退出", "ERROR")
        sys.exit(1)
    log(f"md5_index: {md5_index}", "INFO")
    send_notification("Phase 3", "执行成功", "漏洞审核及报告任务创建完成，开始轮询报告生成", company_name=company_name)


    # ========== Phase 4: 轮询报告生成 ==========
    log("=" * 50, "INFO")
    log("Phase 4: Poll report generation", "INFO")
    log("=" * 50, "INFO")
    send_notification("Phase 4", "执行中", "开始轮询报告生成状态", company_name=company_name)
    try:
        report_task_id = phase4_wait_report(cookie, task_id, company_id)
    except Exception as e:
        send_notification("Phase 4", "执行失败", f"报告轮询异常: {e}", company_name=company_name)
        raise
    if not report_task_id:
        send_notification("Phase 4", "执行失败", f"报告生成失败（md5_index={md5_index}）", company_name=company_name)
        log("X 报告未生成，退出", "ERROR")
        sys.exit(1)
    log(f"report_task_id: {report_task_id}", "INFO")


    # ========== Phase 5: 下载报告 ==========
    log("=" * 50, "INFO")
    log("Phase 5: Download report", "INFO")
    log("=" * 50, "INFO")
    send_notification("Phase 5", "执行中", "开始下载报告", company_name=company_name)
    try:
        file_path = phase5_download_report(
            cookie, report_task_id, company_id,
            company_name=_extract_company_name(task_name),
            export_type=_load_company_export_type(company_id),
        )
    except Exception as e:
        send_notification("Phase 5", "执行失败", f"下载报告异常: {e}", company_name=company_name)
        raise
    if file_path:
        log(f"OK 报告已保存至: {file_path}", "INFO")
        try:
            # ── 生成并发送漏洞话术 ───────────────────────────────
            try:
                import zipfile
                from phase5.generate_report_message import generate_vuln_summary, build_message, _load_template

                # 下载的报告 ZIP 用 UTF-8 编码存储文件名，需指定才能正确解码
                xls_bytes = None
                try:
                    with zipfile.ZipFile(file_path, 'r', metadata_encoding='utf-8') as zf:
                        for name in zf.namelist():
                            if '\u6f0f\u6d1e\u6e05\u5355' in name:
                                xls_bytes = zf.read(name)
                                log(f"[INFO] 找到漏洞清单: {name}", "INFO")
                                break
                except Exception as ex:
                    log(f"[WARNING] 读取 ZIP 元数据失败: {ex}", "WARNING")
                if xls_bytes:
                    # 将 xls 包装成正式 zip（避免 generate_vuln_summary 打开时 "not a zip file"）
                    import io as _io, tempfile as _tempfile
                    _zip_buf = _io.BytesIO()
                    with zipfile.ZipFile(_zip_buf, 'w', zipfile.ZIP_DEFLATED) as _zf:
                        _zf.writestr('漏洞清单.xls', xls_bytes)
                    _zip_buf.seek(0)
                    with _tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as _tf:
                        _tf.write(_zip_buf.read())
                        tmp_zip_path = _tf.name
                    try:
                        result = generate_vuln_summary(tmp_zip_path)
                        template = _load_template()
                        msg = build_message(template, result['summary'], result['top3'])
                        msg = f"【漏扫】【{company_name}】话术:\n\n" + msg
                        send_notification("漏扫话术", "已发送", msg, company_name=company_name)
                        log(f"OK 漏洞话术已发送", "INFO")
                    finally:
                        try:
                            os.unlink(tmp_zip_path)
                        except Exception:
                            pass
                else:
                    log(f"[WARNING] 未找到漏洞清单，跳过话术生成", "WARNING")
            except Exception as e:
                log(f"[WARNING] 生成话术失败，不影响主流程: {e}", "WARNING")

            send_file_message(file_path, f"[OK] 【漏扫】【{company_name}】报告已生成！")
            log(f"OK 已发送到企微群", "INFO")
            send_notification("漏扫扫描", "执行成功", f"报告已下载并发送到群: {os.path.basename(file_path)}", company_name=company_name)
            # 发送成功后删除本地文件节省存储
            try:
                os.remove(file_path)
                log(f"OK 已删除本地文件: {file_path}", "INFO")
            except Exception as e:
                log(f"WARNING 删除本地文件失败: {e}", "WARNING")
        except Exception as e:
            log(f"WARNING 发送到企微群失败，不删除本地文件: {e}", "WARNING")
            send_notification("漏扫扫描", "执行成功但发送失败", f"报告已下载: {os.path.basename(file_path)}，但发送到群失败: {e}", company_name=company_name)
        print(f"\nAll done! Report: {file_path}")
    else:
        send_notification("Phase 5", "执行失败", f"report_task_id={report_task_id}", company_name=company_name)
        log("X 报告下载失败", "ERROR")
        sys.exit(1)

if __name__ == "__main__":
    main()
