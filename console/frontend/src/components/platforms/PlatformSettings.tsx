import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Tag, Toast } from "@douyinfe/semi-ui";
import { IconPlus, IconSearch } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../../api";
import type { Platform } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { DEFAULT_PAGE_SIZE, renderTablePagination, tablePagination } from "../Pagination";
import { FeedbackBanner, ListToolbar, PageSection } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import { PlatformEditorDialog } from "./PlatformEditorDialog";
import styles from "./PlatformSettings.module.css";

type PlatformStatusFilter = "" | "enabled" | "disabled";

export function PlatformSettings() {
  const { t } = useTranslation();
  const state = usePlatforms();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (platform: Platform) => {
    setEditing(platform);
    setEditorOpen(true);
  };
  return (
    <PageSection title={t("platform.title")}>
      <FeedbackBanner error={state.error} />
      <ListToolbar
        actions={
          <Space>
            <Button
              aria-label={t("platform.create")}
              icon={<IconPlus />}
              theme="solid"
              onClick={openCreate}
            >
              {t("platform.create")}
            </Button>
          </Space>
        }
        filters={<PlatformFilters state={state} />}
      />
      <Table
        columns={platformColumns(t, openEdit, state.refresh) as never}
        dataSource={state.pageItems}
        rowKey="platform"
        loading={state.loading}
        pagination={tablePagination({
          page: state.page,
          pageSize: state.pageSize,
          total: state.filteredTotal,
          onPageChange: state.setPage,
          onPageSizeChange: (pageSize) => {
            state.setPageSize(pageSize);
            state.setPage(1);
          },
        })}
        renderPagination={renderTablePagination}
        empty={t("platform.empty")}
        size="small"
      />
      <PlatformEditorDialog
        visible={editorOpen}
        platform={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          setEditorOpen(false);
          await state.refresh();
        }}
      />
    </PageSection>
  );
}

function usePlatforms() {
  const [items, setItems] = useState<Platform[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PlatformStatusFilter>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
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
      const result = await api.listPlatforms();
      if (mountedRef.current && requestId === requestRef.current) setItems(result.items);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "platform.loadFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const filtered = filterPlatforms(items, query, status);
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    items,
    pageItems,
    filteredTotal: filtered.length,
    query,
    status,
    page,
    pageSize,
    loading,
    error,
    setQuery,
    setStatus,
    setPage,
    setPageSize,
    refresh,
  };
}

type PlatformState = ReturnType<typeof usePlatforms>;

function PlatformFilters({ state }: { state: PlatformState }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(state.query);
  const statusOptions = useMemo(
    () => [
      { value: "", label: t("platform.statusFilterAll") },
      { value: "enabled", label: t("platform.statusEnabled") },
      { value: "disabled", label: t("platform.statusDisabled") },
    ],
    [t],
  );
  const submit = () => {
    state.setPage(1);
    state.setQuery(search.trim());
  };
  return (
    <Space>
      <Input
        aria-label={t("platform.search")}
        prefix={<IconSearch />}
        value={search}
        onChange={setSearch}
        onEnterPress={submit}
        placeholder={t("platform.searchPlaceholder")}
        style={{ width: 220 }}
      />
      <Button aria-label={t("platform.searchSubmit")} icon={<IconSearch />} onClick={submit} />
      <Select
        aria-label={t("platform.statusAria")}
        value={state.status}
        optionList={statusOptions}
        onChange={(value) => {
          state.setPage(1);
          state.setStatus(String(value ?? "") as PlatformStatusFilter);
        }}
        style={{ width: 130 }}
      />
    </Space>
  );
}

function filterPlatforms(
  platforms: Platform[],
  query: string,
  status: PlatformStatusFilter,
): Platform[] {
  const keyword = query.trim().toLowerCase();
  return platforms.filter((platform) => {
    if (status === "enabled" && !platform.enabled) return false;
    if (status === "disabled" && platform.enabled) return false;
    if (keyword === "") return true;
    return [platform.platform, platform.displayName]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(keyword));
  });
}

function platformColumns(
  t: TFunction,
  onEdit: (platform: Platform) => void,
  onDeleted: () => Promise<void>,
) {
  return [
    {
      title: t("platform.platformLabel"),
      key: "platform",
      width: "42%",
      render: (_: unknown, platform: Platform) => (
        <div className={styles.tableCellStack}>
          <strong className={styles.tableCellPrimary}>{platform.displayName}</strong>
          <div className={`mono ${styles.tableCellMeta}`}>{platform.platform}</div>
        </div>
      ),
    },
    {
      title: t("common.status"),
      key: "status",
      width: "14%",
      render: (_: unknown, platform: Platform) => (
        <Tag color={platform.enabled ? "green" : "grey"}>
          {platform.enabled ? t("platform.statusEnabled") : t("platform.statusDisabled")}
        </Tag>
      ),
    },
    {
      title: t("common.updatedAt"),
      key: "updatedAt",
      width: "24%",
      render: (_: unknown, platform: Platform) => (
        <span className={styles.tableCellLine}>
          {new Date(platform.updatedAt).toLocaleString()}
        </span>
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: "20%",
      render: (_: unknown, platform: Platform) => (
        <Space className={styles.actionGroup} spacing={4}>
          <Button size="small" onClick={() => onEdit(platform)}>
            {t("common.edit")}
          </Button>
          <DeletePlatformButton platform={platform} onDeleted={onDeleted} />
        </Space>
      ),
    },
  ];
}

function DeletePlatformButton({
  platform,
  onDeleted,
}: {
  platform: Platform;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deletePlatform(platform.platform);
      Toast.success(t("platform.deleted"));
      setVisible(false);
      await onDeleted();
    } catch (caught) {
      setError(errorMessage(caught, "platform.deleteFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="small" type="danger" onClick={() => setVisible(true)}>
        {t("common.delete")}
      </Button>
      <Modal
        className="standard-modal"
        title={t("platform.deleteTitle", { name: platform.displayName })}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => void remove()}
        okText={t("common.delete")}
        confirmLoading={busy}
        okButtonProps={{ type: "danger" as const }}
      >
        <FeedbackBanner error={error} />
        <p className="hint">{t("platform.deleteHint")}</p>
      </Modal>
    </>
  );
}
