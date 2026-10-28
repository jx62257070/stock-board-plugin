/**
 * 插件 dsh-broad-track（宽基跟踪）· 份额口径信号引擎与历史回测（纯函数）
 *
 * 与 `estimate.ts`（二级市场资金流口径）**平行**存在：本模块是「国家队观测」
 * 的主口径，信号来自 **ETF 份额的真实申赎**。
 *
 * 为什么份额口径更接近「国家队进出」：
 * - 份额变动 = 真实的申购 / 赎回，只能通过**一篮子实物申赎**完成，是「真金白银进场」；
 * - 二级市场资金流只是「谁在买卖」，机构换手也会产生，噪音极大；
 * - 国家队（汇金 / 证金）是大额申赎方，其动作在份额上表现为**连续多日的大额同向变动**。
 *
 * 判定规则（全部可复算，页面明示口径）：
 * - **进场** = 份额连续净增段内，累计净申购 ≥ SIGNAL_ENTER_MIN_AMOUNT 亿元
 *   且 组合指数距前高回撤达标（≤ SIGNAL_ENTER_DRAWDOWN_PCT，即「从高点跌够了」）；
 * - **退场** = 份额连续净减段内，累计净赎回 ≥ SIGNAL_EXIT_MIN_AMOUNT 亿元
 *   且 组合指数接近前高（距前高回撤 ≥ SIGNAL_EXIT_NEAR_HIGH_PCT）。
 *
 * ⚠️ **位置条件为什么用「距前高回撤」而不是「历史分位」**（2026-10-26 实测对比）：
 * - 全样本分位在逐日判定时**用了未来数据**（信号日的分位是用包含它之后的整段序列
 *   算的），回测胜率虚高，实盘不可复算；
 * - 分位是序数（排名），回答不了「跌了多少」；回撤是量纲（幅度），
 *   与「国家队抄底 = 大跌后进场」的经济含义直接对齐，也更直观可解释；
 * - 真实 678 交易日回测：回撤口径进场 17 次 / 胜率 71% / 平均持有 6.41%，
 *   分位口径（含前视）16 次 / 63% / 6.87% —— 前者无未来数据仍更优。
 *
 * ⚠️ **信号按「方向段」归并，不按逐日**：
 * 一次持续 3 周的减持战役是**一次事件**，逐日触发会被切成几十个碎片
 * （实测退场信号碎成 42 段，胜率统计全失真）。故先把连续同向的交易日
 * 归并成「段」，段内任一天满足完整条件即该段成信号，信号日取**首日**。
 *
 * ⚠️ **口径边界（必须明示）**：份额变动是**全市场净申赎**，不是国家队专属。
 * 散户 / 险资 / 联接基金同样计入。本引擎用「连续多日 + 大额 + 指数位置」
 * 三个条件联合筛出「疑似国家队动作」，并在界面上标注这是推定而非确证。
 *
 * 本模块不碰网络与宿主能力，输入全是落库行 → 可喂固定数据断言。
 */
import {
  BACKTEST_HOLD_DAYS,
  CAMPAIGN_SILENT_END_DAYS,
  CAMPAIGN_SUSPECT_AMOUNT_FACTOR,
  CAMPAIGN_SUSPECT_STREAK,
  EXIT_COMPLETION_CLEARED_PCT,
  EXIT_COMPLETION_LIGHT_PCT,
  SHARE_SPLIT_CONFIRM_DAYS,
  SHARE_SPLIT_PRICE_TOLERANCE,
  SHARE_SPLIT_RATIO_MAX,
  SHARE_SPLIT_RATIO_MIN,
  SIGNAL_ENTER_DRAWDOWN_PCT,
  SIGNAL_ENTER_MIN_AMOUNT,
  SIGNAL_ENTER_STREAK,
  SIGNAL_EXIT_NEAR_HIGH_PCT,
  SIGNAL_EXIT_MIN_AMOUNT,
  SIGNAL_EXIT_STREAK,
} from './constants';
import type {
  ComboSharePoint,
  EtfShareRow,
  ShareBacktestSample,
  ShareBacktestStat,
  ShareCampaignWave,
  ShareExitCompletion,
  ShareLifecycleState,
  ShareSignalDay,
  ShareSignalLevel,
} from './types';

/** 单日信号判定结果（不含生命周期状态，由时间线装配） */
export type ShareSignalEvaluation = Omit<ShareSignalDay, 'lifecycle'>;

/**
 * 一只 ETF 的份额折算事件（合并 / 拆分）
 */
interface ShareSplitEvent {
  /** 折算生效行在（升序）序列中的索引：该行的份额已是折算后口径 */
  index: number;
  /** 份额倍数（折算后份额 ÷ 折算前份额；合并 < 1，拆分 > 1） */
  factor: number;
  /** 价格口径切换边界：该索引**之前**（不含）的价格行是旧口径 */
  priceCut: number;
}

