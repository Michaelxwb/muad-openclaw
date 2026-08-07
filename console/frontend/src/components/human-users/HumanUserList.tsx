import { useState } from "react";
import { Button, Input, Select, Space, Table } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { HumanUser, Pod } from "../../api";
import { FeedbackBanner, ListToolbar, MetricDescriptions } from "../ConsolePage";
import { renderTablePagination, tablePagination } from "../Pagination";
import styles from "../HumanUsersPanel.module.css";
import type { HumanUsersState } from "./HumanUsersPanel";
import { DeleteHumanUser } from "./DeleteHumanUser";
import { normalizeStatus, userStatusOptions, UserStatusTag, type UserStatusFilter } from "./shared";

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
  const { t } = useTranslation();
  return (
    <MetricDescriptions
      items={[
        { label: t("user.allocatedUsers"), value: pod.userCount },
        { label: t("user.userLimit"), value: pod.maxUsers },
        { label: t("user.availableCapacity"), value: pod.availableSlots },
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
  const { t } = useTranslation();
  return (
    <ListToolbar
      actions={
        <Button theme="solid" onClick={props.onCreate}>
          {t("user.create")}
        </Button>
      }
      filters={
        <Space>
          <Input
            prefix={<IconSearch />}
            value={props.search}
            onChange={props.onSearchChange}
            onEnterPress={props.onSearch}
            placeholder={t("user.searchPlaceholderPod")}
            style={{ width: 200 }}
          />
          <Button
            aria-label={t("user.queryHumanUser")}
            icon={<IconSearch />}
            onClick={props.onSearch}
          />
          <Select
            value={props.status}
            optionList={userStatusOptions(t)}
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
  const { t } = useTranslation();
  return (
    <Table
      columns={humanUserColumns(t, onOpen, onDeleted) as never}
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

function humanUserColumns(
  t: (key: string) => string,
  onOpen: (id: string) => void,
  onDeleted: () => Promise<void>,
) {
  return [
    {
      title: t("user.columnUser"),
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
      title: t("common.status"),
      key: "status",
      width: 90,
      render: (_: unknown, user: HumanUser) => <UserStatusTag status={user.status} />,
    },
    {
      title: t("user.runningAgent"),
      dataIndex: "agentId",
      key: "agentId",
      width: 150,
      className: "mono",
    },
    { title: t("user.identity"), dataIndex: "identityCount", key: "identityCount", width: 110 },
    {
      title: t("user.columnBrowser"),
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
      title: t("common.actions"),
      key: "actions",
      width: 140,
      render: (_: unknown, user: HumanUser) => (
        <Space spacing={4}>
          <Button size="small" onClick={() => onOpen(user.humanUserId)}>
            {t("common.viewDetail")}
          </Button>
          <DeleteHumanUser user={user} compact onDeleted={() => void onDeleted()} />
        </Space>
      ),
    },
  ];
}
