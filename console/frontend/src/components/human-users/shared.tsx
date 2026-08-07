import type { ReactNode } from "react";
import { Tag } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { HumanUserStatus } from "../../api";
import styles from "../HumanUsersPanel.module.css";

export type UserStatusFilter = "" | Exclude<HumanUserStatus, "deleting">;

export function userStatusOptions(t: TFunction) {
  return [
    { value: "", label: t("user.statusAll") },
    { value: "pending", label: t("status.pending") },
    { value: "active", label: t("status.active") },
    { value: "disabled", label: t("status.disabled") },
  ];
}

export function normalizeStatus(value: string): UserStatusFilter {
  return value === "pending" || value === "active" || value === "disabled" ? value : "";
}

export function UserStatusTag({ status }: { status: HumanUserStatus }) {
  const { t } = useTranslation();
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
      ? t("status.active")
      : status === "disabled"
        ? t("status.disabled")
        : status === "deleting"
          ? t("status.deleting")
          : t("status.pending");
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
