import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select, Space } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { ListToolbar } from "../../components/ConsolePage";
import type { SkillScope } from "../../api";
import type { SkillExecutionFilters } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  value: SkillExecutionFilters;
  onChange: (filters: SkillExecutionFilters) => void;
  onSearch: () => void;
  onApply: (patch: Partial<SkillExecutionFilters>) => void;
  onReset: () => void;
}

export function SkillExecutionToolbar(props: Props) {
  const { t } = useTranslation();
  return (
    <ListToolbar
      filters={
        <Space className={styles.filters} spacing={8} wrap>
          <ExecutionSearchControl {...props} />
          <ExecutionClassFilters value={props.value} onApply={props.onApply} />
          <ExecutionTimeFilters value={props.value} onApply={props.onApply} />
          <Button
            aria-label={t("execution.resetAria")}
            icon={<IconRefresh />}
            onClick={props.onReset}
          />
        </Space>
      }
    />
  );
}

function ExecutionSearchControl(props: Props) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        aria-label={t("execution.searchLogs")}
        className={styles.queryInput}
        prefix={<IconSearch />}
        placeholder={t("execution.searchPlaceholder")}
        value={props.value.q}
        onChange={(input) => props.onChange({ ...props.value, q: input })}
        onEnterPress={props.onSearch}
      />
      <Button
        aria-label={t("execution.searchAria")}
        icon={<IconSearch />}
        onClick={props.onSearch}
      />
    </>
  );
}

function ExecutionClassFilters({
  value,
  onApply,
}: {
  value: SkillExecutionFilters;
  onApply: (patch: Partial<SkillExecutionFilters>) => void;
}) {
  const { t } = useTranslation();
  const scopeOptions = useMemo(
    () => [
      { label: t("execution.scopeAll"), value: "" },
      { label: t("execution.scopeSystem"), value: "system" },
      { label: t("status.public"), value: "public" },
      { label: t("status.private"), value: "private" },
    ],
    [t],
  );
  return (
    <ExecutionSelect
      label={t("execution.scopeFilter")}
      value={value.scope}
      options={scopeOptions}
      onChange={(selected) => onApply({ scope: selected as SkillScope | "" })}
    />
  );
}

function ExecutionTimeFilters({
  value,
  onApply,
}: {
  value: SkillExecutionFilters;
  onApply: (patch: Partial<SkillExecutionFilters>) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TimeFilterInput
        field="startedFrom"
        label={t("execution.startedAt")}
        value={value}
        onApply={onApply}
      />
      <TimeFilterInput
        field="startedTo"
        label={t("execution.endedAt")}
        value={value}
        onApply={onApply}
      />
    </>
  );
}

type TimeField = "startedFrom" | "startedTo";

function TimeFilterInput({
  field,
  label,
  value,
  onApply,
}: {
  field: TimeField;
  label: string;
  value: SkillExecutionFilters;
  onApply: (patch: Partial<SkillExecutionFilters>) => void;
}) {
  return (
    <Input
      aria-label={label}
      className={styles.timeInput}
      placeholder={label}
      type="datetime-local"
      value={value[field]}
      onChange={(input) => onApply({ [field]: input })}
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
