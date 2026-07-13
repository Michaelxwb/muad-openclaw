import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Skeleton, Space, Table, Tag } from "@douyinfe/semi-ui";
import { api } from "../api";
import type { AuditEntry, AuditQuery } from "../api";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";

interface AuditFilters {
  actor: string;
  action: string;
  target: string;
}

const EMPTY_FILTERS: AuditFilters = { actor: "", action: "", target: "" };

export function Audit() {
  const state = useAuditRecords();
  const [inputs, setInputs] = useState<AuditFilters>(EMPTY_FILTERS);
  return (
    <div>
      <PageHeader title="审计日志" description="查询管理员、Pod 和运行时产生的关键操作记录" />
      <FeedbackBanner error={state.error} />
      <PageSection>
        <AuditToolbar
          value={inputs}
          onChange={setInputs}
          onSearch={() => {
            state.setPage(1);
            state.setFilters(inputs);
          }}
        />
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
              onPageSizeChange: (pageSize) => {
                state.setPageSize(pageSize);
                state.setPage(1);
              },
            })}
            renderPagination={renderTablePagination}
            rowKey="id"
            size="small"
          />
        </Skeleton>
      </PageSection>
    </div>
  );
}

function useAuditRecords() {
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
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const query: AuditQuery = {
        ...filters,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      };
      const result = await api.audit(query);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setRows(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载审计记录失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [filters, mountedRef, page, pageSize]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, total, loading, error, page, pageSize, setFilters, setPage, setPageSize };
}

function AuditToolbar({
  value,
  onChange,
  onSearch,
}: {
  value: AuditFilters;
  onChange: (filters: AuditFilters) => void;
  onSearch: () => void;
}) {
  const field = (key: keyof AuditFilters, input: string) => onChange({ ...value, [key]: input });
  return (
    <ListToolbar
      filters={
        <Space wrap>
          <Input
            aria-label="按操作人过滤"
            placeholder="操作人"
            value={value.actor}
            onChange={(input) => field("actor", input)}
          />
          <Input
            aria-label="按动作过滤"
            placeholder="动作"
            value={value.action}
            onChange={(input) => field("action", input)}
          />
          <Input
            aria-label="按目标过滤"
            placeholder="目标 ID"
            value={value.target}
            onChange={(input) => field("target", input)}
            onEnterPress={onSearch}
          />
          <Button theme="solid" onClick={onSearch}>
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
    entry.metadata.generation !== undefined && `generation=${entry.metadata.generation}`,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? <span className="mono">{values.join(" · ")}</span> : "-";
}
