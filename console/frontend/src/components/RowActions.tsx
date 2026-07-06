import { Button, Dropdown, Space } from "@douyinfe/semi-ui";
import type { Container } from "../api";

type Action = { key: string; label: string };

type Props = {
  container: Container;
  actions: Action[];
  onViewLogs: (id: string) => void;
  onOpenQr: (id: string) => void;
  onEditChannels: (id: string) => void;
  onOpenResources: (c: Container) => void;
  onAction: (id: string, key: string) => void;
};

// 行内精简按钮：[日志] [扫码(仅微信)] [编辑通道] [资源] [更多▾]
// 拆分出来便于测试与复用；表格列 render 直接调用 <RowActions />。
export function RowActions({
  container: r,
  actions,
  onViewLogs,
  onOpenQr,
  onEditChannels,
  onOpenResources,
  onAction,
}: Props) {
  const showQr = r.channels?.includes("wechat") ?? false;
  return (
    <Space>
      <Button size="small" onClick={() => onViewLogs(r.userId)}>
        日志
      </Button>
      {showQr && (
        <Button size="small" onClick={() => onOpenQr(r.userId)}>
          扫码
        </Button>
      )}
      <Button size="small" onClick={() => onEditChannels(r.userId)}>
        编辑通道
      </Button>
      <Button size="small" onClick={() => onOpenResources(r)}>
        资源
      </Button>
      <Dropdown
        menu={actions.map((a) => ({
          node: "item",
          name: a.label,
          onClick: () => onAction(r.userId, a.key),
        }))}
      >
        <Button size="small">更多▾</Button>
      </Dropdown>
    </Space>
  );
}