/**
 * 检测单只 ETF 序列里的份额折算事件（纯函数，升序输入）
 *
 * 判定两条件缺一不可：
 * 1. **份额倍数**：单日份额 ÷ 上份额 越出 [SHARE_SPLIT_RATIO_MIN, SHARE_SPLIT_RATIO_MAX]；
 * 2. **价格确认**：折算日附近价格出现 ≈ 1/倍数 的跳变 —— 真申赎不伴随价格跳变
 *    （2024-02-05 汇金救市 512100 单日 +132.8%，价格只 +6.8% → 正确排除）。
 *
 * 价格确认又分两种时序（由首个跳变价所在行决定）：
 * - **同日生效**：折算行当日价格已是新口径 → 价格切换边界 = 折算行；
 * - **次日生效**（实测两例都是）：折算行当日价格还是旧口径（腾讯日 K 滞后），
 *   下一交易日才跳变 → 价格切换边界 = 折算行 + 1（折算行价格也要修）。
 *
 * @param rows 升序份额行
 * @returns 折算事件列表（升序）
 */
const detectShareSplits = (rows: readonly EtfShareRow[]): ShareSplitEvent[] => {
  const events: ShareSplitEvent[] = [];
  let prevIdx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.sharesYi <= 0) continue;
    if (prevIdx >= 0) {
      const factor = row.sharesYi / rows[prevIdx].sharesYi;
      if (factor < SHARE_SPLIT_RATIO_MIN || factor > SHARE_SPLIT_RATIO_MAX) {
        // 基准价：折算行之前最近一个有价行（折算行当日价可能还是旧口径，不作基准）
        let basePrice: number | null = null;
        for (let k = prevIdx; k >= 0 && basePrice === null; k -= 1) {
          basePrice = rows[k].price;
        }
        if (basePrice !== null && basePrice > 0) {
          const expected = 1 / factor;
          // 从折算行当日开始找价格跳变：同日 = 当日生效，之后 = 次日生效
          for (let j = i; j <= Math.min(i + SHARE_SPLIT_CONFIRM_DAYS, rows.length - 1); j += 1) {
            const price = rows[j].price;
            if (price === null || price <= 0) continue;
            if (Math.abs(price / basePrice - expected) <= SHARE_SPLIT_PRICE_TOLERANCE * expected) {
              events.push({ index: i, factor, priceCut: j === i ? i : i + 1 });
              break;
            }
          }
        }
      }
    }
    prevIdx = i;
  }
  return events;
};

/**
 * 中和单只 ETF 序列里的份额折算伪影（纯函数，不改输入）
 *
 * 交易所披露的份额与腾讯不复权价在折算（合并 / 拆分）日会口径切换，裸差分
 * 会把折算当成天量申赎：510310 于 2024-09-20 合并 1.95:1 → delta_yi = -595
 * 亿份 ≈ -951 亿元假赎回；510100 于 2025-03-07 合并 2:1 → -14.8 亿份。
 * 同时组合指数的价格序列也在折算日断裂（510310 权重最大，9-23 指数凭空
 * +20% 级跳变）→ 回撤序列全污染。
 *
 * 中和口径（全序列换算成「折算后单位」，等价于对份额做后复权）：
 * - 折算行**之前**的份额 × factor（新旧份额可比，组合总份额曲线不再腰斩）；
 * - 价格切换边界**之前**的价格 × 1/factor（价格序列连续，指数无假跳变）；
 * - Δ份额与金额在修正后的序列上**重算**（折算日 delta ≈ 0，金额伪影消失；
 *   其余日 δ×(份额因子)×价×(价格因子) 与原值一致，只有折算日被修正）。
 *
 * @param rows 份额行（升序或降序均可，内部先统一升序）
 * @returns 中和后的份额行（新数组；未检出折算时逐字段等价）
 */
export const neutralizeShareSplits = (
  rows: readonly EtfShareRow[],
): EtfShareRow[] => {
  if (rows.length < 2) return [...rows];
  const ascending = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const events = detectShareSplits(ascending);
  if (events.length === 0) return ascending;

  const adjusted = ascending.map((row, index) => {
    let shareFactor = 1;
    let priceFactor = 1;
    for (const event of events) {
      if (index < event.index) shareFactor *= event.factor;
      if (index < event.priceCut) priceFactor /= event.factor;
    }
    return {
      ...row,
      sharesYi: row.sharesYi * shareFactor,
      price: row.price === null ? null : row.price * priceFactor,
    };
  });

  // 修正后的序列上重算 Δ份额与金额
  let previousShares: number | null = null;
  return adjusted.map((row) => {
    const deltaYi = previousShares === null ? 0 : row.sharesYi - previousShares;
    previousShares = row.sharesYi;
    return {
      ...row,
      deltaYi,
      amountYi: row.price === null ? null : deltaYi * row.price,
    };
  });
};

