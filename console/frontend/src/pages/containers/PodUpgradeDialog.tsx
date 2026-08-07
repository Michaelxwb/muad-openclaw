import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
    if (failed > 0)
      return setError(t("pod.upgradePartial", { succeeded: podIds.length - failed, failed }));
    Toast.success(t("pod.upgraded", { count: podIds.length }));
    onClose();
    await onDone();
  };
  return (
    <Modal
      title={
        podIds.length === 1
          ? t("pod.upgradeSingle", { podId: podIds[0] })
          : t("pod.upgradeBatch", { count: podIds.length })
      }
      visible={podIds.length > 0}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={t("pod.upgradeConfirm")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !imageTag.trim() }}
      width={420}
    >
      <FeedbackBanner error={error} />
      <label className={styles.field}>
        <span>{t("pod.imageTag")}</span>
        <Input
          aria-label={t("pod.upgradeImageTagAria")}
          value={imageTag}
          onChange={setImageTag}
          placeholder="muad-openclaw:local"
        />
      </label>
    </Modal>
  );
}
