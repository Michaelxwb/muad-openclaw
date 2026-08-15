import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Space, Table, Tag } from "@douyinfe/semi-ui";
import { IconPlus, IconSearch } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api";
import type { HumanUser, HumanUserActivation, HumanUserBootstrapResult, Pod } from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import { ActivationCodeDialog } from "../components/human-users/ActivationCodeDialog";
import { AttachHumanUsersDialog } from "../components/human-users/AttachHumanUsersDialog";
import { CreateHumanUserDialog } from "../components/human-users/CreateHumanUserDialog";
import { HumanUserDetailDialog } from "../components/human-users/HumanUserDetailDialog";
import { DeleteHumanUser } from "../components/human-users/DeleteHumanUser";
import {
  normalizeStatus,
  userStatusOptions,
  UserStatusTag,
  type UserStatusFilter,
} from "../components/human-users/shared";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { errorMessage } from "../utils/error";
import { normalizePage } from "../utils/pageClamp";
import styles from "./Users.module.css";

interface SelectedUser {
  humanUserId: string;
  podId: string;
}

interface UsersProps {
  onOpenPod: (podId: string) => void;
}

export function Users({ onOpenPod }: UsersProps) {
  const { t } = useTranslation();
  const users = useGlobalHumanUsers();
  const pods = useGlobalUserPods();
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [activation, setActivation] = useState<HumanUserActivation | null>(null);
  const [attachUserIds, setAttachUserIds] = useState<string[] | null>(null);
  const selectedPod = useSelectedPod(selectedUser?.podId ?? "", pods.byId);

  const changed = async () => {
    await Promise.all([users.refresh(), pods.refresh()]);
  };
  const created = async (result: HumanUserBootstrapResult) => {
    setCreateOpen(false);
    if (result.activation) setActivation(result.activation);
    await changed();
  };
  const openUser = (user: HumanUser) => {
    if (user.podId === "") {
      setAttachUserIds([user.humanUserId]);
      return;
    }
    setSelectedUser({ humanUserId: user.humanUserId, podId: user.podId });
  };

  return (
    <div>
      <PageHeader title={t("nav.users")} description={t("user.pageDescription")} />
      <FeedbackBanner error={users.error || pods.error || selectedPod.error} />
      <PageSection>
        <GlobalUserToolbar
          users={users}
          createDisabled={pods.items.length === 0}
          onCreate={() => setCreateOpen(true)}
        />
        <GlobalUserTable
          users={users}
          pods={pods.byId}
          onOpen={openUser}
          onAttach={setAttachUserIds}
          onOpenPod={onOpenPod}
          onDeleted={changed}
        />
      </PageSection>
      {pods.items.length > 0 && (
        <CreateHumanUserDialog
          pod={pods.items[0]}
          podOptions={pods.items}
          visible={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={created}
        />
      )}
      <ActivationCodeDialog activation={activation} onClose={() => setActivation(null)} />
      {attachUserIds && (
        <AttachHumanUsersDialog
          humanUserIds={attachUserIds}
          pods={pods.items}
          onClose={() => setAttachUserIds(null)}
          onAttached={changed}
        />
      )}
      {selectedPod.pod && (
        <HumanUserDetailDialog
          pod={selectedPod.pod}
          humanUserId={selectedUser?.humanUserId ?? null}
          onClose={() => setSelectedUser(null)}
          onChanged={changed}
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
  unboundOnly: boolean;
  loading: boolean;
  error: string;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  setQuery: (query: string) => void;
  setStatus: (status: UserStatusFilter) => void;
  setUnboundOnly: (value: boolean) => void;
  refresh: () => Promise<void>;
}

function useGlobalHumanUsers(): GlobalUsersState {
  const [items, setItems] = useState<HumanUser[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserStatusFilter>("");
  const [unboundOnly, setUnboundOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const foregroundRequestRef = useRef(0);

  const refresh = useCallback(
    async (background = false) => {
      const requestId = ++requestRef.current;
      const foregroundRequestId = background ? 0 : ++foregroundRequestRef.current;
      if (mountedRef.current) {
        if (!background) setLoading(true);
        setError("");
      }
      try {
        const result = await api.listAllHumanUsers({
          page,
          pageSize,
          q: query,
          status: status || undefined,
          unbound: unboundOnly || undefined,
        });
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setItems(result.items);
        setTotal(result.total);
        normalizePage(page, result.total, pageSize, setPage);
      } catch (caught) {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setError(errorMessage(caught, "user.loadUsersFailed"));
      } finally {
        if (
          mountedRef.current &&
          !background &&
          foregroundRequestId === foregroundRequestRef.current
        )
          setLoading(false);
      }
    },
    [mountedRef, page, pageSize, query, status, unboundOnly],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(true), 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  return {
    items,
    page,
    pageSize,
    total,
    query,
    status,
    unboundOnly,
    loading,
    error,
    setPage,
    setPageSize,
    setQuery,
    setStatus,
    setUnboundOnly,
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
      const result = await listAllPodsForUsers();
      if (!mountedRef.current) return;
      setItems(result);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(errorMessage(caught, "user.loadPodsFailed"));
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

async function listAllPodsForUsers(): Promise<Pod[]> {
  const pageSize = 100;
  const first = await api.listPods({ page: 1, pageSize });
  const items = [...first.items];
  for (let page = 2; items.length < first.total; page++) {
    const result = await api.listPods({ page, pageSize });
    items.push(...result.items);
    if (result.items.length === 0) break;
  }
  return items;
}

function useSelectedPod(podId: string, pods: Map<string, Pod>) {
  const [pod, setPod] = useState<Pod | null>(null);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
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
    const requestId = ++requestRef.current;
    api
      .getPod(podId)
      .then((result) => {
        if (mountedRef.current && requestId === requestRef.current) setPod(result);
      })
      .catch((caught: unknown) => {
        if (mountedRef.current && requestId === requestRef.current)
          setError(errorMessage(caught, "user.loadPodsFailed"));
      });
  }, [mountedRef, podId, pods]);
  return { pod, error };
}

function GlobalUserToolbar({
  users,
  createDisabled,
  onCreate,
}: {
  users: GlobalUsersState;
  createDisabled: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const submitSearch = () => {
    users.setPage(1);
    users.setQuery(search.trim());
  };
  const filterStatus = (status: UserStatusFilter) => {
    users.setPage(1);
    users.setStatus(status);
  };
  const filterBinding = (value: "all" | "unbound") => {
    users.setPage(1);
    users.setUnboundOnly(value === "unbound");
  };
  return (
    <ListToolbar
      actions={
        <Button
          aria-label={t("user.create")}
          theme="solid"
          icon={<IconPlus />}
          disabled={createDisabled}
          onClick={onCreate}
        >
          {t("user.create")}
        </Button>
      }
      filters={
        <Space>
          <Input
            prefix={<IconSearch />}
            value={search}
            onChange={setSearch}
            onEnterPress={submitSearch}
            placeholder={t("user.searchPlaceholder")}
            style={{ width: 240 }}
          />
          <Button aria-label={t("user.query")} icon={<IconSearch />} onClick={submitSearch} />
          <Select
            value={users.status}
            optionList={userStatusOptions(t)}
            onChange={(value) => filterStatus(normalizeStatus(String(value ?? "")))}
            style={{ width: 120 }}
          />
          <Select
            value={users.unboundOnly ? "unbound" : "all"}
            optionList={[
              { value: "all", label: t("user.bindingAll") },
              { value: "unbound", label: t("user.bindingUnbound") },
            ]}
            onChange={(value) => filterBinding(value === "unbound" ? "unbound" : "all")}
            style={{ width: 140 }}
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
  onAttach,
  onOpenPod,
  onDeleted,
}: {
  users: GlobalUsersState;
  pods: Map<string, Pod>;
  onOpen: (user: HumanUser) => void;
  onAttach: (humanUserIds: string[]) => void;
  onOpenPod: (podId: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Table
      columns={globalUserColumns(t, pods, onOpen, onAttach, onOpenPod, onDeleted) as never}
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
  t: TFunction,
  pods: Map<string, Pod>,
  onOpen: (user: HumanUser) => void,
  onAttach: (humanUserIds: string[]) => void,
  onOpenPod: (podId: string) => void,
  onDeleted: () => Promise<void>,
) {
  return [
    {
      title: t("user.columnUser"),
      key: "user",
      width: 300,
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
      width: 140,
      render: (_: unknown, user: HumanUser) => {
        if (user.podId === "") {
          return (
            <div>
              <Tag color="orange">{t("user.unbound")}</Tag>
              <div className={styles.mutedText}>
                {t("user.originalPod", { podId: user.lastPodId || "-" })}
              </div>
            </div>
          );
        }
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
      title: t("common.status"),
      key: "status",
      width: 90,
      render: (_: unknown, user: HumanUser) => <UserStatusTag status={user.status} />,
    },
    {
      title: t("user.columnModel"),
      key: "model",
      width: 230,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <div className={styles.primaryText}>
            {user.modelConfig.provider}/{user.modelConfig.model}
          </div>
          <div className="mono">{user.modelConfig.apiKey || t("user.configured")}</div>
        </div>
      ),
    },
    {
      title: t("user.runningAgent"),
      dataIndex: "agentId",
      key: "agentId",
      width: 150,
      className: "mono",
    },
    {
      title: t("user.identity"),
      key: "identityCount",
      width: 90,
      render: (_: unknown, user: HumanUser) => <Tag>{user.identityCount}</Tag>,
    },
    {
      title: t("user.columnBrowser"),
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
      title: t("common.actions"),
      key: "actions",
      width: 150,
      render: (_: unknown, user: HumanUser) => (
        <Space spacing={4}>
          {user.podId === "" ? (
            <Button size="small" onClick={() => onAttach([user.humanUserId])}>
              {t("user.bind")}
            </Button>
          ) : (
            <Button size="small" onClick={() => onOpen(user)}>
              {t("common.viewDetail")}
            </Button>
          )}
          <DeleteHumanUser user={user} compact onDeleted={() => void onDeleted()} />
        </Space>
      ),
    },
  ];
}
