import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Skeleton, Space, Table, Tag } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import { api } from "../../api";
import type { AuditEntry, AuditQuery } from "../../api";
import { FeedbackBanner, ListToolbar, PageSection } from "../../components/ConsolePage";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../../components/Pagination";
import { useMountedRef } from "../../hooks/useMountedRef";

interface AuditFilters {
  actor: string;
  action: string;
  target: string;
}

const EMPTY_FILTERS: AuditFilters = { actor: "", action: "", target: "" };

export function OperationAuditTab({ active }: { active: boolean }) {
  const state = useOperationAuditRecords(active);
  const [inputs, setInputs] = useState<AuditFilters>(EMPTY_FILTERS);
  return (
    <>
      <FeedbackBanner error={state.error} />
      <PageSection>
        <OperationAuditToolbar
          value={inputs}
          onChange={setInputs}
          onSearch={() => state.search(inputs)}
        />
        <OperationAuditTable state={state} />
      </PageSection>
    </>
  );
}

function useOperationAuditRecords(active: boolean) {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    if (!active) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const query = operationAuditQuery(filters, page, pageSize);
      const result = await api.audit(query);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setRows(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current)
        setError(caught instanceof Error ? caught.message : "加载操作审计失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [active, filters, mountedRef, page, pageSize]);
  useEffect(() => void load(), [load]);
  const search = (next: AuditFilters) => {
    setPage(1);
    setFilters(next);
  };
  return { rows, total, loading, error, page, pageSize, setPage, setPageSize, search };
}

function operationAuditQuery(filters: AuditFilters, page: number, pageSize: number): AuditQuery {
  return { ...filters, offset: (page - 1) * pageSize, limit: pageSize };
}

type OperationAuditState = ReturnType<typeof useOperationAuditRecords>;

function OperationAuditTable({ state }: { state: OperationAuditState }) {
  return (
    <Skeleton
      placeholder={state.loading ? <Skeleton.Paragraph rows={5} /> : undefined}
      loading={state.loading}
    >
      <Table
        columns={auditColumns as never}
        dataSource={state.rows}
        pagination={tablePagination({
          page: state.page,
          pageSize: state.pageSize,
          total: state.total,
          onPageChange: state.setPage,
          onPageSizeChange: (size) => {
            state.setPageSize(size);
            state.setPage(1);
          },
        })}
        renderPagination={renderTablePagination}
        rowKey="id"
        size="small"
      />
    </Skeleton>
  );
}

function OperationAuditToolbar(props: {
  value: AuditFilters;
  onChange: (filters: AuditFilters) => void;
  onSearch: () => void;
}) {
  const field = (key: keyof AuditFilters, input: string) =>
    props.onChange({ ...props.value, [key]: input });
  return (
    <ListToolbar
      filters={
        <Space>
          <Input
            aria-label="按操作人过滤"
            placeholder="操作人"
            value={props.value.actor}
            onChange={(input) => field("actor", input)}
            style={{ width: 160 }}
          />
          <Input
            aria-label="按动作过滤"
            placeholder="动作"
            value={props.value.action}
            onChange={(input) => field("action", input)}
            style={{ width: 180 }}
          />
          <Input
            aria-label="按目标过滤"
            placeholder="目标 ID"
            value={props.value.target}
            onChange={(input) => field("target", input)}
            onEnterPress={props.onSearch}
            style={{ width: 160 }}
          />
          <Button
            aria-label="查询审计日志"
            icon={<IconSearch />}
            theme="solid"
            onClick={props.onSearch}
          >
            查询
          </Button>
        </Space>
      }
    />
  );
}

const auditColumns = [
  {
    title: "时间",
    key: "ts",
    width: 170,
    render: (_: unknown, entry: AuditEntry) => new Date(entry.ts).toLocaleString(),
  },
  { title: "Actor", dataIndex: "actor", key: "actor", width: 150 },
  { title: "动作", dataIndex: "action", key: "action", width: 210 },
  {
    title: "目标",
    key: "target",
    width: 210,
    render: (_: unknown, entry: AuditEntry) => (
      <div>
        <span className="mono">{entry.target || "-"}</span>
        <div>
          <Tag size="small">{targetTypeLabel(entry.targetType)}</Tag>
        </div>
      </div>
    ),
  },
  {
    title: "上下文",
    key: "metadata",
    render: (_: unknown, entry: AuditEntry) => auditContext(entry),
  },
  {
    title: "结果",
    key: "result",
    width: 100,
    render: (_: unknown, entry: AuditEntry) => entry.metadata.status || entry.payload,
  },
];

function targetTypeLabel(type: AuditEntry["targetType"]): string {
  const labels: Record<AuditEntry["targetType"], string> = {
    pod: "Pod",
    human_user: "Human User",
    identity: "Identity",
    binding_code: "Binding Code",
    platform: "Platform",
    skill: "Skill",
    generic: "通用",
  };
  return labels[type];
}

function auditContext(entry: AuditEntry) {
  const values = [
    entry.metadata.podId && `pod=${entry.metadata.podId}`,
    entry.metadata.humanUserId && `user=${entry.metadata.humanUserId}`,
    entry.metadata.agentId && `agent=${entry.metadata.agentId}`,
    entry.metadata.identityId && `identity=${entry.metadata.identityId}`,
    entry.metadata.bindingCodeId && `code=${entry.metadata.bindingCodeId}`,
    entry.metadata.platform && `platform=${entry.metadata.platform}`,
    entry.metadata.skillName && `skill=${entry.metadata.skillName}`,
    entry.metadata.generation !== undefined && `generation=${entry.metadata.generation}`,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? <span className="mono">{values.join(" · ")}</span> : "-";
}
