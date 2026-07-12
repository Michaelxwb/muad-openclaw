import { Banner, Button, Space, Tag } from "@douyinfe/semi-ui";
import { IconArrowLeft, IconRefresh } from "@douyinfe/semi-icons";
import type { Pod } from "../../api";
import styles from "../PodDetail.module.css";

export function DetailLoadFailure({
  error,
  onBack,
  onRetry,
}: {
  error: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div>
      <Banner type="danger" description={error || "Pod 不存在"} fullMode={false} bordered />
      <Space>
        <Button icon={<IconArrowLeft />} onClick={onBack}>
          返回
        </Button>
        <Button icon={<IconRefresh />} onClick={onRetry}>
          重试
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
  return (
    <div className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <Button aria-label="返回 Pod 列表" icon={<IconArrowLeft />} onClick={onBack} />
          <h2 className={styles.title}>{pod.displayName}</h2>
          <PodStateTag state={pod.state} />
        </div>
        <div className={styles.subtitle}>{pod.podId}</div>
      </div>
      <Button aria-label="刷新 Pod 详情" icon={<IconRefresh />} onClick={onRefresh} />
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
