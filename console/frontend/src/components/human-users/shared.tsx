import type { ReactNode } from "react";
import { Tag } from "@douyinfe/semi-ui";
import type { HumanUserStatus } from "../../api";
import styles from "../HumanUsersPanel.module.css";

export type UserStatusFilter = "" | Exclude<HumanUserStatus, "deleting">;

export const USER_STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待绑定" },
  { value: "active", label: "已启用" },
  { value: "disabled", label: "已停用" },
];

export function normalizeStatus(value: string): UserStatusFilter {
  return value === "pending" || value === "active" || value === "disabled" ? value : "";
}

export function UserStatusTag({ status }: { status: HumanUserStatus }) {
  const color =
    status === "active"
      ? "green"
      : status === "disabled"
        ? "grey"
        : status === "deleting"
          ? "red"
          : "orange";
  const label =
    status === "active"
      ? "已启用"
      : status === "disabled"
        ? "已停用"
        : status === "deleting"
          ? "删除中"
          : "待绑定";
  return <Tag color={color}>{label}</Tag>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label>{label}</label>
      {children}
    </div>
  );
}
