import type { ReactNode } from "react";
import { Descriptions, Empty, Space, Spin, Tag } from "@douyinfe/semi-ui";
import type { Pod, PodResourceConfig } from "../../api";
import { channelMeta } from "../../channels";
import styles from "../PodDetail.module.css";

interface DefinitionRow {
  label: string;
  value: ReactNode;
}

export function ChannelTab({ pod }: { pod: Pod }) {
  if (pod.channels.length === 0) return <Empty description="未配置消息通道" />;
  return (
    <div className={styles.channelList}>
      {pod.channels.map((channel) => (
        <ChannelRow pod={pod} channel={channel} key={channel} />
      ))}
    </div>
  );
}

function ChannelRow({ pod, channel }: { pod: Pod; channel: string }) {
  const meta = channelMeta(channel);
  const connected = pod.channelStatuses?.[channel];
  const configured = pod.channelConfigs?.[channel]?.secretConfigured ?? channel === "wechat";
  return (
    <div className={styles.channelRow}>
      <span>
        {meta.icon} {meta.label}
      </span>
      <Space>
        <Tag color={configured ? "green" : "orange"}>{configured ? "已配置" : "待配置"}</Tag>
        <Tag color={connected === undefined ? "grey" : connected ? "green" : "red"}>
          {connected === undefined ? "未知" : connected ? "在线" : "离线"}
        </Tag>
      </Space>
    </div>
  );
}

export function ConfigTab({ pod }: { pod: Pod }) {
  const converged = pod.generationLag === 0 && pod.lastApplyStatus === "applied";
  const rows: DefinitionRow[] = [
    { label: "期望 generation", value: pod.configGeneration },
    { label: "已应用 generation", value: pod.appliedGeneration },
    {
      label: "收敛状态",
      value: (
        <Tag color={converged ? "green" : "orange"}>
          {converged ? "已收敛" : `未收敛（lag ${pod.generationLag}）`}
        </Tag>
      ),
    },
    { label: "应用状态", value: pod.lastApplyStatus },
    { label: "应用错误", value: pod.lastApplyError || "-" },
    {
      label: "Runtime Guard",
      value: (
        <Tag color={pod.runtimeGuardHealthy ? "green" : "red"}>
          {pod.runtimeGuardHealthy ? "健康" : "异常"}
        </Tag>
      ),
    },
    {
      label: "模型覆盖",
      value: pod.modelOverride.keyConfigured
        ? pod.modelOverride.keyFingerprint || "已配置"
        : "继承全局",
    },
    { label: "Service Token", value: pod.serviceTokenFingerprint },
  ];
  return <DefinitionList rows={rows} />;
}

export function ResourceTab({ resources }: { resources: PodResourceConfig | null }) {
  if (!resources) return <Spin />;
  const rows: DefinitionRow[] = [
    { label: "有效内存上限", value: resources.effective.memLimit },
    { label: "Pod 内存覆盖", value: resources.overrides.memLimit || "继承" },
    { label: "有效 CPU 上限", value: resources.effective.cpuLimit },
    { label: "Pod CPU 覆盖", value: resources.overrides.cpuLimit || "继承" },
    { label: "重启策略", value: resources.effective.restartPolicy },
    {
      label: "Skill 并发",
      value: `${resources.effective.maxSkillConcurrency}（覆盖 ${resources.overrides.maxSkillConcurrency || "继承"}）`,
    },
    {
      label: "Browser 并发",
      value: `${resources.effective.maxBrowserConcurrency}（覆盖 ${resources.overrides.maxBrowserConcurrency || "继承"}）`,
    },
    { label: "内存告警阈值", value: `${resources.memoryAlertThresholdMiB} MiB` },
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
