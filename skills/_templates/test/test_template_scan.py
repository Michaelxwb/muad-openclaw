"""S-08 integration scan: templates and creator converge on Python only."""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TEMPLATES = REPO_ROOT / "skills" / "_templates"
CREATOR = REPO_ROOT / "skills" / "self-skill-creator"
RETIRED_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".bash"}


def test_no_retired_ts_or_shell_files() -> None:
    offenders = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in TEMPLATES.rglob("*")
        if path.is_file() and path.suffix.lower() in RETIRED_SUFFIXES
    ]

    assert offenders == []


def test_only_python_business_template_remains() -> None:
    business_templates = sorted(
        path.name
        for path in TEMPLATES.iterdir()
        if path.is_dir() and path.name.startswith("business-skill-")
    )

    assert business_templates == ["business-skill-python"]


def test_python_template_uses_requests() -> None:
    script = (TEMPLATES / "business-skill-python" / "scripts" / "run.py").read_text(
        encoding="utf-8"
    )
    readme = (TEMPLATES / "business-skill-python" / "README.md").read_text(
        encoding="utf-8"
    )

    assert "import requests" in script
    assert "requests.get" in script
    assert "session-manager" in script
    assert "session-state.json" in script
    assert "platform_request" not in script
    assert "platform_request" not in readme
    assert "requests" in readme


def test_template_manifest_matches_skill_frontmatter() -> None:
    manifest = json.loads(
        (TEMPLATES / "business-skill-python" / "muad.skill.json").read_text(
            encoding="utf-8"
        )
    )
    skill_md = (TEMPLATES / "business-skill-python" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    match = re.search(r"(?m)^name:\s*(\S+)\s*$", skill_md)

    assert match is not None
    assert manifest["name"] == match.group(1)
    assert manifest.get("entrypoint") == "scripts/run.py"


def test_creator_guides_python_only() -> None:
    text = (CREATOR / "SKILL.md").read_text(encoding="utf-8")

    assert "Python" in text
    assert "session-manager get-state" in text
    assert "requests" in text
    assert "platform_request" not in text
    assert "TypeScript" not in text
    assert "三选一" not in text
    assert "run.mjs" not in text
    assert "business-skill-ts" not in text
    assert "business-skill-shell" not in text


def test_http_headers_reference_is_sdk_constraint() -> None:
    text = (CREATOR / "references" / "http-headers.md").read_text(encoding="utf-8")

    assert "session-manager get-state" in text
    assert "requests" in text
    assert "platform_request" not in text
    assert "extract_cookie_value" not in text
    assert 'headers["Cookie"]' not in text


def test_creator_references_have_no_retired_language_samples() -> None:
    for path in sorted((CREATOR / "references").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        assert "TypeScript" not in text, path
        assert "### Shell" not in text, path
        assert re.search(r"```js\b", text) is None, path
        assert "run.mjs" not in text, path
        assert "三种语言" not in text, path
