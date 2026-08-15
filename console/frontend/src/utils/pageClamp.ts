// 分页归一化工具：删除末条记录后 total 缩减，若当前 page 超过最大页，
// 列表会渲染为空。各分页列表在 refresh 成功回调（或 total 变化时）调用
// normalizePage 把 page 回退到最大页。

export function maxPageFor(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 当 total > 0 且 page 超出最大页时，把 page 回退到最大页。 */
export function normalizePage(
  page: number,
  total: number,
  pageSize: number,
  setPage: (page: number) => void,
): void {
  if (total <= 0) return;
  const maxPage = maxPageFor(total, pageSize);
  if (page > maxPage) setPage(maxPage);
}
