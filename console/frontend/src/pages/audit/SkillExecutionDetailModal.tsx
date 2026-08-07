import {
  Banner,
  Button,
  Descriptions,
  Empty,
  Modal,
  Spin,
  Tag,
  Timeline,
  Typography,
} from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import type { SkillExecutionDetail, SkillExecutionStatus } from "../../api";
import i18n from "../../i18n";
import { ErrorDetail } from "../../utils/error";
import { parseSkillProgress, type SkillProgressItem } from "./skillProgress";
import { useSkillExecutionDetail } from "./useSkillExecutionDetail";
import styles from "./SkillExecutions.module.css";

interface Props {
  executionId: string | null;
  onClose: () => void;
}

export function SkillExecutionDetailModal({ executionId, onClose }: Props) {
  const { t } = useTranslation();
  const state = useSkillExecutionDetail(executionId);
  return (
    <Modal
      className={`standard-modal ${styles.detailModal}`}
      title={t("execution.detailTitle")}
      visible={executionId !== null}
      onCancel={onClose}
      footer={null}
      width={760}
    >
      <DetailBody {...state} />
    </Modal>
  );
}

function DetailBody({
  detail,
  loading,
  error,
  errorDetail,
  refresh,
}: ReturnType<typeof useSkillExecutionDetail>) {
  const { t } = useTranslation();
  if (loading && !detail) return <Spin wrapperClassName={styles.detailLoading} />;
  if (error && !detail) {
    return (
      <div className={styles.detailError}>
        <Banner type="danger" description={error} fullMode={false} bordered closeIcon={null} />
        <ErrorDetail detail={errorDetail} />
        <Button aria-label={t("execution.reloadDetail")} onClick={() => void refresh()}>
          {t("execution.reload")}
        </Button>
      </div>
    );
  }
  return detail ? <DetailContent detail={detail} /> : null;
}

function DetailContent({ detail }: { detail: SkillExecutionDetail }) {
  return (
    <div className={styles.detailContent}>
      <ExecutionOverview detail={detail} />
      <ExecutionProgress detail={detail} />
      <ExecutionResult detail={detail} />
    </div>
  );
}

function ExecutionOverview({ detail }: { detail: SkillExecutionDetail }) {
  const { t } = useTranslation();
  const data = [
    { key: t("execution.id"), value: detail.executionId },
    { key: t("common.status"), value: <StatusTag status={detail.status} /> },
    { key: t("execution.userId"), value: detail.humanUserId || "-" },
    { key: "Agent", value: detail.agentId || "-" },
    { key: "Pod", value: detail.podId || "-" },
    { key: "Skill", value: detail.skillName || "-" },
    { key: t("execution.scope"), value: detail.skillScope || "-" },
    { key: t("execution.entryType"), value: entryTypeLabel(detail.entryType) },
    { key: t("execution.activationMode"), value: activationModeLabel(detail.activationMode) },
    { key: t("execution.startedAt"), value: formatTime(detail.startedAt) },
    { key: t("execution.endedAt"), value: formatTime(detail.endedAt) },
    { key: t("execution.duration"), value: formatDuration(detail.durationMs) },
  ];
  return <Descriptions data={data} row size="small" column={2} />;
}

function ExecutionProgress({ detail }: { detail: SkillExecutionDetail }) {
  const { t } = useTranslation();
  const progress = parseSkillProgress(detail.progressJson);
  return (
    <section className={styles.detailSection} aria-label={t("execution.progressTitle")}>
      <Typography.Title heading={6}>{t("execution.progressTitle")}</Typography.Title>
      {progress.length === 0 ? (
        <Empty className={styles.progressEmpty} title={t("execution.noProgress")} />
      ) : (
        <Timeline>
          {progress.map((item) => (
            <ProgressItem key={item.key} item={item} />
          ))}
        </Timeline>
      )}
    </section>
  );
}

function ProgressItem({ item }: { item: SkillProgressItem }) {
  const { t } = useTranslation();
  const title = [item.stage, item.type].filter(Boolean).join(" · ") || t("execution.progressTitle");
  return (
    <Timeline.Item time={formatTime(item.ts)}>
      <div className={styles.progressTitle}>{title}</div>
      <div className={styles.detailText}>{item.text || "-"}</div>
    </Timeline.Item>
  );
}

function ExecutionResult({ detail }: { detail: SkillExecutionDetail }) {
  const { t } = useTranslation();
  const fields = [
    [t("execution.inputSummary"), detail.inputSummary],
    [t("execution.outputSummary"), detail.outputSummary],
    [t("execution.errorCode"), detail.errorCode],
    [t("execution.errorMessage"), detail.errorMessage],
    [t("execution.terminalReason"), detail.terminalReason],
  ] as const;
  return (
    <section className={styles.detailSection} aria-label={t("execution.resultTitle")}>
      <Typography.Title heading={6}>{t("execution.resultTitle")}</Typography.Title>
      <div className={styles.resultGrid}>
        {fields.map(([label, value]) => (
          <ResultField key={label} label={label} value={value} />
        ))}
      </div>
    </section>
  );
}

function ResultField({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <Typography.Text type="tertiary">{label}</Typography.Text>
      <div className={styles.resultText}>{value || "-"}</div>
    </div>
  );
}

function StatusTag({ status }: { status: SkillExecutionStatus }) {
  const { t } = useTranslation();
  const values = {
    running: [t("status.running"), "blue"],
    succeeded: [t("status.succeeded"), "green"],
    failed: [t("status.failed"), "red"],
    cancelled: [t("execution.statusCancelled"), "grey"],
    rejected: [t("execution.statusRejected"), "orange"],
  } as const satisfies Record<SkillExecutionStatus, readonly [string, string]>;
  return <Tag color={values[status][1]}>{values[status][0]}</Tag>;
}

function entryTypeLabel(value: SkillExecutionDetail["entryType"]): string {
  return {
    managed: "Managed",
    "traditional-script": i18n.t("execution.entryTypeScript"),
    "traditional-prompt": i18n.t("execution.entryTypePrompt"),
  }[value];
}

function activationModeLabel(value: SkillExecutionDetail["activationMode"]): string {
  return {
    tool: i18n.t("execution.activationTool"),
    "path-detected": i18n.t("execution.activationPath"),
    runner: "Runner",
  }[value];
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function formatTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
