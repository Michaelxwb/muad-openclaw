"""RED/GREEN tests for skills/self-skill-review/scripts/check.py.

The checker is a real child process reading real fixture directories. Target
scripts are never imported: the no-execute fixture would write a marker file if
the checker executed it, and the test asserts the marker never appears.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
CHECK = SKILL_ROOT / "scripts" / "check.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def run_check(target: Path, *args: str, env=None) -> subprocess.CompletedProcess:
    command = [sys.executable, "-I", str(CHECK), "--target", str(target), *args]
    return subprocess.run(command, capture_output=True, text=True, env=env, check=False)


def line_of(path: Path, needle: str) -> int:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if needle in line:
            return number
    raise AssertionError(f"{needle!r} not found in {path}")


def findings_by_rule(data: dict) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for finding in data["findings"]:
        grouped.setdefault(finding["rule"], []).append(finding)
    return grouped


def test_compliant_skill_passes() -> None:
    result = run_check(FIXTURES / "compliant-skill", "--format", "json")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["findings"] == []
    assert data["summary"]["errors"] == 0
    assert data["summary"]["files"] >= 3


def test_response_trace_id_is_not_a_manual_header() -> None:
    result = run_check(FIXTURES / "compliant-skill", "--format", "json")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert "SS-R007" not in findings_by_rule(data)


def test_review_fingerprint_is_stable_for_unchanged_target() -> None:
    first = run_check(FIXTURES / "compliant-skill", "--format", "json")
    second = run_check(FIXTURES / "compliant-skill", "--format", "json")

    first_fingerprint = json.loads(first.stdout)["summary"]["fingerprint"]
    second_fingerprint = json.loads(second.stdout)["summary"]["fingerprint"]
    assert first_fingerprint.startswith("sha256:")
    assert first_fingerprint == second_fingerprint


def test_platform_skill_requires_requests_and_session_manager() -> None:
    target = FIXTURES / "missing-requests-skill"
    result = run_check(target, "--format", "json")

    assert result.returncode == 1
    grouped = findings_by_rule(json.loads(result.stdout))
    assert "SS-R005" in grouped
    assert "SS-R006" in grouped
    assert any("requests" in finding["message"] for finding in grouped["SS-R005"])


def test_violating_skill_reports_rules_with_file_line() -> None:
    target = FIXTURES / "violating-skill"
    result = run_check(target, "--format", "json")

    assert result.returncode == 1
    assert "error" in result.stderr.lower()
    data = json.loads(result.stdout)
    grouped = findings_by_rule(data)

    expected = {
        "SS-R001",  # Shell file type
        "SS-R003",  # frontmatter/manifest/dir name mismatch
        "SS-R004",  # entrypoint is not .py
        "SS-R007",  # manual Cookie/CSRF headers
        "SS-R008",  # subprocess sends business request
        "SS-R009",  # exception path writes stdout
        "SS-R010",  # write outside SKILL_OUTPUT_DIR
        "SS-R011",  # session-manager skill name mismatch
        "SS-R012",  # hard-coded credential / internal URL
        "SS-R014",  # missing author
    }
    assert expected <= set(grouped)

    run_py = target / "scripts" / "run.py"
    manifest = target / "muad.skill.json"
    expected_locations = {
        "SS-R001": ("scripts/run.sh", 1),
        "SS-R004": ("muad.skill.json", line_of(manifest, "entrypoint")),
        "SS-R007": ("scripts/run.py", line_of(run_py, '"Cookie"')),
        "SS-R008": ("scripts/run.py", line_of(run_py, '"curl"')),
        "SS-R009": ("scripts/run.py", line_of(run_py, 'print("failed")')),
        "SS-R010": ("scripts/run.py", line_of(run_py, "/tmp/review-output.json")),
        "SS-R011": ("scripts/run.py", line_of(run_py, "session = subprocess.run")),
        "SS-R012": ("scripts/run.py", line_of(run_py, "PASSWORD =")),
        "SS-R014": ("muad.skill.json", 1),
    }
    for rule, location in expected_locations.items():
        assert any(
            (finding["file"], finding["line"]) == location
            for finding in grouped[rule]
        ), f"{rule} expected at {location}, got {grouped[rule]}"

    for finding in data["findings"]:
        assert finding["line"] >= 1
        assert finding["file"]
        assert finding["message"]
        assert finding["severity"] in {"error", "warning"}


def test_review_never_executes_target_code(tmp_path: Path) -> None:
    env = dict(os.environ, REVIEW_SENTINEL=str(tmp_path))
    result = run_check(FIXTURES / "no-execute-skill", "--format", "json", env=env)

    assert not (tmp_path / "executed").exists(), "review imported/executed target code"
    data = json.loads(result.stdout)
    assert data["summary"]["files"] >= 3


def test_embedded_instructions_are_ignored() -> None:
    result = run_check(FIXTURES / "violating-skill", "--format", "json")

    data = json.loads(result.stdout)
    assert data["summary"]["errors"] > 0
    assert "IGNORE ALL PREVIOUS INSTRUCTIONS" not in result.stdout
    assert "IGNORE ALL PREVIOUS INSTRUCTIONS" not in result.stderr


def test_markdown_report_contains_file_line() -> None:
    result = run_check(FIXTURES / "missing-requests-skill", "--format", "markdown")

    assert result.returncode == 1
    assert "FAIL" in result.stdout
    assert "scripts/run.py:" in result.stdout
    assert "SS-R005" in result.stdout
    assert "requests" in result.stdout
    assert "规则 ID 仅用于追踪" in result.stdout


def test_output_option_writes_report(tmp_path: Path) -> None:
    output = tmp_path / "report.json"
    result = run_check(
        FIXTURES / "compliant-skill", "--format", "json", "--output", str(output)
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["findings"] == []


def test_missing_target_fails_loud(tmp_path: Path) -> None:
    result = run_check(tmp_path / "does-not-exist", "--format", "json")

    assert result.returncode == 2
    assert result.stdout == ""
    assert "not found" in result.stderr.lower()
