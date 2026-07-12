import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Space, Table, Tag } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Platform } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner, SectionHeader } from "../ConsolePage";
import styles from "./PlatformSettings.module.css";
import { PlatformEditorDialog } from "./PlatformEditorDialog";

export const PLATFORM_OPTIONS = [
  { value: "soar", label: "SOAR" },
  { value: "sea_soar", label: "Sea_SOAR" },
  { value: "mssw", label: "MSSW" },
  { value: "xdr", label: "XDR" },
  { value: "sdsp", label: "SDSP" },
];

export function PlatformSettings() {
  const state = usePlatforms();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const available = PLATFORM_OPTIONS.filter(
    (option) => !state.items.some((platform) => platform.platform === option.value),
  );
  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (platform: Platform) => {
    setEditing(platform);
    setEditorOpen(true);
  };
  return (
    <section className={styles.section} aria-labelledby="platform-settings-title">
      <SectionHeader
        title="业务平台"
        extra={
          <Space>
            <Tag>{state.items.length} 个平台</Tag>
            <Button theme="solid" disabled={available.length === 0} onClick={openCreate}>
              增加平台
            </Button>
          </Space>
        }
      />
      <FeedbackBanner error={state.error} />
      <Table
        columns={platformColumns(openEdit) as never}
        dataSource={state.items}
        rowKey="platform"
        loading={state.loading}
        pagination={false}
        size="small"
      />
      <PlatformEditorDialog
        visible={editorOpen}
        platform={editing}
        available={available}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          setEditorOpen(false);
          await state.refresh();
        }}
      />
    </section>
  );
}

function usePlatforms() {
  const [items, setItems] = useState<Platform[]>([]);
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
      setError(caught instanceof Error ? caught.message : "加载业务平台失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { items, loading, error, refresh };
}

function platformColumns(onEdit: (platform: Platform) => void) {
  return [
    {
      title: "平台",
      key: "platform",
      render: (_: unknown, platform: Platform) => (
        <div>
          <strong>{platform.displayName}</strong>
          <div className="mono">{platform.platform}</div>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      render: (_: unknown, platform: Platform) => (
        <Space>
          <Tag color={platform.enabled ? "green" : "grey"}>
            {platform.enabled ? "已启用" : "已停用"}
          </Tag>
          {!platform.adapterInstalled && <Tag color="red">Adapter 缺失</Tag>}
        </Space>
      ),
    },
    { title: "配置指纹", dataIndex: "configFingerprint", key: "configFingerprint" },
    {
      title: "更新时间",
      key: "updatedAt",
      render: (_: unknown, platform: Platform) => new Date(platform.updatedAt).toLocaleString(),
    },
    {
      title: "操作",
      key: "actions",
      render: (_: unknown, platform: Platform) => (
        <Button size="small" onClick={() => onEdit(platform)}>
          编辑
        </Button>
      ),
    },
  ];
}
