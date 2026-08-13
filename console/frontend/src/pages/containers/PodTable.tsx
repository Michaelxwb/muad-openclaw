import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button, Table, Tag, Tooltip } from "@douyinfe/semi-ui";
import type { TablePaginationProps } from "@douyinfe/semi-ui/lib/es/table/interface";
import type { Pod, PodAction } from "../../api";
import { ChannelTags } from "../../components/ChannelTags";
import { renderTablePagination } from "../../components/Pagination";
import { RowActions } from "../../components/RowActions";
import { applyStatusTags, podActions, statusTags } from "./model";
import styles from "./PodTable.module.css";

export const POD_TABLE_MIN_WIDTH = 1340;
export const POD_TABLE_SCROLL_X = "100%";

type PodTableStyle = CSSProperties & { "--pod-table-min-width": string };

const POD_TABLE_STYLE: PodTableStyle = {
  "--pod-table-min-width": `${POD_TABLE_MIN_WIDTH}px`,
};

interface Props {
  items: Pod[];
  loading: boolean;
  selectedIds: string[];
  pagination: TablePaginationProps | false;
  onSelected: (ids: string[]) => void;
  onDetail: (id: string) => void;
  onLogs: (id: string) => void;
  onQr: (id: string) => void;
  onEdit: (id: string) => void;
  onAction: (id: string, action: PodAction) => void;
}

export function PodTable(props: Props) {
  const { t } = useTranslation();
  return (
    <Table
      className={styles.podTable}
      columns={podColumns(props, t) as never}
      dataSource={props.items}
      loading={props.loading}
      pagination={props.pagination}
      renderPagination={renderTablePagination}
      rowKey="podId"
      scroll={{ x: POD_TABLE_SCROLL_X }}
      size="small"
      style={POD_TABLE_STYLE}
      rowSelection={{
        selectedRowKeys: props.selectedIds,
        onChange: (keys: (string | number)[] | undefined) =>
          props.onSelected((keys ?? []).map(String)),
      }}
    />
  );
}

function renderResourceCell(used: string, total: string, percent: number) {
  const pct = percent > 0 ? `${percent.toFixed(1)}%` : "—";
  return (
    <div className={styles.resourceCell}>
      {used && (
        <span className="mono">
          {used}
          {total ? ` / ${total}` : ""}
        </span>
      )}
      <span className={styles.mutedText}>{pct}</span>
    </div>
  );
}

// 内存显示压成短单位：>=1024MiB 转 GiB，避免「456 MiB / 3072 MiB」在窄列里换行。
function formatMiB(mib: number): string {
  if (mib >= 1024) {
    const gib = mib / 1024;
    return `${gib % 1 === 0 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  }
  return `${mib} MiB`;
}

function podColumns(actions: Props, t: (key: string, options?: Record<string, unknown>) => string) {
  return [
    ...podDataColumns(actions.onDetail, t),
    {
      title: t("common.actions"),
      key: "ops",
      width: 220,
      render: (_: unknown, pod: Pod) => (
        <RowActions
          pod={pod}
          actions={podActions(t)}
          onViewLogs={actions.onLogs}
          onOpenQr={actions.onQr}
          onEdit={actions.onEdit}
          onAction={actions.onAction}
        />
      ),
    },
  ];
}

function podDataColumns(
  onDetail: (id: string) => void,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  return [
    {
      title: "Pod",
      key: "podId",
      width: 180,
      render: (_: unknown, pod: Pod) => (
        <div className={styles.identityCell}>
          <Button
            className={styles.linkButton}
            theme="borderless"
            size="small"
            onClick={() => onDetail(pod.podId)}
          >
            {pod.displayName}
          </Button>
          <div className={`mono ${styles.mutedText}`}>{pod.podId}</div>
        </div>
      ),
    },
    {
      title: t("pod.channelsColumn"),
      key: "channels",
      width: 140,
      render: (_: unknown, pod: Pod) => <ChannelTags pod={pod} />,
    },
    {
      title: t("pod.capacityColumn"),
      key: "capacity",
      width: 95,
      render: (_: unknown, pod: Pod) => <CapacityCell pod={pod} onOpen={onDetail} />,
    },
    {
      title: t("pod.generationColumn"),
      key: "generation",
      width: 105,
      render: (_: unknown, pod: Pod) => <GenerationCell pod={pod} />,
    },
    {
      title: t("common.status"),
      key: "state",
      width: 85,
      render: (_: unknown, pod: Pod) => <PodStatus pod={pod} />,
    },
    {
      title: t("pod.imageColumn"),
      dataIndex: "imageTag",
      key: "imageTag",
      width: 180,
      className: "mono",
    },
    {
      title: "CPU",
      key: "cpu",
      width: 120,
      render: (_: unknown, pod: Pod) =>
        renderResourceCell(
          pod.cpuMills > 0 ? `${pod.cpuMills}m` : "",
          pod.cpuLimitCores ? t("pod.cpuCores", { value: pod.cpuLimitCores }) : "",
          pod.cpuPercent,
        ),
    },
    {
      title: t("pod.memoryColumn"),
      key: "mem",
      width: 160,
      render: (_: unknown, pod: Pod) =>
        renderResourceCell(
          formatMiB(pod.memMiB),
          pod.memLimitMiB > 0 ? formatMiB(pod.memLimitMiB) : "",
          pod.memLimitMiB > 0 ? (pod.memMiB / pod.memLimitMiB) * 100 : 0,
        ),
    },
  ];
}

function CapacityCell({ pod, onOpen }: { pod: Pod; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <Button
      className={styles.capacityButton}
      theme="borderless"
      size="small"
      onClick={() => onOpen(pod.podId)}
    >
      <div>
        <span className="mono">
          {pod.userCount}/{pod.maxUsers}
        </span>
        <div className={styles.mutedText}>
          {t("pod.slotsRemaining", { count: pod.availableSlots })}
        </div>
      </div>
    </Button>
  );
}

function GenerationCell({ pod }: { pod: Pod }) {
  const { t } = useTranslation();
  const status = applyStatusTags(t)[pod.lastApplyStatus] ?? {
    label: pod.lastApplyStatus,
    color: "grey" as const,
  };
  const content = (
    <div>
      <Tag color={status.color} size="small">
        {status.label}
      </Tag>
      <div className={`mono ${styles.mutedText}`}>
        {pod.appliedGeneration}/{pod.configGeneration}
      </div>
    </div>
  );
  return pod.lastApplyError ? <Tooltip content={pod.lastApplyError}>{content}</Tooltip> : content;
}

function PodStatus({ pod }: { pod: Pod }) {
  const { t } = useTranslation();
  const status = statusTags(t)[pod.state] ?? {
    label: pod.state,
    color: "grey" as const,
    dot: "#8899aa",
  };
  return (
    <Tag color={status.color}>
      <span className={styles.statusDot} style={{ background: status.dot }} />
      {status.label}
    </Tag>
  );
}
