import json
import os
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase1.get_dev_id import get_dev_id_list
from phase1.phase1_company import (
    MultipleCandidatesError,
    query_companies,
    resolve_by_selection,
    resolve_company,
)
from shared.http import build_headers, endpoint, endpoint_headers, origin
from shared.session import get_cookie


class SessionAndPhase1Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_patch = patch.dict(os.environ, {"POLICY_CHECK_MSSP_OUTPUT_DIR": self.temp.name})
        self.output_patch.start()

    def tearDown(self):
        self.output_patch.stop()
        self.temp.cleanup()

    def test_session_manager_cookie_is_read_from_mssp_only(self):
        session_path = os.path.join(self.temp.name, "session.json")
        with open(session_path, "w", encoding="utf-8") as handle:
            json.dump({"platforms": {
                "mssp": {"cookies": [{"name": "sid", "value": "secret"}]},
                "mssw": {"cookies": [{"name": "wrong", "value": "value"}]},
            }}, handle)
        runner = lambda *args, **kwargs: SimpleNamespace(
            returncode=0, stdout=json.dumps({"sessionStateFile": session_path}), stderr="",
        )
        self.assertEqual(get_cookie(runner), "sid=secret")

    @patch("phase1.phase1_company.query_companies")
    def test_company_exact_fuzzy_and_candidates(self, query):
        query.return_value = [
            {"company_name": "深信服科技", "company_id": 1},
            {"company_name": "深信服测试", "company_id": 2},
            {"company_name": "其他公司", "company_id": 3},
        ]
        self.assertEqual(resolve_company("1", "cookie"), ("深信服科技", "1"))
        self.assertEqual(resolve_company("其他", "cookie"), ("其他公司", "3"))
        with self.assertRaises(MultipleCandidatesError) as raised:
            resolve_company("深信服", "cookie")
        self.assertEqual(len(raised.exception.candidates), 2)
        self.assertEqual(resolve_by_selection("2"), ("深信服测试", "2"))

    @patch("phase1.phase1_company.request_json")
    def test_customer_search_uses_working_mssp_contract(self, request_json):
        request_json.return_value = {"code": 0, "data": {"list": [
            {"company_name": "卓驭科技股份有限公司", "company_id": "20003309"},
        ]}}

        result = query_companies("cookie", "卓驭")

        self.assertEqual(result[0]["company_id"], "20003309")
        request_json.assert_called_once()
        _, method, endpoint_name, payload = request_json.call_args.args
        self.assertEqual((method, endpoint_name), ("POST", "customer_search"))
        self.assertEqual(payload["keyword"], "卓驭")
        self.assertEqual(payload["limit"], 20)
        self.assertEqual(payload["service_status"], 0)

    def test_required_mssp_headers_apply_to_every_endpoint(self):
        for endpoint_name in (
            "customer_search", "device_info", "distribute_task",
            "task_list", "report", "policy_list",
        ):
            headers = build_headers(
                "sid=value", extra_headers=endpoint_headers(endpoint_name),
            )
            self.assertEqual(
                headers["X-CSRFToken"], "[REDACTED_SECRET]",
            )
            self.assertEqual(headers["Timezone"], "+08:00")

    def test_customer_search_header_profile_matches_monitor_transport(self):
        headers = build_headers(
            "csrf_token=dynamic",
            extra_headers=endpoint_headers("customer_search"),
            profile="monitor_mssp",
        )
        self.assertNotIn("Origin", headers)
        self.assertEqual(headers["Accept-Language"], "zh-CN,zh;q=0.9")
        self.assertIn("Windows NT 10.0", headers["User-Agent"])

    def test_required_headers_cannot_be_overridden_by_endpoint_headers(self):
        headers = build_headers(
            "csrf_token=dynamic",
            extra_headers={"X-CSRFToken": "wrong", "Timezone": "wrong"},
        )
        self.assertEqual(
            headers["X-CSRFToken"], "[REDACTED_SECRET]",
        )
        self.assertEqual(headers["Timezone"], "+08:00")

    def test_all_mssp_requests_omit_origin_header(self):
        self.assertNotIn("Origin", build_headers("sid=value"))

    def test_distribute_task_is_locked_to_mssp_internal_endpoint(self):
        with patch.dict(os.environ, {
            "POLICY_CHECK_MSSP_BASE_URL": "https://soar.sangfor.com.cn",
        }):
            self.assertEqual(origin(), "http://soar-inner.sangfor.com.cn:30001")
            self.assertEqual(
                endpoint("distribute_task"),
                "http://soar-inner.sangfor.com.cn:30001/order/v1/policy_check/distribute_task",
            )

    @patch("phase1.get_dev_id.request_json")
    def test_device_list_rejects_incomplete_response(self, request_json):
        request_json.return_value = {"code": 0, "data": {
            "total": 2, "list": [{"dev_id": 10, "dev_type": "AF"}],
        }}
        with self.assertRaisesRegex(RuntimeError, "不完整"):
            get_dev_id_list("cookie", "company")

    @patch("phase1.get_dev_id.request_json")
    def test_device_ids_preserve_legacy_scope(self, request_json):
        devices = [
            {"dev_id": 1, "dev_type": "AF"}, {"dev_id": 2, "dev_type": "SIP"},
            {"dev_id": 3, "dev_type": "EDR"}, {"dev_id": 4, "dev_type": "STA"},
        ]
        request_json.return_value = {"code": 0, "data": {"total": 4, "list": devices}}
        self.assertEqual(get_dev_id_list("cookie", "company"), ([1, 2, 3, 4], devices))

    def test_candidate_file_is_private(self):
        with patch("phase1.phase1_company.query_companies", return_value=[
            {"company_name": "测试一", "company_id": 1},
            {"company_name": "测试二", "company_id": 2},
        ]):
            with self.assertRaises(MultipleCandidatesError):
                resolve_company("测试", "cookie")
        path = os.path.join(self.temp.name, "cache", "phase1_candidates.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
