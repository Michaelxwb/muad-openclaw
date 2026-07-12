import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Modal, RadioGroup } from "@douyinfe/semi-ui";
import QRCode from "qrcode";
import { api } from "../../api";
import type { Pod } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
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
  const confirm = async () => {
    if (imageTag.trim() && (await onUpgrade(imageTag.trim()))) onClose();
  };
  return (
    <Modal
      title={`升级 ${pod.podId}`}
      visible={visible}
      onCancel={onClose}
      onOk={() => void confirm()}
      okText="升级"
    >
      <Input aria-label="升级镜像 tag" value={imageTag} onChange={setImageTag} />
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
  const [deleteState, setDeleteState] = useState(false);
  const confirm = async () => {
    if (await onDelete(deleteState)) onClose();
  };
  return (
    <Modal
      title={`删除 ${pod.podId}`}
      visible={visible}
      onCancel={onClose}
      onOk={() => void confirm()}
      okText="确认删除"
      okButtonProps={{ type: "danger" as const }}
    >
      <div>删除后 Pod、Human User 和 Identity 控制面记录将被移除。</div>
      <RadioGroup
        className={styles.dangerChoice}
        value={deleteState ? "delete" : "retain"}
        direction="vertical"
        options={[
          { value: "retain", label: "保留 PVC，运行时状态可供后续显式接管" },
          { value: "delete", label: "删除 PVC，workspace、记忆、会话和 private Skill 将永久丢失" },
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
  const state = usePodLogs(podId);
  useEffect(() => {
    if (visible) void state.load();
  }, [state.load, visible]);
  return (
    <Modal
      className="log-modal"
      title={`${podId} 日志`}
      visible={visible}
      width="82vw"
      onCancel={onClose}
      footer={
        <>
          <Button onClick={() => void state.load()}>刷新</Button>
          <Button onClick={onClose}>关闭</Button>
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
        setError(caught instanceof Error ? caught.message : "加载日志失败");
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
  const state = useQrCode(podId);
  useEffect(() => {
    if (visible) void state.load();
  }, [state.load, visible]);
  return (
    <Modal
      title={`${podId} 微信登录`}
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={() => void state.load()}>刷新</Button>
          <Button onClick={() => void state.load(true)}>重新扫码</Button>
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      <div style={{ textAlign: "center" }}>
        {state.dataUrl ? (
          <img className="qr-img" src={state.dataUrl} alt="微信登录二维码" />
        ) : (
          <p>{state.message || "加载中..."}</p>
        )}
      </div>
    </Modal>
  );
}

function useQrCode(podId: string) {
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
        if (result.connected) setMessage("微信已登录");
        else if (result.loginUrl) {
          const generated = await QRCode.toDataURL(result.loginUrl, { margin: 1, width: 220 });
          if (mountedRef.current && requestId === requestRef.current) setDataUrl(generated);
        } else setMessage("未获取到二维码");
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current) {
          setMessage(caught instanceof Error ? caught.message : "获取二维码失败");
        }
      }
    },
    [mountedRef, podId],
  );
  return { dataUrl, message, load };
}
