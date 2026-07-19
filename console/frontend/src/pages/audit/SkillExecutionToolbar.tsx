import { useId } from "react";
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

const STATUS_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "运行中", value: "running" },
  { label: "成功", value: "succeeded" },
  { label: "失败", value: "failed" },
  { label: "已取消", value: "cancelled" },
  { label: "已拒绝", value: "rejected" },
];

const SCOPE_OPTIONS = [
  { label: "全部范围", value: "" },
  { label: "系统", value: "system" },
  { label: "公共", value: "public" },
  { label: "私有", value: "private" },
];

const ENTRY_OPTIONS = [
  { label: "全部模式", value: "" },
  { label: "Managed", value: "managed" },
  { label: "传统脚本", value: "traditional-script" },
  { label: "传统工具", value: "traditional-prompt" },
];

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
  return (
    <FilterInput
      {...props}
      className={styles.queryInput}
      field="q"
      label="模糊搜索执行日志"
      placeholder="Skill、Pod、用户或 Agent"
    />
  );
}

function ExecutionClassFilters(props: FilterProps) {
  const field = (key: keyof SkillExecutionFilters, input: string) =>
    props.onChange({ ...props.value, [key]: input });
  return (
    <>
      <ExecutionSelect
        label="执行状态"
        value={props.value.status}
        options={STATUS_OPTIONS}
        onChange={(value) => field("status", value as SkillExecutionStatus | "")}
      />
      <ExecutionSelect
        label="Skill 范围"
        value={props.value.scope}
        options={SCOPE_OPTIONS}
        onChange={(value) => field("scope", value as SkillScope | "")}
      />
      <ExecutionSelect
        label="执行模式"
        value={props.value.entryType}
        options={ENTRY_OPTIONS}
        onChange={(value) => field("entryType", value as SkillEntryType | "")}
      />
    </>
  );
}

function ExecutionTimeFilters(props: FilterProps) {
  return (
    <>
      <FilterInput
        {...props}
        field="startedFrom"
        label="开始时间"
        placeholder="开始时间"
        type="datetime-local"
      />
      <FilterInput
        {...props}
        field="startedTo"
        label="结束时间"
        placeholder="结束时间"
        type="datetime-local"
      />
    </>
  );
}

function ExecutionToolbarActions(props: Props) {
  return (
    <>
      <Button
        aria-label="查询执行日志"
        icon={<IconSearch />}
        loading={props.busy}
        theme="solid"
        onClick={props.onSearch}
      >
        查询
      </Button>
      <Button aria-label="重置执行日志筛选" icon={<IconRefresh />} onClick={props.onReset} />
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
