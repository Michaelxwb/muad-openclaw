"""Per-execution trace spool and interface request limit.

The recorder keeps per-process counts for the summary and, when a request
limit is configured, also maintains an execution-wide counter file so child
processes share the same per-interface limit. Every I/O failure is swallowed
so auditing never breaks a skill request.
"""

from __future__ import annotations

import atexit
import json
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone

try:  # pragma: no cover - Windows has no fcntl
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

EXIT_REQUEST_LIMIT = 86
DETAIL_LIMIT = 500
BURST_WINDOW_SECONDS = 10.0
TOP_INTERFACE_LIMIT = 10
COUNTER_SUFFIX = ".limit.json"
MAX_COUNTER_BYTES = 1 << 20


def _terminate(code):
    os._exit(code)


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_limit():
    raw = os.environ.get("MUAD_SKILL_REQUEST_LIMIT", "")
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return 0
    return value if value > 0 else 0


class _SharedCounter:
    """Execution-wide counter shared by every process of one skill execution.

    The sidecar lives next to the trace spool and is only used when a request
    limit is configured. fcntl locking keeps read-modify-write atomic across
    processes; without fcntl the recorder falls back to per-process counting.
    """

    def __init__(self, spool_path):
        self._path = spool_path + COUNTER_SUFFIX
        self._disabled = fcntl is None or not spool_path
        self._fallback = {}

    def admit(self, host, method, path):
        key = "%s %s %s" % (method, host, path)

        def update(data):
            interfaces = data.get("interfaces")
            if not isinstance(interfaces, dict):
                interfaces = {}
                data["interfaces"] = interfaces
            count = int(interfaces.get(key, 0) or 0) + 1
            interfaces[key] = count
            data["total"] = int(data.get("total", 0) or 0) + 1
            hosts = data.get("hosts")
            if not isinstance(hosts, dict):
                hosts = {}
                data["hosts"] = hosts
            hosts[host] = int(hosts.get(host, 0) or 0) + 1
            return count

        result = self._mutate(update)
        if result is not None:
            return result
        count = self._fallback.get(key, 0) + 1
        self._fallback[key] = count
        return count

    def complete(self, error):
        if not error:
            return

        def update(data):
            data["errors"] = int(data.get("errors", 0) or 0) + 1

        self._mutate(update)

    def abort(self, interface, count, limit):
        def update(data):
            data["aborted"] = True
            data["abortInterface"] = interface
            data["abortCount"] = count
            data["limit"] = limit

        self._mutate(update)

    def _mutate(self, callback):
        if self._disabled:
            return None
        try:
            fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            self._disabled = True
            return None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                raw = os.read(fd, MAX_COUNTER_BYTES)
                try:
                    data = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    data = {}
                if not isinstance(data, dict):
                    data = {}
                result = callback(data)
                _sync_top_interfaces(data)
                encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                os.lseek(fd, 0, os.SEEK_SET)
                os.ftruncate(fd, 0)
                os.write(fd, encoded)
                return result
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except (OSError, ValueError):
            self._disabled = True
            return None
        finally:
            os.close(fd)


def _sync_top_interfaces(data):
    interfaces = data.get("interfaces")
    if not isinstance(interfaces, dict):
        return
    entries = []
    for key, count in interfaces.items():
        parts = str(key).split(" ", 2)
        if len(parts) != 3:
            continue
        entries.append({
            "method": parts[0],
            "host": parts[1],
            "path": parts[2],
            "count": int(count or 0),
        })
    entries.sort(key=lambda item: (-item["count"], item["host"], item["method"], item["path"]))
    data["topInterfaces"] = entries[:TOP_INTERFACE_LIMIT]