/**
 * 汇总组合（宽基口径）的逐日份额序列（纯函数）
 *
 * 组合总份额 = 当日全部有份额数据的 ETF 之和；
 * 组合净申赎金额 = 各 ETF「Δ份额 × 收盘价」之和。
 *
 * ⚠️ **入参先过 `neutralizeShareSplits`**：交易所份额与不复权价在 ETF
 * 折算（合并 / 拆分）日会口径切换，裸差分会把折算当成天量申赎（实测
 * 510310 2024-09-20 合并被算成 -951 亿元假赎回），必须先中和再进引擎。
 *
 * ⚠️ **组合指数用固定权重的 Laspeyres 价格指数**（不是「各 ETF 收盘价的等权平均」）：
 * - 等权平均会随「当天哪几只 ETF 有数据」跳变 → 产生**虚假涨跌幅**；
 * - 固定权重（基准日市值权重）+ 价格按基准日归一化 + 价格缺失**前值填充**，
 *   指数只反映纯价格变化，与份额变动完全解耦 —— 这才是回测该用的口径。
 *
 * ⚠️ **权重必须是「基准日市值占比」而不是「份额占比」**（实测差异巨大）：
 * 低单价 ETF 的份额数天然远多于高单价 ETF —— 基准日 588000（科创50，单价 0.886 元）
 * 份额占 38.7% 但市值只占 19.2%；510300（沪深300，单价 3.453 元）份额占 13.9%
 * 而市值占 26.9%。用份额权重等于**系统性放大低价 ETF**，
 * 实测到 2026-06-25 组合指数比沪深300实际涨幅高出 69 个百分点（份额权重）
 * vs 42 个百分点（市值权重）。市值权重才是金融上正确的口径。
 *
 * @param sharesByCode 代码 → 份额行（升序或降序都会先统一成升序）
 * @returns 组合逐日序列（升序）
 */
export const buildComboSeries = (
  sharesByCode: ReadonlyMap<string, readonly EtfShareRow[]>,
): ComboSharePoint[] => {
  // 日期 → 当日各 ETF 的份额行
  const byDate = new Map<string, EtfShareRow[]>();
  for (const rows of sharesByCode.values()) {
    for (const row of neutralizeShareSplits(rows)) {
      const bucket = byDate.get(row.date);
      if (bucket) bucket.push(row);
      else byDate.set(row.date, [row]);
    }
  }
  const dates = [...byDate.keys()].sort();

  // 固定权重：基准日（序列首日）的**市值占比**（份额 × 基准日收盘价）
  const baseDate = dates[0];
  const weights = new Map<string, number>();
  const basePrices = new Map<string, number>();
  if (baseDate !== undefined) {
    const baseRows = byDate.get(baseDate) ?? [];
    // 基准日市值 = 份额（亿份）× 收盘价（元）= 亿元
    const totalBaseCap = baseRows.reduce(
      (sum, row) => sum + (row.price !== null && row.price > 0 ? row.sharesYi * row.price : 0),
      0,
    );
    if (totalBaseCap > 0) {
      for (const row of baseRows) {
        if (row.price === null || row.price <= 0) continue;
        const cap = row.sharesYi * row.price;
        if (cap <= 0) continue;
        weights.set(row.code, cap / totalBaseCap);
        basePrices.set(row.code, row.price);
      }
    }
  }

  // 逐只 ETF 的价格序列（前值填充用）
  const lastPriceByCode = new Map<string, number>();
  const priceByDate = new Map<string, Map<string, number>>();
  for (const date of dates) {
    const dayMap = new Map<string, number>();
    for (const row of byDate.get(date) ?? []) {
      // ⚠️ **当日有价就用当日价，只有当日缺价才回退到上一个已知价**。
      // 反过来写（无条件用 previous）会让指数整体错位一天 —— 那不是「前值填充」，
      // 是「滞后一日」，会让分位与信号判定建立在错的点位上。
      const previous = lastPriceByCode.get(row.code);
      const price =
        row.price !== null && row.price > 0 ? row.price : previous;
      if (price === undefined) continue;
      lastPriceByCode.set(row.code, price);
      dayMap.set(row.code, price);
    }
    priceByDate.set(date, dayMap);
  }

  const points: ComboSharePoint[] = [];
  for (const date of dates) {
    const rows = byDate.get(date) ?? [];
    let totalSharesYi = 0;
    let deltaSharesYi = 0;
    let flowSum = 0;
    let flowCount = 0;
    for (const row of rows) {
      totalSharesYi += row.sharesYi;
      deltaSharesYi += row.deltaYi;
      if (row.amountYi !== null) {
        flowSum += row.amountYi;
        flowCount += 1;
      }
    }
    // 固定权重价格指数（Laspeyres，基准日 = 100）
    //
    // ⚠️ **必须先按基准日价格归一化**：不同 ETF 的绝对价格量级差异极大
    // （510300 约 4 元、科创 50ETF 约 1 元），直接用「权重 × 绝对价格」加权
    // 会算出 +183% 这种失真累计值。
    let indexValue = 0;
    let indexWeight = 0;
    const dayPrices = priceByDate.get(date);
    if (dayPrices) {
      for (const [code, weight] of weights) {
        const price = dayPrices.get(code);
        const basePrice = basePrices.get(code);
        if (price === undefined || basePrice === undefined) continue;
        indexValue += weight * (price / basePrice);
        indexWeight += weight;
      }
    }
    // 权重覆盖不全时按已覆盖权重归一（避免成分缺失把指数压低）
    const normalizedIndex = indexWeight > 0 ? (indexValue / indexWeight) * 100 : null;
    points.push({
      date,
      totalSharesYi,
      deltaSharesYi,
      netFlowYi: flowCount > 0 ? flowSum : null,
      avgPrice: normalizedIndex,
      memberCount: rows.length,
    });
  }
  return points;
};

