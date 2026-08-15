import type { Pod, PodAction, PodState } from "../../api";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function statusTags(
  t: Translate,
): Record<
  string,
  { label: string; color: "green" | "blue" | "red" | "orange" | "grey" | "light-blue"; dot: string }
> {
  return {
    creating: { label: t("status.creating"), color: "light-blue", dot: "#4db8ff" },
    running: { label: t("status.running"), color: "green", dot: "#3cdc80" },
    stopped: { label: t("status.stopped"), color: "grey", dot: "#8899aa" },
    unhealthy: { label: t("status.unhealthy"), color: "orange", dot: "#ffa940" },
    error: { label: t("status.error"), color: "red", dot: "#ff4d4f" },
    deleting: { label: t("status.deleting"), color: "orange", dot: "#ffa940" },
    missing: { label: t("pod.stateDeleted"), color: "grey", dot: "#8899aa" },
  };
}

export function applyStatusTags(
  t: Translate,
): Record<string, { label: string; color: "green" | "blue" | "red" | "orange" | "grey" }> {
  return {
    pending: { label: t("status.pendingApply"), color: "orange" },
    applying: { label: t("pod.applyStatusApplying"), color: "blue" },
    applied: { label: t("status.synced"), color: "green" },
    failed: { label: t("status.failed"), color: "red" },
  };
}

const STATUS_FILTER_VALUES: PodStateFilter[] = [
  "",
  "creating",
  "running",
  "stopped",
  "error",
  "unhealthy",
  "deleting",
];

export function statusOptions(t: Translate): { value: string; label: string }[] {
  return [
    { value: "", label: t("pod.statusAll") },
    { value: "creating", label: t("status.creating") },
    { value: "running", label: t("status.running") },
    { value: "stopped", label: t("status.stopped") },
    { value: "error", label: t("status.error") },
    { value: "unhealthy", label: t("status.unhealthy") },
    { value: "deleting", label: t("status.deleting") },
  ];
}

/** 按 Pod 状态过滤生命周期动作：start 仅 stopped；stop/restart 仅 running/unhealthy。
 *  与 pod-detail PodActionPanel 的 LifecycleButtons 判定保持一致。 */
export function podActions(
  t: Translate,
  pod: Pod,
): Array<{ key: PodAction; label: string }> {
  const actions: Array<{ key: PodAction; label: string }> = [];
  if (pod.state === "stopped") {
    actions.push({ key: "start" as const, label: t("pod.actionStart") });
  }
  const active = pod.state === "running" || pod.state === "unhealthy";
  if (active) {
    actions.push({ key: "stop" as const, label: t("pod.actionStop") });
    actions.push({ key: "restart" as const, label: t("pod.actionRestart") });
  }
  return actions;
}

export type PodStateFilter = "" | Exclude<PodState, "missing">;

export function isPodStateFilter(value: string): value is PodStateFilter {
  return (STATUS_FILTER_VALUES as string[]).includes(value);
}
