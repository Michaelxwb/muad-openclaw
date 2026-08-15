import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Descriptions, Empty, Space, Spin, Tag } from "@douyinfe/semi-ui";
import type { Pod, PodResourceConfig } from "../../api";
import { channelMeta } from "../../channels";
import styles from "../PodDetail.module.css";

interface DefinitionRow {
  label: string;
  value: ReactNode;
}

export function ChannelTab({ pod }: { pod: Pod }) {
  const { t } = useTranslation();
  if (pod.channels.length === 0) return <Empty description={t("pod.noChannels")} />;
  return (
    <div className={styles.channelList}>
      {pod.channels.map((channel) => (
        <ChannelRow pod={pod} channel={channel} key={channel} />
      ))}
    </div>
  );
}

function ChannelRow({ pod, channel }: { pod: Pod; channel: string }) {
  const { t } = useTranslation();
  const meta = channelMeta(channel);
  const connected = pod.channelStatuses?.[channel];
  const configured = pod.channelConfigs?.[channel]?.secretConfigured ?? channel === "wechat";
  return (
    <div className={styles.channelRow}>
      <span>
        {meta.icon} {meta.label}
      </span>
      <Space>
        <Tag color={configured ? "green" : "orange"}>
          {configured ? t("pod.channelConfigured") : t("pod.channelPending")}
        </Tag>
        <Tag color={connected === undefined ? "grey" : connected ? "green" : "red"}>
          {connected === undefined
            ? t("common.unknown")
            : connected
              ? t("pod.channelOnline")
              : t("pod.channelOffline")}
        </Tag>
      </Space>
    </div>
  );
}

export function ConfigTab({ pod }: { pod: Pod }) {
  const { t } = useTranslation();
  const converged = pod.generationLag === 0 && pod.lastApplyStatus === "applied";
  const rows: DefinitionRow[] = [
    { label: t("pod.expectedGeneration"), value: pod.configGeneration },
    { label: t("pod.appliedGeneration"), value: pod.appliedGeneration },
    {
      label: t("pod.convergenceStatus"),
      value: (
        <Tag color={converged ? "green" : "orange"}>
          {converged ? t("pod.converged") : t("pod.notConverged", { lag: pod.generationLag })}
        </Tag>
      ),
    },
    { label: t("pod.applyStatus"), value: pod.lastApplyStatus },
    { label: t("pod.applyError"), value: pod.lastApplyError || "-" },
    {
      label: t("pod.runtimeGuard"),
      value: (
        <Tag color={pod.runtimeGuardHealthy ? "green" : "red"}>
          {pod.runtimeGuardHealthy ? t("pod.runtimeGuardHealthy") : t("status.unhealthy")}
        </Tag>
      ),
    },
    { label: t("pod.serviceToken"), value: pod.serviceTokenFingerprint },
  ];
  return <DefinitionList rows={rows} />;
}

export function ResourceTab({ resources }: { resources: PodResourceConfig | null }) {
  const { t } = useTranslation();
  if (!resources) return <Spin />;
  const rows: DefinitionRow[] = [
    { label: t("pod.effectiveMemLimit"), value: resources.effective.memLimit },
    { label: t("pod.podMemOverride"), value: resources.overrides.memLimit || t("pod.inherit") },
    { label: t("pod.effectiveCpuLimit"), value: resources.effective.cpuLimit },
    { label: t("pod.podCpuOverride"), value: resources.overrides.cpuLimit || t("pod.inherit") },
    { label: t("pod.restartPolicy"), value: resources.effective.restartPolicy },
    {
      label: t("pod.maxSkillConcurrency"),
      value: t("pod.overrideValue", {
        effective: resources.effective.maxSkillConcurrency,
        override: resources.overrides.maxSkillConcurrency || t("pod.inherit"),
      }),
    },
    {
      label: t("pod.maxBrowserConcurrency"),
      value: t("pod.overrideValue", {
        effective: resources.effective.maxBrowserConcurrency,
        override: resources.overrides.maxBrowserConcurrency || t("pod.inherit"),
      }),
    },
    {
      label: t("pod.maxLongTaskConcurrency"),
      value: t("pod.overrideValue", {
        effective: resources.effective.maxLongTaskConcurrency,
        override: resources.overrides.maxLongTaskConcurrency || t("pod.inherit"),
      }),
    },
    { label: t("pod.memAlertThreshold"), value: `${resources.memoryAlertThresholdMiB} MiB` },
  ];
  return <DefinitionList rows={rows} />;
}

function DefinitionList({ rows }: { rows: DefinitionRow[] }) {
  return (
    <Descriptions
      data={rows.map((row) => ({ key: row.label, value: row.value }))}
      size="small"
      align="plain"
      row
    />
  );
}
