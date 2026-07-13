import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { Pod } from "../../api";
import { DEFAULT_PAGE_SIZE } from "../../components/Pagination";
import { useMountedRef } from "../../hooks/useMountedRef";
import type { PodStateFilter } from "./model";

interface UsePodListOptions {
  enabled?: boolean;
}

export function usePodList({ enabled = true }: UsePodListOptions = {}) {
  const state = usePodListState();
  const { page, pageSize, search, status, setError, setItems, setLoading, setTotal } = state;
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api.listPods({
        page,
        pageSize,
        q: search,
        state: status || undefined,
      });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载 Pod 失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef, page, pageSize, search, setError, setItems, setLoading, setTotal, status]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { ...state, refresh };
}

function usePodListState() {
  const [items, setItems] = useState<Pod[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PodStateFilter>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  return {
    items,
    total,
    loading,
    error,
    searchDraft,
    search,
    status,
    page,
    pageSize,
    setError,
    setSearchDraft,
    setSearch,
    setStatus,
    setPage,
    setPageSize,
    setItems,
    setTotal,
    setLoading,
  };
}

export type PodListState = ReturnType<typeof usePodList>;
