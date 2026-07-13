import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Table, Tag, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Platform } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner, ListToolbar, PageSection } from "../ConsolePage";
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
    <PageSection title="业务平台">
      <FeedbackBanner error={state.error} />
      <ListToolbar
        actions={
          <Space>
            <Tag>{state.items.length} 个平台</Tag>
            <Button theme="solid" onClick={openCreate}>
              增加平台
            </Button>
          </Space>
        }
      />
      <Table
        columns={platformColumns(openEdit, state.refresh) as never}
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
    </PageSection>
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

function platformColumns(onEdit: (platform: Platform) => void, onDeleted: () => Promise<void>) {
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
        <Space>
          <Button size="small" onClick={() => onEdit(platform)}>
            编辑
          </Button>
          <DeletePlatformButton platform={platform} onDeleted={onDeleted} />
        </Space>
      ),
    },
  ];
}

function DeletePlatformButton({
  platform,
  onDeleted,
}: {
  platform: Platform;
  onDeleted: () => Promise<void>;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deletePlatform(platform.platform);
      Toast.success("平台已删除");
      setVisible(false);
      await onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除平台失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="small" type="danger" onClick={() => setVisible(true)}>
        删除
      </Button>
      <Modal
        className="standard-modal"
        title={`删除 ${platform.displayName}`}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => void remove()}
        okText="删除"
        confirmLoading={busy}
        okButtonProps={{ type: "danger" as const }}
      >
        <FeedbackBanner error={error} />
        <p className="hint">删除后会移除该平台配置，并清理所有用户绑定的该平台 API key。</p>
      </Modal>
    </>
  );
}
