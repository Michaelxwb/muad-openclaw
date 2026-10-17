import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui";
import type { SkillExecution } from "../../api";
import { PodName } from "../../components/PodName";
import { renderTablePagination, tablePagination } from "../../components/Pagination";
import type { SkillExecutionRecordsState } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  state: SkillExecutionRecordsState;
  userNames: ReadonlyMap<string, string>;
  podNames: ReadonlyMap<string, string>;
  onOpenPod?: (podId: string) => void;
  onOpenTrace?: (executionId: string) => void;
}

export function SkillExecutionTable({ state, userNames, podNames, onOpenPod, onOpenTrace }: Props) {
  const { t } = useTranslation();
  const columns = executionColumns(t, userNames, podNames, onOpenPod, onOpenTrace);
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
      onRow={(row) =>
        row && onOpenTrace
          ? { onClick: () => onOpenTrace(row.executionId), style: { cursor: "pointer" } }
          : {}
      }
      size="small"
    />
  );
}

function executionColumns(
  t: TFunction,
  userNames: ReadonlyMap<string, string>,
  podNames: ReadonlyMap<string, string>,
  onOpenPod?: (podId: string) => void,
  onOpenTrace?: (executionId: string) => void,
) {
  return [
    {
      title: t("execution.user"),
      flex: 2,
      render: (_: unknown, row: SkillExecution) => {
        const name = userNames.get(row.humanUserId) || row.humanUserId;
        const secondary = userNames.has(row.humanUserId) ? row.humanUserId : "";
        return <TwoLine primary={name} secondary={secondary} />;
      },
    },
    {
      title: t("execution.agent"),
      flex: 1,
      render: (_: unknown, row: SkillExecution) => (
        <Typography.Text className="mono">{row.agentId || "-"}</Typography.Text>
      ),
    },
    {
      title: t("execution.pod"),
      width: 200,
      render: (_: unknown, row: SkillExecution) =>
        onOpenPod ? (
          <Button
            className={styles.linkButton}
            theme="borderless"
            size="small"
            onClick={() => onOpenPod(row.podId)}
          >
            <PodName podId={row.podId} podNames={podNames} />
          </Button>
        ) : (
          <PodName podId={row.podId} podNames={podNames} />
        ),
    },
    {
      title: t("execution.skill"),
      flex: 1,
      render: (_: unknown, row: SkillExecution) => (
        <div>
          <EllipsisText value={row.skillName} />
          <Tag size="small">{row.skillScope}</Tag>
        </div>
      ),
    },
    {
      title: t("audit.time"),
      width: 180,
      render: (_: unknown, row: SkillExecution) => new Date(row.startedAt).toLocaleString(),
    },
    ...(onOpenTrace
      ? [
          {
            title: t("common.actions"),
            width: 130,
            render: (_: unknown, row: SkillExecution) => (
              <Button
                className={styles.linkButton}
                theme="borderless"
                size="small"
                aria-label={`${t("audit.trace.open")} ${row.executionId}`}
                onClick={() => onOpenTrace(row.executionId)}
              >
                {t("audit.trace.open")}
              </Button>
            ),
          },
        ]
      : []),
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