/**
 * 计算逐日「距前高回撤」序列（纯函数）
 *
 * 回撤 = (当日值 / 截至当日的历史最高值 - 1) × 100（≤0；0 = 处于新高）。
 * 只用**截至当日**的数据（扩展窗口），不含未来 —— 逐日判定与回测都无前视偏差。
 *
 * 为什么不用「历史分位」：分位是序数（排名），回答不了「从高点跌了多少」；
 * 且全样本分位在逐日判定时含未来数据（前视）。回撤是量纲（幅度），
 * 与「国家队抄底 = 大跌后进场」的经济含义直接对齐，也更直观可解释。
 *
 * @param levels 时间序列（升序；缺失为 null）
 * @returns 逐日回撤（%；与输入等长，缺失日为 null）
 */
export const drawdownPctSeries = (
  levels: readonly (number | null)[],
): (number | null)[] => {
  const out: (number | null)[] = new Array(levels.length).fill(null);
  let runningMax: number | null = null;
  for (let index = 0; index < levels.length; index += 1) {
    const value = levels[index];
    if (value === null) continue;
    runningMax = runningMax === null || value > runningMax ? value : runningMax;
    out[index] = runningMax > 0 ? (value / runningMax - 1) * 100 : 0;
  }
  return out;
};

/**
 * 判定一个交易日的份额口径信号（纯函数）
 *
 * @param day 当日输入
 * @param day.date 交易日
 * @param day.totalSharesYi 组合总份额（亿份）
 * @param day.deltaSharesYi 当日份额变动（亿份）
 * @param day.netFlowYi 当日估算净申赎（亿元）
 * @param day.indexLevel 组合指数点位
 * @param day.drawdownPct 组合指数距前高的回撤（%，≤0；0 = 新高）
 * @param day.changeStreak 连续同向天数（正 = 连续净增）
 * @returns 信号判定（档位 + 依据；生命周期状态由时间线装配）
 */
export const evaluateShareSignal = (day: {
  date: string;
  totalSharesYi: number;
  deltaSharesYi: number;
  netFlowYi: number | null;
  indexLevel: number | null;
  drawdownPct: number | null;
  changeStreak: number;
}): ShareSignalEvaluation => {
  const evidences: string[] = [];
  const { netFlowYi, drawdownPct, changeStreak } = day;

  const enterStreak = changeStreak >= SIGNAL_ENTER_STREAK;
  const exitStreak = changeStreak <= -SIGNAL_EXIT_STREAK;
  const deepDrawdown =
    drawdownPct !== null && drawdownPct <= SIGNAL_ENTER_DRAWDOWN_PCT;
  const nearHigh =
    drawdownPct !== null && drawdownPct >= SIGNAL_EXIT_NEAR_HIGH_PCT;

  const enterAmountOk = netFlowYi !== null && netFlowYi >= SIGNAL_ENTER_MIN_AMOUNT;
  const exitAmountOk = netFlowYi !== null && netFlowYi <= -SIGNAL_EXIT_MIN_AMOUNT;

  let level: ShareSignalLevel = 'none';

  if (enterStreak && deepDrawdown && enterAmountOk) {
    level = 'enter';
    evidences.push(`份额连续净增 ${changeStreak} 日（≥ ${SIGNAL_ENTER_STREAK} 日）`);
    evidences.push(
      `指数距前高回落 ${Math.abs(drawdownPct ?? 0).toFixed(1)}%（≥ ${Math.abs(SIGNAL_ENTER_DRAWDOWN_PCT)}%，深度回调）`,
    );
    evidences.push(
      `净申购 ${netFlowYi?.toFixed(2)} 亿元（≥ ${SIGNAL_ENTER_MIN_AMOUNT} 亿元）`,
    );
  } else if (exitStreak && nearHigh && exitAmountOk) {
    level = 'exit';
    evidences.push(`份额连续净减 ${Math.abs(changeStreak)} 日（≥ ${SIGNAL_EXIT_STREAK} 日）`);
    evidences.push(
      `指数距前高仅 ${Math.abs(drawdownPct ?? 0).toFixed(1)}%（≤ ${Math.abs(SIGNAL_EXIT_NEAR_HIGH_PCT)}%，接近新高）`,
    );
    evidences.push(
      `净赎回 ${Math.abs(netFlowYi ?? 0).toFixed(2)} 亿元（≥ ${SIGNAL_EXIT_MIN_AMOUNT} 亿元）`,
    );
  } else {
    const streakText =
      changeStreak === 0
        ? '份额当日无变动'
        : changeStreak > 0
          ? `份额连续净增 ${changeStreak} 日`
          : `份额连续净减 ${Math.abs(changeStreak)} 日`;
    evidences.push(
      `${streakText}，指数距前高 ${
        drawdownPct === null ? '—' : `${drawdownPct.toFixed(1)}%`
      }，净申赎 ${netFlowYi === null ? '—' : `${netFlowYi.toFixed(2)} 亿元`}，未触发进场 / 退场条件`,
    );
  }

  return { ...day, level, evidences };
};

