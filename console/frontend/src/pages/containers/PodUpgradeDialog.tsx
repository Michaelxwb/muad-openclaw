import { useEffect, useState } from "react";
import { Input, Modal, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import styles from "../Containers.module.css";

interface Props {
  podIds: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
}

export function PodUpgradeDialog({ podIds, onClose, onDone }: Props) {
  const [imageTag, setImageTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (podIds.length > 0) {
      setImageTag("");
      setError("");
    }
  }, [podIds]);
  const submit = async () => {
    const tag = imageTag.trim();
    if (!tag || podIds.length === 0) return;
    setBusy(true);
    setError("");
    const results = await Promise.allSettled(podIds.map((podId) => api.upgrade(podId, tag)));
    const failed = results.filter((result) => result.status === "rejected").length;
    setBusy(false);
    if (failed > 0) return setError(`升级完成：${podIds.length - failed} 成功，${failed} 失败`);
    Toast.success(`已升级 ${podIds.length} 个 Pod`);
    onClose();
    await onDone();
  };
  return (
    <Modal
      title={podIds.length === 1 ? `升级 Pod ${podIds[0]}` : `批量升级 ${podIds.length} 个 Pod`}
      visible={podIds.length > 0}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="确认升级"
      confirmLoading={busy}
      okButtonProps={{ disabled: !imageTag.trim() }}
      width={420}
    >
      <FeedbackBanner error={error} />
      <label className={styles.field}>
        <span>镜像 tag</span>
        <Input
          aria-label="升级镜像 tag"
          value={imageTag}
          onChange={setImageTag}
          placeholder="muad-openclaw:local"
        />
      </label>
    </Modal>
  );
}
