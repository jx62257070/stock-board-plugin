/**
 * 插件 dsh-history-review · 静态周 K 数据
 *
 * 「历史牛熊复盘」的行情数据是**死数据**：轮次窗口与阶段区间均为历史事实，
 * 不会随行情变动，因此开发期一次性拉好周 K（gen-weekly-kline.mjs，腾讯源）
 * 存为 `data/weekly-kline.json` 随插件打包，运行时零请求、零存储。
 * 进行中轮次（如「本轮科技 AI 抱团」）的数据推进时，重跑生成脚本并重新构建即可。
 */
import rawSeries from './data/weekly-kline.json';
import type { KlineBar } from './types';

/**
 * 紧凑元组 → 周 K 单根（月字段取周截止日的年月，供窗口 / 阶段按月比对）
 * @param tuple [date, open, high, low, close, volume]
 * @returns 周 K
 */
const toBar = (tuple: unknown): KlineBar | null => {
  if (!Array.isArray(tuple) || tuple.length < 6) return null;
  const [date, open, high, low, close, volume] = tuple as [string, number, number, number, number, number];
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (!Number.isFinite(volume)) return null;
  return { date, month: date.slice(0, 7), open, high, low, close, volume };
};

/**
 * 符号 → 周 K 序列（升序；脏行过滤，空序列不进表）
 * @returns 静态周 K 全集
 */
const buildSeries = (): Readonly<Record<string, readonly KlineBar[]>> => {
  const result: Record<string, readonly KlineBar[]> = {};
  for (const [symbol, tuples] of Object.entries(rawSeries)) {
    const bars = (Array.isArray(tuples) ? tuples : [])
      .map(toBar)
      .filter((bar): bar is KlineBar => bar !== null);
    if (bars.length > 0) result[symbol] = bars;
  }
  return result;
};

/** 静态周 K 全集（symbol → 周 K 序列，升序；模块加载时构建一次） */
export const WEEKLY_SERIES = buildSeries();
