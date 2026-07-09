"""Hermes adapter for muad-progress events.

The adapter is intentionally thin: it converts a CLI event dict into a Hermes
tool/progress callback without owning business logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, MutableMapping, Optional


ProgressSender = Callable[[Mapping[str, Any]], None]


@dataclass(frozen=True)
class DeliveryResult:
    ok: bool
    delivery: str
    reason: Optional[str] = None


def deliver_progress_event(event: Mapping[str, Any], send: ProgressSender) -> DeliveryResult:
    text = str(event.get("text") or "").strip()
    if not text:
        return DeliveryResult(ok=False, delivery="dropped", reason="empty_text")
    if event.get("privacy", "public") != "public":
        return DeliveryResult(ok=True, delivery="dropped", reason="non_public")
    if event.get("visibility", "channel") != "channel":
        return DeliveryResult(ok=True, delivery="dropped", reason="non_channel")

    send(
        {
            "text": text,
            "id": event.get("id") or event.get("stage"),
            "name": event.get("skill") or "muad-progress",
            "phase": event.get("stage"),
            "status": _status_for_event(str(event.get("type") or "progress")),
        }
    )
    return DeliveryResult(ok=True, delivery="sent")


def register(ctx: Any) -> None:
    """Register a Hermes tool when loaded as a plugin.

    Hermes plugin APIs differ by runtime version; this function keeps the
    adapter contract small and easy to wrap in the actual deployment.
    """

    def muad_progress_tool(event: MutableMapping[str, Any]) -> Mapping[str, Any]:
        result = deliver_progress_event(event, lambda payload: ctx.emit_progress(payload))
        return {
            "ok": result.ok,
            "delivery": result.delivery,
            "reason": result.reason,
        }

    ctx.register_tool("muad_progress", muad_progress_tool)


def _status_for_event(event_type: str) -> str:
    if event_type == "done":
        return "done"
    if event_type == "error":
        return "error"
    return "running"
