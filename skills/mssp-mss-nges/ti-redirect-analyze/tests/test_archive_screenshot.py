import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "archive_screenshot.py"
SPEC = importlib.util.spec_from_file_location("archive_screenshot", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ArchiveScreenshotTests(unittest.TestCase):
    def test_archives_original_crop_and_evidence_under_skill_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "skill-output"
            event_dir = output / "事件归档" / "event-1"
            event_dir.mkdir(parents=True)
            source = Path(temp_dir) / "browser.png"
            Image.new("RGB", (1000, 500), "white").save(source)
            with mock.patch.dict(os.environ, {"SKILL_OUTPUT_DIR": str(output)}):
                code = MODULE.main([
                    "--source", str(source), "--event-dir", str(event_dir),
                    "--type", "domain", "--ioc", "example.com",
                ])
            self.assertEqual(code, 0)
            self.assertTrue(next(event_dir.glob("*_原始截图.png")).is_file())
            summary = next(event_dir.glob("*_摘要.png"))
            with Image.open(summary) as image:
                self.assertEqual(image.size, (850, 178))
            self.assertIn("example.com", (event_dir / "TI_情报截图证据.md").read_text(encoding="utf-8"))

    def test_rejects_event_directory_outside_skill_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "skill-output"
            outside = Path(temp_dir) / "outside"
            outside.mkdir()
            with mock.patch.dict(os.environ, {"SKILL_OUTPUT_DIR": str(output)}):
                with self.assertRaisesRegex(ValueError, "必须位于"):
                    MODULE.resolve_event_dir(str(outside))


if __name__ == "__main__":
    unittest.main()
