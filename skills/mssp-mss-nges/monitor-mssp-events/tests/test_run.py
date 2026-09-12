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

# 固定的时间窗口描述（format_report 第一参为字符串，不再传分钟整数）
WIN = "最近10分钟"


class ParseArgsTest(unittest.TestCase):
    def test_company_ids_are_required(self):
        # 仅给公司不给时间范围也应失败
        with self.assertRaises(SystemExit):
            run.parse_args([])
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001"])

    def test_time_range_must_be_provided_either_way(self):
        # 两者都缺：报错要求时间范围
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001"])

    def test_minutes_must_be_positive(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--minutes", "0"])
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--minutes", "-1"])

    def test_explicit_minutes_is_preserved(self):
        args = run.parse_args([
            "--company-id", "1001",
            "--company-id", "1002",
            "--minutes", "10",
        ])
        self.assertEqual(args.company_ids, ["1001", "1002"])
        self.assertEqual(args.mode, "minutes")
        self.assertEqual(args.minutes, 10)
        # start/end 由 minutes 推导
        self.assertIsNotNone(args.start)
        self.assertGreater(args.end, args.start)

    def test_explicit_start_end_are_preserved(self):
        args = run.parse_args([
            "--company-id", "1001",
            "--start", "2026-09-05 00:00",
            "--end", "2026-09-08 10:19",
        ])
        self.assertEqual(args.mode, "range")
        self.assertIsNotNone(args.start)
        self.assertGreater(args.end, args.start)

    def test_minutes_and_range_are_mutually_exclusive(self):
        with self.assertRaises(SystemExit):
            run.parse_args([
                "--company-id", "1001", "--minutes", "120",
                "--start", "2026-09-05 00:00", "--end", "2026-09-08 10:19",
            ])

    def test_start_requires_end(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--start", "2026-09-05 00:00"])
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--end", "2026-09-08 10:19"])

    def test_end_must_be_after_start(self):
        with self.assertRaises(SystemExit):
            run.parse_args([
                "--company-id", "1001",
                "--start", "2026-09-08 10:00", "--end", "2026-09-05 00:00",
            ])

    def test_monitor_entry_rejects_alias_as_company_id(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "卓驭", "--minutes", "15"])

    def test_monitor_entry_has_no_company_keyword_option(self):
        with self.assertRaises(SystemExit):
            run.parse_args(["--company", "卓驭", "--minutes", "15"])

    def test_hours_option_is_removed(self):
        # --hours 已废弃：传入应报错
        with self.assertRaises(SystemExit):
            run.parse_args(["--company-id", "1001", "--hours", "120"])

    def test_notify_no_event_defaults_off(self):
        args = run.parse_args(["--company-id", "1001", "--minutes", "10"])
        self.assertFalse(args.notify_no_event)

    def test_notify_no_event_flag_enables(self):
        args = run.parse_args([
            "--company-id", "1001", "--minutes", "10", "--notify-no-event",
        ])
        self.assertTrue(args.notify_no_event)

    def test_millisecond_timestamps_accepted(self):
        args = run.parse_args([
            "--company-id", "1001",
            "--start", "1757000000000", "--end", "1757001000000",
        ])
        self.assertEqual(args.mode, "range")


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

    def test_event_query_sends_confirmed_numeric_ids_and_three_statuses(self):
        class Response:
            @staticmethod
            def json():
                return {"code": 0, "data": {"list": []}}

        with patch.object(run.shared, "http_json", return_value=Response()) as request:
            run.fetch_event_table("cookie", 1, 2, company_ids=["20003309"])
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["company_id"], ["20003309"])
        self.assertEqual(payload["event_status"], ["inited", "disposal", "suspend"])
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

    def _base_row(self, **overrides):
        row = {
            "company": "客户A", "event_name": "事件A", "event_id": "evt-1",
            "checkout_time": "2026-09-06 15:20:11",
            "host_ip": "10.0.0.1", "hostname": "host-a", "asset_name": "核心服务器",
            "asset_group": "生产组", "business_name": "核心业务",
            "business_level": "核心",
            "asset_type": "服务器", "dev_name": "NGES-1", "is_nges_src": True,
            "device_type": 69, "nges_installed": True,
            "classification": "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）",
            "is_gpt": True,
            "event_status": "disposal",
            "ioc_value": None, "ioc_grouped": None,
            "pass_titles": ["检测通过", "终端GPT研判通过"], "all_titles": [],
        }
        row.update(overrides)
        return row

    def test_report_uses_fixed_dense_field_order(self):
        row = self._base_row()
        report = run.format_report(WIN, {"客户A": "1001"}, [row], [])
        self.assertTrue(report.startswith(
            f"MSSP 事件监控结果（{WIN} · 1 个客户）\n"
            + "=" * 56
        ))
        self.assertIn("监控客户    : 1个（客户A）", report)
        self.assertNotIn("1个（1001）", report)
        self.assertIn(f"监控窗口    : {WIN}", report)
        self.assertNotIn("｜", report)
        self.assertNotIn("|", report)
        self.assertNotIn("已按事件ID去重", report)
        self.assertIsNone(EMOJI_PATTERN.search(report))
        self.assertNotIn("查询失败客户", report)
        self.assertNotIn("场景统计", report)
        self.assertIn("事件1：「事件A」\n客户        : 客户A", report)
        self.assertIn("组件检出时间 : 2026-09-06 15:20:11", report)
        self.assertIn("主机名称    : host-a", report)
        self.assertIn("资产组      : 生产组", report)
        self.assertIn("业务名称    : 核心业务", report)
        self.assertIn(
            "业务名称    : 核心业务\n业务等级    : 核心\n关联告警",
            report,
        )
        # 处置状态翻译为中文
        self.assertIn("处置状态    : 处置中", report)
        self.assertNotIn("disposal", report)
        # IOC 为空则不展示 IOC 字段
        self.assertNotIn("IOC", report)
        self.assertIn("关联告警    :", report)
        self.assertIn("- 检测通过", report)
        self.assertIn("共2条关联告警", report)
        self.assertNotIn("数据源                  :", report)
        self.assertNotIn("NGES 安装               :", report)
        self.assertNotIn("终端 GPT                :", report)
        self.assertNotIn("场景1", report)
        self.assertNotIn("场景                    :", report)
        self.assertIn(
            "共2条关联告警\n事件分类    : "
            "终端GPT检测生成了对应事件，具有终端GPT对整个事件的研判分析（重点价值推送）",
            report,
        )

    def test_report_maps_all_three_disposal_statuses_to_chinese(self):
        cases = {
            "inited": "未处置",
            "disposal": "处置中",
            "suspend": "定期跟进",
        }
        for raw, cn in cases.items():
            row = self._base_row(event_status=raw, pass_titles=[], all_titles=[])
            report = run.format_report(WIN, {"客户A": "1001"}, [row], [])
            self.assertIn(f"处置状态    : {cn}", report)
            self.assertNotIn(raw, report)
        # 未知返回空 -> 显示 -
        row = self._base_row(event_status="zzz", pass_titles=[], all_titles=[])
        report = run.format_report(WIN, {"客户A": "1001"}, [row], [])
        self.assertIn("处置状态    : -", report)

    def test_report_omits_ioc_field_even_when_present(self):
        # IOC 字段已按需求移除：即使 ioc_grouped 有内容也不展示
        row = self._base_row(
            pass_titles=[], all_titles=[],
            ioc_grouped={
                "url": [],
                "ip": [{"ip": "81.227.43.128"}],
                "domain": [],
                "md5": [{
                    "md5": "ba22e98227337623a5928c9ebdeb1870",
                    "virus_name": "Worm.Win32.Agent.V4nh",
                }],
            },
        )
        report = run.format_report(WIN, {"客户A": "1001"}, [row], [])
        self.assertNotIn("IOC", report)
        self.assertNotIn("ba22e98227337623a5928c9ebdeb1870", report)
        self.assertNotIn("81.227.43.128", report)

    def test_report_omits_ioc_fallback_value_too(self):
        row = self._base_row(
            pass_titles=[], all_titles=[],
            ioc_grouped=None,
            ioc_value=["ba22e98227337623a5928c9ebdeb1870"],
        )
        report = run.format_report(WIN, {"客户A": "1001"}, [row], [])
        self.assertNotIn("ba22e98227337623a5928c9ebdeb1870", report)
        self.assertNotIn("IOC", report)

    def test_report_omits_related_alarm_field_when_no_alarm_exists(self):
        row = self._base_row(
            classification="杀毒引擎上报事件",
            all_titles=[], pass_titles=[], event_status=None,
        )
        report = run.format_report(WIN, {"绝味食品股份有限公司": "1001"}, [row], [])
        self.assertNotIn("关联告警", report)
        self.assertIn("事件分类    : 杀毒引擎上报事件", report)

    def test_report_separates_multiple_events_only_between_events(self):
        row = self._base_row(classification="杀毒引擎上报事件")
        report = run.format_report(WIN, {"客户A": "1001"}, [row, row], [])
        separator = "-" * 56
        # 汇总区与明细区各有一条 ==== 分隔线（共 2 条），事件之间用 ---- 分隔
        self.assertEqual(report.count("=" * 56), 2)
        self.assertEqual(report.count(separator), 1)
        self.assertIn(f"事件1：「事件A」\n客户", report)
        self.assertIn(f"{separator}\n事件2：「事件A」\n客户", report)

    def test_report_only_shows_failed_customers_when_present(self):
        report = run.format_report(WIN, {"客户A": "1001"}, [], ["客户A"])
        self.assertIn("查询失败客户 : 客户A", report)
        self.assertIsNone(EMOJI_PATTERN.search(report))

    def test_report_omits_failed_customer_line_when_all_queries_succeed(self):
        report = run.format_report(WIN, {"客户A": "1001"}, [], [])
        self.assertNotIn("查询失败客户", report)
        self.assertIn("当前无事件。", report)

    def test_chat_output_is_wrapped_in_one_code_block(self):
        output = run.format_chat_output("监控结果")
        self.assertEqual(output, "```\n监控结果\n```")
        self.assertEqual(output.count("```"), 2)

    def test_no_event_output_is_suppressed_by_default(self):
        # 默认：无事件时不输出任何内容（stdout 为空，退出码 0）
        import io
        from contextlib import redirect_stdout
        args = run.parse_args(["--company-id", "1001", "--minutes", "10"])
        with patch.object(run, "parse_args", return_value=args), \
                patch.object(run.shared, "get_cookie", return_value="cookie"), \
                patch.object(run, "resolve_confirmed_company_ids",
                             return_value={"客户A": "1001"}), \
                patch.object(run, "fetch_event_table", return_value=[]):
            buf = io.StringIO()
            with redirect_stdout(buf):
                run.main()
        self.assertEqual(buf.getvalue(), "")

    def test_no_event_output_is_emitted_when_notify_flag_on(self):
        # --notify-no-event：无事件时输出「当前无事件」
        import io
        from contextlib import redirect_stdout
        args = run.parse_args([
            "--company-id", "1001", "--minutes", "10", "--notify-no-event",
        ])
        with patch.object(run, "parse_args", return_value=args), \
                patch.object(run.shared, "get_cookie", return_value="cookie"), \
                patch.object(run, "resolve_confirmed_company_ids",
                             return_value={"客户A": "1001"}), \
                patch.object(run, "fetch_event_table", return_value=[]):
            buf = io.StringIO()
            with redirect_stdout(buf):
                run.main()
        out = buf.getvalue()
        self.assertIn("当前无事件", out)
        self.assertIn("0个（状态：未处置/处置中/定期跟进）", out)

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
