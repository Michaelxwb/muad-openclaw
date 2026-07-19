import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { SkillExecution, SkillExecutionQuery } from "../../api";
import { DEFAULT_PAGE_SIZE } from "../../components/Pagination";
import { useMountedRef } from "../../hooks/useMountedRef";
import {
  EMPTY_SKILL_EXECUTION_FILTERS,
  type SkillExecutionFilters,
  type SkillExecutionRecordsState,
} from "./skillExecutionTypes";

const RUNNING_REFRESH_MS = 5000;

export function useSkillExecutionRecords(active: boolean): SkillExecutionRecordsState {
  const result = useExecutionResultState();
  const filters = useExecutionFilterState();
  const loader = useExecutionLoader(
    active,
    filters.filters,
    filters.page,
    filters.pageSize,
    result,
  );
  useExecutionRefreshEffects(active, result.rows, loader.refresh, loader.requestRef);
  return {
    rows: result.rows,
    total: result.total,
    loading: result.loading,
    error: result.error,
    page: filters.page,
    pageSize: filters.pageSize,
    draftFilters: filters.draftFilters,
    setDraftFilters: filters.setDraftFilters,
    setPage: filters.setPage,
    setPageSize: filters.setPageSize,
    search: filters.search,
    reset: filters.reset,
    refresh: loader.refresh,
  };
}

function useExecutionResultState() {
  const [rows, setRows] = useState<SkillExecution[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return { rows, setRows, total, setTotal, loading, setLoading, error, setError };
}

function useExecutionFilterState() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [draftFilters, setDraftFilters] = useState(EMPTY_SKILL_EXECUTION_FILTERS);
  const [filters, setFilters] = useState(EMPTY_SKILL_EXECUTION_FILTERS);
  const search = () => {
    setPage(1);
    setFilters({ ...draftFilters });
  };
  const reset = () => {
    setPage(1);
    setDraftFilters(EMPTY_SKILL_EXECUTION_FILTERS);
    setFilters(EMPTY_SKILL_EXECUTION_FILTERS);
  };
  return {
    page,
    setPage,
    pageSize,
    setPageSize,
    draftFilters,
    setDraftFilters,
    filters,
    search,
    reset,
  };
}

type ExecutionResultState = ReturnType<typeof useExecutionResultState>;

function useExecutionLoader(
  active: boolean,
  filters: SkillExecutionFilters,
  page: number,
  pageSize: number,
  result: ExecutionResultState,
) {
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const { setError, setLoading, setRows, setTotal } = result;
  const refresh = useCallback(
    async (background = false) => {
      if (!active) return;
      const requestId = ++requestRef.current;
      if (!background) setLoading(true);
      setError("");
      try {
        const response = await api.listSkillExecutions(
          buildExecutionQuery(filters, page, pageSize),
        );
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setRows(Array.isArray(response.items) ? response.items : []);
        setTotal(Number.isFinite(response.total) ? response.total : 0);
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current)
          setError(caught instanceof Error ? caught.message : "加载 Skill 执行日志失败");
      } finally {
        if (!background && mountedRef.current && requestId === requestRef.current)
          setLoading(false);
      }
    },
    [active, filters, mountedRef, page, pageSize, setError, setLoading, setRows, setTotal],
  );
  return { refresh, requestRef };
}

function useExecutionRefreshEffects(
  active: boolean,
  rows: SkillExecution[],
  refresh: (background?: boolean) => Promise<void>,
  requestRef: React.MutableRefObject<number>,
) {
  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      return;
    }
    void refresh();
  }, [active, refresh, requestRef]);
  const hasRunning = rows.some((row) => row.status === "running");
  useEffect(() => {
    if (!active || !hasRunning) return;
    const timer = window.setInterval(() => void refresh(true), RUNNING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, hasRunning, refresh]);
}

function buildExecutionQuery(
  filters: SkillExecutionFilters,
  page: number,
  pageSize: number,
): SkillExecutionQuery {
  const query: SkillExecutionQuery = { page, pageSize };
  if (filters.q) query.q = filters.q;
  if (filters.status) query.status = filters.status;
  if (filters.scope) query.scope = filters.scope;
  if (filters.entryType) query.entryType = filters.entryType;
  const startedFrom = toRFC3339(filters.startedFrom);
  const startedTo = toRFC3339(filters.startedTo);
  if (startedFrom) query.startedFrom = startedFrom;
  if (startedTo) query.startedTo = startedTo;
  return query;
}

function toRFC3339(value: string): string | undefined {
  if (value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
