import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, Tag } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { GlobalResourceConfig, ResourceConfig } from "../api";
import { errorMessage } from "../utils/error";
import {
  FeedbackBanner,
  MetricDescriptions,
  PageHeader,
  PageSection,
} from "../components/ConsolePage";
import { PlatformSettings } from "../components/platforms/PlatformSettings";
import { AgentGuidanceSettings } from "../components/settings/AgentGuidanceSettings";
import { useMountedRef } from "../hooks/useMountedRef";
import { memLimitToGB } from "../utils/memLimit";
import styles from "./Settings.module.css";

const RESTART_OPTIONS = [
  { value: "unless-stopped", label: "unless-stopped" },
  { value: "always", label: "always" },
  { value: "on-failure", label: "on-failure" },
  { value: "no", label: "no" },
];

const EMPTY: ResourceConfig = { memLimit: "", cpuLimit: "", restartPolicy: "unless-stopped" };

export function Settings() {
  const { t } = useTranslation();
  const resources = useGlobalResources();
  return (
    <div>
      <PageHeader title={t("nav.settings")} description={t("settings.pageDescription")} />
      <PageSection
        title={t("settings.resourceDefaults")}
        extra={
          <Tag color={resources.config?.configured ? "green" : "grey"}>
            {resources.config?.configured ? t("settings.configured") : t("settings.runtimeDefault")}
          </Tag>
        }
      >
        <FeedbackBanner error={resources.error} message={resources.message} />
        <ResourceForm state={resources} />
        {resources.config && <EffectiveResources config={resources.config} />}
      </PageSection>
      <PageSection title={t("settings.agentGuidance")}>
        <AgentGuidanceSettings />
      </PageSection>
      <PlatformSettings />
    </div>
  );
}

type ResourceState = ReturnType<typeof useGlobalResources>;

function ResourceForm({ state }: { state: ResourceState }) {
  const { t } = useTranslation();
  const set = (key: keyof ResourceConfig, value: string) =>
    state.setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <div className={styles.formGrid}>
      <label htmlFor="resource-memory">{t("settings.memLimit")}</label>
      <Input
        id="resource-memory"
        aria-label={t("settings.memLimitLabel")}
        value={state.form.memLimit}
        onChange={(value) => set("memLimit", value)}
        placeholder="2"
        suffix="GiB"
      />
      <label htmlFor="resource-cpu">{t("settings.cpuLimit")}</label>
      <Input
        id="resource-cpu"
        aria-label={t("settings.cpuLimitLabel")}
        value={state.form.cpuLimit}
        onChange={(value) => set("cpuLimit", value)}
        placeholder="1.5"
      />
      <label>{t("settings.restartPolicy")}</label>
      <Select
        aria-label={t("settings.restartPolicyLabel")}
        value={state.form.restartPolicy}
        optionList={RESTART_OPTIONS}
        onChange={(value) => set("restartPolicy", String(value ?? ""))}
        style={{ width: "100%" }}
      />
      <div />
      <Button theme="solid" loading={state.busy} onClick={() => void state.save()}>
        {t("settings.saveResourceDefaults")}
      </Button>
    </div>
  );
}

function EffectiveResources({ config }: { config: GlobalResourceConfig }) {
  const { t } = useTranslation();
  return (
    <MetricDescriptions
      columns={5}
      items={[
        { label: t("settings.effectiveMem"), value: config.effective.memLimit },
        { label: t("settings.effectiveCpu"), value: config.effective.cpuLimit },
        { label: t("settings.restartPolicy"), value: config.effective.restartPolicy },
        { label: t("settings.skillConcurrency"), value: config.effective.maxSkillConcurrency },
        { label: t("settings.browserConcurrency"), value: config.effective.maxBrowserConcurrency },
      ]}
    />
  );
}

function useGlobalResources() {
  const { t } = useTranslation();
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
        memLimit: memLimitToGB(result.memLimit),
        cpuLimit: result.cpuLimit,
        restartPolicy: result.restartPolicy,
      });
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "settings.loadFailed"));
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
      if (!mountedRef.current) return;
      setMessage(t("settings.updatedDefaults", { count: result.affectedPodIds.length }));
      await load();
    } catch (caught) {
      if (mountedRef.current) {
        setError(errorMessage(caught, "settings.saveFailed"));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  return { form, config, busy, error, message, setForm, save };
}
