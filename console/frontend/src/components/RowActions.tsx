import { Button, Dropdown, Space } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import type { Pod, PodAction } from "../api";

type Action = { key: PodAction; label: string };

type Props = {
  pod: Pod;
  actions: Action[];
  onViewLogs: (id: string) => void;
  onOpenQr: (id: string) => void;
  onEdit: (id: string) => void;
  onAction: (id: string, key: PodAction) => void;
};

// 行内精简按钮：[日志] [扫码(仅微信)] [编辑] [更多▾]
// 下钻 Pod 详情直接点击列表中的 Pod 名称，这里不重复放入口。
// [编辑] 打开合并弹窗，同时编辑消息通道与资源。
// 拆分出来便于测试与复用；表格列 render 直接调用 <RowActions />。
export function RowActions({ pod, actions, onViewLogs, onOpenQr, onEdit, onAction }: Props) {
  const { t } = useTranslation();
  const showQr = pod.channels.includes("wechat");
  return (
    <Space>
      <Button size="small" onClick={() => onViewLogs(pod.podId)}>
        {t("common.logs")}
      </Button>
      {showQr && (
        <Button size="small" onClick={() => onOpenQr(pod.podId)}>
          {t("common.scanQr")}
        </Button>
      )}
      <Button size="small" onClick={() => onEdit(pod.podId)}>
        {t("common.edit")}
      </Button>
      <Dropdown
        menu={actions.map((a) => ({
          node: "item",
          name: a.label,
          onClick: () => onAction(pod.podId, a.key),
        }))}
      >
        <Button size="small">{t("common.more")}▾</Button>
      </Dropdown>
    </Space>
  );
}
