import { useCallback, useEffect, useState } from "react";
import { Table, Input, Button, Space, Skeleton } from "@douyinfe/semi-ui";
import { api, AuditEntry } from "../api";
import { Pagination } from "../components/Pagination";

export function Audit() {
  const [actor, setActor] = useState("");
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const res = await api.audit(actor, offset, pageSize);
      setRows(res.items);
      setTotal(res.total);
    } catch {
      /* keep stale data */
    } finally {
      setLoading(false);
    }
  }, [actor, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { title: "时间", dataIndex: "ts", key: "ts", width: 160, render: (_: unknown, r: AuditEntry) => new Date(r.ts).toLocaleString() },
    { title: "操作人", dataIndex: "actor", key: "actor", width: 100 },
    { title: "动作", dataIndex: "action", key: "action" },
    { title: "目标", dataIndex: "target", key: "target", width: 100, render: (_: unknown, r: AuditEntry) => r.target || "—" },
    { title: "结果", dataIndex: "payload", key: "payload", width: 80 },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div />
        <Space>
          <Input placeholder="按操作人过滤" value={actor} onChange={setActor} style={{ width: 180 }} />
          <Button onClick={() => { setPage(1); load(); }}>查询</Button>
        </Space>
      </div>

      <Skeleton placeholder={loading ? <Skeleton.Paragraph rows={5} /> : undefined} loading={loading}>
        <Table columns={columns as never} dataSource={rows} pagination={false} rowKey="id" size="small" />
      </Skeleton>

      <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
    </div>
  );
}
