'use strict';
/**
 * 通用并发控制工具（保守并发）。
 *
 * 本 skill 的导出/接口调用彼此独立，天然适合并行以缩短整体耗时。但直接无脑
 * 全量并行会同时冲击 MSSW / SOAR 服务器，可能触发限流或超时。因此提供
 * mapLimit 这类"限并发"原语，把并发度控制在 2~3，既显著提速又不至于压垮服务端。
 */

/**
 * 以受限并发度执行一个 async 任务列表。
 * @template T
 * @param {Array<() => Promise<T>>} tasks 返回 Promise 的任务工厂列表
 * @param {number} limit 最大并发数（>=1）
 * @returns {Promise<T[]>} 按输入顺序返回结果；任一失败立即 reject
 */
async function mapLimit(tasks, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, tasks.length || 1));
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await tasks[index]();
    }
  }

  const workers = [];
  const count = Math.min(safeLimit, tasks.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

module.exports = { mapLimit };
