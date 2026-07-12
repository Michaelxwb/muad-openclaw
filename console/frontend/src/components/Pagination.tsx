import { Pagination as SemiPagination } from "@douyinfe/semi-ui";

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: Props) {
  if (total === 0) return null;
  return (
    <SemiPagination
      style={{ marginTop: 16, justifyContent: "flex-end" }}
      currentPage={page}
      pageSize={pageSize}
      total={total}
      pageSizeOpts={[10, 20, 50, 100]}
      showSizeChanger
      showTotal
      size="small"
      prevText="上一页"
      nextText="下一页"
      preventPageChangeOnPageSizeChange
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
    />
  );
}
