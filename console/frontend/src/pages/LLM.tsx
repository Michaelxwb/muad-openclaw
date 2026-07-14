import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Space, Table, Tag, Typography } from "@douyinfe/semi-ui";
import { IconPlus, IconPulse, IconSearch } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { LLMModelConfig, LLMModelInput, LLMModelTestResult } from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { LLMCreateDialog } from "./llm/LLMCreateDialog";

const { Text } = Typography;
type ModelBoundFilter = "" | "bound" | "available";

const MODEL_BOUND_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "已绑定", value: "bound" },
  { label: "可分配", value: "available" },
];

export function LLM() {
  const state = useLLMModels();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div>
      <PageHeader
        title="模型配置"
        description="批量维护可分配模型，创建用户时必须绑定一个未占用模型"
      />
      <FeedbackBanner error={state.error} message={state.message} />
      <PageSection title="模型池">
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

type BusyState = "load" | "create" | "test" | null;

function useLLMModels() {
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, LLMModelTestResult>>({});
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
    setBusy((current) => (current === "create" || current === "test" ? current : "load"));
    try {
      const result = await api.listLLMModels(false);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setModels(result.items);
      setSelected((previous) => keepExistingSelection(previous, result.items));
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(caught instanceof Error ? caught.message : "加载模型配置失败");
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

  const createBatch = async (input: LLMModelInput[]) => {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const result = await api.createLLMModels(input);
      if (!mountedRef.current) return false;
      setMessage(`已录入 ${result.total} 个模型`);
      await load();
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "批量录入失败");
      return false;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const testSelected = async () => {
    const ids = selectedModelIds(selected, models);
    if (ids.length === 0) return setError("请至少选择一个模型");
    setBusy("test");
    setError("");
    setMessage("");
    try {
      const result = await api.testLLMModels(ids);
      if (!mountedRef.current) return;
      setTestResults(indexTestResults(result.results));
      const okCount = result.results.filter((item) => item.ok).length;
      setMessage(`连通性测试完成：${okCount}/${result.results.length} 通过`);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "批量测试失败");
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
    testResults,
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
  };
}

type LLMModelsState = ReturnType<typeof useLLMModels>;

function ModelActions({ state, onCreate }: { state: LLMModelsState; onCreate: () => void }) {
  return (
    <Space>
      <Button aria-label="创建模型" icon={<IconPlus />} theme="solid" onClick={onCreate}>
        创建模型
      </Button>
      <Button
        aria-label="批量测试连通性"
        icon={<IconPulse />}
        loading={state.busy === "test"}
        disabled={state.busy !== null || state.models.length === 0}
        onClick={() => void state.testSelected()}
      >
        批量测试连通性
      </Button>
    </Space>
  );
}

function ModelFilters({ state }: { state: LLMModelsState }) {
  const [search, setSearch] = useState(state.query);
  const submit = () => {
    state.setPage(1);
    state.setQuery(search.trim());
  };
  return (
    <Space>
      <Input
        aria-label="搜索模型配置"
        prefix={<IconSearch />}
        value={search}
        onChange={setSearch}
        onEnterPress={submit}
        placeholder="显示名、模型或 Key"
        style={{ width: 240 }}
      />
      <Button aria-label="查询模型配置" icon={<IconSearch />} onClick={submit} />
      <Select
        aria-label="模型绑定状态"
        value={state.boundFilter}
        optionList={MODEL_BOUND_OPTIONS}
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
  const columns = [
    {
      title: "显示名",
      dataIndex: "displayName",
      render: (_: unknown, model: LLMModelConfig) => (
        <div>
          <div>{model.displayName}</div>
          <Text type="tertiary" size="small" className="mono">
            {model.modelConfigId}
          </Text>
        </div>
      ),
    },
    {
      title: "模型",
      dataIndex: "model",
      render: (_: unknown, model: LLMModelConfig) => (
        <div>
          <div>{model.provider}</div>
          <Text type="tertiary" size="small">
            {model.model}
          </Text>
        </div>
      ),
    },
    {
      title: "Base URL",
      dataIndex: "baseUrl",
    },
    {
      title: "API Key",
      dataIndex: "keyFingerprint",
      render: (_: unknown, model: LLMModelConfig) => model.keyFingerprint || "已配置",
    },
    {
      title: "绑定状态",
      dataIndex: "boundHumanUserId",
      render: (_: unknown, model: LLMModelConfig) =>
        model.boundHumanUserId ? (
          <Space>
            <Tag color="orange">已绑定</Tag>
            <span>{model.boundHumanUserName || "-"}</span>
            <Text type="tertiary" size="small" className="mono">
              {model.boundHumanUserId}
            </Text>
          </Space>
        ) : (
          <Tag color="green">可分配</Tag>
        ),
    },
    {
      title: "测试结果",
      dataIndex: "test",
      render: (_: unknown, model: LLMModelConfig) => {
        const result = state.testResults[model.modelConfigId];
        if (!result) return <Text type="tertiary">未测试</Text>;
        return result.ok ? <Tag color="green">通过</Tag> : <Tag color="red">{result.error}</Tag>;
      },
    },
  ];
  return (
    <Table
      rowKey="modelConfigId"
      loading={state.busy === "load"}
      columns={columns}
      dataSource={state.pageModels}
      rowSelection={{
        selectedRowKeys: selectedModelIds(state.selected, state.models),
        getCheckboxProps: (model) => ({ "aria-label": `选择模型 ${model.displayName}` }),
        onChange: (keys: (string | number)[] | undefined) => {
          const next: Record<string, boolean> = {};
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
      empty="暂无模型配置"
      size="small"
    />
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
      model.keyFingerprint,
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

function indexTestResults(results: LLMModelTestResult[]): Record<string, LLMModelTestResult> {
  const indexed: Record<string, LLMModelTestResult> = {};
  for (const result of results) {
    if (result.modelConfigId) indexed[result.modelConfigId] = result;
  }
  return indexed;
}
