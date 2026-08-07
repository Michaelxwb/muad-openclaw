import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@douyinfe/semi-ui";
import { IconDelete, IconPlay, IconRestart, IconStop } from "@douyinfe/semi-icons";
import { api } from "../../api";
import type { Pod, PodAction } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";
import styles from "../PodDetail.module.css";
import { PodActionDialogs } from "./PodActionDialogs";

interface Props {
  pod: Pod;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}

type ActionDialog = "upgrade" | "delete" | "logs" | "qr" | null;

export function PodActionPanel({ pod, onChanged, onDeleted }: Props) {
  const { t } = useTranslation();
  const runner = useActionRunner(onChanged);
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const runAction = (action: PodAction) =>
    runner.run(action, () => api.action(pod.podId, action), t("pod.actionCompleted", { action }));
  const apply = () =>
    runner.run("apply", () => api.applyPodConfig(pod.podId), t("pod.applyQueued"));
  const upgrade = (imageTag: string) =>
    runner.run("upgrade", () => api.upgrade(pod.podId, imageTag), t("pod.upgradeCompleted"));
  const remove = async (deleteState: boolean) => {
    const success = await runner.run(
      "delete",
      () => api.deletePod(pod.podId, deleteState),
      t("pod.deleted"),
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
      await onChanged();
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "pod.actionFailed"));
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
  const { t } = useTranslation();
  const active = props.pod.state === "running" || props.pod.state === "unhealthy";
  const disabled = props.busy !== "";
  const applyLabel =
    props.pod.generationLag > 0 || props.pod.lastApplyStatus === "failed"
      ? t("pod.applyRetry")
      : t("pod.applyConfig");
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
        {t("pod.actionUpgrade")}
      </Button>
      <Button disabled={disabled} onClick={() => props.onDialog("logs")}>
        {t("pod.actionLogs")}
      </Button>
      {props.pod.channels.includes("wechat") && (
        <Button disabled={disabled} onClick={() => props.onDialog("qr")}>
          {t("pod.actionQr")}
        </Button>
      )}
      <Button
        aria-label={t("common.delete")}
        icon={<IconDelete />}
        type="danger"
        disabled={disabled}
        onClick={() => props.onDialog("delete")}
      >
        {t("common.delete")}
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
  const { t } = useTranslation();
  const active = pod.state === "running" || pod.state === "unhealthy";
  return (
    <>
      <Button
        aria-label={t("pod.actionStart")}
        icon={<IconPlay />}
        disabled={disabled || pod.state !== "stopped"}
        onClick={() => onAction("start")}
      >
        {t("pod.actionStart")}
      </Button>
      <Button
        aria-label={t("pod.actionStop")}
        icon={<IconStop />}
        disabled={disabled || !active}
        onClick={() => onAction("stop")}
      >
        {t("pod.actionStop")}
      </Button>
      <Button
        aria-label={t("pod.actionRestart")}
        icon={<IconRestart />}
        disabled={disabled || !active}
        onClick={() => onAction("restart")}
      >
        {t("pod.actionRestart")}
      </Button>
    </>
  );
}
