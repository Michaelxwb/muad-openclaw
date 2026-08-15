import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal, Select, Space, Table, Tag, Typography } from "@douyinfe/semi-ui";
import { IconPlus, IconPulse, IconSearch } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { LLMModelConfig, LLMModelInput } from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { errorMessage } from "../utils/error";
import { maxPageFor } from "../utils/pageClamp";
import styles from "./LLM.module.css";
import { LLMCreateDialog } from "./llm/LLMCreateDialog";

const { Text } = Typography;
type ModelBoundFilter = "" | "bound" | "available";
export const MODEL_TABLE_COLUMN_WIDTHS = {
  displayName: 220,
  model: 140,
  baseUrl: 220,
  apiKey: 260,
  boundStatus: 150,
  toolCalls: 90,
  testResult: 90,
  actions: 72,
};

export function LLM() {
  const { t } = useTranslation();
  const state = useLLMModels();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div>
      <PageHeader title={t("nav.llm")} description={t("model.pageDescription")} />
      <FeedbackBanner error={state.error} message={state.message} />
      <PageSection title={t("model.pool")}>
        <ListToolbar
          actions={<ModelActions state={state} onCreate={() => setCreateOpen(true)} />}
          filters={<ModelFilters state={state} />}
        />
        <ModelTable state={state} />
      </PageSection>
      <LLMCreateDialog
        visible={createOpen}
        busy={state.busy === "create"}
        onClose={() => setCreateOpen(false)}
        onCreate={state.createBatch}
        onError={state.setError}
      />
    </div>
  );
}

type BusyState = "load" | "create" | "test" | "delete" | null;

function useLLMModels() {
  const { t } = useTranslation();
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [boundFilter, setBoundFilter] = useState<ModelBoundFilter>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [busy, setBusy] = useState<BusyState>("load");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setBusy((current) =>
      current === "create" || current === "test" || current === "delete" ? current : "load",
    );
    try {
      const result = await api.listLLMModels(false);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setModels(result.items);
      setSelected((previous) => keepExistingSelection(previous, result.items));
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(errorMessage(caught, "model.loadFailed"));
      }
    } finally {
      if (mountedRef.current) setBusy((current) => (current === "load" ? null : current));
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredModels = useMemo(
    () => filterModels(models, query, boundFilter),
    [boundFilter, models, query],
  );
  const pageModels = useMemo(
    () => filteredModels.slice((page - 1) * pageSize, page * pageSize),
    [filteredModels, page, pageSize],
  );

  // 删除末条模型后列表缩短，page 超界时回退到最大页，避免空列表。
  useEffect(() => {
    const maxPage = maxPageFor(filteredModels.length, pageSize);
    if (page > maxPage) setPage(maxPage);
  }, [filteredModels.length, page, pageSize]);

  const createBatch = async (input: LLMModelInput[]) => {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const result = await api.createLLMModels(input);
      if (!mountedRef.current) return false;
      setMessage(t("model.createdMessage", { count: result.total }));
      await load();
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "model.batchCreateFailed"));
      return false;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const testSelected = async () => {
    const ids = selectedModelIds(selected, models);
    if (ids.length === 0) return setError(t("model.selectAtLeastOne"));
    setBusy("test");
    setError("");
    setMessage("");
    try {
      const result = await api.testLLMModels(ids);
      if (!mountedRef.current) return;
      const okCount = result.results.filter((item) => item.ok).length;
      setMessage(t("model.testCompleted", { passed: okCount, total: result.results.length }));
      await load();
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "model.batchTestFailed"));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const deleteModel = async (modelConfigId: string): Promise<boolean> => {
    setBusy("delete");
    setError("");
    setMessage("");
    try {
      await api.deleteLLMModel(modelConfigId);
      if (!mountedRef.current) return false;
      setMessage(t("model.deletedMessage"));
      await load();
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "model.deleteFailed"));
      return false;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  return {
    models,
    pageModels,
    filteredTotal: filteredModels.length,
    page,
    pageSize,
    query,
    boundFilter,
    selected,
    busy,
    error,
    message,
    setSelected,
    setPage,
    setPageSize,
    setQuery,
    setBoundFilter,
    setError,
    createBatch,
    testSelected,
    deleteModel,
  };
}

