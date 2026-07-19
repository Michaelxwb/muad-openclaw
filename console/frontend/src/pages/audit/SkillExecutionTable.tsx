import { Button, Empty, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui";
import type { SkillExecution, SkillExecutionStatus } from "../../api";
import { renderTablePagination, tablePagination } from "../../components/Pagination";
import type { SkillExecutionRecordsState } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  state: SkillExecutionRecordsState;
  onOpenPod?: (podId: string) => void;
  onView?: (executionId: string) => void;
}

export function SkillExecutionTable({ state, onOpenPod, onView }: Props) {
  const columns = executionColumns(onOpenPod, onView);
  return (
    <Table
      columns={columns as never}
      dataSource={state.rows}
      empty={<Empty title="暂无 Skill 执行记录" />}
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
  onOpenPod?: (podId: string) => void,
  onView?: (executionId: string) => void,
) {
  return [
    ...identityColumns,
    ...resourceColumns(onOpenPod),
    ...lifecycleColumns,
    ...outcomeColumns(onView),
  ];
}

const identityColumns = [
  {
    title: "时间",
    width: 170,
    render: (_: unknown, row: SkillExecution) => new Date(row.startedAt).toLocaleString(),
  },
  {
    title: "用户 / Agent",
    width: 190,
    render: (_: unknown, row: SkillExecution) => (
      <TwoLine primary={row.humanUserId} secondary={row.agentId} />
    ),
  },
];

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

const lifecycleColumns = [
  {
    title: "模式",
    width: 120,
    render: (_: unknown, row: SkillExecution) => entryTypeLabel(row.entryType),
  },
  {
    title: "状态",
    width: 100,
    render: (_: unknown, row: SkillExecution) => <ExecutionStatusTag status={row.status} />,
  },
  {
    title: "耗时",
    width: 90,
    render: (_: unknown, row: SkillExecution) => formatDuration(row.durationMs),
  },
  {
    title: "最近工具",
    width: 150,
    render: (_: unknown, row: SkillExecution) => row.lastToolName || "-",
  },
];

function outcomeColumns(onView?: (executionId: string) => void) {
  return [
    {
      title: "结果",
      width: 220,
      render: (_: unknown, row: SkillExecution) => <EllipsisText value={executionResult(row)} />,
    },
    {
      title: "操作",
      width: 90,
      fixed: "right",
      render: (_: unknown, row: SkillExecution) => (
        <Button
          aria-label={`查看执行 ${row.executionId} 详情`}
          disabled={!onView}
          onClick={() => onView?.(row.executionId)}
        >
          详情
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
  const values = {
    running: { label: "运行中", color: "blue" },
    succeeded: { label: "成功", color: "green" },
    failed: { label: "失败", color: "red" },
    cancelled: { label: "已取消", color: "grey" },
    rejected: { label: "已拒绝", color: "orange" },
  } as const satisfies Record<SkillExecutionStatus, { label: string; color: string }>;
  return <Tag color={values[status].color}>{values[status].label}</Tag>;
}

function entryTypeLabel(value: SkillExecution["entryType"]): string {
  const labels = {
    managed: "Managed",
    "traditional-script": "传统脚本",
    "traditional-prompt": "传统工具",
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
    return row.errorMessage || row.terminalReason || row.errorCode || "执行失败";
  return row.outputSummary || row.terminalReason || (row.status === "running" ? "执行中" : "-");
}
