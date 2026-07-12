import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { LLMForm, Pod } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { EMPTY_MODEL, modelInput } from "./model";

export function usePodModels(globalConfigured: boolean) {
  const pods = usePods();
  const selection = usePodSelection(globalConfigured);
  const override = usePodOverride();
  return {
    ...pods,
    ...selection,
    ...override,
    busy: selection.busy ? "apply" : override.busy ? "override" : null,
    error: selection.error || override.error || pods.error,
    message: selection.message || override.message,
  };
}

function usePodSelection(globalConfigured: boolean) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const apply = async () => {
    const podIds = Object.keys(selected).filter((podId) => selected[podId]);
    if (!globalConfigured) return setError("请先保存全局模型配置");
    if (podIds.length === 0) return setError("请至少选择一个 Pod");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.applyLLM(podIds);
      if (mountedRef.current) setMessage(`已提交 ${podIds.length} 个 Pod 应用任务`);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "应用模型失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  return { selected, busy, error, message, setSelected, apply };
}

function usePodOverride() {
  const [overrideId, setOverrideId] = useState("");
  const [override, setOverride] = useState<LLMForm>(EMPTY_MODEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const chooseOverride = async (podId: string) => {
    setOverrideId(podId);
    setError("");
    if (!podId) return setOverride(EMPTY_MODEL);
    const requestId = ++requestRef.current;
    try {
      const result = await api.getPodLLM(podId);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      const model = result.modelOverride;
      setOverride({
        provider: model.provider ?? EMPTY_MODEL.provider,
        baseUrl: model.baseUrl ?? EMPTY_MODEL.baseUrl,
        model: model.model ?? "",
        apiKey: "",
      });
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(caught instanceof Error ? caught.message : "加载 Pod 模型配置失败");
      }
    }
  };
  const saveOverride = async (clear = false) => {
    if (!overrideId) return setError("请选择 Pod");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.setPodLLM(overrideId, clear ? { clear: true } : modelInput(override));
      if (!mountedRef.current) return;
      setOverride((previous) => ({ ...previous, apiKey: "" }));
      setMessage(clear ? "Pod 模型覆写已清除" : "Pod 模型覆写已保存");
    } catch (caught) {
      if (mountedRef.current)
        setError(caught instanceof Error ? caught.message : "保存 Pod 模型失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  return { overrideId, override, busy, error, message, setOverride, chooseOverride, saveOverride };
}

function usePods() {
  const [pods, setPods] = useState<Pod[]>([]);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await api.listPods({ page: 1, pageSize: 100 });
      if (mountedRef.current && requestId === requestRef.current) setPods(result.items);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载 Pod 列表失败");
    }
  }, [mountedRef]);
  useEffect(() => {
    void load();
  }, [load]);
  return { pods, error };
}

export type PodModelState = ReturnType<typeof usePodModels>;
