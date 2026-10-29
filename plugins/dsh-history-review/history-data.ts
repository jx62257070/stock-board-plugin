/**
 * 插件 dsh-history-review · 批量取数层
 *
 * 按指数清单串行拉取全部月 K（同上游连续请求 500ms 错峰，频率红线），
 * 失败向上抛出由调用方决定整体重试。
 */
import { BULL_INDEX_LIST, BULL_SYNC_DELAY_MS } from './constants';
import type { MonthlyBar } from './types';

/**
 * 等待指定毫秒（串行错峰用）
 * @param ms 毫秒数
 * @returns 完成后 resolve
 */
const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

/**
 * 批量拉取全部叠加指数的月 K（串行错峰）
 * @param fetchMonthly 拉取单只指数全部月 K 的函数（sina-kline.ts 构造）
 * @param onStep 每完成一只的回调（已完成数 / 总数 / 指数名），用于同步进度展示
 * @returns symbol → 月 K 序列
 */
export const fetchAllIndexMonthlies = async (
  fetchMonthly: (symbol: string) => Promise<MonthlyBar[]>,
  onStep?: (done: number, total: number, name: string) => void,
): Promise<Record<string, MonthlyBar[]>> => {
  const result: Record<string, MonthlyBar[]> = {};

  for (const [index, ref] of BULL_INDEX_LIST.entries()) {
    if (index > 0) {
      await delay(BULL_SYNC_DELAY_MS);
    }
    onStep?.(index, BULL_INDEX_LIST.length, ref.name);
    result[ref.symbol] = await fetchMonthly(ref.symbol);
  }
  return result;
};
