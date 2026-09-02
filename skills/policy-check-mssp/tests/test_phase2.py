import os
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase2.phase2_wait_check import (
    classify_task,
    find_new_task,
    query_once,
    run_phase2,
    snapshot_task_ids,
)
from shared.state import read_state, write_state


class Phase2Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_patch = patch.dict(os.environ, {"POLICY_CHECK_MSSP_OUTPUT_DIR": self.temp.name})
        self.output_patch.start()

    def tearDown(self):
        self.output_patch.stop()
        self.temp.cleanup()

    def test_baseline_prevents_matching_an_old_task(self):
        tasks = [
            {"_id": "old", "company_id": 1},
            {"_id": "new", "company_id": "1"},
            {"_id": "other", "company_id": "2"},
        ]
        self.assertEqual(find_new_task(tasks, "1", {"old"})["_id"], "new")

    @patch("phase2.phase2_wait_check.query_task_list")
    def test_snapshot_includes_only_company_tasks(self, query):
        query.return_value = {"data": {"list": [
            {"_id": "a", "company_id": "1"}, {"_id": "b", "company_id": "2"},
        ]}}
        self.assertEqual(snapshot_task_ids("cookie", "1"), {"a"})

    @patch("phase2.phase2_wait_check.query_task_list")
    def test_query_once_does_not_poll(self, query):
        query.return_value = {"data": {"list": [
            {"_id": "old", "company_id": "1"},
            {"_id": "new", "task_name": "task", "company_id": "1",
             "assess_status": 20, "report_status": "running"},
        ]}}
        result = query_once("cookie", "1", {"old"})
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["task_id"], "new")
        self.assertEqual(query.call_count, 1)

    @patch("phase2.phase2_wait_check.query_task_list", return_value={"data": {"list": []}})
    def test_not_found_returns_immediately(self, query):
        result = query_once("cookie", "1", set())
        self.assertEqual(result["status"], "not_found")
        self.assertEqual(query.call_count, 1)

    def test_remote_status_classification(self):
        self.assertEqual(classify_task({"assess_status": 20}), "running")
        self.assertEqual(classify_task({"assess_status": 30}), "failed")
        self.assertEqual(classify_task({"assess_status": 40, "report_status": "finish"}), "completed")

    @patch("phase2.phase2_wait_check.get_session", return_value="cookie")
    @patch("phase2.phase2_wait_check.query_once")
    def test_phase2_uses_saved_context_and_updates_business_status(self, query, _cookie):
        write_state({
            "status": "submitted", "company_id": "1", "task_id": "",
            "baseline_task_ids": ["old"],
        })
        query.return_value = {
            "status": "completed", "task_id": "new", "task_name": "task",
            "assess_status": 40, "report_status": "finish", "assess_fraction": "1/1",
        }
        result = run_phase2()
        self.assertEqual(result["status"], "completed")
        state = read_state()
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["execution"]["status"], "succeeded")
        query.assert_called_once_with("cookie", "1", ["old"], "")

    @patch("phase2.phase2_wait_check.get_session", return_value="cookie")
    @patch("phase2.phase2_wait_check.query_once")
    def test_explicit_company_reads_only_its_saved_context(self, query, _cookie):
        write_state({
            "status": "submitted", "company_id": "1", "task_id": "task-1",
            "baseline_task_ids": ["old-1"],
        })
        write_state({
            "status": "submitted", "company_id": "2", "task_id": "task-2",
            "baseline_task_ids": ["old-2"],
        })
        query.return_value = {
            "status": "running", "task_id": "task-1", "task_name": "task-1",
        }
        run_phase2("1")
        query.assert_called_once_with("cookie", "1", ["old-1"], "task-1")
        self.assertEqual(read_state("2")["task_id"], "task-2")


if __name__ == "__main__":
    unittest.main()
