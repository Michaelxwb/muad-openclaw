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
import type { SkillExecutionDetail, SkillExecutionStatus } from "../../api";
import { parseSkillProgress, type SkillProgressItem } from "./skillProgress";
import { useSkillExecutionDetail } from "./useSkillExecutionDetail";
import styles from "./SkillExecutions.module.css";

interface Props {
  executionId: string | null;
  onClose: () => void;
}

export function SkillExecutionDetailModal({ executionId, onClose }: Props) {
  const state = useSkillExecutionDetail(executionId);
  return (
    <Modal
      className={`standard-modal ${styles.detailModal}`}
      title="Skill 执行详情"
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
  refresh,
}: ReturnType<typeof useSkillExecutionDetail>) {
  if (loading && !detail) return <Spin wrapperClassName={styles.detailLoading} />;
  if (error && !detail) {
    return (
      <div className={styles.detailError}>
        <Banner type="danger" description={error} fullMode={false} bordered closeIcon={null} />
        <Button aria-label="重新加载执行详情" onClick={() => void refresh()}>
          重新加载
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
  const data = [
    { key: "执行 ID", value: detail.executionId },
    { key: "状态", value: <StatusTag status={detail.status} /> },
    { key: "用户 ID", value: detail.humanUserId || "-" },
    { key: "Agent", value: detail.agentId || "-" },
    { key: "Pod", value: detail.podId || "-" },
    { key: "Skill", value: detail.skillName || "-" },
    { key: "范围", value: detail.skillScope || "-" },
    { key: "模式", value: entryTypeLabel(detail.entryType) },
    { key: "激活方式", value: activationModeLabel(detail.activationMode) },
    { key: "开始时间", value: formatTime(detail.startedAt) },
    { key: "结束时间", value: formatTime(detail.endedAt) },
    { key: "耗时", value: formatDuration(detail.durationMs) },
  ];
  return <Descriptions data={data} row size="small" column={2} />;
}

function ExecutionProgress({ detail }: { detail: SkillExecutionDetail }) {
  const progress = parseSkillProgress(detail.progressJson);
  return (
    <section className={styles.detailSection} aria-label="执行进度">
      <Typography.Title heading={6}>执行进度</Typography.Title>
      {progress.length === 0 ? (
        <Empty className={styles.progressEmpty} title="暂无进度明细" />
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
  const title = [item.stage, item.type].filter(Boolean).join(" · ") || "执行进度";
  return (
    <Timeline.Item time={formatTime(item.ts)}>
      <div className={styles.progressTitle}>{title}</div>
      <div className={styles.detailText}>{item.text || "-"}</div>
    </Timeline.Item>
  );
}

function ExecutionResult({ detail }: { detail: SkillExecutionDetail }) {
  const fields = [
    ["输入摘要", detail.inputSummary],
    ["输出摘要", detail.outputSummary],
    ["错误码", detail.errorCode],
    ["错误信息", detail.errorMessage],
    ["终态原因", detail.terminalReason],
  ] as const;
  return (
    <section className={styles.detailSection} aria-label="执行结果">
      <Typography.Title heading={6}>执行结果</Typography.Title>
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
  const values = {
    running: ["运行中", "blue"],
    succeeded: ["成功", "green"],
    failed: ["失败", "red"],
    cancelled: ["已取消", "grey"],
    rejected: ["已拒绝", "orange"],
  } as const satisfies Record<SkillExecutionStatus, readonly [string, string]>;
  return <Tag color={values[status][1]}>{values[status][0]}</Tag>;
}

function entryTypeLabel(value: SkillExecutionDetail["entryType"]): string {
  return { managed: "Managed", "traditional-script": "传统脚本", "traditional-prompt": "传统工具" }[
    value
  ];
}

function activationModeLabel(value: SkillExecutionDetail["activationMode"]): string {
  return { tool: "Tool 激活", "path-detected": "路径识别", runner: "Runner" }[value];
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
