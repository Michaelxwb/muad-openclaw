import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select, Space } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { ListToolbar } from "../../components/ConsolePage";
import type { SkillEntryType, SkillExecutionStatus, SkillScope } from "../../api";
import type { SkillExecutionFilters } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  value: SkillExecutionFilters;
  busy: boolean;
  onChange: (filters: SkillExecutionFilters) => void;
  onSearch: () => void;
  onReset: () => void;
}

type FilterProps = Pick<Props, "value" | "onChange">;

export function SkillExecutionToolbar(props: Props) {
  return (
    <ListToolbar
      filters={
        <Space className={styles.filters} spacing={8} wrap>
          <ExecutionIdentityFilters value={props.value} onChange={props.onChange} />
          <ExecutionClassFilters value={props.value} onChange={props.onChange} />
          <ExecutionTimeFilters value={props.value} onChange={props.onChange} />
          <ExecutionToolbarActions {...props} />
        </Space>
      }
    />
  );
}

function ExecutionIdentityFilters(props: FilterProps) {
  const { t } = useTranslation();
  return (
    <FilterInput
      {...props}
      className={styles.queryInput}
      field="q"
      label={t("execution.searchLogs")}
      placeholder={t("execution.searchPlaceholder")}
    />
  );
}

function ExecutionClassFilters(props: FilterProps) {
  const { t } = useTranslation();
  const statusOptions = useMemo(
    () => [
      { label: t("execution.statusAll"), value: "" },
      { label: t("status.running"), value: "running" },
      { label: t("status.succeeded"), value: "succeeded" },
      { label: t("status.failed"), value: "failed" },
      { label: t("execution.statusCancelled"), value: "cancelled" },
      { label: t("execution.statusRejected"), value: "rejected" },
    ],
    [t],
  );
  const scopeOptions = useMemo(
    () => [
      { label: t("execution.scopeAll"), value: "" },
      { label: t("execution.scopeSystem"), value: "system" },
      { label: t("status.public"), value: "public" },
      { label: t("status.private"), value: "private" },
    ],
    [t],
  );
  const entryOptions = useMemo(
    () => [
      { label: t("execution.entryAll"), value: "" },
      { label: "Managed", value: "managed" },
      { label: t("execution.entryTypeScript"), value: "traditional-script" },
      { label: t("execution.entryTypePrompt"), value: "traditional-prompt" },
    ],
    [t],
  );
  const field = (key: keyof SkillExecutionFilters, input: string) =>
    props.onChange({ ...props.value, [key]: input });
  return (
    <>
      <ExecutionSelect
        label={t("execution.statusFilter")}
        value={props.value.status}
        options={statusOptions}
        onChange={(value) => field("status", value as SkillExecutionStatus | "")}
      />
      <ExecutionSelect
        label={t("execution.scopeFilter")}
        value={props.value.scope}
        options={scopeOptions}
        onChange={(value) => field("scope", value as SkillScope | "")}
      />
      <ExecutionSelect
        label={t("execution.entryTypeFilter")}
        value={props.value.entryType}
        options={entryOptions}
        onChange={(value) => field("entryType", value as SkillEntryType | "")}
      />
    </>
  );
}

function ExecutionTimeFilters(props: FilterProps) {
  const { t } = useTranslation();
  return (
    <>
      <FilterInput
        {...props}
        field="startedFrom"
        label={t("execution.startedAt")}
        placeholder={t("execution.startedAt")}
        type="datetime-local"
      />
      <FilterInput
        {...props}
        field="startedTo"
        label={t("execution.endedAt")}
        placeholder={t("execution.endedAt")}
        type="datetime-local"
      />
    </>
  );
}

function ExecutionToolbarActions(props: Props) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        aria-label={t("execution.searchAria")}
        icon={<IconSearch />}
        loading={props.busy}
        theme="solid"
        onClick={props.onSearch}
      >
        {t("common.search")}
      </Button>
      <Button
        aria-label={t("execution.resetAria")}
        icon={<IconRefresh />}
        onClick={props.onReset}
      />
    </>
  );
}

function FilterInput(
  props: FilterProps & {
    field: keyof SkillExecutionFilters;
    label: string;
    placeholder: string;
    type?: string;
    className?: string;
  },
) {
  return (
    <Input
      aria-label={props.label}
      className={
        props.className ?? (props.type === "datetime-local" ? styles.timeInput : undefined)
      }
      placeholder={props.placeholder}
      type={props.type}
      value={props.value[props.field]}
      onChange={(input) => props.onChange({ ...props.value, [props.field]: input })}
    />
  );
}

function ExecutionSelect(props: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <>
      <span id={labelId} className={styles.visuallyHidden}>
        {props.label}
      </span>
      <Select
        aria-labelledby={labelId}
        value={props.value}
        optionList={props.options}
        onChange={(value) => props.onChange(normalizeSelectValue(value))}
      />
    </>
  );
}

function normalizeSelectValue(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}
