import pathlib
import re
import sys
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import run  # noqa: E402


EMOJI_PATTERN = re.compile(
    "["
    "\\U0001F000-\\U0001FAFF"
    "\\U00002600-\\U000027BF"
    "]"
)


class ParseArgsTest(unittest.TestCase):
    def test_customer_and_duration_are_required(self):
        with self.assertRaises(SystemExit):
            run.parse_args([])
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001"])
        with self.assertRaises(SystemExit):
            run.parse_args(["--minutes", "15"])

    def test_duration_must_be_positive(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--minutes", "0"])
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--minutes", "-1"])

    def test_explicit_customer_and_duration_are_preserved(self):
        args = run.parse_args([
            "--company-id", "1001",
            "--company-id", "1002",
            "--minutes", "15",
        ])
        self.assertEqual(args.company_ids, ["1001", "1002"])
        self.assertEqual(args.minutes, 15)

    def test_monitor_entry_rejects_alias_as_company_id(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "卓驭", "--minutes", "15"])

    def test_monitor_entry_has_no_company_keyword_option(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company", "卓驭", "--minutes", "15"])


class EventQueryTest(unittest.TestCase):
    def test_event_query_rejects_missing_customer_ids_before_request(self):
        with self.assertRaisesRegex(ValueError, "明确指定"):
            run.fetch_event_table("cookie", 1, 2, company_ids=[])

    def test_event_query_rejects_customer_keyword_as_company_id(self):
        with self.assertRaisesRegex(ValueError, "数字 company_id"):
            run.fetch_event_table("cookie", 1, 2, company_ids=["卓驭"])

    def test_event_query_rejects_invalid_time_window_and_limit(self):
        with self.assertRaisesRegex(ValueError, "递增"):
            run.fetch_event_table("cookie", 2, 1, company_ids=["1001"])
        with self.assertRaisesRegex(ValueError, "limit"):
            run.fetch_event_table("cookie", 1, 2, company_ids=["1001"], limit=101)

    def test_event_query_sends_only_confirmed_numeric_ids(self):
        class Response:
            @staticmethod
            def json():
                return {"code": 0, "data": {"list": []}}

        with patch.object(run.shared, "http_json", return_value=Response()) as request:
            run.fetch_event_table("cookie", 1, 2, company_ids=["20003309"])
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["company_id"], ["20003309"])
        self.assertNotIn("卓驭", str(payload))

    def test_confirmed_customer_ids_are_resolved_to_full_platform_names(self):
        candidates = [{
            "company_id": "1001",
            "company_name": "绝味食品股份有限公司",
        }]
        with patch.object(run.shared, "search_customers", return_value=candidates):
            customers = run.resolve_confirmed_company_ids("cookie", ["1001"])
        self.assertEqual(customers, {"绝味食品股份有限公司": "1001"})

    def test_customer_resolution_rejects_missing_full_name(self):
        with patch.object(run.shared, "search_customers", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "完整客户名称"):
                run.resolve_confirmed_company_ids("cookie", ["1001"])

    def test_asset_query_rejects_untrusted_company_id(self):
        with self.assertRaisesRegex(ValueError, "数字 company_id"):
            run.shared.get_asset_info("cookie", "10.0.0.1", "卓驭")

    def test_event_query_rejects_non_object_customer_candidates(self):
        response = type("Response", (), {
            "json": staticmethod(lambda: {
                "code": 0,
                "data": {"list": [None, "invalid", {
                    "company_name": "绝味食品股份有限公司",
                    "company_id": "1001",
                }]},
            })
        })()
        with patch.object(run.shared, "http_json", return_value=response):
            candidates = run.shared.search_customers("cookie", "绝味")
        self.assertEqual(candidates, [{
            "company_name": "绝味食品股份有限公司",
            "company_id": "1001",
        }])

    def test_report_uses_fixed_dense_field_order(self):
        row = {
            "company": "客户A", "event_name": "事件A", "event_id": "evt-1",
            "host_ip": "10.0.0.1", "hostname": "host-a", "asset_name": "核心服务器",
            "asset_group": "生产组", "business_name": "核心业务",
            "business_level": "核心",
            "asset_type": "服务器", "dev_name": "NGES-1", "is_nges_src": True,
            "device_type": 69, "nges_installed": True,
            "classification": "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）",
            "is_gpt": True,
            "pass_titles": ["检测通过", "终端GPT研判通过"], "all_titles": [],
        }
        report = run.format_report(15, {"客户A": "1001"}, [row], [])
        self.assertTrue(report.startswith(
            "MSSP 事件监控结果（最近 15 分钟 · 1 个客户）\n"
            + "=" * 56
        ))
        self.assertIn("监控客户                : 1个（客户A）", report)
        self.assertNotIn("1个（1001）", report)
        self.assertIn("监控窗口                : 最近15分钟", report)
        self.assertNotIn("｜", report)
        self.assertNotIn("|", report)
        self.assertIsNone(EMOJI_PATTERN.search(report))
        self.assertNotIn("查询失败客户", report)
        self.assertNotIn("场景统计", report)
        self.assertIn("事件 1\n客户                    : 客户A", report)
        self.assertIn("主机名称                : host-a", report)
        self.assertIn("资产名称                : 核心服务器", report)
        self.assertIn("业务名称                : 核心业务", report)
        self.assertIn(
            "业务名称                : 核心业务\n业务等级                : 核心\n资产类型",
            report,
        )
        self.assertIn("关联告警                :", report)
        self.assertIn("- 检测通过", report)
        self.assertIn("共2条关联告警", report)
        self.assertNotIn("数据源                  :", report)
        self.assertNotIn("NGES 安装               :", report)
        self.assertNotIn("终端 GPT                :", report)
        self.assertNotIn("场景1", report)
        self.assertNotIn("场景                    :", report)
        self.assertIn(
            "共2条关联告警\n事件分类                : "
            "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）",
            report,
        )

    def test_report_omits_related_alarm_field_when_no_alarm_exists(self):
        row = {
            "company": "绝味食品股份有限公司", "event_name": "事件A",
            "event_id": "evt-1", "classification": "杀毒引擎上报事件",
            "all_titles": [], "pass_titles": [],
        }
        report = run.format_report(
            15, {"绝味食品股份有限公司": "1001"}, [row], []
        )
        self.assertNotIn("关联告警", report)
        self.assertIn("事件分类                : 杀毒引擎上报事件", report)

    def test_report_separates_multiple_events_only_between_events(self):
        row = {
            "company": "客户A", "event_name": "事件A", "event_id": "evt-1",
            "device_type": 69, "is_nges_src": True, "classification": "杀毒引擎上报事件",
        }
        report = run.format_report(15, {"客户A": "1001"}, [row, row], [])
        separator = "-" * 56
        self.assertEqual(report.count("=" * 56), 1)
        self.assertEqual(report.count(separator), 1)
        self.assertIn(f"事件 1\n客户", report)
        self.assertIn(f"{separator}\n事件 2\n客户", report)

    def test_report_only_shows_failed_customers_when_present(self):
        report = run.format_report(15, {"客户A": "1001"}, [], ["客户A"])
        self.assertIn("查询失败客户            : 客户A", report)
        self.assertIsNone(EMOJI_PATTERN.search(report))

    def test_report_omits_failed_customer_line_when_all_queries_succeed(self):
        report = run.format_report(15, {"客户A": "1001"}, [], [])
        self.assertNotIn("查询失败客户", report)
        self.assertIn("结论：监控窗口内未发现可推送的新事件。", report)

    def test_chat_output_is_wrapped_in_one_code_block(self):
        output = run.format_chat_output("监控结果")
        self.assertEqual(output, "```\n监控结果\n```")
        self.assertEqual(output.count("```"), 2)

    def test_asset_type_supports_platform_text_values(self):
        self.assertEqual(run.asset_type_cn("endpoint"), "终端")
        self.assertEqual(run.asset_type_cn("server"), "服务器")

    def test_business_level_maps_asset_api_codes(self):
        self.assertEqual(run.business_level_cn(1), "核心")
        self.assertEqual(run.business_level_cn("2"), "重要")
        self.assertEqual(run.business_level_cn(3), "一般")
        self.assertEqual(run.business_level_cn(None), "")
        self.assertEqual(run.business_level_cn(4), "")
        self.assertEqual(run.business_level_cn("unknown"), "")

    def test_asset_query_returns_complete_asset_information(self):
        class Response:
            @staticmethod
            def json():
                return {"code": 0, "data": {"list": [{
                    "asset_name": "核心服务器", "hostname": "host-a",
                    "business_name": "核心业务", "asset_type": "server",
                    "business_level": 1,
                    "adapter": {"NGES": [{"dev_name": "SaaS_NGES"}]},
                }]}}

        with patch.object(run.shared, "http_json", return_value=Response()):
            asset = run.shared.get_asset_info("cookie", "10.0.0.1", "1001")
        self.assertEqual(asset["asset_name"], "核心服务器")
        self.assertEqual(asset["hostname"], "host-a")
        self.assertEqual(run.business_level_cn(asset["business_level"]), "核心")
        self.assertTrue(asset["nges_installed"])
        self.assertEqual(run.adapter_device_names(asset), "SaaS_NGES")


if __name__ == "__main__":
    unittest.main()
