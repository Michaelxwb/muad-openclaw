import { Select, Button } from "@douyinfe/semi-ui";

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}

const SIZE_OPTIONS = [
  { value: 10, label: "10 条/页" },
  { value: 20, label: "20 条/页" },
  { value: 50, label: "50 条/页" },
  { value: 100, label: "100 条/页" },
];

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: Props) {
  if (total === 0) return null;
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: 12,
        fontSize: 13,
        color: "var(--semi-color-text-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Select
          value={pageSize}
          optionList={SIZE_OPTIONS}
          onChange={(v) => onPageSizeChange(v as number)}
          style={{ width: 120 }}
          size="small"
        />
        <span>
          第 {page}/{totalPages} 页 共 {total} 条
        </span>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Button size="small" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          上一页
        </Button>
        <Button size="small" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}
