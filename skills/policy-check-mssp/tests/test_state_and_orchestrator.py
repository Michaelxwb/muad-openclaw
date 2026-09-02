import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase1 import phase1_trigger
from phase1.phase1_company import MultipleCandidatesError
from shared.state import (
    ActiveRunError, RunLock, latest_status, new_run, read_state, state_path, write_state,
)


class StateAndOrchestratorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_patch = patch.dict(os.environ, {"POLICY_CHECK_MSSP_OUTPUT_DIR": self.temp.name})
        self.output_patch.start()

    def tearDown(self):
        self.output_patch.stop()
        self.temp.cleanup()

    def test_active_step_lock_blocks_duplicate_and_release_allows_retry(self):
        with RunLock():
            new_run("company")
            with self.assertRaises(ActiveRunError):
                with RunLock():
                    pass
            state = latest_status()
            self.assertEqual(state["status"], "preparing")
            self.assertEqual(state["execution"]["status"], "running")
        with RunLock():
            pass

    def test_different_company_locks_can_run_together(self):
        with RunLock("100"):
            with RunLock("200"):
                self.assertTrue(True)
            with self.assertRaises(ActiveRunError):
                with RunLock("100"):
                    pass

    def test_company_states_do_not_overwrite_each_other(self):
        write_state({"company_id": "100", "status": "submitted", "task_id": "task-a"})
        write_state({"company_id": "200", "status": "running", "task_id": "task-b"})
        self.assertEqual(read_state("100")["task_id"], "task-a")
        self.assertEqual(read_state("200")["task_id"], "task-b")
        self.assertEqual(read_state()["company_id"], "200")

    def test_legacy_last_session_is_available_until_company_state_is_written(self):
        with open(state_path(), "w", encoding="utf-8") as handle:
            json.dump({"company_id": "100", "task_id": "legacy-task"}, handle)
        self.assertEqual(read_state("100")["task_id"], "legacy-task")
        self.assertIsNone(read_state("200"))

    @patch("phase1.phase1_trigger.execute")
    def test_batch_submission_runs_customers_concurrently(self, execute):
        barrier = threading.Barrier(2)

        def run_one(company=None, company_id=None, selection=None, session=None):
            barrier.wait(timeout=2)
            value = company or company_id
            return {"ok": True, "status": "submitted", "company_id": value}

        execute.side_effect = run_one
        result = phase1_trigger.execute_batch(["客户A", "客户B"], [], max_workers=2)
        self.assertEqual(result["submitted"], 2)
        self.assertEqual(result["failed"], 0)

    @patch("phase1.phase1_trigger.execute")
    def test_batch_partial_failure_keeps_success_and_candidates(self, execute):
        def run_one(company=None, company_id=None, selection=None, session=None):
            if company == "模糊客户":
                raise MultipleCandidatesError([{"name": "客户A", "id": "100"}])
            return {"ok": True, "status": "submitted", "company_id": "200"}

        execute.side_effect = run_one
        result = phase1_trigger.execute_batch(["模糊客户", "明确客户"], [], max_workers=2)
        self.assertEqual((result["submitted"], result["failed"]), (1, 1))
        self.assertEqual(result["results"][0]["candidates"][0]["id"], "100")
        self.assertTrue(result["results"][1]["ok"])

    def test_stale_local_execution_does_not_change_remote_running_status(self):
        write_state({
            "workflow_id": "old", "status": "running", "current_phase": "phase2",
            "execution": {"run_id": "step", "step": "phase2", "status": "running"},
        })
        state = latest_status()
        self.assertEqual(state["status"], "running")
        self.assertEqual(state["execution"]["status"], "interrupted")
        self.assertIn("可重新执行", state["execution"]["error"])
        path = os.path.join(self.temp.name, "cache", "last_session.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    @patch("phase2.phase2_wait_check.snapshot_task_ids", return_value=set())
    @patch("phase2.phase2_wait_check.query_once", return_value={
        "status": "not_found", "task_id": "", "task_name": "",
    })
    @patch("phase1.phase1_trigger.get_dev_id_list")
    @patch("phase1.phase1_trigger._resolve_input", return_value=("客户", "100"))
    @patch("phase1.phase1_trigger.get_session", return_value="cookie")
    @patch("phase1.phase1_trigger.distribute_policy_check_task")
    def test_failed_phase1_does_not_block_next_submission(self, distribute, _cookie,
                                                          _resolve, devices, _query,
                                                          _snapshot):
        devices.return_value = ([1], [{"dev_id": 1, "dev_type": "AF"}])
        distribute.side_effect = [
            RuntimeError("first failure"),
            {"code": 0, "data": {"_id": "task-2", "task_name": "策略检查-2"}},
        ]
        with self.assertRaisesRegex(RuntimeError, "first failure"):
            phase1_trigger.execute(company="客户")
        self.assertEqual(read_state()["status"], "failed")
        result = phase1_trigger.execute(company="客户")
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(result["task_id"], "task-2")
        self.assertEqual(read_state()["execution"]["status"], "succeeded")
        self.assertEqual(distribute.call_count, 2)

    @patch("phase1.phase1_trigger.get_session", return_value="cookie")
    @patch("phase1.phase1_trigger.distribute_policy_check_task")
    @patch("phase2.phase2_wait_check.query_once")
    @patch("phase1.phase1_trigger._resolve_input", return_value=("客户", "100"))
    def test_confirmed_remote_running_task_blocks_duplicate_submission(self, _resolve, query,
                                                                       distribute, _cookie):
        write_state({
            "status": "submitted", "company_id": "100", "task_id": "task-1",
            "baseline_task_ids": [],
        })
        query.return_value = {"status": "running", "task_id": "task-1", "task_name": "task"}
        with self.assertRaisesRegex(RuntimeError, "仍在运行"):
            phase1_trigger.execute(company="客户")
        distribute.assert_not_called()
        self.assertEqual(read_state()["status"], "running")
        self.assertEqual(read_state()["execution"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
