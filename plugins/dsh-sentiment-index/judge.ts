/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 指标层（**纯函数**，可冒烟直跑、可回测）
 *
 * 口径（开发方案 §4，全部板块级）：
 * - 因子先归一化为「该板块自身近 250 日历史分位（0~100）」再加权 —— 抗极值、跨板块可比；
 * - 热度指数 = 成交占比 0.6 + 相对放量 0.2 + 换手 0.2；
 * - 散户情绪指数 = 小单净占比 0.4 + 成交占比 0.3 + 赚钱效应 0.3
 *   （赚钱效应 = 上涨家数占比与涨停占比分位再对半）；
 * - 某因子当日缺席时其权重按比例摊给其余因子，**绝不把 null 当 0**；
 * - 背离两条：价创新低而情绪高位（钝化）；情绪新高而小单连续为负（衰竭）。
 *
 * 分位实现用「增量有序窗口 + 二分插入」而不是逐日全排序：
 * 30 板块 × 420 日 × 7 因子的全量重算要控制在毫秒级（每次采集后与页面首屏都要跑）。
 */
import {
  DIVERGENCE_BLUNT_MIN_RETAIL,
  DIVERGENCE_FADE_NEGATIVE_DAYS,
  DIVERGENCE_WINDOW,
  HEAT_WEIGHTS,
  MIN_FACTOR_SAMPLES,
  MONEY_EFFECT_WEIGHTS,
  PERCENTILE_WINDOW,
  PERCENT_BASE,
  RETAIL_WEIGHTS,
  VOLUME_RATIO_WINDOW,
} from './constants';
import type {
  BoardDay,
  DivergenceMark,
  FactorPercentiles,
  FactorValues,
  IndexPoint,
  MarketPoint,
} from './types';

/**
 * 有序窗口：维护最近 N 个样本的有序数组（二分查找插入），支持分位查询
 *
 * 每步代价 = O(log n) 查找 + O(n) 搬移（n ≤ 250，搬移是连续内存操作，
 * 比「逐日复制数组重排序」低一个数量级）。
 */
class SortedWindow {
  /** 有序样本（升序） */
  private readonly sorted: number[] = [];
  /** 窗口容量 */
  private readonly capacity: number;

  /**
   * @param capacity 窗口容量（样本数）
   */
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /**
   * 纳入一个样本（超出容量时淘汰最旧样本）
   * @param value 样本值
   * @returns void
   */
  push(value: number): void {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.sorted[mid] <= value) low = mid + 1;
      else high = mid;
    }
    this.sorted.splice(low, 0, value);
    if (this.sorted.length > this.capacity) this.sorted.shift();
  }

  /**
   * 当前值在窗口内的分位（0~100）：≤ 该值的样本占比
   * @param value 待定位的值
   * @param minSamples 最小样本数（不足视为样本不足，返回 null）
   * @returns 分位；窗口为空或样本不足返回 null
   */
  percentileOf(value: number, minSamples: number): number | null {
    if (this.sorted.length < minSamples) return null;
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.sorted[mid] <= value) low = mid + 1;
      else high = mid;
    }
    return (low / this.sorted.length) * PERCENT_BASE;
  }
}

/**
 * 构建「交易日 → 沪深两市总成交额」映射
 * @param market 沪深成交额序列
 * @returns 日期映射
 */
export const buildMarketMap = (market: readonly MarketPoint[]): Map<string, number> =>
  new Map(
    market.filter((point) => point.date && point.totalAmount > 0).map((point) => [point.date, point.totalAmount]),
  );

/**
 * 计算某日的单日因子原始值
 * @param day 当日数据
 * @param prevDays 当日之前的序列（升序，供相对放量取前 20 日均额）
 * @param marketAmount 当日沪深两市总成交额（元）；缺失为 null
 * @returns 因子原始值
 */
