import { useState } from "react";
import { Button, Input, Select, Space, Table } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import type { HumanUser, Pod } from "../../api";
import { FeedbackBanner, ListToolbar, MetricDescriptions } from "../ConsolePage";
import { renderTablePagination, tablePagination } from "../Pagination";
import styles from "../HumanUsersPanel.module.css";
import type { HumanUsersState } from "./HumanUsersPanel";
import { DeleteHumanUser } from "./DeleteHumanUser";
import {
  normalizeStatus,
  USER_STATUS_OPTIONS,
  UserStatusTag,
  type UserStatusFilter,
} from "./shared";

interface Props {
  pod: Pod;
  users: HumanUsersState;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDeleted: () => Promise<void>;
}

export function HumanUserList({ pod, users, onCreate, onOpen, onDeleted }: Props) {
  const [search, setSearch] = useState("");
  const submitSearch = () => {
    users.setPage(1);
    users.setQuery(search.trim());
  };
  const filterStatus = (status: UserStatusFilter) => {
    users.setPage(1);
    users.setStatus(status);
  };
  return (
    <>
      <CapacityMetrics pod={pod} />
      <FeedbackBanner error={users.error} />
      <UserToolbar
        search={search}
        status={users.status}
        onSearchChange={setSearch}
        onSearch={submitSearch}
        onStatus={filterStatus}
        onCreate={onCreate}
      />
      <UserTable users={users} onOpen={onOpen} onDeleted={onDeleted} />
    </>
  );
}

function CapacityMetrics({ pod }: { pod: Pod }) {
  return (
    <MetricDescriptions
      items={[
        { label: "已分配用户", value: pod.userCount },
        { label: "用户上限", value: pod.maxUsers },
        { label: "剩余容量", value: pod.availableSlots },
      ]}
    />
  );
}

interface ToolbarProps {
  search: string;
  status: UserStatusFilter;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onStatus: (value: UserStatusFilter) => void;
  onCreate: () => void;
}

function UserToolbar(props: ToolbarProps) {
  return (
    <ListToolbar
      actions={
        <Button theme="solid" onClick={props.onCreate}>
          创建用户
        </Button>
      }
      filters={
        <Space>
          <Input
            prefix={<IconSearch />}
            value={props.search}
            onChange={props.onSearchChange}
            onEnterPress={props.onSearch}
            placeholder="名称、ID 或 agent"
            style={{ width: 200 }}
          />
          <Button aria-label="查询 Human User" icon={<IconSearch />} onClick={props.onSearch} />
          <Select
            value={props.status}
            optionList={USER_STATUS_OPTIONS}
            onChange={(value) => props.onStatus(normalizeStatus(String(value ?? "")))}
            style={{ width: 120 }}
          />
        </Space>
      }
    />
  );
}

function UserTable({
  users,
  onOpen,
  onDeleted,
}: {
  users: HumanUsersState;
  onOpen: (id: string) => void;
  onDeleted: () => Promise<void>;
}) {
  return (
    <Table
      columns={humanUserColumns(onOpen, onDeleted) as never}
      dataSource={users.items}
      rowKey="humanUserId"
      loading={users.loading}
      pagination={tablePagination({
        page: users.page,
        pageSize: users.pageSize,
        total: users.total,
        onPageChange: users.setPage,
        onPageSizeChange: (size) => {
          users.setPageSize(size);
          users.setPage(1);
        },
      })}
      renderPagination={renderTablePagination}
      size="small"
    />
  );
}

function humanUserColumns(onOpen: (id: string) => void, onDeleted: () => Promise<void>) {
  return [
    {
      title: "用户",
      key: "user",
      width: 210,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <div className={styles.primaryText}>{user.displayName}</div>
          <div className={`mono ${styles.secondaryText}`}>{user.humanUserId}</div>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 90,
      render: (_: unknown, user: HumanUser) => <UserStatusTag status={user.status} />,
    },
    { title: "运行 Agent", dataIndex: "agentId", key: "agentId", width: 150, className: "mono" },
    { title: "身份标识", dataIndex: "identityCount", key: "identityCount", width: 80 },
    {
      title: "浏览器",
      key: "browser",
      width: 190,
      render: (_: unknown, user: HumanUser) => (
        <div>
          <span className="mono">{user.browserProfile}</span>
          <div className={styles.secondaryText}>CDP {user.browserCdpPort}</div>
        </div>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_: unknown, user: HumanUser) => (
        <Space spacing={4}>
          <Button size="small" onClick={() => onOpen(user.humanUserId)}>
            详情
          </Button>
          <DeleteHumanUser user={user} compact onDeleted={() => void onDeleted()} />
        </Space>
      ),
    },
  ];
}
