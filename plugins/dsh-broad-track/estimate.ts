/**
 * 插件 dsh-broad-track（宽基跟踪）· 预估模型与操作信号（纯函数）
 *
 * 国家队持仓预估（分层，口径透明可复算）：
 * 1. **锚点层**：定期报告披露（或公开披露整理）的国家队持仓份额；
 *    未配置锚点时按「期末总份额 × 机构持有比例 × 国家队占比」粗估兜底；
 * 2. **滚动层**：锚点报告期之后各季「期间申购 − 期间赎回」的净申购份额，
 *    按同一国家队占比分摊（净赎回季按同比例分摊是粗估，界面明示）；
 * 3. **折现层**：预估份额 × 最新价 = 预估持仓金额。
 *
 * 操作信号（日频，只用二级市场痕迹）：
 * - 「强买入」= 宽基 ETF 等权平均跌幅 ≤ -1.5% 且 主力净流入 > 0 且 成交额 ≥ 20 日均值 1.5 倍；
 * - 「买入」= 等权平均跌幅 ≤ -0.5% 且 主力净流入 > 0；
 * - 「撤退」= 主力净流出连续 ≥ 3 日 且 等权平均涨幅 ≥ +0.5%（上涨中撤退）；
 * - 其余 = 观察。
 *
 * 本模块不碰网络与宿主能力，输入全是落库行 → 冒烟测试可喂固定数据断言。
 */
import {
  ANCHOR_DEFAULT_PERIOD,
  INST_RATIO_FALLBACK,
  MAIN_INFLOW_RECENT_DAYS,
  SIGNAL_AMOUNT_SURGE,
  SIGNAL_INDEX_DROP_BUY,
  SIGNAL_INDEX_DROP_STRONG,
  SIGNAL_INDEX_RISE_SELL,
  SIGNAL_LEVEL,
  SIGNAL_SELL_STREAK,
  SIGNAL_TIMELINE_DAYS,
  YUAN_PER_YI,
} from './constants';
import type {
  AnchorHolding,
  EtfDailyRow,
  EtfEstimate,
  EtfHolderRow,
  EtfQuarterRow,
  SignalDayInput,
  SignalDayResult,
} from './types';
import type { TrackedEtf } from './constants';

/** 预估计算所需的单只 ETF 输入 */
export interface EtfEstimateInput {
  /** 清单条目（代码 / 名称 / 指数） */
  etf: TrackedEtf;
  /** 该 ETF 的日频行（任意顺序，内部按日期升序排序） */
  dailyRows: readonly EtfDailyRow[];
  /** 该 ETF 的季度行（任意顺序，内部按报告期排序） */
  quarters: readonly EtfQuarterRow[];
  /** 该 ETF 的持有人结构行（任意顺序，内部按报告期排序） */
  holders: readonly EtfHolderRow[];
  /** 用户配置的锚点（无则按持有人结构粗估） */
  anchor: AnchorHolding | null;
  /** 国家队在机构持仓中的占比（0-1，用户设置） */
  nationalOfInst: number;
}

/**
 * 取最近的持有人结构行（按公告日期降序的第一个）
 * @param holders 持有人结构行（任意顺序）
 * @returns 最近一行；无数据为 null
 */
const latestHolder = (holders: readonly EtfHolderRow[]): EtfHolderRow | null => {
  let latest: EtfHolderRow | null = null;
  for (const row of holders) {
    if (latest === null || row.periodEnd > latest.periodEnd) latest = row;
  }
  return latest;
};

/**
 * 取最近的季度行（按报告期降序的第一个）
 * @param quarters 季度行（任意顺序）
 * @returns 最近一行；无数据为 null
 */
const latestQuarter = (quarters: readonly EtfQuarterRow[]): EtfQuarterRow | null => {
  let latest: EtfQuarterRow | null = null;
  for (const row of quarters) {
    if (latest === null || row.periodEnd > latest.periodEnd) latest = row;
  }
  return latest;
};

/**
 * 取最新日频行（按日期升序的最后一个）
 * @param dailyRows 日频行（任意顺序）
 * @returns 最新一行；无数据为 null
 */
