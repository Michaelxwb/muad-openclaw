import io
import os
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase3.phase3_export_report import _download_url, export_report, run_phase3
from phase4.phase4_generate_message import fetch_policy_results, generate_policy_message, run_phase4
from shared.output import reports_dir
from shared.state import read_state, write_state


class FakeResponse:
    def __init__(self, content: bytes, disposition: str = ""):
        self.content = content
        self.headers = {"Content-Disposition": disposition}

    def iter_content(self, chunk_size=8192):
        yield self.content


def valid_docx() -> bytes:
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr("word/document.xml", "<document />")
    return target.getvalue()


class Phase3AndPhase4Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_patch = patch.dict(os.environ, {
            "POLICY_CHECK_MSSP_OUTPUT_DIR": self.temp.name,
        })
        self.output_patch.start()

    def tearDown(self):
        self.output_patch.stop()
        self.temp.cleanup()

    def test_report_url_preserves_gateway_prefix(self):
        self.assertEqual(
            _download_url("/order/v1/tools/task/download_report?file_id=f1"),
            "http://soar-inner.sangfor.com.cn:30001/gateway/idps/order/v1/tools/task/download_report?file_id=f1",
        )

    def test_report_directories_are_isolated_by_company(self):
        self.assertNotEqual(reports_dir("company-a"), reports_dir("company-b"))

    @patch("phase3.phase3_export_report.request")
    @patch("phase3.phase3_export_report.request_json")
    def test_valid_docx_is_saved(self, request_json, request):
        request_json.return_value = {"data": {
            "url": "/order/v1/tools/task/download_report?file_id=f1",
        }}
        request.return_value = FakeResponse(valid_docx(), "filename*=UTF-8''%E6%8A%A5%E5%91%8A.docx")
        result = export_report("cookie", "task", "company", "name")
        self.assertTrue(zipfile.is_zipfile(result["file_path"]))
        self.assertEqual(result["file_name"], "报告.docx")
        request_json.assert_called_once_with(
            "cookie", "POST", "report", {"_id": "task", "company_id": "company"},
        )

    @patch("phase3.phase3_export_report.request")
    @patch("phase3.phase3_export_report.request_json")
    def test_invalid_docx_is_rejected(self, request_json, request):
        request_json.return_value = {"data": {"url": "/download?file_id=f1"}}
        request.return_value = FakeResponse(b"not a docx", 'filename="bad.docx"')
        with self.assertRaisesRegex(RuntimeError, "DOCX"):
            export_report("cookie", "task", "company")

    @patch("phase3.phase3_export_report.get_session", return_value="cookie")
    @patch("phase3.phase3_export_report.export_report")
    def test_phase3_uses_saved_context_without_running_other_phases(self, export, _cookie):
        write_state({
            "status": "completed", "task_id": "task", "task_name": "name",
            "company_id": "company",
        })
        export.return_value = {"ok": True, "file_path": "/tmp/report.docx"}
        result = run_phase3()
        self.assertEqual(result["file_path"], "/tmp/report.docx")
        export.assert_called_once_with("cookie", "task", "company", "name")
        self.assertEqual(read_state()["execution"]["status"], "succeeded")
        self.assertTrue(read_state()["report_exported"])

    @patch("phase4.phase4_generate_message.request_json")
    def test_policy_results_preserve_time_pagination_and_dedup(self, request_json):
        tz = timezone(timedelta(hours=8))
        now = datetime(2026, 9, 1, 12, tzinfo=tz)
        base = {"dev_name": "AF-1", "dev_type": "AF", "name": "策略A",
                "description": "建议调整", "policy_status": "风险"}
        first_page = [{**base, "latest_time": ["2026-08-31 01:00:00"]}] * 100
        second_page = [
            {**base, "latest_time": "2026-09-01 10:00:00"},
            {**base, "name": "过期", "latest_time": "2026-08-30 23:59:59"},
        ]
        request_json.side_effect = [
            {"data": {"total": 102, "list": first_page}},
            {"data": {"total": 102, "list": second_page}},
        ]
        results = fetch_policy_results("cookie", "company", [1], now=now)
        self.assertEqual(len(results), 1)
        payloads = [call.args[3] for call in request_json.call_args_list]
        self.assertEqual([payload["offset"] for payload in payloads], [0, 100])
        self.assertTrue(all(payload["limit"] == 100 and payload["status"] == "at_risk"
                            for payload in payloads))

    @patch("phase4.phase4_generate_message.fetch_policy_results")
    def test_message_groups_legacy_categories_without_webhook(self, fetch):
        fetch.return_value = [
            {"dev_name": "AF-1", "dev_type": "AF", "name": "取策略",
             "description": "", "policy_status": "策略获取失败"},
            {"dev_name": "EDR-1", "dev_type": "EDR", "name": "授权",
             "description": "更新授权", "policy_status": "授权已过期"},
        ]
        result = generate_policy_message("cookie", "company", [1, 2], "task", "客户")
        self.assertEqual(result["summary"]["failed_count"], 1)
        self.assertEqual(result["summary"]["groups"], {"EDR": 1})
        self.assertIn("【策略检查】【客户】", result["message"])
        self.assertTrue(os.path.isfile(result["message_path"]))

    @patch("phase4.phase4_generate_message.get_session", return_value="cookie")
    @patch("phase4.phase4_generate_message.generate_policy_message")
    def test_phase4_can_run_independently_with_explicit_arguments(self, generate, _cookie):
        generate.return_value = {
            "summary": {"risk_count": 1}, "message": "result",
            "message_path": "/tmp/message.txt", "results_path": "/tmp/results.json",
            "results": [{"name": "risk"}],
        }
        result = run_phase4("company", [1], "task", "客户")
        self.assertNotIn("results", result)
        self.assertEqual(result["message"], "result")
        generate.assert_called_once_with("cookie", "company", [1], "task", "客户")
        self.assertEqual(read_state()["execution"]["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
