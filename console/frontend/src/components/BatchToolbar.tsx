import { useState } from "react";
import { Button, Space, Modal, RadioGroup, Toast } from "@douyinfe/semi-ui";
import { api } from "../api";

interface Props {
  selectedIds: string[];
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function BatchToolbar({ selectedIds, onBatchUpgrade, onBatchDelete }: Props) {
  const someSelected = selectedIds.length > 0;

  function handleUpgrade() {
    if (!someSelected) return;
    Modal.confirm({
      title: "确认批量升级",
      content: `将对 ${selectedIds.length} 个已勾选 Pod 执行批量升级。`,
      onOk: onBatchUpgrade,
    });
  }

  function handleDelete() {
    if (selectedIds.length === 0) return;
    let deleteState = false;
    Modal.warning({
      title: "确认批量删除",
      content: (
        <Space vertical align="start">
          <div>确定删除 {selectedIds.length} 个已勾选 Pod？</div>
          <DeleteStateChoice onChange={(next) => (deleteState = next)} />
        </Space>
      ),
      onOk: async () => {
        try {
          const results = await Promise.allSettled(
            selectedIds.map((id) => api.deletePod(id, deleteState)),
          );
          const failed = results.filter((r) => r.status === "rejected");
          if (failed.length === 0) {
            Toast.success(`已删除 ${selectedIds.length} 个 Pod`);
          } else {
            Toast.warning(
              `删除完成：${selectedIds.length - failed.length} 成功，${failed.length} 失败`,
            );
          }
          onBatchDelete(selectedIds);
        } catch (caught) {
          Toast.error(caught instanceof Error ? caught.message : "批量删除 Pod 失败");
        }
      },
    });
  }

  return (
    <Space spacing={4}>
      <Button onClick={handleUpgrade} disabled={!someSelected}>
        批量升级
      </Button>
      <Button type="danger" onClick={handleDelete} disabled={!someSelected}>
        批量删除
      </Button>
    </Space>
  );
}

function DeleteStateChoice({ onChange }: { onChange: (deleteState: boolean) => void }) {
  const [value, setValue] = useState("retain");
  return (
    <RadioGroup
      value={value}
      direction="vertical"
      options={[
        { value: "retain", label: "保留 PVC，后续可在创建同名 Pod 时显式接管" },
        { value: "delete", label: "删除 PVC，workspace、记忆、会话和 private Skill 将永久丢失" },
      ]}
      onChange={(event) => {
        const next = String(event.target.value);
        setValue(next);
        onChange(next === "delete");
      }}
    />
  );
}