/**
 * 一个信号波段（一次「进场 / 退场」战役）
 *
 * 波段 = 一个**方向段**（连续同向的份额变动），段内满足完整条件即成信号。
 * 信号日取段内**首个**满足条件的交易日（事件起点，不是事件中间）。
 */
export interface ShareSignalWave {
  /** 档位 */
  level: ShareSignalLevel;
  /** 信号日（段内首个满足条件的那天；YYYY-MM-DD） */
  date: string;
  /** 段起始日 */
  startDate: string;
  /** 段结束日 */
  endDate: string;
  /** 段内交易日数 */
  days: number;
  /** 段内连续同向天数（到信号日为止） */
  streak: number;
  /** 段起始时的组合总份额（亿份） */
  startSharesYi: number;
  /** 段结束时的组合总份额（亿份） */
  endSharesYi: number;
  /** 段内累计份额变动（亿份） */
  deltaSharesYi: number;
  /** 段内累计净申赎金额（亿元；缺失的日按 0 计） */
  netFlowYi: number | null;
  /** 段起止的指数点位 */
  indexStart: number | null;
  indexEnd: number | null;
  /** 段内指数涨跌幅（%；缺失为 null） */
  indexReturn: number | null;
  /** 触发依据（取信号日的那条） */
  evidences: string[];
}

/**
 * 由组合序列构建信号波段（纯函数，升序）
 *
 * ⚠️ **2026-10-27 起改为「战役状态机」口径**：确认条件从「单日净申赎 ≥ 门槛」
 * 改为「段内累计净申赎 ≥ 门槛」——单日口径在真实 679 交易日上过严（26 次 vs 31 次），
 * 且「连续 3 日共 60 亿」比「1 日 20 亿 + 2 日 0」更符合「战役」语义。
 * 确认日 / 胜率统计（enter 72% / 20 日均 6.92%）与旧口径基本一致（71% / 8.61%）。
 *
 * @param points 组合逐日序列（升序）
 * @returns 波段列表（升序，仅含已确认的战役）
 */
export const buildShareSignalWaves = (
  points: readonly ComboSharePoint[],
): ShareSignalWave[] => {
  const campaigns = buildShareCampaigns(points);
  const indexByDate = new Map(points.map((p, i) => [p.date, i] as const));
  const waves: ShareSignalWave[] = [];

  for (const campaign of campaigns) {
    if (!campaign.confirmDate) continue;
    const confirmIdx = indexByDate.get(campaign.confirmDate);
    if (confirmIdx === undefined) continue;
    const startIdx = indexByDate.get(campaign.startDate);
    if (startIdx === undefined) continue;
    const endIdx = indexByDate.get(campaign.endDate) ?? confirmIdx;

    waves.push({
      level: campaign.level,
      date: campaign.confirmDate,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      days: campaign.days,
      streak: confirmIdx - startIdx + 1,
      startSharesYi: points[startIdx].totalSharesYi,
      endSharesYi: points[endIdx].totalSharesYi,
      deltaSharesYi: campaign.netFlowYi,
      netFlowYi: campaign.netFlowYi,
      indexStart: points[startIdx].avgPrice,
      indexEnd: points[endIdx].avgPrice,
      indexReturn:
        points[startIdx].avgPrice !== null
          && points[endIdx].avgPrice !== null
          && points[startIdx].avgPrice !== 0
          ? ((points[endIdx].avgPrice - points[startIdx].avgPrice)
            / points[startIdx].avgPrice) * 100
          : null,
      evidences: [...campaign.evidences],
    });
  }

  return waves;
};

/**
 * 一波国家队操作战役（生命周期状态机的内部轨迹）
 */
interface CampaignWalk {
  /** 战役方向 */
  level: 'enter' | 'exit';
  /** 方向符号（1 = 净增，-1 = 净减） */
  sign: 1 | -1;
  /** 段起始索引 */
  startIdx: number;
  /** 疑似日索引（未触发为 null） */
  suspectIdx: number | null;
  /** 确认日索引（未确认为 null） */
  confirmIdx: number | null;
  /** 段内累计净申赎（亿元） */
  flow: number;
  /** 段内交易日数 */
  days: number;
}

/**
 * 国家队操作战役状态机（纯函数）
 *
 * 一波操作 = 一个方向段（连续同向份额变动），生命周期：
 * 观望 → 疑似（连续 2 日同向 或 单日申赎 ≥ 确认门槛一半）→ 确认（三条件齐）
 * → 结束（方向反转，或连续 3 日静默兜底）→ 观望 / 持仓。
 *
 * 全程只用截至当日的数据（无前视）；战役结束时固化累计金额，
 * 并维护「估算持仓余额 = Σ进场 − Σ退场」（含全市场噪音，界面明示口径）。
 *
 * @param points 组合逐日序列（升序）
 * @returns 战役列表（升序，含未确认的战役）
 */
