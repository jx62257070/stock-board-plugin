/**
 * 市场宽度 · 快照统计与分钟点追加（纯函数）
 *
 * 口径自宿主 `src/common/utils/compute-market-breadth.ts` 与
 * `src/common/utils/append-breadth-point.ts` 移植：
 * - 涨跌幅非有限数值（停牌/异常）的标的剔除，不计家数不计量；
 * - ARMS = (上涨家数 ÷ 下跌家数) ÷ (上涨成交量 ÷ 下跌成交量)，成交量取 volume（手），
 *   与通达信主流口径一致；分母为 0 时 ARMS/A/D 为 null；
 * - 活跃占比分母为换手率有效（正常交易）家数，停牌股换手率为 null 天然剔除。
 */
import type { FullQuote } from 'stock-sdk';
import { BREADTH_ACTIVE_TURNOVER_THRESHOLD, MINUTE_MS } from './constants';
import type { BreadthPoint, MarketBreadth } from './types';

/**
 * 从全市场快照计算市场宽度统计
 * @param quotes 全市场完整报价列表
 * @returns 市场宽度统计（arms / ad / activeRatio 无法计算时为 null）
 */
export const computeMarketBreadth = (quotes: readonly FullQuote[]): MarketBreadth => {
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;
  let upVol = 0;
  let downVol = 0;
  let activeCount = 0;
  let activeTotal = 0;
  for (const quote of quotes) {
    const pct = quote.changePercent;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;
    const vol = quote.volume ?? 0;
    if (pct > 0) {
      upCount += 1;
      upVol += vol;
    } else if (pct < 0) {
      downCount += 1;
      downVol += vol;
    } else {
      flatCount += 1;
    }
    const turnover = quote.turnoverRate;
    if (typeof turnover === 'number' && Number.isFinite(turnover)) {
      activeTotal += 1;
      if (turnover > BREADTH_ACTIVE_TURNOVER_THRESHOLD) activeCount += 1;
    }
  }
  const ad = downCount > 0 ? upCount / downCount : null;
  const arms = downCount > 0 && downVol > 0 ? upCount / downCount / (upVol / downVol) : null;
  const activeRatio = activeTotal > 0 ? (activeCount / activeTotal) * 100 : null;
  return {
    upCount,
    downCount,
    flatCount,
    upVol,
    downVol,
    ad,
    arms,
    activeCount,
    activeTotal,
    activeRatio,
  };
};

/**
 * 追加一个分钟点（同分钟覆盖，纯函数）
 *
 * 30s 轮询每轮产生一点，同一分钟重复采样取最后一次（末次快照最新）；
 * 结果按时间升序返回，不改入参数组。
 * @param series 既有分时序列（升序）
 * @param point 新点（time 将向下取整到分钟）
 * @returns 新序列（升序，同分钟仅保留最后一次采样）
 */
export const appendBreadthPoint = (
  series: readonly BreadthPoint[],
  point: BreadthPoint,
): BreadthPoint[] => {
  const minute = Math.floor(point.time / MINUTE_MS) * MINUTE_MS;
  const next = series.filter(
    (item) => Math.floor(item.time / MINUTE_MS) * MINUTE_MS !== minute,
  );
  next.push({ ...point, time: minute });
  return next.sort((a, b) => a.time - b.time);
};

/**
 * 毫秒时间戳 → 本地日键 YYYY-MM-DD（口径同宿主 toDayKey：dayjs 本地时区格式化）
 * @param ts 毫秒时间戳
 * @returns 本地日键
 */
export const toDayKey = (ts: number): string => {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/**
 * 分钟时间戳 → 本地时区当日分钟数（0 ~ 1439）
 * @param ts 毫秒时间戳
 * @returns 当日分钟数
 */
export const toMinuteOfDay = (ts: number): number => {
  const date = new Date(ts);
  return date.getHours() * 60 + date.getMinutes();
};
