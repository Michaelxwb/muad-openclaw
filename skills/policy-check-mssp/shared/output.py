#!/usr/bin/env python3
"""Per-user writable output paths for policy-check-mssp."""

import hashlib
import json
import os
import shutil
import tempfile


SKILL_OUTPUT_SUBDIR = "policy-check-mssp"


def output_root() -> str:
    injected = os.environ.get("SKILL_OUTPUT_DIR", "").strip()
    explicit = os.environ.get("POLICY_CHECK_MSSP_OUTPUT_DIR", "").strip()
    base = explicit or injected or tempfile.gettempdir()
    root = explicit or os.path.join(base, SKILL_OUTPUT_SUBDIR)
    os.makedirs(root, mode=0o700, exist_ok=True)
    return root


def cache_dir() -> str:
    path = os.path.join(output_root(), "cache")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _scope_key(company_id: str) -> str:
    value = str(company_id or "").strip().encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:24]


def reports_dir(company_id: str = "") -> str:
    path = os.path.join(output_root(), "reports")
    if company_id:
        path = os.path.join(path, _scope_key(company_id))
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def clear_reports(company_id: str = "") -> None:
    path = reports_dir(company_id)
    for name in os.listdir(path):
        target = os.path.join(path, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.unlink(target)


def atomic_write_json(path: str, value) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".artifact-", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def atomic_write_text(path: str, value: str) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".artifact-", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
