import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, Tag } from "@douyinfe/semi-ui";
import { api } from "../api";
import type { GlobalResourceConfig, ResourceConfig } from "../api";
import {
  FeedbackBanner,
  MetricDescriptions,
  PageHeader,
  SectionHeader,
} from "../components/ConsolePage";
import { PlatformSettings } from "../components/platforms/PlatformSettings";
import { useMountedRef } from "../hooks/useMountedRef";
import styles from "./Settings.module.css";

const RESTART_OPTIONS = [
  { value: "unless-stopped", label: "unless-stopped" },
  { value: "always", label: "always" },
  { value: "on-failure", label: "on-failure" },
  { value: "no", label: "no" },
];

const EMPTY: ResourceConfig = { memLimit: "", cpuLimit: "", restartPolicy: "unless-stopped" };

export function Settings() {
  const resources = useGlobalResources();
  return (
    <div>
      <PageHeader title="资源与平台" description="设置 Pod 默认资源，并管理业务平台接入配置" />
      <section className={styles.section} aria-labelledby="resource-settings-title">
        <SectionHeader
          title="Pod 资源默认值"
          extra={
            <Tag color={resources.config?.configured ? "green" : "grey"}>
              {resources.config?.configured ? "已配置" : "运行时默认"}
            </Tag>
          }
        />
        <FeedbackBanner error={resources.error} message={resources.message} />
        <ResourceForm state={resources} />
        {resources.config && <EffectiveResources config={resources.config} />}
      </section>
      <PlatformSettings />
    </div>
  );
}

type ResourceState = ReturnType<typeof useGlobalResources>;

function ResourceForm({ state }: { state: ResourceState }) {
  const set = (key: keyof ResourceConfig, value: string) =>
    state.setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <div className={styles.formGrid}>
      <label htmlFor="resource-memory">内存上限</label>
      <Input
        id="resource-memory"
        aria-label="全局 Pod 内存上限"
        value={state.form.memLimit}
        onChange={(value) => set("memLimit", value)}
        placeholder="2g"
      />
      <label htmlFor="resource-cpu">CPU 上限</label>
      <Input
        id="resource-cpu"
        aria-label="全局 Pod CPU 上限"
        value={state.form.cpuLimit}
        onChange={(value) => set("cpuLimit", value)}
        placeholder="1.5"
      />
      <label>重启策略</label>
      <Select
        aria-label="全局 Pod 重启策略"
        value={state.form.restartPolicy}
        optionList={RESTART_OPTIONS}
        onChange={(value) => set("restartPolicy", String(value ?? ""))}
        style={{ width: "100%" }}
      />
      <div />
      <Button theme="solid" loading={state.busy} onClick={() => void state.save()}>
        保存资源默认值
      </Button>
    </div>
  );
}

function EffectiveResources({ config }: { config: GlobalResourceConfig }) {
  return (
    <MetricDescriptions
      columns={5}
      items={[
        { label: "有效内存", value: config.effective.memLimit },
        { label: "有效 CPU", value: config.effective.cpuLimit },
        { label: "重启策略", value: config.effective.restartPolicy },
        { label: "Skill 并发默认值", value: config.effective.maxSkillConcurrency },
        { label: "Browser 并发默认值", value: config.effective.maxBrowserConcurrency },
      ]}
    />
  );
}

function useGlobalResources() {
  const [form, setForm] = useState<ResourceConfig>(EMPTY);
  const [config, setConfig] = useState<GlobalResourceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await api.getResources();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setConfig(result);
      setForm({
        memLimit: result.memLimit,
        cpuLimit: result.cpuLimit,
        restartPolicy: result.restartPolicy,
      });
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载资源配置失败");
    }
  }, [mountedRef]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.setResources(form);
      setMessage(`已更新默认值，${result.affectedPodIds.length} 个 Pod 等待应用`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存资源配置失败");
    } finally {
      setBusy(false);
    }
  };
  return { form, config, busy, error, message, setForm, save };
}