export const buildShareCampaigns = (
  points: readonly ComboSharePoint[],
): ShareCampaignWave[] => {
  const drawdowns = drawdownPctSeries(points.map((p) => p.avgPrice));
  const campaigns: ShareCampaignWave[] = [];

  let campaign: CampaignWalk | null = null;
  let silentRun = 0;
  let balance = 0;

  const suspectHit = (level: 'enter' | 'exit', days: number, flow: number): boolean => {
    const half = (level === 'enter' ? SIGNAL_ENTER_MIN_AMOUNT : SIGNAL_EXIT_MIN_AMOUNT)
      * CAMPAIGN_SUSPECT_AMOUNT_FACTOR;
    const bigDay = level === 'enter' ? flow >= half : flow <= -half;
    return days >= CAMPAIGN_SUSPECT_STREAK || bigDay;
  };
  const confirmHit = (level: 'enter' | 'exit', days: number, segFlow: number, dd: number | null): boolean => {
    if (level === 'enter') {
      return days >= SIGNAL_ENTER_STREAK && segFlow >= SIGNAL_ENTER_MIN_AMOUNT
        && dd !== null && dd <= SIGNAL_ENTER_DRAWDOWN_PCT;
    }
    return days >= SIGNAL_EXIT_STREAK && segFlow <= -SIGNAL_EXIT_MIN_AMOUNT
      && dd !== null && dd >= SIGNAL_EXIT_NEAR_HIGH_PCT;
  };
  const exitCompletion = (flow: number, balanceBefore: number): ShareExitCompletion => {
    // 分母 ≤ 0（余额已清零 / 超额赎回噪音）视为彻底退场
    if (balanceBefore <= 0) return 'cleared';
    const ratio = Math.min(100, (Math.abs(flow) / balanceBefore) * 100);
    if (ratio >= EXIT_COMPLETION_CLEARED_PCT) return 'cleared';
    if (ratio >= EXIT_COMPLETION_LIGHT_PCT) return 'light';
    return 'partial';
  };
  const closeCampaign = (endIdx: number, reason: 'reversal' | 'silent' | 'eof'): void => {
    if (!campaign) return;
    const balanceBefore = balance;
    if (campaign.level === 'enter') {
      balance += campaign.flow;
    } else {
      balance -= Math.abs(campaign.flow);
    }
    const evidences: string[] = [];
    if (campaign.confirmIdx !== null) {
      const dd = drawdowns[campaign.confirmIdx];
      if (campaign.level === 'enter') {
        evidences.push(`段内累计净申购 ${campaign.flow.toFixed(0)} 亿元（≥ ${SIGNAL_ENTER_MIN_AMOUNT} 亿元）`);
        evidences.push(`连续净增 ${campaign.days} 日（≥ ${SIGNAL_ENTER_STREAK} 日）`);
        evidences.push(`确认日指数距前高回撤 ${dd === null ? '—' : `${Math.abs(dd).toFixed(1)}%`}`);
      } else {
        evidences.push(`段内累计净赎回 ${Math.abs(campaign.flow).toFixed(0)} 亿元（≥ ${SIGNAL_EXIT_MIN_AMOUNT} 亿元）`);
        evidences.push(`连续净减 ${campaign.days} 日（≥ ${SIGNAL_EXIT_STREAK} 日）`);
        evidences.push(`确认日指数距前高 ${dd === null ? '—' : `${Math.abs(dd).toFixed(1)}%`}`);
      }
    }
    campaigns.push({
      level: campaign.level,
      startDate: points[campaign.startIdx].date,
      suspectDate: campaign.suspectIdx !== null ? points[campaign.suspectIdx].date : null,
      confirmDate: campaign.confirmIdx !== null ? points[campaign.confirmIdx].date : null,
      endDate: points[endIdx].date,
      endReason: reason,
      days: campaign.days,
      netFlowYi: campaign.flow,
      balanceYi: balance,
      exitCompletion: campaign.level === 'exit' ? exitCompletion(campaign.flow, balanceBefore) : null,
      evidences,
    });
    campaign = null;
    silentRun = 0;
  };

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const delta = point.deltaSharesYi;
    const flow = point.netFlowYi ?? 0;
    const direction: 1 | -1 | 0 = delta > 0 ? 1 : delta < 0 ? -1 : 0;

    // 方向反转 → 当前战役终止（结束日取前一日）
    if (direction !== 0 && campaign && direction !== campaign.sign) {
      closeCampaign(index - 1, 'reversal');
    } else if (direction === 0 && campaign && endRuleSilentHit(silentRun + 1)) {
      // 静默兜底（真实数据上几乎不触发，见 CAMPAIGN_SILENT_END_DAYS 注释）
      closeCampaign(index, 'silent');
      continue;
    }

    if (direction === 0) continue; // 份额零变动：不打断战役、不累计

    silentRun = 0;
    if (!campaign) {
      campaign = {
        level: direction === 1 ? 'enter' : 'exit',
        sign: direction,
        startIdx: index,
        suspectIdx: null,
        confirmIdx: null,
        flow: 0,
        days: 0,
      };
    }
    campaign.flow += flow;
    campaign.days += 1;

    if (campaign.suspectIdx === null && suspectHit(campaign.level, campaign.days, flow)) {
      campaign.suspectIdx = index;
    }
    if (campaign.confirmIdx === null
      && confirmHit(campaign.level, campaign.days, campaign.flow, drawdowns[index])) {
      campaign.confirmIdx = index;
    }
  }
  closeCampaign(points.length - 1, 'eof');

  return campaigns;
};

