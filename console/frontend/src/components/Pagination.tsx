import { useId } from "react";
import { Select, Space, Typography } from "@douyinfe/semi-ui";
import { Pagination as SemiPagination } from "@douyinfe/semi-ui";
import type { TablePaginationProps } from "@douyinfe/semi-ui/lib/es/table/interface";
import styles from "./Pagination.module.css";

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE: number = PAGE_SIZE_OPTIONS[0];

interface TablePaginationInput {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export function tablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: TablePaginationInput): TablePaginationProps | false {
  if (total === 0) return false;
  return {
    currentPage: page,
    pageSize,
    total,
    pageSizeOpts: [...PAGE_SIZE_OPTIONS],
    showSizeChanger: false,
    showTotal: true,
    size: "small",
    position: "bottom",
    formatPageText: ({ currentStart = 0, currentEnd = 0, total: currentTotal = 0 } = {}) =>
      `显示第 ${currentStart} 条-第 ${currentEnd} 条，共 ${currentTotal} 条`,
    preventPageChangeOnPageSizeChange: true,
    onPageChange,
    onPageSizeChange,
  };
}

export function renderTablePagination(pagination: TablePaginationProps) {
  const total = pagination.total ?? 0;
  if (total <= 0) return null;
  const page = pagination.currentPage ?? 1;
  const pageSize = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
  return (
    <div className={styles.tablePagination}>
      <span className={styles.info}>{formatRange(page, pageSize, total)}</span>
      <div className={styles.controls}>
        <PageSizeSelect
          pageSize={pageSize}
          onPageSizeChange={(nextPageSize) => pagination.onPageSizeChange?.(nextPageSize)}
        />
        <SemiPagination
          {...pagination}
          pageSize={pageSize}
          showSizeChanger={false}
          showTotal={false}
          size="small"
        />
      </div>
    </div>
  );
}

function formatRange(page: number, pageSize: number, total: number) {
  const currentStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const currentEnd = Math.min(page * pageSize, total);
  return `显示第 ${currentStart} 条-第 ${currentEnd} 条，共 ${total} 条`;
}

interface PageSizeSelectProps {
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
}

export function PageSizeSelect({ pageSize, onPageSizeChange }: PageSizeSelectProps) {
  const labelId = useId();
  const options = PAGE_SIZE_OPTIONS.map((value) => ({ label: String(value), value }));
  return (
    <Space className={styles.pageSize} spacing={6}>
      <span id={labelId} className={styles.visuallyHidden}>
        每页数量
      </span>
      <Typography.Text className={styles.label}>每页</Typography.Text>
      <Select
        aria-labelledby={labelId}
        className={styles.select}
        size="small"
        value={pageSize}
        optionList={options}
        onChange={(value) => {
          const next = Number(Array.isArray(value) ? value[0] : value);
          if (PAGE_SIZE_OPTIONS.includes(next as (typeof PAGE_SIZE_OPTIONS)[number]))
            onPageSizeChange(next);
        }}
      />
      <Typography.Text className={styles.label}>条</Typography.Text>
    </Space>
  );
}
