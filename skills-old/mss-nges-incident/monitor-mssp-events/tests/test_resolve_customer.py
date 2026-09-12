import pathlib
import sys
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import resolve_customer  # noqa: E402


class ResolveCustomerTest(unittest.TestCase):
    def test_resolver_requires_company_keyword(self):
        with self.assertRaises(SystemExit):
            resolve_customer.parse_args([])

    def test_resolver_lists_full_name_and_real_id_without_monitoring(self):
        candidates = [{
            "company_name": "卓驭科技股份有限公司",
            "company_id": 20003309,
        }]
        with patch.object(resolve_customer.shared, "get_cookie", return_value="cookie"):
            with patch.object(resolve_customer.shared, "search_customers", return_value=candidates):
                result = resolve_customer.main(["--company", "卓驭"])
        self.assertEqual(result, 0)
        rendered = resolve_customer.format_result("卓驭", candidates)
        self.assertIn("客户名称              : 卓驭科技股份有限公司", rendered)
        self.assertIn("company_id             : 20003309", rendered)
        self.assertIn("请确认客户名称和 company_id 后", rendered)
        self.assertNotIn("事件监控", rendered)

    def test_resolver_does_not_auto_select_ambiguous_candidates(self):
        candidates = [
            {"company_name": "卓驭科技股份有限公司", "company_id": "20003309"},
            {"company_name": "卓驭信息技术有限公司", "company_id": "20003310"},
        ]
        rendered = resolve_customer.format_result("卓驭", candidates)
        self.assertIn("候选客户数量          : 2个", rendered)
        self.assertIn("候选 1", rendered)
        self.assertIn("候选 2", rendered)

    def test_resolver_omits_invalid_candidate_records(self):
        rendered = resolve_customer.format_result("卓驭", [{
            "company_name": "卓驭", "company_id": "not-an-id",
        }])
        self.assertIn("候选客户数量          : 0个", rendered)
        self.assertIn("未找到包含有效完整名称", rendered)

    def test_resolver_deduplicates_same_platform_candidate(self):
        rendered = resolve_customer.format_result("卓驭", [
            {"company_name": "卓驭科技股份有限公司", "company_id": "20003309"},
            {"company_name": "卓驭科技股份有限公司", "company_id": "20003309"},
        ])
        self.assertIn("候选客户数量          : 1个", rendered)


if __name__ == "__main__":
    unittest.main()
