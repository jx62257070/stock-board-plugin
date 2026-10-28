/**
 * 插件 csw-active-cap-index · 计算层（纯函数，不依赖宿主运行时）
 *
 * 全部输入输出都是可序列化的普通对象，便于单元测试与对账：
 * - 解析：上游 `'-'` / 非数值一律 null 化（`num`）；
 * - 口径：活跃市值（指南针 0AMV 近似）与指数贡献（通达信口径）各一个纯视图函数；
 * - 历史：交易日快照仓库（`ctx.db` 的薄封装，upsert 语义）。
 */
import { ACTIVE_BOARD_ROWS, CONTRIB_SIDE_ROWS, DAILY_TABLE, HISTORY_DAYS, MA_WINDOW } from './constants';
import type { PluginDatabase } from '../../host/types/plugin.types';
import type {
  ActiveDisplayRow,
  ActiveView,
  ContributionRow,
  ContributionView,
  ClistRawRow,
  DailySnapshotRow,
  IndexKey,
  IndexRawRow,
  IndexSnapshotMap,
  StockRow,
  TrendPoint,
} from './types';

/**
 * 上游数值解析：`'-'` / undefined / 非有限数值一律归 null
 * @param raw 上游原始值
 * @returns 数值或 null
 */
export const num = (raw: number | string | undefined | null): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

/**
 * 金额人性化：≥1 万亿显示「X.XX万亿」，≥1 亿显示「XXXX亿 / XX.XX亿」
 * @param yuan 元（可 null）
 * @returns 展示文案（null 显示 `--`）
 */
export const formatAmountCn = (yuan: number | null | undefined): string => {
  if (yuan == null) return '--';
  if (yuan >= 1e12) return `${(yuan / 1e12).toFixed(2)}万亿`;
  return `${(yuan / 1e8).toFixed(yuan / 1e8 >= 100 ? 0 : 2)}亿`;
};

/**
 * 点数人性化（贡献点 / 涨跌点）：正值带 `+`，绝对值 < 1 保留 3 位小数
 * @param value 点数（可 null）
 * @returns 展示文案
 */
export const formatPoints = (value: number | null | undefined): string => {
  if (value == null) return '--';
  const abs = Math.abs(value);
  return value > 0 ? `+${abs.toFixed(abs < 1 ? 3 : 2)}` : abs.toFixed(abs < 1 ? 3 : 2);
};

/**
 * 裸代码 → 完整符号（6/9 开头沪市，其余按深市；本插件样本只有沪深 A 股）
 * @param code 裸代码（如 `600519`）
 * @returns 完整符号（`sh600519`）
 */
export const toFullSymbol = (code: string): string =>
  code.startsWith('6') || code.startsWith('9') ? `sh${code}` : `sz${code}`;

/**
 * 数组求和（跳过 null）
 * @param values 数值数组
 * @returns 合计（全 null 返回 null）
 */
export const sumOf = (values: readonly (number | null)[]): number | null => {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value != null) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
};

/**
 * 本地日期（`YYYY-MM-DD`；快照表的日期键）
 * @param d Date 对象（缺省当前时间）
 * @returns 日期字符串
 */
