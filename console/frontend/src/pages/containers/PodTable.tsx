import { Button, Table, Tag, Tooltip } from "@douyinfe/semi-ui";
import type { Pod, PodAction } from "../../api";
import { ChannelTags } from "../../components/ChannelTags";
import { RowActions } from "../../components/RowActions";
import { APPLY_STATUS_TAGS, POD_ACTIONS, STATUS_TAGS } from "./model";

interface Props {
  items: Pod[];
  loading: boolean;
  selectedIds: string[];
  onSelected: (ids: string[]) => void;
  onDetail: (id: string) => void;
  onLogs: (id: string) => void;
  onQr: (id: string) => void;
  onChannels: (id: string) => void;
  onResources: (pod: Pod) => void;
  onAction: (id: string, action: PodAction) => void;
}

export function PodTable(props: Props) {
  return (
    <Table
      columns={podColumns(props) as never}
      dataSource={props.items}
      loading={props.loading}
      pagination={false}
      rowKey="podId"
      size="small"
      rowSelection={{
        selectedRowKeys: props.selectedIds,
        onChange: (keys: (string | number)[] | undefined) =>
          props.onSelected((keys ?? []).map(String)),
      }}
    />
  );
}

function podColumns(actions: Props) {
  return [
    ...podDataColumns(actions.onDetail),
    {
      title: "操作",
      key: "ops",
      width: 280,
      render: (_: unknown, pod: Pod) => (
        <RowActions
          pod={pod}
          actions={POD_ACTIONS}
          onOpenDetail={actions.onDetail}
          onViewLogs={actions.onLogs}
          onOpenQr={actions.onQr}
          onEditChannels={actions.onChannels}
          onOpenResources={actions.onResources}
          onAction={actions.onAction}
        />
      ),
    },
  ];
}

function podDataColumns(onDetail: (id: string) => void) {
  return [
    {
      title: "Pod",
      key: "podId",
      width: 170,
      render: (_: unknown, pod: Pod) => (
        <div style={{ minWidth: 0 }}>
          <Button
            theme="borderless"
            size="small"
            onClick={() => onDetail(pod.podId)}
            style={{ height: "auto", padding: 0, fontWeight: 600 }}
          >
            {pod.displayName}
          </Button>
          <div className="mono" style={{ color: "var(--semi-color-text-2)", fontSize: 12 }}>
            {pod.podId}
          </div>
        </div>
      ),
    },
    {
      title: "消息通道",
      key: "channels",
      width: 180,
      render: (_: unknown, pod: Pod) => <ChannelTags pod={pod} />,
    },
    {
      title: "用户容量",
      key: "capacity",
      width: 110,
      render: (_: unknown, pod: Pod) => <CapacityCell pod={pod} onOpen={onDetail} />,
    },
    {
      title: "配置状态",
      key: "generation",
      width: 120,
      render: (_: unknown, pod: Pod) => <GenerationCell pod={pod} />,
    },
    {
      title: "状态",
      key: "state",
      width: 90,
      render: (_: unknown, pod: Pod) => <PodStatus pod={pod} />,
    },
    { title: "镜像", dataIndex: "imageTag", key: "imageTag", width: 160, className: "mono" },
    {
      title: "CPU",
      key: "cpu",
      width: 65,
      render: (_: unknown, pod: Pod) => `${pod.cpuPercent.toFixed(1)}%`,
    },
    {
      title: "内存",
      key: "mem",
      width: 75,
      render: (_: unknown, pod: Pod) => `${pod.memMiB} MiB`,
    },
  ];
}

function CapacityCell({ pod, onOpen }: { pod: Pod; onOpen: (id: string) => void }) {
  return (
    <Button
      theme="borderless"
      size="small"
      onClick={() => onOpen(pod.podId)}
      style={{ height: "auto", padding: 0, textAlign: "left" }}
    >
      <div>
        <span className="mono">
          {pod.userCount}/{pod.maxUsers}
        </span>
        <div style={{ color: "var(--semi-color-text-2)", fontSize: 12 }}>
          剩余 {pod.availableSlots}
        </div>
      </div>
    </Button>
  );
}

function GenerationCell({ pod }: { pod: Pod }) {
  const status = APPLY_STATUS_TAGS[pod.lastApplyStatus] ?? {
    label: pod.lastApplyStatus,
    color: "grey" as const,
  };
  const content = (
    <div>
      <Tag color={status.color} size="small">
        {status.label}
      </Tag>
      <div className="mono" style={{ color: "var(--semi-color-text-2)", fontSize: 12 }}>
        {pod.appliedGeneration}/{pod.configGeneration}
      </div>
    </div>
  );
  return pod.lastApplyError ? <Tooltip content={pod.lastApplyError}>{content}</Tooltip> : content;
}

function PodStatus({ pod }: { pod: Pod }) {
  const status = STATUS_TAGS[pod.state] ?? {
    label: pod.state,
    color: "grey" as const,
    dot: "#8899aa",
  };
  return (
    <Tag color={status.color}>
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          marginRight: 5,
          verticalAlign: "middle",
          background: status.dot,
          borderRadius: "50%",
        }}
      />
      {status.label}
    </Tag>
  );
}