type LLMModelsState = ReturnType<typeof useLLMModels>;

function ModelActions({ state, onCreate }: { state: LLMModelsState; onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <Space>
      <Button
        aria-label={t("model.createModel")}
        icon={<IconPlus />}
        theme="solid"
        onClick={onCreate}
      >
        {t("model.createModel")}
      </Button>
      <Button
        aria-label={t("model.testConnectivity")}
        icon={<IconPulse />}
        loading={state.busy === "test"}
        disabled={state.busy !== null || state.models.length === 0}
        onClick={() => void state.testSelected()}
      >
        {t("model.testConnectivity")}
      </Button>
    </Space>
  );
}

function ModelFilters({ state }: { state: LLMModelsState }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(state.query);
  const boundOptions = useMemo(
    () => [
      { label: t("model.boundAll"), value: "" },
      { label: t("model.boundBound"), value: "bound" },
      { label: t("model.boundAvailable"), value: "available" },
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
        aria-label={t("model.searchConfig")}
        prefix={<IconSearch />}
        value={search}
        onChange={setSearch}
        onEnterPress={submit}
        placeholder={t("model.searchPlaceholder")}
        style={{ width: 240 }}
      />
      <Button aria-label={t("model.searchSubmit")} icon={<IconSearch />} onClick={submit} />
      <Select
        aria-label={t("model.boundStatusLabel")}
        value={state.boundFilter}
        optionList={boundOptions}
        onChange={(value) => {
          state.setPage(1);
          state.setBoundFilter(String(value ?? "") as ModelBoundFilter);
        }}
        style={{ width: 120 }}
      />
    </Space>
  );
}

function ModelTable({ state }: { state: LLMModelsState }) {
  const { t } = useTranslation();
  const columns = [
    {
      title: t("model.displayName"),
      dataIndex: "displayName",
      width: MODEL_TABLE_COLUMN_WIDTHS.displayName,
      render: (_: unknown, model: LLMModelConfig) => (
        <div className={styles.tableCellStack}>
          <div className={styles.tableCellPrimary}>{model.displayName}</div>
          <Text type="tertiary" size="small" className="mono">
            <span className={styles.tableCellMeta}>{model.modelConfigId}</span>
          </Text>
        </div>
      ),
    },
    {
      title: t("model.model"),
      dataIndex: "model",
      width: MODEL_TABLE_COLUMN_WIDTHS.model,
      render: (_: unknown, model: LLMModelConfig) => (
        <div className={styles.tableCellStack}>
          <div className={styles.tableCellPrimary}>{model.provider}</div>
          <Text type="tertiary" size="small">
            <span className={styles.tableCellMeta}>{model.model}</span>
          </Text>
        </div>
      ),
    },
    {
      title: t("model.baseUrl"),
      dataIndex: "baseUrl",
      width: MODEL_TABLE_COLUMN_WIDTHS.baseUrl,
      render: (_: unknown, model: LLMModelConfig) => (
        <span className={styles.tableCellLine}>{model.baseUrl}</span>
      ),
    },
    {
      title: t("model.apiKey"),
      dataIndex: "apiKey",
      width: MODEL_TABLE_COLUMN_WIDTHS.apiKey,
      render: (_: unknown, model: LLMModelConfig) => (
        <Text type="tertiary" size="small" className="mono">
          <span className={styles.tableCellLine}>{model.apiKey || t("model.notConfigured")}</span>
        </Text>
      ),
    },
    {
      title: t("model.boundStatus"),
      dataIndex: "boundHumanUserId",
      width: MODEL_TABLE_COLUMN_WIDTHS.boundStatus,
      render: (_: unknown, model: LLMModelConfig) =>
        model.boundHumanUserId ? (
          <Space className={styles.boundStatus}>
            <Tag color="orange">{t("model.boundBound")}</Tag>
            <span className={styles.boundUserName}>{model.boundHumanUserName || "-"}</span>
          </Space>
        ) : (
          <Tag color="green">{t("model.boundAvailable")}</Tag>
        ),
    },
    {
      title: t("model.toolCalls"),
      dataIndex: "supportsTools",
      width: MODEL_TABLE_COLUMN_WIDTHS.toolCalls,
      render: (_: unknown, model: LLMModelConfig) =>
        model.supportsTools ? (
          <Tag color="green">{t("model.toolCallsSupported")}</Tag>
        ) : (
          <Tag color="grey">{t("model.toolCallsUnsupported")}</Tag>
        ),
    },
    {
      title: t("model.testResult"),
      dataIndex: "test",
      width: MODEL_TABLE_COLUMN_WIDTHS.testResult,
      render: (_: unknown, model: LLMModelConfig) => {
        if (!model.lastTestAt) return <Text type="tertiary">{t("model.notTested")}</Text>;
        return model.lastTestOK ? (
          <Tag color="green">{t("model.testPassed")}</Tag>
        ) : (
          <Tag color="red">{model.lastTestError || t("status.failed")}</Tag>
        );
      },
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: MODEL_TABLE_COLUMN_WIDTHS.actions,
      render: (_: unknown, model: LLMModelConfig) => (
        <DeleteModelButton
          model={model}
          onDelete={state.deleteModel}
          busy={state.busy === "delete"}
        />
      ),
    },
  ];
  return (
    <Table
      className={styles.modelTable}
      rowKey="modelConfigId"
      loading={state.busy === "load"}
      columns={columns}
      dataSource={state.pageModels}
      rowSelection={{
        selectedRowKeys: selectedModelIds(state.selected, state.models),
        getCheckboxProps: (model) => ({
          "aria-label": t("model.selectModel", { name: model.displayName }),
        }),
        onChange: (keys: (string | number)[] | undefined) => {
          // Preserve selection on other pages; only update keys for current page.
          const pageIds = new Set(state.pageModels.map((model) => model.modelConfigId));
          const next: Record<string, boolean> = { ...state.selected };
          for (const id of pageIds) delete next[id];
          for (const key of keys ?? []) next[String(key)] = true;
          state.setSelected(next);
        },
      }}
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
      empty={t("model.empty")}
      size="small"
    />
  );
}

function DeleteModelButton({
  model,
  onDelete,
  busy,
}: {
  model: LLMModelConfig;
  onDelete: (modelConfigId: string) => Promise<boolean>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const bound = Boolean(model.boundHumanUserId);
  const confirm = async () => {
    setError("");
    const deleted = await onDelete(model.modelConfigId);
    if (deleted) setOpen(false);
  };
  return (
    <>
      <Button
        aria-label={t("model.deleteModelTitle", { name: model.displayName })}
        size="small"
        type="danger"
        theme="borderless"
        disabled={bound || busy}
        title={bound ? t("model.cannotDeleteBound") : t("model.deleteModel")}
        onClick={() => setOpen(true)}
      >
        {t("common.delete")}
      </Button>
      <Modal
        title={t("model.deleteModelTitle", { name: model.displayName })}
        visible={open}
        onCancel={() => setOpen(false)}
        onOk={() => void confirm()}
        okText={t("common.confirmDelete")}
        okButtonProps={{ type: "danger" as const }}
        confirmLoading={busy}
      >
        <FeedbackBanner error={error} />
        <p className="hint">{t("model.deleteHint")}</p>
      </Modal>
    </>
  );
}

function filterModels(
  models: LLMModelConfig[],
  query: string,
  boundFilter: ModelBoundFilter,
): LLMModelConfig[] {
  const keyword = query.trim().toLowerCase();
  return models.filter((model) => {
    if (boundFilter === "bound" && !model.boundHumanUserId) return false;
    if (boundFilter === "available" && model.boundHumanUserId) return false;
    if (keyword === "") return true;
    return [
      model.displayName,
      model.modelConfigId,
      model.provider,
      model.model,
      model.baseUrl,
      model.apiKey,
      model.boundHumanUserName,
      model.boundHumanUserId,
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(keyword));
  });
}

function selectedModelIds(selected: Record<string, boolean>, models: LLMModelConfig[]) {
  return models
    .filter((model) => selected[model.modelConfigId])
    .map((model) => model.modelConfigId);
}

function keepExistingSelection(
  selected: Record<string, boolean>,
  models: LLMModelConfig[],
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const model of models) {
    if (selected[model.modelConfigId]) next[model.modelConfigId] = true;
  }
  return next;
}
