/**
 * 市场宽度 · 六大广度指标序列计算（纯函数）
 *
 * 自宿主 `src/common/utils/compute-breadth-indicators.ts` 移植：
 * 口径对齐通达信（ADR/OBOS N=10、OBOS 均线 6、ADL 均线 10、ARMS 平滑均线 21、
 * MCO EMA19/39 + 信号线 MA9）。本地积累的窗口缩短处理：滚动均线 / 比率窗口取
 * min(N, 可用 bar 数)，EMA 自首个值播种递推——积累不足时为「缩短窗口」版本，
 * 随交易日积累趋近标准口径，不返回空白。
 * ADL 为自本地首条 bar 起的累加，只有相对意义（上游历史无法回填）。
 */
import {
  BREADTH_ADL_MA_PERIOD,
  BREADTH_ADR_PERIOD,
  BREADTH_ARMS_MA_PERIOD,
  BREADTH_MCO_FAST_PERIOD,
  BREADTH_MCO_SLOW_PERIOD,
  BREADTH_MCO_SIGNAL_PERIOD,
  BREADTH_OBOS_MA_PERIOD,
  BREADTH_OBOS_PERIOD,
} from './constants';
import type { BreadthDayBar, BreadthIndicatorSeries } from './types';

/**
 * 计算截至下标 i 的滚动均值（窗口 = min(period, i+1)；遇 null 跳过，
 * 窗口内无有效值返回 null）
 * @param values 值序列
 * @param i 当前下标
 * @param period 周期
 * @returns 均值；无有效值时 null
 */
const rollingMean = (values: Array<number | null>, i: number, period: number): number | null => {
  const start = Math.max(0, i - period + 1);
  let sum = 0;
  let count = 0;
  for (let k = start; k <= i; k += 1) {
    const value = values[k];
    if (value === null || value === undefined) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : null;
};

/**
 * EMA 单步递推（alpha = 2 / (period + 1)；当前值为 null 时保持上次值）
 * @param prev 上一个 EMA 值（首个值直接作为种子）
 * @param value 当前输入值
 * @param period 周期
 * @returns 当前 EMA 值（prev 与 value 均为 null 时 null）
 */
const emaStep = (prev: number | null, value: number | null, period: number): number | null => {
  if (value === null) return prev;
  if (prev === null) return value;
  const alpha = 2 / (period + 1);
  return alpha * value + (1 - alpha) * prev;
};

/**
 * 从日 bar 序列计算六大市场广度指标序列
 * @param bars 日 bar 序列（任意顺序，函数内按日期升序重排）
 * @returns 六指标序列（dates 与各指标数组按下标对齐；空输入返回空序列）
 */
export const computeBreadthIndicatorSeries = (
  bars: readonly BreadthDayBar[],
): BreadthIndicatorSeries => {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));

  /** 逐日上涨家数 / 下跌家数 / 家数差 / ARMS（原始输入） */
  const upCounts = sorted.map((bar) => bar.upCount);
  const downCounts = sorted.map((bar) => bar.downCount);
  const dif = sorted.map((bar) => bar.upCount - bar.downCount);
  const armsValues = sorted.map((bar) => bar.arms);

  /** ADL：逐日累加（家数差恒有值，不产生 null） */
  const adl: Array<number | null> = [];
  let adlAcc = 0;
  for (const value of dif) {
    adlAcc += value;
    adl.push(adlAcc);
  }

  /**
   * 计算截至下标 i 的滚动总和（窗口 = min(period, i+1)，家数恒有值不产生 null）
   * @param values 家数序列
   * @param i 当前下标
   * @param period 周期
   * @returns 滚动总和
   */
  const windowSum = (values: number[], i: number, period: number): number => {
    const start = Math.max(0, i - period + 1);
    let sum = 0;
    for (let k = start; k <= i; k += 1) sum += values[k]!;
    return sum;
  };
  const adr: Array<number | null> = sorted.map((_, i) => {
    const downSum = windowSum(downCounts, i, BREADTH_ADR_PERIOD);
    return downSum > 0 ? windowSum(upCounts, i, BREADTH_ADR_PERIOD) / downSum : null;
  });
  const obos: Array<number | null> = sorted.map((_, i) =>
    windowSum(upCounts, i, BREADTH_OBOS_PERIOD) - windowSum(downCounts, i, BREADTH_OBOS_PERIOD),
  );

  /** ARMS 平滑均线（原始 ARMS 可能为 null，窗口内跳过） */
  const armsMa = sorted.map((_, i) => rollingMean(armsValues, i, BREADTH_ARMS_MA_PERIOD));

  /** MCO：DIF 双 EMA 差 + 信号线 MA */
  const mco: Array<number | null> = [];
  let fast: number | null = null;
  let slow: number | null = null;
  for (const value of dif) {
    fast = emaStep(fast, value, BREADTH_MCO_FAST_PERIOD);
    slow = emaStep(slow, value, BREADTH_MCO_SLOW_PERIOD);
    mco.push(fast !== null && slow !== null ? fast - slow : null);
  }
  const mcoSignal = mco.map((_, i) => rollingMean(mco, i, BREADTH_MCO_SIGNAL_PERIOD));

  /** 活跃占比（%）：旧 bar 无字段为 null，分母缺失/为 0 亦为 null */
  const activeRatio: Array<number | null> = sorted.map((bar) =>
    bar.activeTotal !== undefined && bar.activeTotal > 0
      ? ((bar.activeCount ?? 0) / bar.activeTotal) * 100
      : null,
  );

  return {
    dates: sorted.map((bar) => bar.date),
    adl,
    adlMa: adl.map((_, i) => rollingMean(adl, i, BREADTH_ADL_MA_PERIOD)),
    adr,
    obos,
    obosMa: obos.map((_, i) => rollingMean(obos, i, BREADTH_OBOS_MA_PERIOD)),
    armsMa,
    mco,
    mcoSignal,
    activeRatio,
  };
};
