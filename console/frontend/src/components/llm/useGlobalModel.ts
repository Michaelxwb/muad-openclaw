import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { GlobalLLMConfig, LLMForm } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { EMPTY_MODEL, modelInput } from "./model";

export function useGlobalModel() {
  const loaded = useGlobalModelConfig();
  const [form, setForm] = useState<LLMForm>(EMPTY_MODEL);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!loaded.config) return;
    setForm({
      provider: loaded.config.provider ?? EMPTY_MODEL.provider,
      baseUrl: loaded.config.baseUrl ?? EMPTY_MODEL.baseUrl,
      model: loaded.config.model ?? "",
      apiKey: "",
    });
  }, [loaded.config]);
  const test = async () => {
    if (!form.apiKey.trim()) return setError("连通性测试需要输入 API Key");
    await run("test", async () => {
      await api.testLLM(form);
      setMessage("连通性测试通过");
    });
  };
  const save = async () => {
    await run("save", async () => {
      const result = await api.setLLM(modelInput(form));
      setForm((previous) => ({ ...previous, apiKey: "" }));
      loaded.setConfig(result);
      setMessage("全局模型配置已保存");
    });
  };
  const run = async (operation: "save" | "test", action: () => Promise<void>) => {
    setBusy(operation);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置操作失败");
    } finally {
      setBusy(null);
    }
  };
  return { ...loaded, form, busy, error: error || loaded.error, message, setForm, test, save };
}

function useGlobalModelConfig() {
  const [config, setConfig] = useState<GlobalLLMConfig | null>(null);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await api.getLLM();
      if (mountedRef.current && requestId === requestRef.current) setConfig(result);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载全局模型配置失败");
    }
  }, [mountedRef]);
  useEffect(() => {
    void load();
  }, [load]);
  return { config, error, setConfig };
}

export type GlobalModelState = ReturnType<typeof useGlobalModel>;
