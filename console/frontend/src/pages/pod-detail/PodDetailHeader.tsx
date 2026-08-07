import { Banner, Button, Space, Tag } from "@douyinfe/semi-ui";
import { IconArrowLeft, IconRefresh } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { Pod } from "../../api";
import { ErrorDetail } from "../../utils/error";
import styles from "../PodDetail.module.css";

export function DetailLoadFailure({
  error,
  detail,
  onBack,
  onRetry,
}: {
  error: string;
  detail?: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <Banner type="danger" description={error || t("pod.notFound")} fullMode={false} bordered />
      <ErrorDetail detail={detail} />
      <Space>
        <Button icon={<IconArrowLeft />} onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button icon={<IconRefresh />} onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </Space>
    </div>
  );
}

export function PodDetailHeader({
  pod,
  onBack,
  onRefresh,
}: {
  pod: Pod;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <Button aria-label={t("pod.backToListAria")} icon={<IconArrowLeft />} onClick={onBack} />
          <h2 className={styles.title}>{pod.displayName}</h2>
          <PodStateTag state={pod.state} />
        </div>
        <div className={styles.subtitle}>{pod.podId}</div>
      </div>
      <Button aria-label={t("pod.refreshDetailAria")} icon={<IconRefresh />} onClick={onRefresh} />
    </div>
  );
}

function PodStateTag({ state }: { state: Pod["state"] }) {
  const colors: Record<Pod["state"], "green" | "blue" | "red" | "orange" | "grey"> = {
    creating: "blue",
    running: "green",
    stopped: "grey",
    unhealthy: "orange",
    error: "red",
    deleting: "orange",
    missing: "grey",
  };
  return <Tag color={colors[state]}>{state}</Tag>;
}
