import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";

export interface LongTaskActionsController {
  busyTaskIds: ReadonlySet<string>;
  error: string;
  message: string;
  cancel: (taskId: string) => Promise<void>;
}

// CMP-02：任务级在途状态、错误/成功反馈与统一 API 调用；单个 taskId 在途只允许
// 一个请求（重复点击丢弃），成功/失败后各执行一次列表刷新以呈现 Worker 实际状态。
export function useLongTaskActions({
  refresh,
}: {
  refresh: () => Promise<void> | void;
}): LongTaskActionsController {
  const { t } = useTranslation();
  const mountedRef = useMountedRef();
  const inFlightRef = useRef(new Set<string>());
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const cancel = useCallback(
    async (taskId: string) => {
      if (!taskId || inFlightRef.current.has(taskId)) return;
      inFlightRef.current.add(taskId);
      setBusyTaskIds(new Set(inFlightRef.current));
      setError("");
      setMessage("");
      try {
        const result = await api.cancelLongTask(taskId);
        if (!mountedRef.current) return;
        if (result.outcome === "cancel_requested") {
          // 202 仅代表已接受：等待停止确认，不冒充已取消。
          setMessage(t("longTasks.cancelRequested"));
        } else if (result.outcome === "cancelled") {
          setMessage(t("longTasks.cancelledNotice"));
        } else {
          // already_terminal：保留并展示实际终态，不改写为已取消。
          setMessage(t(`status.${result.status}`));
        }
      } catch (caught) {
        if (mountedRef.current) setError(errorMessage(caught, "longTasks.cancelFailed"));
      } finally {
        inFlightRef.current.delete(taskId);
        if (mountedRef.current) setBusyTaskIds(new Set(inFlightRef.current));
        // 无论成败各刷新一次：超时/失败不推断失败终态，也不自动重提业务任务。
        void Promise.resolve(refresh()).catch(() => {});
      }
    },
    [mountedRef, refresh, t],
  );

  return useMemo(
    () => ({ busyTaskIds, error, message, cancel }),
    [busyTaskIds, error, message, cancel],
  );
}