const latestDaily = (dailyRows: readonly EtfDailyRow[]): EtfDailyRow | null => {
  let latest: EtfDailyRow | null = null;
  for (const row of dailyRows) {
    if (latest === null || row.date > latest.date) latest = row;
  }
  return latest;
};

/**
 * 计算一只 ETF 的国家队持仓预估（纯函数）
 *
 * 锚点缺失时的兜底粗估：取最近一期持有人结构的「总份额 × 机构持有比例 × 国家队占比」，
 * 报告期用 ANCHOR_DEFAULT_PERIOD 或该期实际公告日（取更近者）。
 * @param input 单只 ETF 的预估输入
 * @returns 预估结果（展示口径）
 */
export const estimateEtf = (input: EtfEstimateInput): EtfEstimate => {
  const { etf, dailyRows, quarters, holders, anchor, nationalOfInst } = input;

  const holder = latestHolder(holders);
  const quarter = latestQuarter(quarters);
  const daily = latestDaily(dailyRows);

  // 国家队占比 = 机构持有比例 × 国家队占机构比例（持有人结构缺失时用兜底机构比例）
  const instRatio = holder?.instRatio ?? null;
  const instShare = (instRatio === null ? INST_RATIO_FALLBACK : instRatio) / 100;
  const nationalShare = instShare * nationalOfInst;

  // 锚点：用户配置优先；否则按持有人结构粗估
  let anchorSharesYi: number;
  let anchorPeriodEnd: string;
  let anchorSource: string;
  if (anchor && Number.isFinite(anchor.sharesYi)) {
    anchorSharesYi = anchor.sharesYi;
    anchorPeriodEnd = anchor.periodEnd;
    anchorSource = anchor.source;
  } else if (holder && holder.totalSharesYi !== null && holder.instRatio !== null) {
    anchorSharesYi = holder.totalSharesYi * instShare * nationalOfInst;
    anchorPeriodEnd = holder.periodEnd;
    anchorSource = `按持有人结构粗估（${holder.periodEnd}）`;
  } else {
    // 无任何锚点信息：按约定的默认报告期起算（与页面默认锚点草稿同口径），
    // 即「默认期之前视为无持仓、之后只计净申购」，避免把历史全部申赎都算进来
    anchorSharesYi = 0;
    anchorPeriodEnd = ANCHOR_DEFAULT_PERIOD;
    anchorSource = `无锚点数据，按 ${ANCHOR_DEFAULT_PERIOD} 起算`;
  }

  // 滚动层：锚点报告期之后的净申购 × 国家队占比
  let netSubscribeYi = 0;
  let rolledSharesYi = 0;
  const after = quarters
    .filter((row) => row.periodEnd > anchorPeriodEnd)
    .sort((left, right) => (left.periodEnd < right.periodEnd ? -1 : 1));
  for (const row of after) {
    if (row.subscribeYi === null || row.redeemYi === null) continue;
    const net = row.subscribeYi - row.redeemYi;
    netSubscribeYi += net;
    rolledSharesYi += net * nationalShare;
  }

  const estSharesYi = anchorSharesYi + rolledSharesYi;
  const latestPrice = daily?.price ?? null;
  const estAmountYi =
    latestPrice === null ? null : (estSharesYi * latestPrice) / YUAN_PER_YI;
  const anchorAmountYi =
    latestPrice === null ? null : (anchorSharesYi * latestPrice) / YUAN_PER_YI;
  const deltaYi =
    estAmountYi === null || anchorAmountYi === null ? null : estAmountYi - anchorAmountYi;

  const lastNetSubscribeYi =
    quarter !== null && quarter.subscribeYi !== null && quarter.redeemYi !== null
      ? quarter.subscribeYi - quarter.redeemYi
      : null;

  return {
    code: etf.code,
    name: etf.name,
    indexName: etf.indexName,
    anchorSharesYi,
    anchorPeriodEnd,
    anchorSource,
    netSubscribeYi,
    rolledSharesYi,
    estSharesYi,
    latestPrice,
    estAmountYi,
    anchorAmountYi,
    deltaYi,
    sharesEndYi: quarter?.sharesEndYi ?? null,
    netAssetYi: quarter?.netAssetYi ?? null,
    lastNetSubscribeYi,
    lastPeriodEnd: quarter?.periodEnd ?? '',
    instRatio,
  };
};

