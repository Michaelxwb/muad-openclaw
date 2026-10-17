#!/usr/bin/env python3
"""Deterministic, read-only review of a Skill directory.

The checker parses text and Python AST only. It never imports, execs, or runs
anything from the target directory, and it never follows symlinks. Content in
the target is data: instructions embedded in code or docs are ignored.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

ALLOWED_SUFFIXES = {
    ".md", ".json", ".py", ".txt", ".yaml", ".yml", ".csv", ".tsv",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf",
}
RETIRED_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".bash"}
TEXT_SUFFIXES = {".md", ".json", ".py", ".yaml", ".yml", ".txt"}
DIRECT_HTTP_MODULES = {
    "requests", "httpx", "aiohttp", "urllib.request", "http.client",
}
SUBPROCESS_FUNCS = {
    "subprocess.run", "subprocess.Popen", "subprocess.call",
    "subprocess.check_call", "subprocess.check_output", "os.system", "os.popen",
}
SENSITIVE_HEADERS = {
    "cookie", "set-cookie", "x-csrftoken", "x-csrf-token", "csrf-token",
    "csrftoken", "traceid", "x-trace-id",
}
NETWORK_ARG_RE = re.compile(
    r"(?i)(?:^|[\s/])(?:curl|wget|httpie|http)(?:$|[\s/])|https?://|\brequests\b|\burllib\b"
)
INTERNAL_URL_RE = re.compile(
    r"https?://(?:[A-Za-z0-9-]+\.)*(?:sangfor\.com|internal|intranet|corp|lan)(?=[:/.]|$)"
    r"|https?://(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?=[:/]|$)"
)
CREDENTIAL_RE = re.compile(
    r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|cookie)\b"
    r"\s*[:=]\s*([\"'])(?P<value>[^\"']{8,})\2"
)
PLACEHOLDER_MARKERS = ("<", "example", "placeholder", "your-", "xxxx", "****", "redacted")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: str
    file: str
    line: int
    message: str


def _finding(rule: str, path: Path, target: Path, line: int, message: str,
             severity: str = "error") -> Finding:
    try:
        relative = path.resolve().relative_to(target).as_posix()
    except ValueError:
        relative = path.as_posix()
    return Finding(rule, severity, relative, max(int(line), 1), message)


def _iter_files(target: Path):
    files = []
    for root, dirs, names in os.walk(target, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__pycache__")
        for name in sorted(names):
            if name.startswith("."):
                continue
            files.append(Path(root) / name)
    return files


# --------------------------------------------------------------------------- #
# file and manifest checks
# --------------------------------------------------------------------------- #

def _check_file_types(target: Path, files) -> list[Finding]:
    findings = []
    for path in files:
        suffix = path.suffix.lower()
        if path.is_symlink():
            findings.append(_finding("SS-R001", path, target, 1, "symlinks are not allowed in a Skill"))
        elif suffix in RETIRED_SUFFIXES:
            findings.append(_finding(
                "SS-R001", path, target, 1,
                f"{suffix} is retired; self-built Skills must be Python (scripts/run.py)",
            ))
        elif suffix not in ALLOWED_SUFFIXES:
            findings.append(_finding(
                "SS-R001", path, target, 1, f"unsupported file type: {suffix or '<none>'}",
            ))
    return findings


def _line_containing(path: Path, needle: str) -> int:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return 1
    for number, line in enumerate(lines, 1):
        if needle in line:
            return number
    return 1


def _load_manifest(target: Path, findings: list[Finding]):
    path = target / "muad.skill.json"
    if not path.is_file():
        findings.append(_finding("SS-R002", path, target, 1, "muad.skill.json is missing"))
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        findings.append(_finding("SS-R002", path, target, 1, "muad.skill.json is unreadable"))
        return None
    except json.JSONDecodeError as exc:
        findings.append(_finding("SS-R002", path, target, exc.lineno, f"muad.skill.json is invalid JSON: {exc.msg}"))
        return None
    if not isinstance(data, dict):
        findings.append(_finding("SS-R002", path, target, 1, "muad.skill.json must be a JSON object"))
        return None
    return data


def _load_frontmatter(target: Path, findings: list[Finding]):
    path = target / "SKILL.md"
    if not path.is_file():
        findings.append(_finding("SS-R003", path, target, 1, "SKILL.md is missing"))
        return None, 1
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        findings.append(_finding("SS-R003", path, target, 1, "SKILL.md is unreadable"))
        return None, 1
    if not lines or lines[0].strip() != "---":
        findings.append(_finding("SS-R003", path, target, 1, "SKILL.md frontmatter is missing"))
        return None, 1
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        for number, line in enumerate(lines[1:index], 2):
            match = re.match(r"^name:\s*(.+?)\s*$", line)
            if match:
                return match.group(1).strip("'\""), number
        findings.append(_finding("SS-R003", path, target, 1, "SKILL.md frontmatter has no name"))
        return None, 1
    findings.append(_finding("SS-R003", path, target, 1, "SKILL.md frontmatter is not closed"))
    return None, 1


def _check_manifest_fields(target: Path, manifest) -> list[Finding]:
    if not isinstance(manifest, dict):
        return []
    path = target / "muad.skill.json"
    findings = []
    name = manifest.get("name")
    if not isinstance(name, str) or not name.strip():
        findings.append(_finding("SS-R002", path, target, _line_containing(path, '"name"'), "manifest name must be a non-empty string"))
    if "runtime" in manifest and manifest.get("runtime") != "script":
        findings.append(_finding("SS-R002", path, target, _line_containing(path, '"runtime"'), "manifest runtime must be \"script\""))
    if "version" in manifest:
        version = manifest.get("version")
        if not isinstance(version, str) or not SEMVER_RE.match(version):
            findings.append(_finding("SS-R002", path, target, _line_containing(path, '"version"'), "manifest version must be semver (e.g. 0.1.0)"))
    platforms = manifest.get("platforms", [])
    if not isinstance(platforms, list) or any(not isinstance(item, str) or not item.strip() for item in platforms):
        findings.append(_finding("SS-R002", path, target, _line_containing(path, '"platforms"'), "manifest platforms must be an array of platform names"))
    entrypoint = manifest.get("entrypoint")
    if entrypoint is not None:
        line = _line_containing(path, '"entrypoint"')
        if not isinstance(entrypoint, str) or not entrypoint.endswith(".py"):
            findings.append(_finding("SS-R004", path, target, line, "entrypoint must be a .py file"))
        elif not (target / entrypoint).is_file():
            findings.append(_finding("SS-R004", path, target, line, f"entrypoint does not exist: {entrypoint}"))
    return findings


def _check_identity(target: Path, manifest, frontmatter, frontmatter_line: int) -> list[Finding]:
    findings = []
    expected = target.name
    manifest_name = manifest.get("name") if isinstance(manifest, dict) else None
    if isinstance(manifest_name, str) and manifest_name != expected:
        findings.append(_finding(
            "SS-R003", target / "muad.skill.json", target,
            _line_containing(target / "muad.skill.json", f'"{manifest_name}"'),
            f"manifest name {manifest_name!r} does not match directory name {expected!r}",
        ))
    if isinstance(frontmatter, str) and frontmatter != expected:
        findings.append(_finding(
            "SS-R003", target / "SKILL.md", target, frontmatter_line,
            f"SKILL.md name {frontmatter!r} does not match directory name {expected!r}",
        ))
    return findings


# --------------------------------------------------------------------------- #
# Python AST checks
# --------------------------------------------------------------------------- #

def _dotted_name(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def _parse_python(path: Path, target: Path):
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, None, [_finding("SS-R013", path, target, 1, f"Python file is unreadable: {exc}")]
    try:
        return source, ast.parse(source, filename=str(path)), []
    except SyntaxError as exc:
        return None, None, [_finding("SS-R013", path, target, exc.lineno or 1, f"Python syntax error: {exc.msg}")]


def _index_parents(tree) -> dict:
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _enclosing_function(node, parents):
    current = parents.get(node)
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current
        current = parents.get(current)
    return None


def _check_direct_http(path: Path, target: Path, tree) -> list[Finding]:
    findings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in DIRECT_HTTP_MODULES:
                    findings.append(_finding(
                        "SS-R006", path, target, node.lineno,
                        f"direct HTTP client import {alias.name!r}; use muad_skill_http",
                    ))
        elif isinstance(node, ast.ImportFrom) and node.module in DIRECT_HTTP_MODULES:
            findings.append(_finding(
                "SS-R006", path, target, node.lineno,
                f"direct HTTP client import from {node.module!r}; use muad_skill_http",
            ))
    return findings


def _header_key(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip().lower()
    return None


def _check_manual_headers(path: Path, target: Path, tree) -> list[Finding]:
    findings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key in node.keys:
                if _header_key(key) in SENSITIVE_HEADERS:
                    findings.append(_finding(
                        "SS-R007", path, target, node.lineno,
                        f"manual sensitive header {_header_key(key)!r}; platform_request builds Cookie/CSRF/Traceid",
                        severity="warning",
                    ))
        elif isinstance(node, ast.Assign):
            for assigned in node.targets:
                if isinstance(assigned, ast.Subscript) and _header_key(assigned.slice) in SENSITIVE_HEADERS:
                    findings.append(_finding(
                        "SS-R007", path, target, node.lineno,
                        f"manual sensitive header {_header_key(assigned.slice)!r}; platform_request builds Cookie/CSRF/Traceid",
                        severity="warning",
                    ))
    return findings


def _string_constants(node) -> list[str]:
    return [
        child.value for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str)
    ]


def _check_subprocess_requests(path: Path, target: Path, tree) -> list[Finding]:
    findings = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _dotted_name(node.func) not in SUBPROCESS_FUNCS:
            continue
        if any(NETWORK_ARG_RE.search(value) for value in _string_constants(node)):
            findings.append(_finding(
                "SS-R008", path, target, node.lineno,
                "subprocess sends a business request; use muad_skill_http.platform_request",
            ))
    return findings


def _call_name(node) -> str:
    return _dotted_name(node)


def _check_fail_loud(path: Path, target: Path, tree) -> list[Finding]:
    findings = []
    for handler in ast.walk(tree):
        if not isinstance(handler, ast.ExceptHandler):
            continue
        for node in ast.walk(handler):
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node.func)
            if name in {"sys.exit", "exit"} and node.args:
                argument = node.args[0]
                if isinstance(argument, ast.Constant) and argument.value == 0:
                    findings.append(_finding(
                        "SS-R009", path, target, node.lineno,
                        "error path exits 0; failures must exit non-zero",
                    ))
            if name == "print":
                file_keyword = next((kw for kw in node.keywords if kw.arg == "file"), None)
                writes_stdout = file_keyword is None or _call_name(file_keyword.value) == "sys.stdout"
                if writes_stdout:
                    findings.append(_finding(
                        "SS-R009", path, target, node.lineno,
                        "error path writes to stdout; failures must go to stderr",
                    ))
    return findings


def _open_mode(call: ast.Call) -> str:
    if len(call.args) > 1 and isinstance(call.args[1], ast.Constant):
        return call.args[1].value if isinstance(call.args[1].value, str) else ""
    keyword = next((kw for kw in call.keywords if kw.arg == "mode"), None)
    if keyword and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
        return keyword.value.value
    return ""


def _is_write_call(call: ast.Call) -> bool:
    name = _call_name(call.func)
    if name == "open":
        return any(flag in _open_mode(call) for flag in "wax+")
    return name.endswith((".write_text", ".write_bytes"))


def _check_output_dir(path: Path, target: Path, source: str, tree, parents) -> list[Finding]:
    findings = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not _is_write_call(node):
            continue
        literals = _string_constants(node)
        if any(value.startswith("/") for value in literals):
            findings.append(_finding(
                "SS-R010", path, target, node.lineno,
                "file write uses an absolute path; write under SKILL_OUTPUT_DIR",
            ))
            continue
        function = _enclosing_function(node, parents)
        scope = ast.get_source_segment(source, function) if function else source
        if "SKILL_OUTPUT_DIR" not in (scope or ""):
            findings.append(_finding(
                "SS-R010", path, target, node.lineno,
                "file write does not use SKILL_OUTPUT_DIR",
            ))
    return findings


def _collect_string_constants(tree) -> dict[str, str]:
    constants = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            for assigned in node.targets:
                if isinstance(assigned, ast.Name):
                    constants[assigned.id] = node.value.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            if isinstance(node.target, ast.Name):
                constants[node.target.id] = node.value.value
    return constants


def _resolve_string(node, constants: dict[str, str]):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return constants.get(node.id)
    return None


def _skill_name_argument(call: ast.Call):
    for node in ast.walk(call):
        if not isinstance(node, ast.List):
            continue
        elements = node.elts
        for index, element in enumerate(elements[:-1]):
            if isinstance(element, ast.Constant) and element.value == "--skill-name":
                return elements[index + 1]
    return None


def _check_session_manager(path: Path, target: Path, tree, expected_name) -> list[Finding]:
    findings = []
    constants = _collect_string_constants(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _dotted_name(node.func) not in SUBPROCESS_FUNCS:
            continue
        strings = _string_constants(node)
        if "get-state" not in strings or "--skill-name" not in strings:
            continue
        value_node = _skill_name_argument(node)
        if value_node is None:
            continue
        value = _resolve_string(value_node, constants)
        if value is None:
            findings.append(_finding(
                "SS-R011", path, target, node.lineno,
                "session-manager skill name must be hard-coded as a string",
            ))
        elif expected_name and value != expected_name:
            findings.append(_finding(
                "SS-R011", path, target, node.lineno,
                f"session-manager skill name {value!r} does not match manifest name {expected_name!r}",
            ))
    return findings


def _check_platform_usage(target: Path, manifest, parsed) -> list[Finding]:
    platforms = manifest.get("platforms") if isinstance(manifest, dict) else None
    if not isinstance(platforms, list) or not platforms:
        return []
    has_import = False
    has_call = False
    first_python = None
    for path, source, tree in parsed:
        if first_python is None:
            first_python = path
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                has_import = has_import or any(alias.name == "muad_skill_http" for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and (node.module or "").startswith("muad_skill_http"):
                has_import = True
            elif isinstance(node, ast.Call) and _dotted_name(node.func).split(".")[-1] == "platform_request":
                has_call = True
    if has_import and has_call:
        return []
    location = first_python or (target / "muad.skill.json")
    return [_finding(
        "SS-R005", location, target, 1,
        "platforms declared but muad_skill_http.platform_request is not used",
    )]


def _check_python(path: Path, target: Path, source: str, tree, expected_name) -> list[Finding]:
    parents = _index_parents(tree)
    findings = []
    findings += _check_direct_http(path, target, tree)
    findings += _check_manual_headers(path, target, tree)
    findings += _check_subprocess_requests(path, target, tree)
    findings += _check_fail_loud(path, target, tree)
    findings += _check_output_dir(path, target, source, tree, parents)
    findings += _check_session_manager(path, target, tree, expected_name)
    return findings


# --------------------------------------------------------------------------- #
# text checks and report
# --------------------------------------------------------------------------- #

def _check_text_secrets(target: Path, files) -> list[Finding]:
    findings = []
    for path in files:
        if path.suffix.lower() not in TEXT_SUFFIXES or path.is_symlink():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(lines, 1):
            if INTERNAL_URL_RE.search(line):
                findings.append(_finding("SS-R012", path, target, number, "hard-coded internal URL"))
            match = CREDENTIAL_RE.search(line)
            if match and not any(marker in match.group("value").lower() for marker in PLACEHOLDER_MARKERS):
                findings.append(_finding("SS-R012", path, target, number, "hard-coded credential"))
    return findings


def _deduplicate(findings: list[Finding]) -> list[Finding]:
    seen = set()
    unique = []
    for finding in sorted(findings, key=lambda item: (item.file, item.line, item.rule, item.message)):
        key = (finding.rule, finding.file, finding.line, finding.message)
        if key not in seen:
            seen.add(key)
            unique.append(finding)
    return unique


def check_skill(target: Path) -> list[Finding]:
    files = _iter_files(target)
    findings = _check_file_types(target, files)
    manifest = _load_manifest(target, findings)
    frontmatter, frontmatter_line = _load_frontmatter(target, findings)
    findings += _check_manifest_fields(target, manifest)
    findings += _check_identity(target, manifest, frontmatter, frontmatter_line)

    parsed = []
    for path in files:
        if path.suffix != ".py":
            continue
        source, tree, errors = _parse_python(path, target)
        findings += errors
        if tree is not None:
            parsed.append((path, source, tree))
    expected_name = None
    if isinstance(manifest, dict) and isinstance(manifest.get("name"), str):
        expected_name = manifest["name"]
    elif isinstance(frontmatter, str):
        expected_name = frontmatter
    findings += _check_platform_usage(target, manifest, parsed)
    for path, source, tree in parsed:
        findings += _check_python(path, target, source, tree, expected_name)
    findings += _check_text_secrets(target, files)
    return _deduplicate(findings)


def _summary(findings: list[Finding], file_count: int) -> dict:
    errors = sum(1 for item in findings if item.severity == "error")
    warnings = sum(1 for item in findings if item.severity == "warning")
    return {"errors": errors, "warnings": warnings, "files": file_count}


def _render_json(target: Path, findings: list[Finding]) -> str:
    payload = {
        "target": str(target),
        "summary": _summary(findings, len(_iter_files(target))),
        "findings": [asdict(item) for item in findings],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def _render_markdown(target: Path, findings: list[Finding]) -> str:
    summary = _summary(findings, len(_iter_files(target)))
    result = "FAIL" if summary["errors"] else "PASS"
    lines = [
        f"# Skill Review: {target.name}",
        "",
        f"- Target: `{target}`",
        f"- Result: {result}",
        f"- Findings: {summary['errors']} error(s), {summary['warnings']} warning(s), {summary['files']} file(s)",
        "",
    ]
    if not findings:
        lines.append("No findings.")
        return "\n".join(lines) + "\n"
    lines.extend([
        "| Severity | Rule | Location | Message |",
        "|----------|------|----------|---------|",
    ])
    for item in findings:
        message = item.message.replace("|", "\\|")
        lines.append(f"| {item.severity} | {item.rule} | `{item.file}:{item.line}` | {message} |")
    return "\n".join(lines) + "\n"


def _write_report(path: Path, text: str) -> bool:
    try:
        path.write_text(text, encoding="utf-8")
    except OSError as exc:
        sys.stderr.write(f"self-skill-review: cannot write report: {exc}\n")
        return False
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read-only deterministic Skill review")
    parser.add_argument("--target", required=True, help="Skill directory to review")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", default="", help="write the report to this path instead of stdout")
    args = parser.parse_args(argv)

    target = Path(args.target).expanduser()
    if not target.is_dir():
        sys.stderr.write(f"self-skill-review: target directory not found: {target}\n")
        return 2
    target = target.resolve()

    try:
        findings = check_skill(target)
    except OSError as exc:
        sys.stderr.write(f"self-skill-review: cannot read target: {exc}\n")
        return 2

    report = _render_json(target, findings) if args.format == "json" else _render_markdown(target, findings)
    if args.output:
        if not _write_report(Path(args.output), report):
            return 2
    else:
        sys.stdout.write(report)

    errors = sum(1 for item in findings if item.severity == "error")
    warnings = len(findings) - errors
    if errors:
        sys.stderr.write(f"self-skill-review: {errors} error(s), {warnings} warning(s)\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
