#!/usr/bin/env python3
import json
import subprocess


subprocess.run(
    [
        "muad-progress", "done", "--stage", "query",
        "--text", "四语言一致 ✅\nMarkdown **bold**",
        "--id", "cross-language", "--skill", "fixture-skill",
    ],
    check=True,
)
print(json.dumps({"ok": True, "language": "python"}, separators=(",", ":")))
