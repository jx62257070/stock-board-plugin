/**
 * 插件 dsh-bull-review（历史复盘）· 指标回算
 *
 * 全部是**纯函数**：输入月 K 序列与轮次档案，输出统计结果，不发请求、不碰库 ——
 * 页面上所有数字（涨幅 / 回撤 / 时长）都从这里算出来，硬编码文案只做定性结论。
 * 月份统一用 `YYYY-MM` 字符串字典序比较，等价于时间先后。
 */
import type {
  MonthlyBar,
  ReviewBearStats,
  ReviewRoundMeta,
  ReviewRoundStats,
} from './types';

/**
 * 截取月份区间内的月 K（含首尾）
 * @param bars 月 K 序列（升序）
 * @param startMonth 起始月（YYYY-MM，含）
 * @param endMonth 结束月（YYYY-MM，含）
 * @returns 区间内序列
 */
export const sliceBarsInRange = (
  bars: readonly MonthlyBar[],
  startMonth: string,
  endMonth: string,
): MonthlyBar[] => bars.filter((bar) => bar.month >= startMonth && bar.month <= endMonth);

/**
 * 取收盘最高的月 K
 * @param bars 月 K 序列
 * @returns 顶点月 K；空序列为 undefined
 */
export const findPeakBar = (bars: readonly MonthlyBar[]): MonthlyBar | undefined =>
  bars.reduce<MonthlyBar | undefined>(
    (best, bar) => (best === undefined || bar.close > best.close ? bar : best),
    undefined,
  );

/**
 * 取收盘最低的月 K
 * @param bars 月 K 序列
 * @returns 低点月 K；空序列为 undefined
 */
export const findTroughBar = (bars: readonly MonthlyBar[]): MonthlyBar | undefined =>
  bars.reduce<MonthlyBar | undefined>(
    (best, bar) => (best === undefined || bar.close < best.close ? bar : best),
    undefined,
  );

/**
 * 计算涨跌幅
 * @param from 基准值
 * @param to 目标值
 * @returns 涨跌幅（%，`to < from` 时为负）
 */
export const calcChangePercent = (from: number, to: number): number =>
  from > 0 ? ((to - from) / from) * 100 : 0;

/**
 * 计算两个月份之间的间隔数
 * @param fromMonth 起始月（YYYY-MM）
 * @param toMonth 结束月（YYYY-MM）
 * @returns 间隔月数（`to < from` 时为 0）
 */
export const countMonths = (fromMonth: string, toMonth: string): number => {
  const [fromYear, fromMonthPart] = fromMonth.split('-').map(Number);
  const [toYear, toMonthPart] = toMonth.split('-').map(Number);
  if (fromYear === undefined || toYear === undefined) return 0;
  return Math.max(0, (toYear - fromYear) * 12 + ((toMonthPart ?? 1) - (fromMonthPart ?? 1)));
};

/**
 * 回算一轮牛市行情的统计指标
 *
 * 起点 = 窗口内首根月 K；顶点 = `[start, peak]` 内收盘最高（peak 为硬编码的历史顶月，
 * 只用来圈定搜索范围，顶点月份以数据为准）；低点 = `[顶点月, end]` 内收盘最低。
 * @param bars 该轮叠加指数的全量月 K（升序）
 * @param round 轮次档案
 * @returns 统计结果；窗口内数据不足两根时为 null
 */
export const buildRoundStats = (
  bars: readonly MonthlyBar[],
  round: ReviewRoundMeta,
): ReviewRoundStats | null => {
  const inWindow = sliceBarsInRange(bars, round.window.start, round.window.end);
  const startBar = inWindow[0];
  if (!startBar || inWindow.length < 2) return null;

  const peakBar = findPeakBar(sliceBarsInRange(bars, round.window.start, round.window.peak));
  const endBar = inWindow[inWindow.length - 1];
  if (!peakBar || !endBar) return null;

  const troughBar = findTroughBar(sliceBarsInRange(bars, peakBar.month, round.window.end));
  if (!troughBar) return null;

  return {
    startMonth: startBar.month,
    startClose: startBar.close,
    peakMonth: peakBar.month,
    peakClose: peakBar.close,
    gainPercent: calcChangePercent(startBar.close, peakBar.close),
    troughMonth: troughBar.month,
    troughClose: troughBar.close,
    drawdownPercent: calcChangePercent(peakBar.close, troughBar.close),
    monthsToPeak: countMonths(startBar.month, peakBar.month),
    endMonth: endBar.month,
    endClose: endBar.close,
  };
};

/**
 * 回算一轮熊市行情的统计指标
 *
 * 顶部 = 窗口起点首根月 K 的收盘（熊市从顶起算）；底部 = `[start, trough]` 内收盘最低
 * （trough 为硬编码的历史底月参考，只用来圈定搜索范围）；反弹 = 底部到窗口末之间的最高收盘。
 * @param bars 该轮叠加指数的全量月 K（升序）
 * @param round 轮次档案
 * @returns 统计结果；窗口内数据不足两根时为 null
 */
export const buildBearStats = (
  bars: readonly MonthlyBar[],
  round: ReviewRoundMeta,
): ReviewBearStats | null => {
  const inWindow = sliceBarsInRange(bars, round.window.start, round.window.end);
  const startBar = inWindow[0];
  if (!startBar || inWindow.length < 2) return null;

  const troughBar = findTroughBar(sliceBarsInRange(bars, round.window.start, round.window.peak));
  const endBar = inWindow[inWindow.length - 1];
  if (!troughBar || !endBar) return null;

  const bounceBar = findPeakBar(sliceBarsInRange(bars, troughBar.month, round.window.end));
  if (!bounceBar) return null;

  return {
    startMonth: startBar.month,
    peakClose: startBar.close,
    troughMonth: troughBar.month,
    troughClose: troughBar.close,
    drawdownPercent: calcChangePercent(startBar.close, troughBar.close),
    bouncePercent: calcChangePercent(troughBar.close, bounceBar.close),
    monthsToTrough: countMonths(startBar.month, troughBar.month),
    monthsTotal: countMonths(startBar.month, endBar.month),
    endMonth: endBar.month,
    endClose: endBar.close,
  };
};
