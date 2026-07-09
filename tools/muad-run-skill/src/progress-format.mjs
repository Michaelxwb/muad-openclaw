const STATUS_LABELS = {
  progress: "进行中",
  done: "完成",
  error: "失败",
};

export function formatProgressText(event) {
  const skill = event.skill ? `${event.skill} ` : "";
  const stage = event.stage ? `「${event.stage}」` : "";
  const status = STATUS_LABELS[event.type] ?? event.type ?? "progress";
  const text = typeof event.text === "string" ? event.text.trim() : "";
  return `${skill}${stage}${status}: ${text}`.trim();
}

export function toToolUpdate(event) {
  const progressText = formatProgressText(event);
  return {
    content: [],
    details: {
      muadProgress: true,
      skill: event.skill,
      stage: event.stage,
      type: event.type,
      text: event.text,
      ts: event.ts,
    },
    progress: {
      text: progressText,
      visibility: "channel",
      privacy: "public",
      id: `${event.skill ?? "skill"}:${event.stage ?? event.type ?? "progress"}`,
    },
  };
}
