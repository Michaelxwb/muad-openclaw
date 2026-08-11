import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Input, Select, Space, Table, Tag, Tooltip } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import type { BasicSelectValue } from "@douyinfe/semi-ui/lib/es/select";
import { api } from "../api";
import type {
  LongTask,
  LongTaskPool as ApiLongTaskPool,
  LongTaskQuery,
  LongTaskStatus,
} from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { errorMessage } from "../utils/error";
import styles from "./LongTasks.module.css";

const REFRESH_MS = 5000;

interface Props {
  onOpenPod?: (podId: string) => void;
}

interface Filters {
  q: string;
  status: LongTaskStatus | "";
}

interface LongTaskRow extends LongTask {
  effectivePoolQueued: number;
  effectivePoolRunning: number;
  effectivePoolLimit: number;
}

const EMPTY_FILTERS: Filters = { q: "", status: "" };

export function LongTasks({ onOpenPod }: Props) {
  const { t } = useTranslation();
  const state = useLongTasks();
  return (
    <div>
      <PageHeader title={t("nav.longTasks")} description={t("longTasks.pageDescription")} />
      <FeedbackBanner error={state.error} />
      <PageSection>
        <LongTaskToolbar state={state} />
        <LongTaskTable state={state} onOpenPod={onOpenPod} />
      </PageSection>
    </div>
  );
}

