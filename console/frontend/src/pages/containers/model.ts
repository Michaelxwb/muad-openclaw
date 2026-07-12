import type { PodAction, PodState } from "../../api";

export const STATUS_TAGS: Record<
  string,
  { label: string; color: "green" | "blue" | "red" | "orange" | "grey" | "light-blue"; dot: string }
> = {
  creating: { label: "创建中", color: "light-blue", dot: "#4db8ff" },
  running: { label: "运行中", color: "green", dot: "#3cdc80" },
  stopped: { label: "已停止", color: "grey", dot: "#8899aa" },
  unhealthy: { label: "不健康", color: "orange", dot: "#ffa940" },
  error: { label: "异常", color: "red", dot: "#ff4d4f" },
  deleting: { label: "删除中", color: "orange", dot: "#ffa940" },
  missing: { label: "已删除", color: "grey", dot: "#8899aa" },
};

export const APPLY_STATUS_TAGS: Record<
  string,
  { label: string; color: "green" | "blue" | "red" | "orange" | "grey" }
> = {
  pending: { label: "待应用", color: "orange" },
  applying: { label: "应用中", color: "blue" },
  applied: { label: "已同步", color: "green" },
  failed: { label: "失败", color: "red" },
};

export const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "creating", label: "创建中" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "error", label: "异常" },
  { value: "unhealthy", label: "不健康" },
  { value: "deleting", label: "删除中" },
];

export const POD_ACTIONS = [
  { key: "start" as const, label: "启动" },
  { key: "stop" as const, label: "停止" },
  { key: "restart" as const, label: "重启" },
] satisfies Array<{ key: PodAction; label: string }>;

export type PodStateFilter = "" | Exclude<PodState, "missing">;

export function isPodStateFilter(value: string): value is PodStateFilter {
  return STATUS_OPTIONS.some((option) => option.value === value);
}
