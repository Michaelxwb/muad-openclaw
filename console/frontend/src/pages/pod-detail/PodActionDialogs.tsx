import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal, RadioGroup } from "@douyinfe/semi-ui";
import QRCode from "qrcode";
import { api } from "../../api";
import type { Pod } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";
import styles from "../PodDetail.module.css";

type ActionDialog = "upgrade" | "delete" | "logs" | "qr" | null;

interface Props {
  pod: Pod;
  active: ActionDialog;
  onClose: () => void;
  onUpgrade: (tag: string) => Promise<boolean>;
  onDelete: (deleteState: boolean) => Promise<boolean>;
}

export function PodActionDialogs(props: Props) {
  return (
    <>
      <UpgradeDialog
        pod={props.pod}
        visible={props.active === "upgrade"}
        onClose={props.onClose}
        onUpgrade={props.onUpgrade}
      />
      <DeleteDialog
        pod={props.pod}
        visible={props.active === "delete"}
        onClose={props.onClose}
        onDelete={props.onDelete}
      />
      <PodLogDialog
        podId={props.pod.podId}
        visible={props.active === "logs"}
        onClose={props.onClose}
      />
      <PodQrDialog
        podId={props.pod.podId}
        visible={props.active === "qr"}
        onClose={props.onClose}
      />
    </>
  );
}

function UpgradeDialog({
  pod,
  visible,
  onClose,
  onUpgrade,
}: {
  pod: Pod;
  visible: boolean;
  onClose: () => void;
  onUpgrade: (tag: string) => Promise<boolean>;
}) {
  const [imageTag, setImageTag] = useState(pod.imageTag);
  useEffect(() => {
    if (visible) setImageTag(pod.imageTag);
  }, [pod.imageTag, visible]);
  const { t } = useTranslation();
  const confirm = async () => {
    const tag = imageTag.trim();
    if (!tag) return;
    if (await onUpgrade(tag)) onClose();
  };
  return (
    <Modal
      title={t("pod.upgradeSingle", { podId: pod.podId })}
      visible={visible}
      onCancel={onClose}
      onOk={() => void confirm()}
      okText={t("pod.actionUpgrade")}
      okButtonProps={{ disabled: !imageTag.trim() }}
    >
      <Input aria-label={t("pod.upgradeImageTagAria")} value={imageTag} onChange={setImageTag} />
    </Modal>
  );
}

function DeleteDialog({
  pod,
  visible,
  onClose,
  onDelete,
}: {
  pod: Pod;
  visible: boolean;
  onClose: () => void;
  onDelete: (deleteState: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [deleteState, setDeleteState] = useState(false);
  const confirm = async () => {
    if (await onDelete(deleteState)) onClose();
  };
  return (
    <Modal
      title={t("pod.deleteTitle", { podId: pod.podId })}
      visible={visible}
      onCancel={onClose}
      onOk={() => void confirm()}
      okText={t("common.confirmDelete")}
      okButtonProps={{ type: "danger" as const }}
    >
      <div>{t("pod.deleteHint")}</div>
      <RadioGroup
        className={styles.dangerChoice}
        value={deleteState ? "delete" : "retain"}
        direction="vertical"
        options={[
          { value: "retain", label: t("pod.deleteRetainPvc") },
          { value: "delete", label: t("pod.deleteRemovePvc") },
        ]}
        onChange={(event) => setDeleteState(event.target.value === "delete")}
      />
    </Modal>
  );
}

export function PodLogDialog({
  podId,
  visible,
  onClose,
}: {
  podId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const state = usePodLogs(podId);
  useEffect(() => {
    if (visible) void state.load();
  }, [state.load, visible]);
  return (
    <Modal
      className="log-modal"
      title={t("pod.logTitle", { podId })}
      visible={visible}
      width="82vw"
      onCancel={onClose}
      footer={
        <>
          <Button onClick={() => void state.load()}>{t("common.refresh")}</Button>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </>
      }
    >
      <FeedbackBanner error={state.error} />
      <pre className="log-pre">{state.logs}</pre>
    </Modal>
  );
}

function usePodLogs(podId: string) {
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setError("");
    try {
      const result = await api.logs(podId, 300);
      if (mountedRef.current && requestId === requestRef.current) setLogs(result.logs);
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(errorMessage(caught, "pod.logLoadFailed"));
      }
    }
  }, [mountedRef, podId]);
  return { logs, error, load };
}

export function PodQrDialog({
  podId,
  visible,
  onClose,
}: {
  podId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const state = useQrCode(podId);
  useEffect(() => {
    if (visible) void state.load();
  }, [state.load, visible]);
  return (
    <Modal
      title={t("pod.qrTitle", { podId })}
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={() => void state.load()}>{t("common.refresh")}</Button>
          <Button onClick={() => void state.load(true)}>{t("pod.qrRescan")}</Button>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </>
      }
    >
      <div style={{ textAlign: "center" }}>
        {state.dataUrl ? (
          <img className="qr-img" src={state.dataUrl} alt={t("pod.qrAlt")} />
        ) : (
          <p>{state.message || t("common.loading")}</p>
        )}
      </div>
    </Modal>
  );
}

function useQrCode(podId: string) {
  const { t } = useTranslation();
  const [dataUrl, setDataUrl] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(
    async (force = false) => {
      const requestId = ++requestRef.current;
      setMessage("");
      setDataUrl("");
      try {
        const result = await api.qrcode(podId, force);
        if (!mountedRef.current || requestId !== requestRef.current) return;
        if (result.connected) setMessage(t("pod.qrConnected"));
        else if (result.loginUrl) {
          const generated = await QRCode.toDataURL(result.loginUrl, { margin: 1, width: 220 });
          if (mountedRef.current && requestId === requestRef.current) setDataUrl(generated);
        } else setMessage(t("pod.qrNotAvailable"));
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current) {
          setMessage(errorMessage(caught, "pod.qrFailed"));
        }
      }
    },
    [mountedRef, podId, t],
  );
  return { dataUrl, message, load };
}
