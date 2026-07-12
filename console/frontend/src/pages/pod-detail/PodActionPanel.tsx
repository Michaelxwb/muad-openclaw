import { useState } from "react";
import { Button, Toast } from "@douyinfe/semi-ui";
import { IconDelete, IconPlay, IconRestart, IconStop } from "@douyinfe/semi-icons";
import { api } from "../../api";
import type { Pod, PodAction } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import styles from "../PodDetail.module.css";
import { PodActionDialogs } from "./PodActionDialogs";

interface Props {
  pod: Pod;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}

type ActionDialog = "upgrade" | "delete" | "logs" | "qr" | null;

export function PodActionPanel({ pod, onChanged, onDeleted }: Props) {
  const runner = useActionRunner(onChanged);
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const runAction = (action: PodAction) =>
    runner.run(action, () => api.action(pod.podId, action), `Pod ${action} 已完成`);
  const apply = () =>
    runner.run("apply", () => api.applyPodConfig(pod.podId), "配置已进入应用队列");
  const upgrade = (imageTag: string) =>
    runner.run("upgrade", () => api.upgrade(pod.podId, imageTag), "Pod 升级完成");
  const remove = async (deleteState: boolean) => {
    const success = await runner.run(
      "delete",
      () => api.deletePod(pod.podId, deleteState),
      "Pod 已删除",
    );
    if (success) onDeleted();
    return success;
  };
  return (
    <>
      <FeedbackBanner error={runner.error} message={runner.message} />
      <PodActionButtons
        pod={pod}
        busy={runner.busy}
        onAction={runAction}
        onApply={apply}
        onDialog={setDialog}
      />
      <PodActionDialogs
        pod={pod}
        active={dialog}
        onClose={() => setDialog(null)}
        onUpgrade={upgrade}
        onDelete={remove}
      />
    </>
  );
}

function useActionRunner(onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      await action();
      if (!mountedRef.current) return false;
      setMessage(success);
      Toast.success(success);
      await onChanged();
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "Pod 操作失败");
      return false;
    } finally {
      if (mountedRef.current) setBusy("");
    }
  };
  return { busy, error, message, run };
}

interface ButtonProps {
  pod: Pod;
  busy: string;
  onAction: (action: PodAction) => void;
  onApply: () => void;
  onDialog: (dialog: Exclude<ActionDialog, null>) => void;
}

function PodActionButtons(props: ButtonProps) {
  const active = props.pod.state === "running" || props.pod.state === "unhealthy";
  const disabled = props.busy !== "";
  const applyLabel =
    props.pod.generationLag > 0 || props.pod.lastApplyStatus === "failed" ? "重试应用" : "应用配置";
  return (
    <div className={styles.toolbar}>
      <LifecycleButtons pod={props.pod} disabled={disabled} onAction={props.onAction} />
      <Button
        loading={props.busy === "apply"}
        disabled={disabled || !active}
        onClick={props.onApply}
      >
        {applyLabel}
      </Button>
      <Button disabled={disabled || !active} onClick={() => props.onDialog("upgrade")}>
        升级
      </Button>
      <Button disabled={disabled} onClick={() => props.onDialog("logs")}>
        日志
      </Button>
      {props.pod.channels.includes("wechat") && (
        <Button disabled={disabled} onClick={() => props.onDialog("qr")}>
          二维码
        </Button>
      )}
      <Button
        aria-label="删除"
        icon={<IconDelete />}
        type="danger"
        disabled={disabled}
        onClick={() => props.onDialog("delete")}
      >
        删除
      </Button>
    </div>
  );
}

function LifecycleButtons({
  pod,
  disabled,
  onAction,
}: {
  pod: Pod;
  disabled: boolean;
  onAction: (action: PodAction) => void;
}) {
  const active = pod.state === "running" || pod.state === "unhealthy";
  return (
    <>
      <Button
        aria-label="启动"
        icon={<IconPlay />}
        disabled={disabled || pod.state !== "stopped"}
        onClick={() => onAction("start")}
      >
        启动
      </Button>
      <Button
        aria-label="停止"
        icon={<IconStop />}
        disabled={disabled || !active}
        onClick={() => onAction("stop")}
      >
        停止
      </Button>
      <Button
        aria-label="重启"
        icon={<IconRestart />}
        disabled={disabled || !active}
        onClick={() => onAction("restart")}
      >
        重启
      </Button>
    </>
  );
}
