import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Space, Table, Tag } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { HumanUser, Pod } from "../api";
import {
  FeedbackBanner,
  ListToolbar,
  MetricDescriptions,
  PageHeader,
  PageSection,
} from "../components/ConsolePage";
import { HumanUserDetailDialog } from "../components/human-users/HumanUserDetailDialog";
import {
  normalizeStatus,
  USER_STATUS_OPTIONS,
  UserStatusTag,
  type UserStatusFilter,
} from "../components/human-users/shared";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import styles from "./Users.module.css";

interface SelectedUser {
  humanUserId: string;
  podId: string;
}

interface UsersProps {
  onOpenPod: (podId: string) => void;
}

export function Users({ onOpenPod }: UsersProps) {
  const users = useGlobalHumanUsers();
  const pods = useGlobalUserPods();
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const selectedPod = useSelectedPod(selectedUser?.podId ?? "", pods.byId);

  const changed = async () => {
    await Promise.all([users.refresh(), pods.refresh()]);
  };

  return (
    <div>
      <PageHeader title="用户管理" description="跨 Pod 查看和管理 Human User、绑定模型与身份状态" />
      <MetricDescriptions
        items={[
          { label: "用户总数", value: users.total },
          { label: "Pod 数", value: pods.items.length },
          { label: "当前页", value: `${users.items.length}/${users.pageSize}` },
        ]}
      />
      <FeedbackBanner error={users.error || pods.error || selectedPod.error} />
      <PageSection>
        <GlobalUserToolbar users={users} />
        <GlobalUserTable
          users={users}
          pods={pods.byId}
          onOpen={(user) => setSelectedUser({ humanUserId: user.humanUserId, podId: user.podId })}
          onOpenPod={onOpenPod}
        />
      </PageSection>
      {selectedPod.pod && (
        <HumanUserDetailDialog
          pod={selectedPod.pod}
          humanUserId={selectedUser?.humanUserId ?? null}
          onClose={() => setSelectedUser(null)}
          onChanged={changed}
          onDeleted={() => {
            setSelectedUser(null);
            void changed();
          }}
        />
      )}
    </div>
  );
}

interface GlobalUsersState {
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

function useGlobalHumanUsers(): GlobalUsersState {
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
      const result = await api.listAllHumanUsers({
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
      setError(caught instanceof Error ? caught.message : "加载用户失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef, page, pageSize, query, status]);

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

function useGlobalUserPods() {
  const [items, setItems] = useState<Pod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const refresh = useCallback(async () => {
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api.listPods({ page: 1, pageSize: 100 });
      if (!mountedRef.current) return;
      setItems(result.items);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载 Pod 失败");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const byId = useMemo(() => new Map(items.map((pod) => [pod.podId, pod])), [items]);
  return { items, byId, loading, error, refresh };
}

function useSelectedPod(podId: string, pods: Map<string, Pod>) {
  const [pod, setPod] = useState<Pod | null>(null);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  useEffect(() => {
    setError("");
    if (podId === "") {
      setPod(null);
      return;
    }
    const cached = pods.get(podId);
    if (cached) {
      setPod(cached);
      return;
    }
    setPod(null);
    api
      .getPod(podId)
      .then((result) => {
        if (mountedRef.current) setPod(result);
      })
      .catch((caught: unknown) => {
        if (mountedRef.current)
          setError(caught instanceof Error ? caught.message : "加载 Pod 失败");
      });
  }, [mountedRef, podId, pods]);
  return { pod, error };
}

function GlobalUserToolbar({ users }: { users: GlobalUsersState }) {
  const [search, setSearch] = useState("");
  const submitSearch = () => {
    users.setPage(1);
    users.setQuery(search.trim());
  };
  const filterStatus = (status: UserStatusFilter) => {
    users.setPage(1);
    users.setStatus(status);
  };
  return (
    <ListToolbar
      filters={
        <Space>
          <Input
            prefix={<IconSearch />}
            value={search}
            onChange={setSearch}
            onEnterPress={submitSearch}
            placeholder="名称、ID、agent 或 Pod"
            style={{ width: 240 }}
          />
          <Button aria-label="查询用户" icon={<IconSearch />} onClick={submitSearch} />
          <Select
            value={users.status}
            optionList={USER_STATUS_OPTIONS}
            onChange={(value) => filterStatus(normalizeStatus(String(value ?? "")))}
            style={{ width: 120 }}
          />
        </Space>
      }
    />
  );
}

function GlobalUserTable({
  users,
  pods,
  onOpen,
  onOpenPod,
}: {
  users: GlobalUsersState;
  pods: Map<string, Pod>;
  onOpen: (user: HumanUser) => void;
  onOpenPod: (podId: string) => void;
}) {
  return (
    <Table
      columns={globalUserColumns(pods, onOpen, onOpenPod) as never}
      dataSource={users.items}
      rowKey="humanUserId"
      loading={users.loading}
      pagination={tablePagination({
        page: users.page,
        pageSize: users.pageSize,
        total: users.total,
        onPageChange: users.setPage,
        onPageSizeChange: (pageSize) => {
          users.setPageSize(pageSize);
          users.setPage(1);
        },
      })}
      renderPagination={renderTablePagination}
      size="small"
    />
  );
}

function globalUserColumns(
  pods: Map<string, Pod>,
  onOpen: (user: HumanUser) => void,
  onOpenPod: (podId: string) => void,
) {
  return [
    {
      title: "用户",
      key: "user",
      width: 220,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <div className={styles.primaryText}>{user.displayName}</div>
          <div className="mono">{user.humanUserId}</div>
        </div>
      ),
    },
    {
      title: "Pod",
      key: "pod",
      width: 170,
      render: (_: unknown, user: HumanUser) => {
        const pod = pods.get(user.podId);
        return (
          <div>
            <Button
              className={styles.podLink}
              size="small"
              theme="borderless"
              onClick={() => onOpenPod(user.podId)}
            >
              {pod?.displayName ?? user.podId}
            </Button>
            <div className="mono">{user.podId}</div>
          </div>
        );
      },
    },
    {
      title: "状态",
      key: "status",
      width: 90,
      render: (_: unknown, user: HumanUser) => <UserStatusTag status={user.status} />,
    },
    {
      title: "LLM 配置",
      key: "model",
      width: 230,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <div className={styles.primaryText}>
            {user.modelConfig.provider}/{user.modelConfig.model}
          </div>
          <div className="mono">{user.modelConfig.keyFingerprint || "已配置"}</div>
        </div>
      ),
    },
    { title: "Agent", dataIndex: "agentId", key: "agentId", width: 150, className: "mono" },
    {
      title: "Identity",
      key: "identityCount",
      width: 90,
      render: (_: unknown, user: HumanUser) => <Tag>{user.identityCount}</Tag>,
    },
    {
      title: "Browser",
      key: "browser",
      width: 170,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <span className="mono">{user.browserProfile}</span>
          <div className={styles.mutedText}>CDP {user.browserCdpPort}</div>
        </div>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render: (_: unknown, user: HumanUser) => (
        <Button size="small" onClick={() => onOpen(user)}>
          详情
        </Button>
      ),
    },
  ];
}
