import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Table, Tag, Typography } from "@douyinfe/semi-ui";
import type { SkillHealthItem } from "../../api";
import styles from "../Audit.module.css";

interface Props {
  items: SkillHealthItem[];
  loading: boolean;
  onDrilldown: (item: SkillHealthItem) => void;
}

export function SkillHealthTable({ items, loading, onDrilldown }: Props) {
  const { t } = useTranslation();
  const columns = useMemo(() => healthColumns(t, onDrilldown), [t, onDrilldown]);
  const rows = useMemo(() => sortSkillHealth(items), [items]);
  return (
    <Table
      columns={columns as never}
      dataSource={rows}
      empty={<Empty title={t("audit.health.empty")} />}
      loading={loading}
      pagination={false}
      rowKey={(row) => (row ? `${row.skillName}|${row.skillScope}|${row.humanUserId}` : "")}
      onRow={(row) =>
        row ? { onClick: () => onDrilldown(row), style: { cursor: "pointer" } } : {}
      }
      size="small"
    />
  );
}

export function sortSkillHealth(items: SkillHealthItem[]): SkillHealthItem[] {
  return [...items].sort((left, right) => {
    const severity = healthSeverity(right) - healthSeverity(left);
    if (severity !== 0) return severity;
    if (right.abortedCount !== left.abortedCount) return right.abortedCount - left.abortedCount;
    if (right.flaggedCount !== left.flaggedCount) return right.flaggedCount - left.flaggedCount;
    if (right.errorRate !== left.errorRate) return right.errorRate - left.errorRate;
    if (right.maxRequests !== left.maxRequests) return right.maxRequests - left.maxRequests;
    if (right.executions !== left.executions) return right.executions - left.executions;
    const skill = left.skillName.localeCompare(right.skillName);
    return skill !== 0 ? skill : left.humanUserId.localeCompare(right.humanUserId);
  });
}

function healthSeverity(item: SkillHealthItem): number {
  if (item.abortedCount > 0) return 3;
  if (item.flaggedCount > 0) return 2;
  if (item.errorRate > 0) return 1;
  return 0;
}

function healthColumns(t: TFunction, onDrilldown: (item: SkillHealthItem) => void) {
  return [
    {
      title: t("audit.health.user"),
      width: 200,
      render: (_: unknown, row: SkillHealthItem) => (
        <div>
          <div className={styles.primary}>{row.humanUserName || row.humanUserId}</div>
          <Typography.Text type="tertiary" className="mono">
            {row.humanUserId}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t("audit.health.skill"),
      flex: 2,
      render: (_: unknown, row: SkillHealthItem) => (
        <div>
          <div className={styles.primary}>{row.skillName}</div>
          <Tag size="small">{scopeLabel(t, row.skillScope)}</Tag>
        </div>
      ),
    },
    {
      title: t("audit.health.executions"),
      width: 90,
      render: (_: unknown, row: SkillHealthItem) => row.executions,
    },
    {
      title: t("audit.health.aborted"),
      width: 100,
      render: (_: unknown, row: SkillHealthItem) =>
        row.abortedCount > 0 ? (
          <Tag color="red" size="small">
            {row.abortedCount}
          </Tag>
        ) : (
          <span>0</span>
        ),
    },
    {
      title: t("audit.health.flagged"),
      width: 100,
      render: (_: unknown, row: SkillHealthItem) => row.flaggedCount,
    },
    {
      title: t("audit.health.maxRequests"),
      width: 120,
      render: (_: unknown, row: SkillHealthItem) => row.maxRequests,
    },
    {
      title: t("audit.health.errorRate"),
      width: 100,
      render: (_: unknown, row: SkillHealthItem) => formatRate(row.errorRate),
    },
    {
      title: t("audit.health.lastExecution"),
      width: 180,
      render: (_: unknown, row: SkillHealthItem) => formatTime(row.lastExecutionAt),
    },
    {
      title: t("common.actions"),
      width: 130,
      render: (_: unknown, row: SkillHealthItem) => (
        <Button
          size="small"
          theme="borderless"
          aria-label={`${t("audit.health.drilldown")} ${row.skillName} ${
            row.humanUserName || row.humanUserId
          }`}
          onClick={() => onDrilldown(row)}
        >
          {t("audit.health.drilldown")}
        </Button>
      ),
    },
  ];
}

function scopeLabel(t: TFunction, scope: SkillHealthItem["skillScope"]): string {
  if (scope === "private") return t("status.private");
  if (scope === "public") return t("status.public");
  return t("execution.scopeSystem");
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "-";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
