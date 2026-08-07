import { useMemo, useState } from "react";
import { Button, Space, Modal, RadioGroup, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { errorMessage } from "../utils/error";

interface Props {
  selectedIds: string[];
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function BatchToolbar({ selectedIds, onBatchUpgrade, onBatchDelete }: Props) {
  const { t } = useTranslation();
  const someSelected = selectedIds.length > 0;

  function handleUpgrade() {
    if (!someSelected) return;
    Modal.confirm({
      title: t("common.batchUpgradeTitle"),
      content: t("common.batchUpgradeContent", { count: selectedIds.length }),
      onOk: onBatchUpgrade,
    });
  }

  function handleDelete() {
    if (selectedIds.length === 0) return;
    let deleteState = false;
    Modal.warning({
      title: t("common.batchDeleteTitle"),
      content: (
        <Space vertical align="start">
          <div>{t("common.batchDeleteContent", { count: selectedIds.length })}</div>
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
            Toast.success(t("common.batchDeleteSuccess", { count: selectedIds.length }));
          } else {
            Toast.warning(
              t("common.batchDeletePartial", {
                success: selectedIds.length - failed.length,
                failed: failed.length,
              }),
            );
          }
          onBatchDelete(selectedIds);
        } catch (caught) {
          Toast.error(errorMessage(caught, "common.batchDeleteFailed"));
        }
      },
    });
  }

  return (
    <Space spacing={4}>
      <Button onClick={handleUpgrade} disabled={!someSelected}>
        {t("common.batchUpgrade")}
      </Button>
      <Button type="danger" onClick={handleDelete} disabled={!someSelected}>
        {t("common.batchDelete")}
      </Button>
    </Space>
  );
}

function DeleteStateChoice({ onChange }: { onChange: (deleteState: boolean) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("retain");
  const options = useMemo(
    () => [
      { value: "retain", label: t("common.deleteStateRetain") },
      { value: "delete", label: t("common.deleteStateDelete") },
    ],
    [t],
  );
  return (
    <RadioGroup
      value={value}
      direction="vertical"
      options={options}
      onChange={(event) => {
        const next = String(event.target.value);
        setValue(next);
        onChange(next === "delete");
      }}
    />
  );
}
