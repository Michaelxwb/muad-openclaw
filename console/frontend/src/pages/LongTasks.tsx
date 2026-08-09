import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Input, Select, Skeleton, Space, Table, Tag } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
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

interface LongTaskPoolView {
  poolKey: string;
  podId: string;
  humanUserId: string;
  agentId: string;
  peerId: string;
  queued: number;
  running: number;
  limit: number;
  tasks: LongTask[];
}

interface MutableLongTaskPoolView extends LongTaskPoolView {
  fromSummary: boolean;
  rowQueued: number;
  rowRunning: number;
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
        <LongTaskPools state={state} onOpenPod={onOpenPod} />
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
    setFilters({ ...draftFilters });
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
  return (
    <ListToolbar
      filters={
        <Space className={styles.filters} spacing={8} wrap>
          <Input
            className={styles.queryInput}
            aria-label={t("longTasks.query")}
            placeholder={t("longTasks.searchPlaceholder")}
            value={state.draftFilters.q}
            onChange={(q) => state.setDraftFilters({ ...state.draftFilters, q })}
            onEnterPress={state.search}
          />
          <Select
            aria-label={t("longTasks.statusFilter")}
            value={state.draftFilters.status}
            optionList={statusOptions}
            onChange={(value) =>
              state.setDraftFilters({
                ...state.draftFilters,
                status: String(value ?? "") as LongTaskStatus | "",
              })
            }
            style={{ width: 160 }}
          />
          <Button
            aria-label={t("common.search")}
            icon={<IconSearch />}
            theme="solid"
            onClick={state.search}
          >
            {t("common.search")}
          </Button>
          <Button onClick={state.reset}>{t("common.all")}</Button>
          <Button
            aria-label={t("common.refresh")}
            disabled={state.loading}
            icon={<IconRefresh />}
            loading={state.loading}
            onClick={() => void state.refresh()}
          >
            {t("common.refresh")}
          </Button>
        </Space>
      }
    />
  );
}

function LongTaskPools({
  state,
  onOpenPod,
}: {
  state: LongTaskState;
  onOpenPod?: (podId: string) => void;
}) {
  const { t } = useTranslation();
  const pools = useMemo(() => groupLongTasks(state.pools, state.rows), [state.pools, state.rows]);
  const columns = useMemo(() => longTaskColumns(t, onOpenPod), [onOpenPod, t]);
  const pagination = tablePagination({
    page: state.page,
    pageSize: state.pageSize,
    total: state.total,
    onPageChange: state.setPage,
    onPageSizeChange: (size) => {
      state.setPageSize(size);
      state.setPage(1);
    },
  });
  return (
    <Skeleton
      placeholder={state.loading ? <Skeleton.Paragraph rows={5} /> : undefined}
      loading={state.loading}
    >
      {pools.length === 0 ? (
        <Empty title={t("longTasks.empty")} />
      ) : (
        <div className={styles.poolList}>
          {pools.map((pool) => (
            <section className={styles.poolPanel} key={pool.poolKey}>
              <PoolHeader pool={pool} />
              <Table
                columns={columns as never}
                dataSource={pool.tasks}
                pagination={false}
                rowKey="taskId"
                size="small"
              />
            </section>
          ))}
          {pagination && renderTablePagination(pagination)}
        </div>
      )}
    </Skeleton>
  );
}

function PoolHeader({ pool }: { pool: LongTaskPoolView }) {
  const { t } = useTranslation();
  return (
    <div className={styles.poolHeader}>
      <div className={styles.poolIdentity}>
        <span className={`${styles.poolTitle} ${styles.mono}`}>
          {t("longTasks.pool")} {pool.poolKey}
        </span>
        <span className={styles.poolMeta}>
          {pool.agentId} / {pool.humanUserId || "-"} / {pool.peerId}
        </span>
      </div>
      <div className={styles.poolStats}>
        <PoolStat label={t("longTasks.queued")} value={pool.queued} tone="queued" />
        <PoolStat label={t("longTasks.running")} value={pool.running} tone="running" />
        <PoolStat label={t("longTasks.limit")} value={pool.limit || "-"} tone="limit" />
      </div>
    </div>
  );
}

function PoolStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "queued" | "running" | "limit";
}) {
  return (
    <div className={`${styles.poolStat} ${styles[tone]}`} aria-label={`${label}: ${value}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function longTaskColumns(t: TFunction, onOpenPod?: (podId: string) => void) {
  return [
    {
      title: t("longTasks.task"),
      key: "task",
      width: 260,
      render: (_: unknown, task: LongTask) => (
        <div className={styles.taskCell}>
          <span className={`${styles.primary} ${styles.mono}`}>{task.taskId}</span>
          <span className={styles.subtle}>{task.poolKey}</span>
        </div>
      ),
    },
    {
      title: "Pod",
      key: "podId",
      width: 150,
      render: (_: unknown, task: LongTask) =>
        onOpenPod ? (
          <Button theme="borderless" size="small" onClick={() => onOpenPod(task.podId)}>
            {task.podId}
          </Button>
        ) : (
          <span className={styles.mono}>{task.podId}</span>
        ),
    },
    {
      title: t("longTasks.user"),
      key: "user",
      width: 220,
      render: (_: unknown, task: LongTask) => (
        <div className={styles.taskCell}>
          <span className={styles.primary}>{task.agentId}</span>
          <span className={`${styles.subtle} ${styles.mono}`}>{task.humanUserId || "-"}</span>
        </div>
      ),
    },
    {
      title: t("longTasks.skill"),
      key: "skill",
      width: 180,
      render: (_: unknown, task: LongTask) => (
        <div className={styles.taskCell}>
          <span className={styles.primary}>{task.skillName}</span>
          <span className={`${styles.subtle} ${styles.mono}`}>{task.skillRoot || "-"}</span>
        </div>
      ),
    },
    {
      title: t("common.status"),
      key: "status",
      width: 120,
      render: (_: unknown, task: LongTask) => <LongTaskStatusTag status={task.status} />,
    },
    {
      title: t("longTasks.submittedAt"),
      key: "submittedAt",
      width: 170,
      render: (_: unknown, task: LongTask) => formatTime(task.submittedAt),
    },
    {
      title: t("longTasks.startedAt"),
      key: "startedAt",
      width: 170,
      render: (_: unknown, task: LongTask) => formatTime(task.startedAt),
    },
    {
      title: t("longTasks.endedAt"),
      key: "endedAt",
      width: 170,
      render: (_: unknown, task: LongTask) => formatTime(task.endedAt),
    },
    {
      title: t("longTasks.terminal"),
      key: "terminal",
      render: (_: unknown, task: LongTask) => task.terminalReason || task.errorCode || "-",
    },
  ];
}

function groupLongTasks(poolRows: ApiLongTaskPool[], rows: LongTask[]): LongTaskPoolView[] {
  const pools = new Map<string, MutableLongTaskPoolView>();
  for (const poolRow of poolRows) {
    pools.set(poolRow.poolKey, {
      poolKey: poolRow.poolKey,
      podId: poolRow.podId,
      humanUserId: poolRow.humanUserId,
      agentId: poolRow.agentId,
      peerId: poolRow.peerId,
      queued: poolRow.poolQueued,
      running: poolRow.poolRunning,
      limit: poolRow.poolLimit,
      tasks: [],
      fromSummary: true,
      rowQueued: 0,
      rowRunning: 0,
    });
  }
  for (const row of rows) {
    const poolKey = row.poolKey || `${row.agentId}:${row.peerId}`;
    let pool = pools.get(poolKey);
    if (!pool) {
      pool = {
        poolKey,
        podId: row.podId,
        humanUserId: row.humanUserId,
        agentId: row.agentId,
        peerId: row.peerId,
        queued: row.poolQueued,
        running: row.poolRunning,
        limit: row.poolLimit,
        tasks: [],
        fromSummary: false,
        rowQueued: 0,
        rowRunning: 0,
      };
      pools.set(poolKey, pool);
    }
    pool.limit = Math.max(pool.limit, row.poolLimit);
    if (!pool.humanUserId && row.humanUserId) pool.humanUserId = row.humanUserId;
    if (row.status === "queued") pool.rowQueued += 1;
    if (row.status === "running") pool.rowRunning += 1;
    if (!pool.fromSummary) {
      pool.queued = Math.max(pool.queued, row.poolQueued, pool.rowQueued);
      pool.running = Math.max(pool.running, row.poolRunning, pool.rowRunning);
    }
    pool.tasks.push(row);
  }
  return [...pools.values()]
    .map(toPoolView)
    .sort((left, right) => left.poolKey.localeCompare(right.poolKey));
}

function toPoolView(pool: MutableLongTaskPoolView): LongTaskPoolView {
  return {
    poolKey: pool.poolKey,
    podId: pool.podId,
    humanUserId: pool.humanUserId,
    agentId: pool.agentId,
    peerId: pool.peerId,
    queued: pool.queued,
    running: pool.running,
    limit: pool.limit,
    tasks: pool.tasks,
  };
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

function formatTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