export const localDate = (d: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 是否工作日（周一至周五；节假日不识别，快照层用成交额下限二次过滤）
 * @param d Date 对象（缺省当前时间）
 * @returns 是否周一至周五
 */
export const isWeekday = (d: Date = new Date()): boolean => d.getDay() >= 1 && d.getDay() <= 5;

/**
 * 简单移动平均序列（窗口不足处补 null；缺口不参与均值）
 * @param values 数值数组（null 视为缺口）
 * @param window 窗口大小
 * @returns 与输入等长的均线数组
 */
export const movingAverage = (values: readonly (number | null)[], window: number): (number | null)[] =>
  values.map((_, index) => {
    if (index < window - 1) return null;
    const slice = values.slice(index - window + 1, index + 1);
    const avg = sumOf(slice);
    const counted = slice.filter((v) => v != null).length;
    return avg == null || counted === 0 ? null : avg / counted;
  });

/**
 * 5 日均线（趋势曲线专用，窗口见 `MA_WINDOW`）
 * @param values 数值数组（null 视为缺口）
 * @returns 与输入等长的均线数组
 */
export const maSeries = (values: readonly (number | null)[]): (number | null)[] =>
  movingAverage(values, MA_WINDOW);

/**
 * clist 原始行 → 统一行结构
 * @param raw clist 原始行
 * @returns 统一行情行（code / name 缺失时以空串兜底，不参与展示但保持形状）
 */
export const toStockRow = (raw: ClistRawRow): StockRow => ({
  code: raw.f12 ?? '',
  name: raw.f14 ?? '',
  price: num(raw.f2),
  changePct: num(raw.f3),
  amount: num(raw.f6),
  totalCap: num(raw.f20),
  floatCap: num(raw.f21),
});

/**
 * 活跃市值视图（指南针 0AMV 近似口径）
 *
 * 活跃集合 = 成交额 ≥ 门槛的个股（来自成交额 Top 300，上游降序返回）；
 * 活跃市值 = 活跃集合的流通市值合计。
 * @param rows 成交额 Top 300 统一行（已按成交额降序）
 * @param thresholdYi 门槛（亿元）
 * @param totalMarketAmount 两市实时总成交额（元；缺失 null，占比降级）
 * @returns 视图数据
 */
export const buildActiveView = (
  rows: readonly StockRow[],
  thresholdYi: number,
  totalMarketAmount: number | null,
): ActiveView => {
  const threshold = thresholdYi * 1e8;
  const activeRows = rows.filter((row) => row.amount != null && row.amount >= threshold);
  const activeCap = sumOf(activeRows.map((row) => row.floatCap));
  const activeAmount = sumOf(activeRows.map((row) => row.amount));
  const turnoverRows = rows.slice(0, ACTIVE_BOARD_ROWS);
  const maxAmount = Math.max(...turnoverRows.map((row) => row.amount ?? 0), 0);
  const displayRows: ActiveDisplayRow[] = turnoverRows.map((row, index) => ({
    ...row,
    rank: index + 1,
    isActive: row.amount != null && row.amount >= threshold,
    amountShare:
      activeAmount != null && activeAmount > 0 && row.amount != null
        ? (row.amount / activeAmount) * 100
        : null,
    amountBarRatio: maxAmount > 0 && row.amount != null ? row.amount / maxAmount : 0,
  }));
  return {
    activeRows,
    displayRows,
    activeCap,
    activeCount: activeRows.length,
    activeAmount,
    amountShareOfMarket:
      activeAmount != null && activeAmount > 0 && totalMarketAmount != null
        ? (activeAmount / totalMarketAmount) * 100
        : null,
  };
};

/**
 * 指数贡献视图（通达信口径）
 *
 * 贡献点(i) = 涨跌幅(i)% × (总市值(i) ÷ 样本总市值) × 指数点位。
 * 样本合计与指数实际涨跌点（f4）可对账：全样本时二者应相等。
 * @param candidates 候选池（Top 市值 ∪ Top 成交额，已去重）
 * @param indexRaw 指数 ulist 原始行（f2 / f3 / f4 / f20）
 * @param prefixes 该指数的样本代码前缀圈定
 * @returns 视图数据（正负榜单 + 对账）
 */
export const buildContributionView = (
  candidates: readonly StockRow[],
  indexRaw: IndexRawRow | undefined,
  prefixes: readonly string[],
): ContributionView => {
  const indexPrice = num(indexRaw?.f2);
  const indexChangePct = num(indexRaw?.f3);
  const indexChangePoints = num(indexRaw?.f4);
  const scopeTotalCap = num(indexRaw?.f20);
  const matched = candidates.filter((row) => prefixes.some((prefix) => row.code.startsWith(prefix)));
  const scored = matched
    .map((row) => {
      const weight =
        scopeTotalCap != null && scopeTotalCap > 0 && row.totalCap != null
          ? (row.totalCap / scopeTotalCap) * 100
          : null;
      const points =
        indexPrice != null &&
        scopeTotalCap != null &&
        scopeTotalCap > 0 &&
        row.totalCap != null &&
        row.changePct != null
          ? (indexPrice * (row.changePct / 100) * row.totalCap) / scopeTotalCap
          : null;
      return { ...row, weight, points };
    })
    .filter((row): row is ContributionRow & { points: number } => row.points != null)
    .sort((a, b) => b.points - a.points);
  const samplePointsSum = sumOf(scored.map((row) => row.points));
  // 贡献占比：|贡献点| ÷ |指数实际涨跌点|（涨跌点为 0 时无法对账，置 null）
  const withShare = scored.map((row) => ({
    ...row,
    share:
      indexChangePoints != null && indexChangePoints !== 0
        ? (Math.abs(row.points) / Math.abs(indexChangePoints)) * 100
        : null,
  }));
  return {
    indexPrice,
    indexChangePct,
    indexChangePoints,
    scopeTotalCap,
    positive: withShare.filter((row) => row.points > 0).slice(0, CONTRIB_SIDE_ROWS),
    negative: withShare.filter((row) => row.points < 0).reverse().slice(0, CONTRIB_SIDE_ROWS),
    sampleCount: withShare.length,
    positiveCount: withShare.filter((row) => row.points > 0).length,
    negativeCount: withShare.filter((row) => row.points < 0).length,
    samplePointsSum,
    coverage:
      samplePointsSum != null && indexChangePoints != null && indexChangePoints !== 0
        ? (samplePointsSum / indexChangePoints) * 100
        : null,
  };
};

/**
 * 指数快照列表 → 按名称圈定的映射（三只指数按官方名称匹配）
 * @param diff ulist 返回的原始行数组（可能缺个别指数）
 * @returns 映射（key: sh / sz / cyb）
 */
export const indexRowsToMap = (diff: readonly IndexRawRow[]): IndexSnapshotMap => {
  const byKey: IndexSnapshotMap = {};
  for (const raw of diff) {
    if (raw.f14 === '上证指数') byKey.sh = raw;
    if (raw.f14 === '深证成指') byKey.sz = raw;
    if (raw.f14 === '创业板指') byKey.cyb = raw;
  }
  return byKey;
};

/** 候选池贡献视图的入口参数键（`IndexKey` 的运行时别名，避免直接依赖字面量散落） */
export type ContributionIndexKey = IndexKey;

/**
 * 交易日快照仓库（`ctx.db` 薄封装：建表幂等 + 同日 upsert + 按日期升序读取）
 * @param db 插件数据库句柄（apply 里从 ctx.db 传入）
 * @returns 仓库（record / list）
 */
export const createHistoryRepo = (db: PluginDatabase) => {
  let ready = false;
  /** 建表（幂等，ensureTable 可重复调用） */
  const ensure = async (): Promise<void> => {
    if (ready) return;
    await db.ensureTable(DAILY_TABLE, [
      { name: 'date', type: 'text', indexed: true },
      { name: 'activeCap', type: 'real' },
      { name: 'activeCount', type: 'integer' },
      { name: 'activeAmount', type: 'real' },
    ]);
    ready = true;
  };
  return {
    /**
     * 记录 / 覆盖某交易日快照（盘中多次刷新同日 upsert）
     * @param date 交易日（`YYYY-MM-DD`）
     * @param activeCap 活跃市值（元）
     * @param activeCount 活跃家数
     * @param activeAmount 活跃成交额（元）
     */
    record: async (date: string, activeCap: number, activeCount: number, activeAmount: number): Promise<void> => {
      await ensure();
      const existing = await db.select<DailySnapshotRow>(DAILY_TABLE, { where: { date }, limit: 1 });
      if (existing.length > 0) {
        await db.update(DAILY_TABLE, existing[0].id, { activeCap, activeCount, activeAmount });
      } else {
        await db.insert(DAILY_TABLE, { date, activeCap, activeCount, activeAmount });
      }
    },
    /**
     * 近 N 个交易日快照（按日期升序）
     * @param limit 条数（缺省 `HISTORY_DAYS`）
     * @returns 快照行（升序）
     */
    list: async (limit: number = HISTORY_DAYS): Promise<TrendPoint[]> => {
      await ensure();
      const found = await db.select<DailySnapshotRow>(DAILY_TABLE, {
        orderBy: { column: 'date', desc: true },
        limit,
      });
      return found
        .reverse()
        .map((row) => ({ date: row.date, activeCap: row.activeCap ?? null }));
    },
  };
};

/** 历史仓库类型（`createHistoryRepo` 的返回，供 plugin.ts 与测试复用） */
export type HistoryRepo = ReturnType<typeof createHistoryRepo>;