class TraceRecorder:
    def __init__(self, spool_path, execution_id, limit):
        self._spool_path = spool_path
        self._enabled = bool(spool_path) and bool(execution_id)
        self._limit = limit
        self._lock = threading.Lock()
        self._file = None
        self._file_failed = False
        self._counts = {}
        self._hosts = {}
        self._burst = deque()
        self._max_burst = 0
        self._total = 0
        self._errors = 0
        self._details = 0
        self._truncated = False
        self._aborted = False
        self._summary_written = False
        self._shared = _SharedCounter(spool_path) if limit > 0 and spool_path else None

    # -- request lifecycle ------------------------------------------------- #

    def admit(self, host, method, path):
        """Count one attempt and terminate before sending the N+1 request."""
        terminate_now = False
        already_aborted = False
        with self._lock:
            if self._aborted:
                already_aborted = True
            else:
                self._total += 1
                key = (host, method, path)
                count = self._counts.get(key, 0) + 1
                self._counts[key] = count
                self._hosts[host] = self._hosts.get(host, 0) + 1
                self._track_burst_locked()
                shared_count = self._shared.admit(host, method, path) if self._shared else None
                effective = shared_count if shared_count is not None else count
                if self._limit and effective > self._limit:
                    self._aborted = True
                    interface = "%s %s %s" % (method, host, path)
                    self._write_abort_locked(host, method, path, effective)
                    if self._shared is not None:
                        self._shared.abort(interface, effective, self._limit)
                    self._write_summary_locked()
                    terminate_now = True
        if terminate_now or already_aborted:
            _terminate(EXIT_REQUEST_LIMIT)

    def complete(self, host, method, path, status, duration_ms, error_class, extra=None):
        """Record the response (or transport failure) if the detail cap allows."""
        event = {
            "v": 1,
            "ts": _now_iso(),
            "kind": "http",
            "host": host,
            "method": method,
            "path": path,
            "status": status,
            "durationMs": duration_ms,
            "errorClass": error_class or "",
        }
        if extra:
            event.update(extra)
        with self._lock:
            if status is None or status >= 400:
                self._errors += 1
            if self._details < DETAIL_LIMIT:
                if self._write_locked(event):
                    self._details += 1
            else:
                self._truncated = True
        if self._shared is not None:
            self._shared.complete(status is None or status >= 400)

    # -- spool ------------------------------------------------------------- #

    def flush_summary(self):
        with self._lock:
            self._write_summary_locked()

    def _track_burst_locked(self):
        now = time.monotonic()
        self._burst.append(now)
        while self._burst and now - self._burst[0] > BURST_WINDOW_SECONDS:
            self._burst.popleft()
        if len(self._burst) > self._max_burst:
            self._max_burst = len(self._burst)

    def _write_abort_locked(self, host, method, path, count):
        self._write_locked(
            {
                "v": 1,
                "ts": _now_iso(),
                "kind": "abort",
                "reason": "request_limit",
                "interface": "%s %s %s" % (method, host, path),
                "count": count,
                "limit": self._limit,
            }
        )

    def _write_summary_locked(self):
        if self._summary_written:
            return
        self._summary_written = True
        top = sorted(
            (
                {"host": host, "method": method, "path": path, "count": count}
                for (host, method, path), count in self._counts.items()
            ),
            key=lambda item: (-item["count"], item["host"], item["method"], item["path"]),
        )[:TOP_INTERFACE_LIMIT]
        self._write_locked(
            {
                "v": 1,
                "ts": _now_iso(),
                "kind": "summary",
                "totalRequests": self._total,
                "errorCount": self._errors,
                "hosts": dict(self._hosts),
                "topInterfaces": top,
                "maxBurst10s": self._max_burst,
                "truncated": self._truncated,
                "aborted": self._aborted,
            }
        )
        self._flush_locked()

    def _write_locked(self, event):
        if not self._enabled or self._file_failed:
            return False
        try:
            if self._file is None:
                fd = os.open(
                    self._spool_path,
                    os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                    0o600,
                )
                self._file = os.fdopen(fd, "a", encoding="utf-8")
            self._file.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            return True
        except (OSError, ValueError):
            self._disable_locked()
            return False

    def _flush_locked(self):
        try:
            if self._file is not None:
                self._file.flush()
                os.fsync(self._file.fileno())
        except (OSError, ValueError):
            self._disable_locked()

    def _disable_locked(self):
        self._file_failed = True
        self._file = None


_recorder = None
_recorder_lock = threading.Lock()


def get_recorder():
    global _recorder
    with _recorder_lock:
        if _recorder is None:
            _recorder = TraceRecorder(
                os.environ.get("MUAD_TRACE_SPOOL", ""),
                os.environ.get("MUAD_EXECUTION_ID", ""),
                _parse_limit(),
            )
            atexit.register(_recorder.flush_summary)
        return _recorder


def flush_summary():
    get_recorder().flush_summary()


def reset():
    global _recorder
    with _recorder_lock:
        _recorder = None
