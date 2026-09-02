#!/usr/bin/env python3
"""Atomic per-company run state and crash-safe execution locks."""

import fcntl
import hashlib
import json
import os
import tempfile
import uuid
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from typing import Dict, Optional

from shared.output import cache_dir


TERMINAL_STATUSES = {"succeeded", "failed", "interrupted"}
ACTIVE_STATUSES = {"pending", "running"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _company_key(company_id: str) -> str:
    value = str(company_id or "").strip().encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:24]


def _company_dir(name: str) -> str:
    path = os.path.join(cache_dir(), name)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def state_path(company_id: str = "") -> str:
    if company_id:
        return os.path.join(_company_dir("companies"), f"{_company_key(company_id)}.json")
    return os.path.join(cache_dir(), "last_session.json")


def lock_path(company_id: str = "") -> str:
    if company_id:
        return os.path.join(_company_dir("locks"), f"{_company_key(company_id)}.lock")
    return os.path.join(cache_dir(), "active.lock")


def _read_json(path: str) -> Optional[Dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None


def read_state(company_id: str = "") -> Optional[Dict]:
    state = _read_json(state_path(company_id))
    if state is not None or not company_id:
        return state
    legacy = _read_json(state_path())
    if legacy and str(legacy.get("company_id") or "") == str(company_id):
        return legacy
    return None


def _atomic_write(target: str, state: Dict, prefix: str) -> None:
    directory = os.path.dirname(target)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=prefix, dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        os.chmod(target, 0o600)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def write_state(state: Dict, company_id: str = "") -> Dict:
    state = dict(state)
    state["updated_at"] = utc_now()
    scope = str(company_id or state.get("company_id") or "").strip()
    if scope:
        state["company_id"] = scope
        _atomic_write(state_path(scope), state, ".company-state-")
    _atomic_write(state_path(), state, ".last-session-")
    return state


def update_state(scope_company_id: str = "", **changes) -> Dict:
    state = read_state(scope_company_id) or {}
    state.update(changes)
    return write_state(state, scope_company_id)


def _execution(step: str) -> Dict:
    now = utc_now()
    return {
        "run_id": str(uuid.uuid4()),
        "step": step,
        "status": "running",
        "started_at": now,
        "finished_at": "",
        "error": "",
    }


def new_run(company_input: str, company_id: str = "") -> Dict:
    now = utc_now()
    return write_state({
        "workflow_id": str(uuid.uuid4()),
        "company_input": company_input,
        "company_id": str(company_id or ""),
        "status": "preparing",
        "current_phase": "phase1",
        "created_at": now,
        "updated_at": now,
        "execution": _execution("phase1"),
    }, company_id)


def begin_step(step: str, company_id: str = "") -> Dict:
    state = read_state(company_id) or {"status": "unknown", "created_at": utc_now()}
    state["current_phase"] = step
    state["execution"] = _execution(step)
    return write_state(state, company_id)


def finish_step(status: str = "succeeded", error: str = "",
                company_id: str = "") -> Dict:
    state = read_state(company_id) or {}
    execution = dict(state.get("execution") or {})
    execution.update(status=status, finished_at=utc_now(), error=error[:500])
    state["execution"] = execution
    return write_state(state, company_id)


class ActiveRunError(RuntimeError):
    def __init__(self, state: Optional[Dict], company_id: str = ""):
        suffix = f"（company_id={company_id}）" if company_id else ""
        super().__init__(f"该客户已有 MSSP 策略检查步骤正在执行{suffix}")
        self.state = state or {}


class RunLock(AbstractContextManager):
    def __init__(self, company_id: str = ""):
        self.company_id = str(company_id or "").strip()
        self._handle = None

    def __enter__(self):
        path = lock_path(self.company_id)
        self._handle = open(path, "a+", encoding="utf-8")
        os.chmod(path, 0o600)
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._handle.close()
            self._handle = None
            raise ActiveRunError(read_state(self.company_id), self.company_id) from exc
        reconcile_interrupted_state(self.company_id)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._handle is not None:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            self._handle.close()
            self._handle = None
        return False


def execution_is_active(company_id: str = "") -> bool:
    handle = open(lock_path(company_id), "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return True
    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()
    return False


def reconcile_interrupted_state(company_id: str = "") -> Optional[Dict]:
    state = read_state(company_id)
    execution = dict(state.get("execution") or {}) if state else {}
    if not state or execution.get("status") not in ACTIVE_STATUSES:
        return state
    execution.update(
        status="interrupted", finished_at=utc_now(),
        error="上一次短步骤执行进程已结束，可重新执行该步骤",
    )
    state["execution"] = execution
    return write_state(state, company_id)


def latest_status(company_id: str = "") -> Optional[Dict]:
    handle = open(lock_path(company_id), "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return read_state(company_id)
    try:
        return reconcile_interrupted_state(company_id)
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()