export const computeDayFactors = (
  day: BoardDay,
  prevDays: readonly BoardDay[],
  marketAmount: number | null,
): FactorValues => {
  const amount = day.amount ?? 0;
  const amountShare =
    marketAmount !== null && marketAmount > 0 && amount > 0 ? (amount / marketAmount) * PERCENT_BASE : null;

  const prevAmounts = prevDays
    .slice(-VOLUME_RATIO_WINDOW)
    .map((item) => item.amount ?? 0)
    .filter((item) => item > 0);
  const prevAverage =
    prevAmounts.length > 0 ? prevAmounts.reduce((sum, item) => sum + item, 0) / prevAmounts.length : null;
  const volumeRatio =
    prevAverage !== null && prevAverage > 0 && amount > 0 ? amount / prevAverage : null;

  const counted = (day.upCount ?? 0) + (day.downCount ?? 0);
  const upRatio = day.upCount !== null && counted > 0 ? ((day.upCount ?? 0) / counted) * PERCENT_BASE : null;
  const limitUpRatio =
    day.limitUpCount !== null && counted > 0 ? ((day.limitUpCount ?? 0) / counted) * PERCENT_BASE : null;

  return {
    amountShare,
    volumeRatio,
    turnover: day.turnover,
    smallNetRatio: day.smallRatio,
    pctChg: day.pctChg,
    upRatio,
    limitUpRatio,
    limitUpCount: day.limitUpCount,
  };
};

/**
 * 加权合成：缺席因子（null）的权重按比例摊给其余因子
 * @param entries 权重与因子值对
 * @returns 合成值（0~100）；全部缺席返回 null
 */
const weightedCompose = (entries: readonly (readonly [number, number | null])[]): number | null => {
  let sum = 0;
  let weight = 0;
  for (const [weightValue, value] of entries) {
    if (value === null || !Number.isFinite(value)) continue;
    sum += weightValue * value;
    weight += weightValue;
  }
  if (weight <= 0) return null;
  return sum / weight;
};

/**
 * 计算板块的逐日指数序列（全量重算：历史行的分位只依赖 ≤ 当日的数据，永不漂移）
 *
 * 这是「重算消除中间态脏数据」的实现：每次采集后对关注板块整体重跑，
 * 落库层只写与已有结果有差异的尾部（见 storage.ts）。
 * @param days 板块逐日数据（升序；调用方须已裁掉未落定日）
 * @param marketMap 交易日 → 沪深总成交额
 * @returns 逐日指数序列（与输入同长度同顺序）
 */
export const computeIndexSeries = (
  days: readonly BoardDay[],
  marketMap: ReadonlyMap<string, number>,
): IndexPoint[] => {
  // 每个因子一个有序窗口：逐日推进、纳入当日值后即可查当日分位
  const windows = {
    amountShare: new SortedWindow(PERCENTILE_WINDOW),
    volumeRatio: new SortedWindow(PERCENTILE_WINDOW),
    turnover: new SortedWindow(PERCENTILE_WINDOW),
    smallNetRatio: new SortedWindow(PERCENTILE_WINDOW),
    upRatio: new SortedWindow(PERCENTILE_WINDOW),
    limitUpRatio: new SortedWindow(PERCENTILE_WINDOW),
  };

  return days.map((day, index) => {
    const factors = computeDayFactors(day, days.slice(0, index), marketMap.get(day.date) ?? null);
    const values: FactorPercentiles = {
      amountShare: null,
      volumeRatio: null,
      turnover: null,
      smallNetRatio: null,
      upRatio: null,
      limitUpRatio: null,
    };
    for (const key of Object.keys(values) as readonly (keyof FactorPercentiles)[]) {
      const raw = factors[key];
      if (raw === null || !Number.isFinite(raw)) continue;
      const window = windows[key];
      window.push(raw);
      values[key] = window.percentileOf(raw, MIN_FACTOR_SAMPLES);
    }

    const heatIndex = weightedCompose([
      [HEAT_WEIGHTS.amountShare, values.amountShare],
      [HEAT_WEIGHTS.volumeRatio, values.volumeRatio],
      [HEAT_WEIGHTS.turnover, values.turnover],
    ]);
    const moneyEffect = weightedCompose([
      [MONEY_EFFECT_WEIGHTS.upRatio, values.upRatio],
      [MONEY_EFFECT_WEIGHTS.limitUpRatio, values.limitUpRatio],
    ]);
    const retailIndex = weightedCompose([
      [RETAIL_WEIGHTS.smallNetRatio, values.smallNetRatio],
      [RETAIL_WEIGHTS.amountShare, values.amountShare],
      [RETAIL_WEIGHTS.moneyEffect, moneyEffect],
    ]);

    return { date: day.date, heatIndex, retailIndex, factors, percentiles: values };
  });
};

