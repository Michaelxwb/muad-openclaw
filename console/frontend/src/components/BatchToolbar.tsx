import { Button, Space, Modal, Toast, Checkbox } from "@douyinfe/semi-ui";
import { api } from "../api";

interface Props {
  selectedIds: string[];
  allIds: string[];
  onSelectAll: (checked: boolean) => void;
  onReloadSkills: () => void;
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function BatchToolbar({
  selectedIds,
  allIds,
  onSelectAll,
  onReloadSkills,
  onBatchUpgrade,
  onBatchDelete,
}: Props) {
  const allSelected = selectedIds.length === allIds.length && allIds.length > 0;
  const someSelected = selectedIds.length > 0;

  function handleSelectAll(checked: boolean) {
    onSelectAll(checked);
  }

  function handleReload() {
    onReloadSkills();
  }

  function handleUpgrade() {
    onBatchUpgrade();
  }

  function handleDelete() {
    if (selectedIds.length === 0) return;
    Modal.warning({
      title: "确认批量删除",
      content: (
        <div>
          <p>确定删除以下 {selectedIds.length} 个容器？此操作不可撤销。</p>
          <div
            style={{
              margin: "8px 0 0",
              maxHeight: 120,
              overflowY: "auto",
              fontFamily: "monospace",
            }}
          >
            {selectedIds.map((id) => (
              <div key={id} style={{ padding: "2px 0" }}>
                {id}
              </div>
            ))}
          </div>
        </div>
      ),
      onOk: async () => {
        try {
          const results = await Promise.all(
            selectedIds.map((id) => api.deleteContainer(id, false)),
          );
          const failed = results.filter((r) => r === undefined);
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

  const indeterminate = selectedIds.length > 0 && !allSelected;

  return (
    <Space spacing={4}>
      <Checkbox
        checked={allSelected}
        indeterminate={indeterminate}
        onChange={(e) => handleSelectAll((e.target as HTMLInputElement).checked)}
      />
      <Button size="small" onClick={handleReload} disabled={!someSelected}>
        重载 Skill
      </Button>
      <Button size="small" onClick={handleUpgrade} disabled={!someSelected}>
        批量升级
      </Button>
      <Button size="small" type="danger" onClick={handleDelete} disabled={!someSelected}>
        批量删除 ({selectedIds.length})
      </Button>
    </Space>
  );
}
