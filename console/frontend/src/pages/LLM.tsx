import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Space, Table, Tag, Typography } from "@douyinfe/semi-ui";
import { IconPlus, IconPulse } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { LLMModelConfig, LLMModelInput, LLMModelTestResult } from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import { useMountedRef } from "../hooks/useMountedRef";
import { LLMCreateDialog } from "./llm/LLMCreateDialog";

const { Text } = Typography;

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
    selected,
    testResults,
    busy,
    error,
    message,
    setSelected,
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
      dataSource={state.models}
      rowSelection={{
        selectedRowKeys: selectedModelIds(state.selected, state.models),
        getCheckboxProps: (model) => ({ "aria-label": `选择模型 ${model.displayName}` }),
        onChange: (keys: (string | number)[] | undefined) => {
          const next: Record<string, boolean> = {};
          for (const key of keys ?? []) next[String(key)] = true;
          state.setSelected(next);
        },
      }}
      pagination={false}
      empty="暂无模型配置"
      size="small"
    />
  );
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
