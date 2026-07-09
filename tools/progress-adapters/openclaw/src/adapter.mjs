export function deliverOpenClawProgressEvent(event, deps) {
  const text = String(event.text || "").trim();
  if (!text) {
    return { ok: false, delivery: "dropped", reason: "empty_text" };
  }
  if (event.privacy && event.privacy !== "public") {
    return { ok: true, delivery: "dropped", reason: "non_public" };
  }
  if (event.visibility && event.visibility !== "channel") {
    return { ok: true, delivery: "dropped", reason: "non_channel" };
  }
  deps.emitToolProgress({
    text,
    id: event.id || event.stage,
    name: event.skill || "muad-progress",
    phase: event.stage,
    status: statusForEvent(event.type),
  });
  return { ok: true, delivery: "sent" };
}

function statusForEvent(type) {
  if (type === "done") {
    return "done";
  }
  if (type === "error") {
    return "error";
  }
  return "running";
}