/**
 * 计算宽基口径合计的预估（纯函数）
 * @param estimates 逐只 ETF 的预估
 * @returns 合计（金额均为亿元；价格缺失的行不计入金额合计）
 */
export const sumEstimates = (estimates: readonly EtfEstimate[]): {
  estTotalYi: number;
  deltaTotalYi: number;
  anchorTotalYi: number;
} => {
  let estTotalYi = 0;
  let deltaTotalYi = 0;
  let anchorTotalYi = 0;
  for (const item of estimates) {
    if (item.estAmountYi !== null) estTotalYi += item.estAmountYi;
    if (item.anchorAmountYi !== null) anchorTotalYi += item.anchorAmountYi;
    if (item.deltaYi !== null) deltaTotalYi += item.deltaYi;
  }
  return { estTotalYi, deltaTotalYi, anchorTotalYi };
};

/**
 * 汇总一个交易日的宽基口径输入（纯函数）
 *
 * 宽基涨跌用**跟踪 ETF 的等权平均涨跌幅**（自洽口径：时间线上没有指数日频数据，
 * 当前指数快照只做页头展示，不混用）；主力净流入 / 成交额为清单合计。
 * @param date 日期（YYYY-MM-DD）
 * @param rows 当日全部 ETF 的日频行
 * @returns 信号输入；当日无任何 ETF 数据时返回 null
 */
export const aggregateSignalDay = (
  date: string,
  rows: readonly EtfDailyRow[],
): SignalDayInput | null => {
  if (rows.length === 0) return null;

  let changeSum = 0;
  let changeCount = 0;
  let mainInflowTotal = 0;
  let amountTotal = 0;
  for (const row of rows) {
    if (row.changePercent !== null) {
      changeSum += row.changePercent;
      changeCount += 1;
    }
    if (row.mainInflow !== null) mainInflowTotal += row.mainInflow;
    if (row.amount !== null) amountTotal += row.amount;
  }

  return {
    date,
    indexAvgChange: changeCount > 0 ? changeSum / changeCount : null,
    mainInflowTotal,
    amountTotal,
    amountAvg20: null,
    outflowStreak: 0,
  };
};

/**
 * 判定一个交易日的国家队操作信号（纯函数）
 * @param day 当日宽基口径输入（amountAvg20 / outflowStreak 需调用方补齐）
 * @returns 信号判定（档位 + 触发依据）
 */
export const evaluateSignal = (day: SignalDayInput): SignalDayResult => {
  const evidences: string[] = [];
  const avg = day.indexAvgChange;
  const amountRatio =
    day.amountAvg20 !== null && day.amountAvg20 > 0 ? day.amountTotal / day.amountAvg20 : null;

  const dropStrong = avg !== null && avg <= SIGNAL_INDEX_DROP_STRONG;
  const dropBuy = avg !== null && avg <= SIGNAL_INDEX_DROP_BUY;
  const inflow = day.mainInflowTotal > 0;
  const surge = amountRatio !== null && amountRatio >= SIGNAL_AMOUNT_SURGE;
  const riseSell = avg !== null && avg >= SIGNAL_INDEX_RISE_SELL;
  const streakSell = day.outflowStreak >= SIGNAL_SELL_STREAK;

  let level: SignalDayResult['level'] = SIGNAL_LEVEL.WATCH;

  if (dropStrong && inflow && surge) {
    level = SIGNAL_LEVEL.STRONG_BUY;
    evidences.push(`宽基等权平均 ${fmtPercent(avg)}（≤ ${SIGNAL_INDEX_DROP_STRONG}%）`);
    evidences.push(`主力净流入 ${fmtYi(day.mainInflowTotal)} 亿元 > 0`);
    evidences.push(
      `成交额 ${fmtYi(day.amountTotal)} 亿元 = 20 日均值的 ${amountRatio === null ? '—' : amountRatio.toFixed(2)} 倍（≥ ${SIGNAL_AMOUNT_SURGE}）`,
    );
  } else if (dropBuy && inflow) {
    level = SIGNAL_LEVEL.BUY;
    evidences.push(`宽基等权平均 ${fmtPercent(avg)}（≤ ${SIGNAL_INDEX_DROP_BUY}%）`);
    evidences.push(`主力净流入 ${fmtYi(day.mainInflowTotal)} 亿元 > 0`);
  } else if (streakSell && riseSell && day.mainInflowTotal < 0) {
    level = SIGNAL_LEVEL.SELL;
    evidences.push(`宽基等权平均 ${fmtPercent(avg)}（≥ +${SIGNAL_INDEX_RISE_SELL}%）`);
    evidences.push(`主力净流出连续 ${day.outflowStreak} 日（≥ ${SIGNAL_SELL_STREAK} 日）`);
  } else {
    evidences.push(
      `宽基等权平均 ${avg === null ? '—' : fmtPercent(avg)}，主力净流入 ${fmtYi(day.mainInflowTotal)} 亿元，未触发买入 / 撤退条件`,
    );
  }

  return { ...day, level, evidences };
};

