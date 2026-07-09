export type MuadProgressEventType = "progress" | "done" | "error";

export type MuadProgressEvent = {
  type: MuadProgressEventType;
  skill?: string;
  stage?: string;
  text: string;
  id?: string;
  code?: string;
  visibility?: string;
  privacy?: string;
  ts?: string;
  delivery?: string;
};

export type OpenClawProgressDeps = {
  emitToolProgress: (payload: {
    text: string;
    id?: string;
    name: string;
    phase?: string;
    status: "running" | "done" | "error";
  }) => Promise<void> | void;
  now?: () => Date;
};

export type DeliveryResult = {
  ok: boolean;
  delivery: "sent" | "dropped";
  reason?: string;
};

const defaultToolName = "muad-progress";

export async function deliverOpenClawProgressEvent(
  event: MuadProgressEvent,
  deps: OpenClawProgressDeps,
): Promise<DeliveryResult> {
  const text = event.text.trim();
  if (!text) {
    return { ok: false, delivery: "dropped", reason: "empty_text" };
  }
  if (event.privacy && event.privacy !== "public") {
    return { ok: true, delivery: "dropped", reason: "non_public" };
  }
  if (event.visibility && event.visibility !== "channel") {
    return { ok: true, delivery: "dropped", reason: "non_channel" };
  }
  await deps.emitToolProgress({
    text,
    id: event.id || event.stage,
    name: event.skill || defaultToolName,
    phase: event.stage,
    status: resolveStatus(event.type),
  });
  return { ok: true, delivery: "sent" };
}

function resolveStatus(type: MuadProgressEventType): "running" | "done" | "error" {
  if (type === "done") {
    return "done";
  }
  if (type === "error") {
    return "error";
  }
  return "running";
}