function useLongTasks() {
  const [rows, setRows] = useState<LongTask[]>([]);
  const [pools, setPools] = useState<ApiLongTaskPool[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const dataRequestRef = useRef(0);
  const foregroundRequestRef = useRef(0);
  const refresh = useCallback(
    async (background = false) => {
      const dataRequestId = ++dataRequestRef.current;
      const foregroundRequestId = background ? 0 : ++foregroundRequestRef.current;
      if (!background) setLoading(true);
      setError("");
      try {
        const result = await api.listLongTasks(longTaskQuery(filters, page, pageSize));
        if (!mountedRef.current || dataRequestId !== dataRequestRef.current) return;
        setRows(result.items);
        setPools(result.pools ?? []);
        setTotal(result.total);
      } catch (caught) {
        if (mountedRef.current && dataRequestId === dataRequestRef.current)
          setError(errorMessage(caught, "longTasks.loadFailed"));
      } finally {
        if (
          !background &&
          mountedRef.current &&
          foregroundRequestId === foregroundRequestRef.current
        )
          setLoading(false);
      }
    },
    [filters, mountedRef, page, pageSize],
  );
  useEffect(() => void refresh(), [refresh]);
  const hasActive = pools.some((pool) => pool.poolQueued > 0 || pool.poolRunning > 0);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void refresh(true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);
  const search = () => {
    setPage(1);
    setFilters({ ...draftFilters, q: draftFilters.q.trim() });
  };
  const reset = () => {
    setPage(1);
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  return {
    rows,
    pools,
    total,
    page,
    pageSize,
    loading,
    error,
    draftFilters,
    setDraftFilters,
    setPage,
    setPageSize,
    search,
    reset,
    refresh,
  };
}

function longTaskQuery(filters: Filters, page: number, pageSize: number): LongTaskQuery {
  const query: LongTaskQuery = { page, pageSize };
  if (filters.q) query.q = filters.q;
  if (filters.status) query.status = filters.status;
  return query;
}

type LongTaskState = ReturnType<typeof useLongTasks>;

function LongTaskToolbar({ state }: { state: LongTaskState }) {
  const { t } = useTranslation();
  const statusOptions = useMemo(
    () => [
      { label: t("longTasks.statusAll"), value: "" },
      { label: t("status.queued"), value: "queued" },
      { label: t("status.running"), value: "running" },
      { label: t("status.succeeded"), value: "succeeded" },
      { label: t("status.failed"), value: "failed" },
    ],
    [t],
  );
  const filterStatus = (value: BasicSelectValue | undefined | BasicSelectValue[]) => {
    const next = String(Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
    state.setDraftFilters({
      ...state.draftFilters,
      status: next as LongTaskStatus | "",
    });
  };
  return (
    <ListToolbar
      filters={
        <Space className={styles.filterGroup} spacing={8}>
          <Input
            className={styles.queryInput}
            aria-label={t("longTasks.query")}
            prefix={<IconSearch />}
            placeholder={t("longTasks.searchPlaceholder")}
            value={state.draftFilters.q}
            onChange={(q) => state.setDraftFilters({ ...state.draftFilters, q })}
            onEnterPress={state.search}
          />
          <Tooltip content={t("common.search")}>
            <Button aria-label={t("common.search")} icon={<IconSearch />} onClick={state.search} />
          </Tooltip>
          <Select
            className={styles.statusSelect}
            aria-label={t("longTasks.statusFilter")}
            value={state.draftFilters.status}
            optionList={statusOptions}
            onChange={filterStatus}
          />
          <Button onClick={state.reset}>{t("common.all")}</Button>
          <Tooltip content={t("common.refresh")}>
            <Button
              aria-label={t("common.refresh")}
              disabled={state.loading}
              icon={<IconRefresh />}
              loading={state.loading}
              onClick={() => void state.refresh()}
            />
          </Tooltip>
        </Space>
      }
    />
  );
}

function LongTaskTable({
  state,
  onOpenPod,
}: {
  state: LongTaskState;
  onOpenPod?: (podId: string) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => mergePoolCounts(state.rows, state.pools), [state.pools, state.rows]);
  const columns = useMemo(() => longTaskColumns(t, onOpenPod), [onOpenPod, t]);
  return (
    <Table
      columns={columns as never}
      dataSource={rows}
      empty={<Empty title={t("longTasks.empty")} />}
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
      rowKey="taskId"
      scroll={{ x: 1464 }}
      size="small"
    />
  );
}

function longTaskColumns(t: TFunction, onOpenPod?: (podId: string) => void) {
  return [
    {
      title: t("longTasks.task"),
      key: "task",
      align: "left" as const,
      width: 230,
      render: (_: unknown, task: LongTaskRow) => (
        <div className={styles.taskCell}>
          <span className={`${styles.primary} ${styles.mono}`}>{task.taskId}</span>
          <span className={styles.subtle}>{task.peerId || "-"}</span>
        </div>
      ),
    },
    {
      title: t("longTasks.agentPool"),
      key: "pool",
      align: "left" as const,
      width: 260,
      render: (_: unknown, task: LongTaskRow) => (
        <div className={styles.taskCell}>
          <span className={`${styles.primary} ${styles.mono}`}>{task.poolKey}</span>
          <span className={styles.subtle} aria-label={poolMetricsLabel(t, task)}>
            {poolMetricsText(t, task)}
          </span>
        </div>
      ),
    },
    {
      title: t("longTasks.podUser"),
      key: "podUser",
      align: "left" as const,
      width: 210,
      render: (_: unknown, task: LongTaskRow) => (
        <div className={styles.taskCell}>
          {onOpenPod ? (
            <Button
              className={styles.linkButton}
              theme="borderless"
              size="small"
              onClick={() => onOpenPod(task.podId)}
            >
              {task.podId}
            </Button>
          ) : (
            <span className={styles.mono}>{task.podId}</span>
          )}
          <span className={styles.primary}>{task.agentId}</span>
          <span className={`${styles.subtle} ${styles.mono}`}>{task.humanUserId || "-"}</span>
        </div>
      ),
    },
    {
      title: t("longTasks.skill"),
      key: "skill",
      align: "left" as const,
      width: 240,
      render: (_: unknown, task: LongTaskRow) => (
        <div className={styles.taskCell}>
          <span className={`${styles.primary} ${styles.skillName}`}>{task.skillName}</span>
          <span className={`${styles.subtle} ${styles.mono}`}>{task.skillRoot || "-"}</span>
        </div>
      ),
    },
    {
      title: t("common.status"),
      key: "status",
      align: "left" as const,
      width: 70,
      render: (_: unknown, task: LongTaskRow) => <LongTaskStatusTag status={task.status} />,
    },
    {
      title: t("longTasks.submittedAt"),
      key: "submittedAt",
      align: "left" as const,
      width: 108,
      render: (_: unknown, task: LongTaskRow) => <TimeCell value={task.submittedAt} />,
    },
    {
      title: t("longTasks.startedAt"),
      key: "startedAt",
      align: "left" as const,
      width: 108,
      render: (_: unknown, task: LongTaskRow) => <TimeCell value={task.startedAt} />,
    },
    {
      title: t("longTasks.endedAt"),
      key: "endedAt",
      align: "left" as const,
      width: 108,
      render: (_: unknown, task: LongTaskRow) => <TimeCell value={task.endedAt} />,
    },
    {
      title: t("longTasks.terminal"),
      key: "terminal",
      align: "left" as const,
      width: 130,
      render: (_: unknown, task: LongTaskRow) => task.terminalReason || task.errorCode || "-",
    },
  ];
}

function mergePoolCounts(rows: LongTask[], pools: ApiLongTaskPool[]): LongTaskRow[] {
  const byPool = new Map(pools.map((pool) => [pool.poolKey, pool]));
  return rows.map((row) => {
    const pool = byPool.get(row.poolKey);
    return {
      ...row,
      effectivePoolQueued: pool?.poolQueued ?? row.poolQueued,
      effectivePoolRunning: pool?.poolRunning ?? row.poolRunning,
      effectivePoolLimit: pool?.poolLimit ?? row.poolLimit,
    };
  });
}

function poolMetricsText(t: TFunction, task: LongTaskRow) {
  return [
    `${t("longTasks.queued")} ${task.effectivePoolQueued}`,
    `${t("longTasks.running")} ${task.effectivePoolRunning}`,
    `${t("longTasks.limit")} ${task.effectivePoolLimit || "-"}`,
  ].join(" / ");
}

function poolMetricsLabel(t: TFunction, task: LongTaskRow) {
  return [
    `${t("longTasks.queued")}: ${task.effectivePoolQueued}`,
    `${t("longTasks.running")}: ${task.effectivePoolRunning}`,
    `${t("longTasks.limit")}: ${task.effectivePoolLimit || "-"}`,
  ].join("; ");
}

function LongTaskStatusTag({ status }: { status: LongTaskStatus }) {
  const { t } = useTranslation();
  const color =
    status === "succeeded"
      ? "green"
      : status === "failed"
        ? "red"
        : status === "running"
          ? "blue"
          : "orange";
  return <Tag color={color}>{t(`status.${status}`)}</Tag>;
}

function TimeCell({ value }: { value?: string }) {
  const formatted = formatTime(value);
  if (typeof formatted === "string") return <span>{formatted}</span>;
  return (
    <span className={styles.timeCell}>
      <span className={styles.timeDate}>{formatted.date}</span>
      <span className={styles.timeClock}>{formatted.time}</span>
    </span>
  );
}

function formatTime(value?: string): { date: string; time: string } | string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return {
    date: `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    time: [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":"),
  };
}