/**
 * 检测背离标记（方案 §4.3 两条，打在主图上）
 * @param series 指数序列（与板块日线同序）
 * @param days 板块日线（价格创新低用收盘价）
 * @returns 背离标记列表（按日期升序）
 */
export const detectDivergences = (
  series: readonly IndexPoint[],
  days: readonly BoardDay[],
): DivergenceMark[] => {
  const marks: DivergenceMark[] = [];
  for (let index = DIVERGENCE_WINDOW; index < series.length; index += 1) {
    const point = series[index];
    if (!point) continue;

    // 情绪钝化：收盘价创近 5 日新低，而散户情绪指数仍在高位
    const retail = point.retailIndex;
    const close = days[index]?.close;
    if (retail !== null && retail >= DIVERGENCE_BLUNT_MIN_RETAIL && close !== null) {
      const priorCloses = days
        .slice(index - DIVERGENCE_WINDOW, index)
        .map((day) => day.close)
        .filter((value): value is number => value !== null);
      if (priorCloses.length > 0 && close < Math.min(...priorCloses)) {
        marks.push({ date: point.date, kind: 'blunt' });
        continue;
      }
    }

    // 情绪衰竭：散户情绪指数创近 5 日新高，而小单净额已连续 N 日为负
    const priorRetail = series
      .slice(index - DIVERGENCE_WINDOW, index)
      .map((item) => item.retailIndex)
      .filter((value): value is number => value !== null);
    if (retail !== null && priorRetail.length > 0 && retail > Math.max(...priorRetail)) {
      const tailSmall = days
        .slice(index - DIVERGENCE_FADE_NEGATIVE_DAYS + 1, index + 1)
        .map((day) => day.smallNet);
      if (
        tailSmall.length === DIVERGENCE_FADE_NEGATIVE_DAYS &&
        tailSmall.every((value) => value !== null && value < 0)
      ) {
        marks.push({ date: point.date, kind: 'fade' });
      }
    }
  }
  return marks;
};

/**
 * 滞后交易日数：板块最新数据日距基准日隔了几个交易日（按分母序列的交易日历数）
 * @param marketDates 交易日历（升序、去重）
 * @param boardDate 板块最新数据日
 * @param benchmarkDate 基准交易日
 * @returns 滞后交易日数；板块日期晚于基准日（异常）返回 0
 */
export const resolveStaleDays = (
  marketDates: readonly string[],
  boardDate: string,
  benchmarkDate: string,
): number => {
  if (!boardDate || !benchmarkDate || boardDate >= benchmarkDate) return 0;
  const startIndex = marketDates.indexOf(boardDate);
  const endIndex = marketDates.lastIndexOf(benchmarkDate);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return 0;
  return endIndex - startIndex;
};

/**
 * 计算全市场成交额较前一交易日的变化（%，情绪条用）
 * @param market 沪深成交额序列（升序）
 * @returns 变化百分比；样本不足返回 null
 */
export const marketAmountChangePct = (market: readonly MarketPoint[]): number | null => {
  if (market.length < 2) return null;
  const last = market[market.length - 1];
  const prev = market[market.length - 2];
  if (!last || !prev || prev.totalAmount <= 0) return null;
  return ((last.totalAmount - prev.totalAmount) / prev.totalAmount) * PERCENT_BASE;
};
