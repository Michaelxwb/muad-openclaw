import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Popconfirm, Tooltip } from "@douyinfe/semi-ui";
import type { LongTask } from "../../api";
import styles from "../LongTasks.module.css";

export interface LongTaskActionsProps {
  task: LongTask;
  busy: boolean;
  onCancel: (taskId: string) => void;
}

// CMP-01：纯展示 + 确认 + 事件上抛，不直接发 HTTP；只携带本行稳定 taskId。
// queued 直接取消；running 经 Popconfirm（含 Skill 与任务 ID）确认后上抛；
// cancelling 禁用展示；终态一律无取消/重试入口；能力缺失给出可读原因。
export function LongTaskActions({ task, busy, onCancel }: LongTaskActionsProps) {
  const { t } = useTranslation();
  const unavailableReason = useMemo(() => {
    switch (task.cancelUnavailableReason) {
      case "capability_unknown":
        return t("longTasks.cancelUnavailableUnknown");
      case "worker_unsupported":
        return t("longTasks.cancelUnavailableUnsupported");
      case "task_not_cancellable":
        return t("longTasks.cancelUnavailableStatus");
      default:
        return "";
    }
  }, [t, task.cancelUnavailableReason]);

  if (task.status === "cancelling") {
    return (
      <Button size="small" theme="borderless" className={styles.taskAction} disabled>
        {t("status.cancelling")}
      </Button>
    );
  }
  if (task.status !== "queued" && task.status !== "running") {
    return null;
  }
  const label = task.status === "queued" ? t("longTasks.cancelQueued") : t("longTasks.terminate");
  if (!task.canCancel) {
    const disabled = (
      <Button size="small" theme="borderless" className={styles.taskAction} disabled>
        {label}
      </Button>
    );
    if (!unavailableReason) return disabled;
    return (
      <Tooltip content={unavailableReason}>
        <span className={styles.taskActionWrap}>{disabled}</span>
      </Tooltip>
    );
  }
  if (task.status === "queued") {
    return (
      <Button
        size="small"
        theme="borderless"
        className={styles.taskAction}
        disabled={busy}
        loading={busy}
        onClick={() => onCancel(task.taskId)}
      >
        {label}
      </Button>
    );
  }
  return (
    <Popconfirm
      title={t("longTasks.terminateTitle")}
      content={t("longTasks.terminateContent", { skill: task.skillName, taskId: task.taskId })}
      okText={t("common.confirm")}
      cancelText={t("common.cancel")}
      onConfirm={() => onCancel(task.taskId)}
    >
      <Button
        size="small"
        theme="borderless"
        className={styles.taskAction}
        disabled={busy}
        loading={busy}
      >
        {label}
      </Button>
    </Popconfirm>
  );
}
