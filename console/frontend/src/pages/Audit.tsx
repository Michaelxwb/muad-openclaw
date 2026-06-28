import { useCallback, useEffect, useState } from "react";
import { api, AuditEntry } from "../api";
import { Pagination } from "../components/Pagination";
import styles from "./Audit.module.css";

export function Audit() {
  const [actor, setActor] = useState("");
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const res = await api.audit(actor, offset, pageSize);
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [actor, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  function onSearch() {
    setPage(1);
    load();
  }

  return (
    <div className={styles.page}>
      {err && <div className="error">{err}</div>}

      <div className={styles.toolbar}>
        <div className={styles.actions}>{/* left side reserved for future actions */}</div>
        <div className={styles.filterRow}>
          <input
            placeholder="按操作人过滤（留空全部）"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
          <button onClick={onSearch}>查询</button>
        </div>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作人</th>
            <th>动作</th>
            <th>目标</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className={styles.skeletonRow}>
                  <td>
                    <div className={styles.skeletonCell} style={{ width: "140px" }} />
                  </td>
                  <td>
                    <div className={styles.skeletonCell} style={{ width: "60px" }} />
                  </td>
                  <td>
                    <div className={styles.skeletonCell} style={{ width: "100px" }} />
                  </td>
                  <td>
                    <div className={styles.skeletonCell} style={{ width: "80px" }} />
                  </td>
                  <td>
                    <div className={styles.skeletonCell} />
                  </td>
                </tr>
              ))
            : rows.map((r) => (
                <tr key={r.id}>
                  <td className={styles.ts}>{new Date(r.ts).toLocaleString()}</td>
                  <td>{r.actor}</td>
                  <td className={styles.action}>{r.action}</td>
                  <td>{r.target || "—"}</td>
                  <td>{r.payload}</td>
                </tr>
              ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                暂无审计记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
      />
    </div>
  );
}