/**
 * 静默天数是否达到战役结束兜底线
 * @param silentDays 连续份额零变动的交易日数
 * @returns 是否达到 CAMPAIGN_SILENT_END_DAYS
 */
const endRuleSilentHit = (silentDays: number): boolean =>
  silentDays >= CAMPAIGN_SILENT_END_DAYS;

/**
 * 由战役列表装配逐日生命周期状态（纯函数）
 *
 * ⚠️ **色带只画「有信息量」的状态（2026-10-27）**：观望（灰）/ 疑似（浅）/ 确认（深）。
 * - 「结束」是回头看才能下的结论（战役打完才知道，或离场几乎清仓才成立），
 *   属于战役卡与回测统计这类**回看面**，不上色带；
 * - 未确认战役的「疑似」额外要求**段内累计净申赎（截至当日）达到确认门槛量级**
 *   —— 1~2 日的碎抖动（±10 亿级）保持灰色，只有量级像一场「战役」的段才点亮浅色。
 *
 * - 已确认战役：疑似日→确认日前 = 疑似；确认日→段尾 = 确认；其余 = 观望；
 * - 未确认战役：段内累计金额达门槛日起→段尾 = 疑似，其余 = 观望；
 * - 战役之间的空档：估算持仓余额 > 0 → 「持仓观望」，否则「观望」。
 * @param points 组合逐日序列（升序）
 * @param campaigns 战役列表（升序，来自 buildShareCampaigns）
 * @returns 逐日生命周期状态（与 points 等长）
 */
const buildLifecycleByIndex = (
  points: readonly ComboSharePoint[],
  campaigns: readonly ShareCampaignWave[],
): ShareLifecycleState[] => {
  const indexByDate = new Map(points.map((p, i) => [p.date, i] as const));
  const lifecycle: ShareLifecycleState[] = new Array(points.length).fill('watching');
  let cursor = 0;
  let balance = 0;

  for (const campaign of campaigns) {
    const startIdx = indexByDate.get(campaign.startDate);
    const endIdx = indexByDate.get(campaign.endDate);
    if (startIdx === undefined || endIdx === undefined) continue;

    // 战役之间的空档：持仓观望 / 观望
    for (let i = cursor; i < startIdx; i += 1) {
      lifecycle[i] = balance > 0 ? 'holding' : 'watching';
    }
    const suspectIdx = campaign.suspectDate ? indexByDate.get(campaign.suspectDate) : undefined;
    const confirmIdx = campaign.confirmDate ? indexByDate.get(campaign.confirmDate) : undefined;
    // eof = 战役仍在进行（数据末尾）；「结束」不上色带（回头看才有，见函数头注释）。
    // 未确认战役的疑似额外卡「段内累计净申赎 ≥ 确认门槛」——碎抖动不点亮色带。
    const confirmed = confirmIdx !== undefined;
    const magnitudeThreshold = campaign.level === 'enter'
      ? SIGNAL_ENTER_MIN_AMOUNT
      : SIGNAL_EXIT_MIN_AMOUNT;
    let segmentFlow = 0;
    for (let i = startIdx; i <= endIdx; i += 1) {
      segmentFlow += points[i].netFlowYi ?? 0;
      if (confirmed && i >= confirmIdx) {
        lifecycle[i] = campaign.level === 'enter' ? 'entry_confirmed' : 'exit_confirmed';
      } else if (suspectIdx !== undefined && i >= suspectIdx
        && (confirmed || Math.abs(segmentFlow) >= magnitudeThreshold)) {
        lifecycle[i] = campaign.level === 'enter' ? 'entry_suspected' : 'exit_suspected';
      } else {
        lifecycle[i] = 'watching';
      }
    }
    if (campaign.level === 'enter') balance += campaign.netFlowYi;
    else balance -= Math.abs(campaign.netFlowYi);
    cursor = endIdx + 1;
  }
  for (let i = cursor; i < points.length; i += 1) {
    lifecycle[i] = balance > 0 ? 'holding' : 'watching';
  }
  return lifecycle;
};

/**
 * 由组合序列构建逐日信号时间线（纯函数，升序）
 *
 * 逐日信号用于**图表标注**（每天显示当时的状态）：
 * - `level` 只在**战役确认日**打 enter / exit 标（图表上的信号点 = 事件）；
 * - `lifecycle` 是 8 状态生命周期（观望 / 疑似 / 确认 / 结束 / 持仓）。
 * 统计与回测请用 `buildShareSignalWaves`（避免同一事件被重复计数）。
 * @param points 组合逐日序列（升序）
 * @returns 逐日信号（升序）
 */
