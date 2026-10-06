import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, Input, Modal, Toast } from "@douyinfe/semi-ui";
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
  const [crossVersion, setCrossVersion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (podIds.length > 0) {
      setImageTag("");
      setCrossVersion(false);
      setError("");
    }
  }, [podIds]);
  const submit = async () => {
    const tag = imageTag.trim();
    if (!tag || podIds.length === 0) return;
    setBusy(true);
    setError("");
    // 跨版本迁移显式关闭自动回滚（allowRollback=false，失败停在 error）；
    // 默认不传该字段，保持既有自动回滚语义。
    const allowRollback = crossVersion ? false : undefined;
    const results = await Promise.allSettled(
      podIds.map((podId) => api.upgrade(podId, tag, allowRollback)),
    );
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
      <div className={styles.upgradeOptions}>
        <Checkbox
          aria-label={t("pod.upgradeCrossVersion")}
          checked={crossVersion}
          onChange={(event) => setCrossVersion((event.target as HTMLInputElement).checked)}
        >
          {t("pod.upgradeCrossVersion")}
        </Checkbox>
        {crossVersion && (
          <div className={styles.upgradeWarning}>{t("pod.upgradeCrossVersionHint")}</div>
        )}
      </div>
    </Modal>
  );
}
