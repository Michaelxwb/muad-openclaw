import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui";
import type { SkillExecution, SkillExecutionStatus } from "../../api";
import { renderTablePagination, tablePagination } from "../../components/Pagination";
import i18n from "../../i18n";
import type { SkillExecutionRecordsState } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  state: SkillExecutionRecordsState;
  onOpenPod?: (podId: string) => void;
  onView?: (executionId: string) => void;
}

export function SkillExecutionTable({ state, onOpenPod, onView }: Props) {
  const { t } = useTranslation();
  const columns = executionColumns(t, onOpenPod, onView);
  return (
    <Table
      columns={columns as never}
      dataSource={state.rows}
      empty={<Empty title={t("execution.empty")} />}
      loading={state.loading}
      pagination={tablePagination({
        page: state.page,
        pageSize: state.pageSize,
        total: state.total,
        onPageChange: state.setPage,
        onPageSizeChange: (size) => {
          state.setPageSize(size);
          state.setPage(1);
        },
      })}
      renderPagination={renderTablePagination}
      rowKey="executionId"
      scroll={{ x: 1480 }}
      size="small"
    />
  );
}

function executionColumns(
  t: TFunction,
  onOpenPod?: (podId: string) => void,
  onView?: (executionId: string) => void,
) {
  return [
    ...identityColumns(t),
    ...resourceColumns(onOpenPod),
    ...lifecycleColumns(t),
    ...outcomeColumns(t, onView),
  ];
}

function identityColumns(t: TFunction) {
  return [
    {
      title: t("audit.time"),
      width: 170,
      render: (_: unknown, row: SkillExecution) => new Date(row.startedAt).toLocaleString(),
    },
    {
      title: t("execution.userAgent"),
      width: 190,
      render: (_: unknown, row: SkillExecution) => (
        <TwoLine primary={row.humanUserId} secondary={row.agentId} />
      ),
    },
  ];
}

function resourceColumns(onOpenPod?: (podId: string) => void) {
  return [
    {
      title: "Pod",
      width: 130,
      render: (_: unknown, row: SkillExecution) =>
        onOpenPod ? (
          <Button theme="borderless" onClick={() => onOpenPod(row.podId)}>
            {row.podId}
          </Button>
        ) : (
          row.podId
        ),
    },
    {
      title: "Skill",
      width: 200,
      render: (_: unknown, row: SkillExecution) => (
        <div>
          <EllipsisText value={row.skillName} />
          <Tag size="small">{row.skillScope}</Tag>
        </div>
      ),
    },
  ];
}

function lifecycleColumns(t: TFunction) {
  return [
    {
      title: t("execution.entryType"),
      width: 120,
      render: (_: unknown, row: SkillExecution) => entryTypeLabel(row.entryType),
    },
    {
      title: t("common.status"),
      width: 100,
      render: (_: unknown, row: SkillExecution) => <ExecutionStatusTag status={row.status} />,
    },
    {
      title: t("execution.duration"),
      width: 90,
      render: (_: unknown, row: SkillExecution) => formatDuration(row.durationMs),
    },
    {
      title: t("execution.lastTool"),
      width: 150,
      render: (_: unknown, row: SkillExecution) => row.lastToolName || "-",
    },
  ];
}

function outcomeColumns(t: TFunction, onView?: (executionId: string) => void) {
  return [
    {
      title: t("audit.result"),
      width: 220,
      render: (_: unknown, row: SkillExecution) => <EllipsisText value={executionResult(row)} />,
    },
    {
      title: t("common.actions"),
      width: 90,
      fixed: "right",
      render: (_: unknown, row: SkillExecution) => (
        <Button
          aria-label={t("execution.viewDetail", { id: row.executionId })}
          disabled={!onView}
          onClick={() => onView?.(row.executionId)}
        >
          {t("common.viewDetail")}
        </Button>
      ),
    },
  ];
}

function TwoLine({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <div>
      <div className={styles.primary}>{primary || "-"}</div>
      <Typography.Text type="tertiary" className="mono">
        {secondary || "-"}
      </Typography.Text>
    </div>
  );
}

function EllipsisText({ value }: { value: string }) {
  const content = value || "-";
  return (
    <Tooltip content={content} position="topLeft">
      <span className={styles.ellipsis}>{content}</span>
    </Tooltip>
  );
}

function ExecutionStatusTag({ status }: { status: SkillExecutionStatus }) {
  const { t } = useTranslation();
  const values = {
    running: { label: t("status.running"), color: "blue" },
    succeeded: { label: t("status.succeeded"), color: "green" },
    failed: { label: t("status.failed"), color: "red" },
    cancelled: { label: t("execution.statusCancelled"), color: "grey" },
    rejected: { label: t("execution.statusRejected"), color: "orange" },
  } as const satisfies Record<SkillExecutionStatus, { label: string; color: string }>;
  return <Tag color={values[status].color}>{values[status].label}</Tag>;
}

function entryTypeLabel(value: SkillExecution["entryType"]): string {
  const labels = {
    managed: "Managed",
    "traditional-script": i18n.t("execution.entryTypeScript"),
    "traditional-prompt": i18n.t("execution.entryTypePrompt"),
  };
  return labels[value];
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function executionResult(row: SkillExecution): string {
  if (row.status === "failed" || row.status === "rejected")
    return (
      row.errorMessage || row.terminalReason || row.errorCode || i18n.t("execution.resultFailed")
    );
  return (
    row.outputSummary ||
    row.terminalReason ||
    (row.status === "running" ? i18n.t("status.inProgress") : "-")
  );
}