/**
 * 由落库日频行构建信号时间线（纯函数；升序返回）
 *
 * amountAvg20 取「截至前一日的近 20 个交易日成交额均值」（不含当日，避免当日把均值抬起来）；
 * outflowStreak 为截至当日的连续净流出天数（当日净流出才计数）。
 * @param dailyByCode 代码 → 日频行（升序或降序都会先统一成升序）
 * @returns 逐日信号结果（升序；无数据返回空数组）
 */
export const buildSignalTimeline = (
  dailyByCode: ReadonlyMap<string, readonly EtfDailyRow[]>,
): SignalDayResult[] => {
  // 日期 → 当日全部 ETF 行
  const byDate = new Map<string, EtfDailyRow[]>();
  for (const rows of dailyByCode.values()) {
    for (const row of rows) {
      const bucket = byDate.get(row.date);
      if (bucket) bucket.push(row);
      else byDate.set(row.date, [row]);
    }
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return [];

  // 先聚合出每日的原始输入（升序）
  const days: SignalDayInput[] = [];
  for (const date of dates) {
    const aggregated = aggregateSignalDay(date, byDate.get(date) ?? []);
    if (aggregated) days.push(aggregated);
  }

  // 补 amountAvg20（前 20 日均值，不含当日）与 outflowStreak
  let streak = 0;
  const results: SignalDayResult[] = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const window = days.slice(Math.max(0, index - 20), index);
    day.amountAvg20 =
      window.length > 0 ? window.reduce((sum, item) => sum + item.amountTotal, 0) / window.length : null;
    if (day.mainInflowTotal < 0) streak += 1;
    else streak = 0;
    day.outflowStreak = streak;
    results.push(evaluateSignal(day));
  }
  return results;
};

/**
 * 取信号时间线的最近 N 日（纯函数）
 * @param timeline 升序时间线
 * @param days 展示天数（默认 SIGNAL_TIMELINE_DAYS）
 * @returns 最近 N 日（仍为升序）
 */
export const recentSignalDays = (
  timeline: readonly SignalDayResult[],
  days: number = SIGNAL_TIMELINE_DAYS,
): SignalDayResult[] => timeline.slice(Math.max(0, timeline.length - days));

/**
 * 汇总「近 N 日主力净流入」（纯函数）
 * @param timeline 升序时间线
 * @param days 近 N 日（默认 MAIN_INFLOW_RECENT_DAYS）
 * @returns 近 N 日主力净流入合计（元）
 */
export const recentMainInflow = (
  timeline: readonly SignalDayResult[],
  days: number = MAIN_INFLOW_RECENT_DAYS,
): number =>
  timeline
    .slice(Math.max(0, timeline.length - days))
    .reduce((sum, day) => sum + day.mainInflowTotal, 0);

/**
 * 涨跌幅格式化（纯函数；供证据文案用）
 * @param value 涨跌幅（百分数）；null 返回占位
 * @returns 带符号百分比文本
 */
const fmtPercent = (value: number | null): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

/**
 * 元 → 亿元字符串（纯函数；供证据文案用）
 * @param value 金额（元）
 * @returns 亿元字符串
 */
const fmtYi = (value: number): string => (value / YUAN_PER_YI).toFixed(2);
