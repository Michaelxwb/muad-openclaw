import { Select } from "./Select";
import styles from "./Pagination.module.css";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100].map((n) => ({
  value: String(n),
  label: `${n} 条/页`,
}));

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: Props) {
  if (total === 0) return null;

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className={styles.pagination}>
      <Select
        value={String(pageSize)}
        options={PAGE_SIZE_OPTIONS}
        onChange={(v) => onPageSizeChange(Number(v))}
        minWidth={95}
      />
      <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        &lt; 上一页
      </button>
      <span className={styles.info}>
        第 {page}/{totalPages} 页 共 {total} 条
      </span>
      <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        下一页 &gt;
      </button>
    </div>
  );
}
