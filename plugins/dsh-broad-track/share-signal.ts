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
  ShareSignalDay,
  ShareSignalLevel,
} from './types';

/**
 * 汇总组合（宽基口径）的逐日份额序列（纯函数）
 *
 * 组合总份额 = 当日全部有份额数据的 ETF 之和；
 * 组合净申赎金额 = 各 ETF「Δ份额 × 收盘价」之和。
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
    for (const row of rows) {
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
 * 一个方向段（连续同向份额变动的交易日集合）
 *
 * 方向段的划分依据是**份额变动的符号连续性**：
 * 份额不变的交易日**不打断**方向段（国家队持有不动也是「持有」，
 * 清零会把一段连续的减持切成几十个碎片）。
 */
interface DirectionSegment {
  /** 方向：1 = 净增，-1 = 净减 */
  direction: 1 | -1;
  /** 段内交易日索引（升序） */
  indices: number[];
}

/**
 * 把时间线切成方向段（纯函数）
 * @param points 组合逐日序列（升序）
 * @returns 方向段列表（升序）
 */
const buildDirectionSegments = (
  points: readonly ComboSharePoint[],
): DirectionSegment[] => {
  const segments: DirectionSegment[] = [];
  let current: DirectionSegment | null = null;

  points.forEach((point, index) => {
    const direction: 1 | -1 | 0 =
      point.deltaSharesYi > 0 ? 1 : point.deltaSharesYi < 0 ? -1 : 0;
    if (direction === 0) {
      // 份额不变：不打断方向段，但也不累加
      if (current) current.indices.push(index);
      return;
    }
    if (current && current.direction === direction) {
      current.indices.push(index);
      return;
    }
    // 方向切换 → 结束当前段
    current = {
      direction,
      indices: [index],
    };
    segments.push(current);
  });
  return segments;
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
 * @returns 信号判定（档位 + 依据）
 */
export const evaluateShareSignal = (day: {
  date: string;
  totalSharesYi: number;
  deltaSharesYi: number;
  netFlowYi: number | null;
  indexLevel: number | null;
  drawdownPct: number | null;
  changeStreak: number;
}): ShareSignalDay => {
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
 * @param points 组合逐日序列（升序）
 * @returns 波段列表（升序）
 */
export const buildShareSignalWaves = (
  points: readonly ComboSharePoint[],
): ShareSignalWave[] => {
  const levels = points.map((point) => point.avgPrice);
  const drawdowns = drawdownPctSeries(levels);
  const waves: ShareSignalWave[] = [];

  for (const segment of buildDirectionSegments(points)) {
    const wantLevel: ShareSignalLevel = segment.direction === 1 ? 'enter' : 'exit';

    // 段内逐日判定，找**首个**满足完整条件的那天作为信号日
    let signalIndex: number | null = null;
    let signalDay: ShareSignalDay | null = null;
    let streak = 0;
    for (const index of segment.indices) {
      const point = points[index];
      // 段内连续天数：正方向累加，负方向累减（切向时从 1 / -1 重新起算）
      if (point.deltaSharesYi > 0) streak = streak > 0 ? streak + 1 : 1;
      else if (point.deltaSharesYi < 0) streak = streak < 0 ? streak - 1 : -1;
      const day = evaluateShareSignal({
        date: point.date,
        totalSharesYi: point.totalSharesYi,
        deltaSharesYi: point.deltaSharesYi,
        netFlowYi: point.netFlowYi,
        indexLevel: point.avgPrice,
        drawdownPct: drawdowns[index],
        changeStreak: streak,
      });
      if (signalIndex === null && day.level === wantLevel) {
        signalIndex = index;
        signalDay = day;
        break;
      }
    }
    if (signalIndex === null || signalDay === null) continue;

    const firstIndex = segment.indices[0];
    const lastIndex = segment.indices[segment.indices.length - 1];
    const first = points[firstIndex];
    const last = points[lastIndex];
    const indexStart = first.avgPrice;
    const indexEnd = last.avgPrice;

    // 信号强度取「到信号日为止」的累计（整段累计会把信号之后的无关波动算进来）
    let flowToSignal = 0;
    let deltaToSignal = 0;
    for (const index of segment.indices) {
      if (index > signalIndex) break;
      flowToSignal += points[index].netFlowYi ?? 0;
      deltaToSignal += points[index].deltaSharesYi;
    }

    waves.push({
      level: wantLevel,
      date: signalDay.date,
      startDate: first.date,
      endDate: last.date,
      days: segment.indices.length,
      streak: Math.abs(signalDay.changeStreak),
      startSharesYi: first.totalSharesYi,
      endSharesYi: last.totalSharesYi,
      deltaSharesYi: deltaToSignal,
      netFlowYi: flowToSignal,
      indexStart,
      indexEnd,
      indexReturn:
        indexStart !== null && indexEnd !== null && indexStart !== 0
          ? ((indexEnd - indexStart) / indexStart) * 100
          : null,
      evidences: [...signalDay.evidences],
    });
  }

  return waves;
};

/**
 * 由组合序列构建逐日信号时间线（纯函数，升序）
 *
 * 逐日信号用于**图表标注**（每天显示当时的状态）；
 * 统计与回测请用 `buildShareSignalWaves`（避免同一事件被重复计数）。
 * @param points 组合逐日序列（升序）
 * @returns 逐日信号（升序）
 */
export const buildShareSignalTimeline = (
  points: readonly ComboSharePoint[],
): ShareSignalDay[] => {
  const levels = points.map((point) => point.avgPrice);
  const drawdowns = drawdownPctSeries(levels);
  const results: ShareSignalDay[] = [];
  let streak = 0;
  for (const point of points) {
    // ⚠️ 份额**不变**的日子不能清零连续天数 —— 国家队持有不动也是「持有」，
    // 清零会把一段连续的减持切成几十个碎片。
    if (point.deltaSharesYi > 0) streak += 1;
    else if (point.deltaSharesYi < 0) streak = streak > 0 ? -1 : streak - 1;
    results.push(
      evaluateShareSignal({
        date: point.date,
        totalSharesYi: point.totalSharesYi,
        deltaSharesYi: point.deltaSharesYi,
        netFlowYi: point.netFlowYi,
        indexLevel: point.avgPrice,
        drawdownPct: drawdowns[results.length],
        changeStreak: streak,
      }),
    );
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