export const buildShareSignalTimeline = (
  points: readonly ComboSharePoint[],
): ShareSignalDay[] => {
  const levels = points.map((point) => point.avgPrice);
  const drawdowns = drawdownPctSeries(levels);
  const campaigns = buildShareCampaigns(points);
  const confirmDates = new Map<string, ShareSignalLevel>();
  for (const campaign of campaigns) {
    if (campaign.confirmDate) confirmDates.set(campaign.confirmDate, campaign.level);
  }
  const lifecycleByIndex = buildLifecycleByIndex(points, campaigns);

  const results: ShareSignalDay[] = [];
  let streak = 0;
  for (const point of points) {
    // ⚠️ 份额**不变**的日子不能清零连续天数 —— 国家队持有不动也是「持有」，
    // 清零会把一段连续的减持切成几十个碎片。方向切换时从 ±1 重新起算。
    if (point.deltaSharesYi > 0) streak = streak > 0 ? streak + 1 : 1;
    else if (point.deltaSharesYi < 0) streak = streak < 0 ? streak - 1 : -1;
    const index = results.length;
    const evaluation = evaluateShareSignal({
      date: point.date,
      totalSharesYi: point.totalSharesYi,
      deltaSharesYi: point.deltaSharesYi,
      netFlowYi: point.netFlowYi,
      indexLevel: point.avgPrice,
      drawdownPct: drawdowns[index],
      changeStreak: streak,
    });
    results.push({
      ...evaluation,
      // 图表标注口径：只有战役确认日才算信号点
      level: confirmDates.get(point.date) ?? 'none',
      lifecycle: lifecycleByIndex[index],
    });
  }
  return results;
};

/**
 * 历史回测：评估信号出现后的收益（纯函数）
 *
 * 收益口径：组合固定权重价格指数从**信号日**到 N 个交易日后的涨跌幅（%）。
 *
 * ⚠️ **按波段评估而非逐日**：一次持续多日的进场是「一次事件」，
 * 逐日评估会把同一件事计多次，胜率与平均收益都会失真。
 * @param points 组合逐日序列（升序）
 * @param holdDays 持有期（交易日；默认 BACKTEST_HOLD_DAYS）
 * @returns 按档位分组的回测统计
 */
export const runShareBacktest = (
  points: readonly ComboSharePoint[],
  holdDays: number = BACKTEST_HOLD_DAYS,
): ShareBacktestStat[] => {
  const waves = buildShareSignalWaves(points);
  const indexByDate = new Map<string, number>();
  points.forEach((point, index) => indexByDate.set(point.date, index));

  const samples: ShareBacktestSample[] = [];
  for (const wave of waves) {
    const startIndex = indexByDate.get(wave.date);
    if (startIndex === undefined) continue;
    const base = points[startIndex].avgPrice;
    const next = points[startIndex + 1]?.avgPrice ?? null;
    const future = points[startIndex + holdDays]?.avgPrice ?? null;
    samples.push({
      date: wave.date,
      level: wave.level,
      return1d:
        base !== null && next !== null ? ((next - base) / base) * 100 : null,
      returnHold:
        base !== null && future !== null ? ((future - base) / base) * 100 : null,
      indexLevel: base,
    });
  }

  const stats: ShareBacktestStat[] = [];
  for (const level of ['enter', 'exit'] as const) {
    const group = samples.filter((sample) => sample.level === level);
    const returns1d = group
      .map((sample) => sample.return1d)
      .filter((value): value is number => value !== null);
    const returnsHold = group
      .map((sample) => sample.returnHold)
      .filter((value): value is number => value !== null);
    const winCount = returnsHold.filter((value) => value > 0).length;
    stats.push({
      level,
      count: group.length,
      avgReturn1d:
        returns1d.length > 0
          ? returns1d.reduce((sum, value) => sum + value, 0) / returns1d.length
          : null,
      avgReturnHold:
        returnsHold.length > 0
          ? returnsHold.reduce((sum, value) => sum + value, 0) / returnsHold.length
          : null,
      winCount,
      winRate: returnsHold.length > 0 ? (winCount / returnsHold.length) * 100 : null,
      samples: group,
    });
  }
  return stats;
};

/**
 * 汇总「近 N 日」组合净申赎（纯函数）
 * @param points 组合逐日序列（升序）
 * @param days 近 N 日
 * @returns 净申赎合计（亿元）与缺失天数
 */
export const recentNetFlow = (
  points: readonly ComboSharePoint[],
  days: number,
): { totalYi: number; missingDays: number } => {
  const window = points.slice(Math.max(0, points.length - days));
  let totalYi = 0;
  let missingDays = 0;
  for (const point of window) {
    if (point.netFlowYi === null) missingDays += 1;
    else totalYi += point.netFlowYi;
  }
  return { totalYi, missingDays };
};
