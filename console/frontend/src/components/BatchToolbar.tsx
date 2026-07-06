import { Button, Space, Modal, Toast } from "@douyinfe/semi-ui";
import { api } from "../api";

interface Props {
  selectedIds: string[];
  onReloadSkills: () => void;
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function BatchToolbar({
  selectedIds,
  onReloadSkills,
  onBatchUpgrade,
  onBatchDelete,
}: Props) {
  const someSelected = selectedIds.length > 0;

  function handleReload() {
    if (!someSelected) return;
    Modal.confirm({
      title: "确认重载 Skill",
      content: `将对 ${selectedIds.length} 个已勾选容器执行 Skill 重载。`,
      onOk: onReloadSkills,
    });
  }

  function handleUpgrade() {
    if (!someSelected) return;
    Modal.confirm({
      title: "确认批量升级",
      content: `将对 ${selectedIds.length} 个已勾选容器执行批量升级。`,
      onOk: onBatchUpgrade,
    });
  }

  function handleDelete() {
    if (selectedIds.length === 0) return;
    Modal.warning({
      title: "确认批量删除",
      content: `确定删除 ${selectedIds.length} 个已勾选容器？此操作不可撤销。`,
      onOk: async () => {
        try {
          const results = await Promise.allSettled(
            selectedIds.map((id) => api.deleteContainer(id, false)),
          );
          const failed = results.filter((r) => r.status === "rejected");
          if (failed.length === 0) {
            Toast.success(`已删除 ${selectedIds.length} 个容器`);
          } else {
            Toast.warning(
              `删除完成：${selectedIds.length - failed.length} 成功，${failed.length} 失败`,
            );
          }
          onBatchDelete(selectedIds);
        } catch (e) {
          Toast.error((e as Error).message);
        }
      },
    });
  }

  return (
    <Space spacing={4}>
      <Button onClick={handleReload} disabled={!someSelected}>
        重载 Skill
      </Button>
      <Button onClick={handleUpgrade} disabled={!someSelected}>
        批量升级
      </Button>
      <Button type="danger" onClick={handleDelete} disabled={!someSelected}>
        批量删除
      </Button>
    </Space>
  );
}
