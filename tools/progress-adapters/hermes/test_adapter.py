import unittest

from adapter import deliver_progress_event


class HermesProgressAdapterTest(unittest.TestCase):
    def test_forwards_public_channel_progress(self) -> None:
        sent = []

        result = deliver_progress_event(
            {
                "type": "progress",
                "skill": "xdr-alert",
                "stage": "query",
                "text": "正在查询 XDR 告警数据",
            },
            sent.append,
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.delivery, "sent")
        self.assertEqual(
            sent[0],
            {
                "text": "正在查询 XDR 告警数据",
                "id": "query",
                "name": "xdr-alert",
                "phase": "query",
                "status": "running",
            },
        )

    def test_drops_non_channel_progress(self) -> None:
        sent = []

        result = deliver_progress_event(
            {"type": "progress", "text": "internal", "visibility": "internal"},
            sent.append,
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.delivery, "dropped")
        self.assertEqual(result.reason, "non_channel")
        self.assertEqual(sent, [])

    def test_maps_done_and_error_statuses(self) -> None:
        sent = []
        deliver_progress_event({"type": "done", "text": "处理完成"}, sent.append)
        deliver_progress_event({"type": "error", "text": "处理失败"}, sent.append)

        self.assertEqual(sent[0]["status"], "done")
        self.assertEqual(sent[1]["status"], "error")


if __name__ == "__main__":
    unittest.main()
