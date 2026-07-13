import { useCallback, useEffect, useRef, useState } from "react";
import type { HumanUser, HumanUserActivation, HumanUserBootstrapResult, Pod } from "../../api";
import { api } from "../../api";
import { DEFAULT_PAGE_SIZE } from "../Pagination";
import { useMountedRef } from "../../hooks/useMountedRef";
import styles from "../HumanUsersPanel.module.css";
import { ActivationCodeDialog } from "./ActivationCodeDialog";
import { CreateHumanUserDialog } from "./CreateHumanUserDialog";
import { HumanUserDetailDialog } from "./HumanUserDetailDialog";
import { HumanUserList } from "./HumanUserList";
import type { UserStatusFilter } from "./shared";

interface Props {
  pod: Pod;
  onPodChanged: () => Promise<void>;
}

export interface HumanUsersState {
  items: HumanUser[];
  page: number;
  pageSize: number;
  total: number;
  query: string;
  status: UserStatusFilter;
  loading: boolean;
  error: string;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  setQuery: (query: string) => void;
  setStatus: (status: UserStatusFilter) => void;
  refresh: () => Promise<void>;
}

function useHumanUsers(podId: string): HumanUsersState {
  const [items, setItems] = useState<HumanUser[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserStatusFilter>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api.listHumanUsers(podId, {
        page,
        pageSize,
        q: query,
        status: status || undefined,
      });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载 Human User 失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef, page, pageSize, podId, query, status]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  return {
    items,
    page,
    pageSize,
    total,
    query,
    status,
    loading,
    error,
    setPage,
    setPageSize,
    setQuery,
    setStatus,
    refresh,
  };
}

export function HumanUsersPanel({ pod, onPodChanged }: Props) {
  const users = useHumanUsers(pod.podId);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [activation, setActivation] = useState<HumanUserActivation | null>(null);

  const changed = async () => {
    await Promise.all([users.refresh(), onPodChanged()]);
  };
  const created = async (result: HumanUserBootstrapResult) => {
    setCreateOpen(false);
    if (result.activation) setActivation(result.activation);
    await changed();
  };

  return (
    <div className={styles.panel}>
      <HumanUserList
        pod={pod}
        users={users}
        onCreate={() => setCreateOpen(true)}
        onOpen={setSelectedUserId}
      />
      <CreateHumanUserDialog
        pod={pod}
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={created}
      />
      <ActivationCodeDialog activation={activation} onClose={() => setActivation(null)} />
      <HumanUserDetailDialog
        pod={pod}
        humanUserId={selectedUserId}
        onClose={() => setSelectedUserId(null)}
        onChanged={changed}
        onDeleted={() => {
          setSelectedUserId(null);
          void changed();
        }}
      />
    </div>
  );
}
