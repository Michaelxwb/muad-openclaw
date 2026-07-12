import { Button, Dropdown, Space } from "@douyinfe/semi-ui";
import { IconUserGroup } from "@douyinfe/semi-icons";
import type { Pod, PodAction } from "../api";

type Action = { key: PodAction; label: string };

type Props = {
  pod: Pod;
  actions: Action[];
  onOpenDetail: (id: string) => void;
  onViewLogs: (id: string) => void;
  onOpenQr: (id: string) => void;
  onEditChannels: (id: string) => void;
  onOpenResources: (pod: Pod) => void;
  onAction: (id: string, key: PodAction) => void;
};

// 行内精简按钮：[用户管理] [日志] [扫码(仅微信)] [编辑通道] [资源] [更多▾]
// 拆分出来便于测试与复用；表格列 render 直接调用 <RowActions />。
export function RowActions({
  pod,
  actions,
  onOpenDetail,
  onViewLogs,
  onOpenQr,
  onEditChannels,
  onOpenResources,
  onAction,
}: Props) {
  const showQr = pod.channels.includes("wechat");
  return (
    <Space>
      <Button
        size="small"
        theme="solid"
        icon={<IconUserGroup />}
        aria-label="用户管理"
        onClick={() => onOpenDetail(pod.podId)}
      >
        用户管理
      </Button>
      <Button size="small" onClick={() => onViewLogs(pod.podId)}>
        日志
      </Button>
      {showQr && (
        <Button size="small" onClick={() => onOpenQr(pod.podId)}>
          扫码
        </Button>
      )}
      <Button size="small" onClick={() => onEditChannels(pod.podId)}>
        编辑通道
      </Button>
      <Button size="small" onClick={() => onOpenResources(pod)}>
        资源
      </Button>
      <Dropdown
        menu={actions.map((a) => ({
          node: "item",
          name: a.label,
          onClick: () => onAction(pod.podId, a.key),
        }))}
      >
        <Button size="small">更多▾</Button>
      </Dropdown>
    </Space>
  );
}
