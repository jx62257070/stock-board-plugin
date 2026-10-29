/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 受限并发映射
 *
 * 与宿主 `src/common/utils/map-with-concurrency.ts` 同口径的进程内实现
 * （插件禁 import 宿主 src/）：最多 concurrency 个任务同时在跑，逐个回填结果。
 */

/**
 * 以受限并发映射一个列表（结果顺序与入参一致）
 * @param items 入参列表
 * @param worker 单项异步任务
 * @param options 并发选项
 * @param options.concurrency 并发上限（≥1）
 * @returns 与入参同序的结果数组（含抛错则整体 reject）
 */
export const mapWithConcurrency = async<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: { concurrency: number },
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(options.concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(lanes);
  return results;
};
