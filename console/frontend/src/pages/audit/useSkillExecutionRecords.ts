import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { SkillExecution, SkillExecutionQuery } from "../../api";
import { DEFAULT_PAGE_SIZE } from "../../components/Pagination";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";
import {
  EMPTY_SKILL_EXECUTION_FILTERS,
  type SkillExecutionFilters,
  type SkillExecutionRecordsState,
} from "./skillExecutionTypes";

export function useSkillExecutionRecords(
  active: boolean,
): SkillExecutionRecordsState & { errorDetail?: string } {
  const result = useExecutionResultState();
  const filters = useExecutionFilterState();
  const loader = useExecutionLoader(
    active,
    filters.filters,
    filters.page,
    filters.pageSize,
    result,
  );
  useExecutionRefreshEffects(active, loader.refresh, loader.requestRef);
  return {
    rows: result.rows,
    total: result.total,
    loading: result.loading,
    error: result.error,
    errorDetail: result.errorDetail,
    page: filters.page,
    pageSize: filters.pageSize,
    draftFilters: filters.draftFilters,
    setDraftFilters: filters.setDraftFilters,
    setPage: filters.setPage,
    setPageSize: filters.setPageSize,
    search: filters.search,
    applyFilter: filters.applyFilter,
    reset: filters.reset,
    refresh: loader.refresh,
  };
}

function useExecutionResultState() {
  const [rows, setRows] = useState<SkillExecution[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  return {
    rows,
    setRows,
    total,
    setTotal,
    loading,
    setLoading,
    error,
    setError,
    errorDetail,
    setErrorDetail,
  };
}

function useExecutionFilterState() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [draftFilters, setDraftFilters] = useState(EMPTY_SKILL_EXECUTION_FILTERS);
  const [filters, setFilters] = useState(EMPTY_SKILL_EXECUTION_FILTERS);
  const applyTimerRef = useRef<number | null>(null);
  const clearApplyTimer = () => {
    if (applyTimerRef.current !== null) {
      window.clearTimeout(applyTimerRef.current);
      applyTimerRef.current = null;
    }
  };
  // 范围/时间过滤自动生效：draftFilters 立即同步（控件即时显示），
  // filters 经短 debounce 提交，避免 datetime 输入逐字触发请求。
  const applyFilter = (patch: Partial<SkillExecutionFilters>) => {
    setDraftFilters((prev) => ({ ...prev, ...patch }));
    clearApplyTimer();
    applyTimerRef.current = window.setTimeout(() => {
      applyTimerRef.current = null;
      setPage(1);
      setFilters((prev) => ({ ...prev, ...patch }));
    }, 250);
  };
  const search = () => {
    clearApplyTimer();
    setPage(1);
    setFilters({ ...draftFilters });
  };
  const reset = () => {
    clearApplyTimer();
    setPage(1);
    setDraftFilters(EMPTY_SKILL_EXECUTION_FILTERS);
    setFilters(EMPTY_SKILL_EXECUTION_FILTERS);
  };
  useEffect(
    () => () => {
      if (applyTimerRef.current !== null) window.clearTimeout(applyTimerRef.current);
    },
    [],
  );
  return {
    page,
    setPage,
    pageSize,
    setPageSize,
    draftFilters,
    setDraftFilters,
    filters,
    search,
    applyFilter,
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
  const { setError, setErrorDetail, setLoading, setRows, setTotal } = result;
  const refresh = useCallback(
    async (background = false) => {
      if (!active) return;
      const requestId = ++requestRef.current;
      if (!background) setLoading(true);
      setError("");
      setErrorDetail(undefined);
      try {
        const response = await api.listSkillExecutions(
          buildExecutionQuery(filters, page, pageSize),
        );
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setRows(Array.isArray(response.items) ? response.items : []);
        setTotal(Number.isFinite(response.total) ? response.total : 0);
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current) {
          setError(errorMessage(caught, "execution.loadFailed"));
          setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
        }
      } finally {
        if (!background && mountedRef.current && requestId === requestRef.current)
          setLoading(false);
      }
    },
    [
      active,
      filters,
      mountedRef,
      page,
      pageSize,
      setError,
      setErrorDetail,
      setLoading,
      setRows,
      setTotal,
    ],
  );
  return { refresh, requestRef };
}

function useExecutionRefreshEffects(
  active: boolean,
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
}

function buildExecutionQuery(
  filters: SkillExecutionFilters,
  page: number,
  pageSize: number,
): SkillExecutionQuery {
  const query: SkillExecutionQuery = { page, pageSize };
  if (filters.q) query.q = filters.q;
  if (filters.scope) query.scope = filters.scope;
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
