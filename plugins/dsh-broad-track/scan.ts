/**
 * 插件 dsh-broad-track（宽基跟踪）· 刷新编排
 *
 * 两个入口，都只由用户点击触发（频率纪律：重接口不轮询，结果落库后页面零联网）：
 * - `refreshDaily`：行情快照（1 次批量）+ 逐 ETF 资金流与日 K（各 14 次）≈ 29 次请求；
 * - `syncQuarter`：逐 ETF 份额申赎与持有人结构（各 14 次）= 28 次请求。
 *
 * 成交额历史的口径：东财 K 线在 push2delay 上不可用、同花顺 line 对 ETF 404，
 * 故用**新浪日 K 的成交量 × 收盘价**近似，并用当日东财精确成交额做单点校准
 * （校准因子 = 精确值 ÷ 近似值，应用到全部历史日；误差在分子分母间基本抵消）。
 *
 * 失败策略：单只 ETF 失败只降级该只（推一条 warning），不影响其余 ETF 与整体落库；
 * 行情批量失败直接抛错（刷新主线中断，提示用户重试）。
 */
import {
  EM_F10_DELAY_MS,
  EM_FFLOW_DELAY_MS,
  FFLOW_DAYS,
  TRACKED_ETFS,
  TRACKED_INDICES,
  etfSecid,
  etfSinaSymbol,
} from './constants';
import {
  fetchCyrjgRows,
  fetchFflowDays,
  fetchGmbdRows,
  fetchQuoteBatch,
  fetchSinaKline,
} from './em-data';
import type { SinaKlineRow } from './em-parse';
import type {
  BroadDeps,
  BroadScanProgress,
  EtfDailyRow,
  EtfHolderRow,
  EtfQuarterRow,
  QuoteRow,
} from './types';
import type { BroadRepo } from './storage';

/** 日频刷新结果 */
export interface DailyRefreshResult {
  /** 降级与告警（空数组 = 一切正常） */
  warnings: string[];
  /** 落库的日频行数 */
  rowCount: number;
}

/** 季度同步结果 */
export interface QuarterSyncResult {
  /** 降级与告警（空数组 = 一切正常） */
  warnings: string[];
  /** 落库的季度行数 */
  quarterCount: number;
  /** 落库的持有人结构行数 */
  holderCount: number;
}

/**
 * 错误消息归一（纯函数）
 * @param error 未知错误
 * @returns 可读消息
 */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 用新浪 K 线估算每日成交额，并按当日精确值校准（纯函数）
 *
 * 近似成交额 = 成交量（股）× 收盘价；校准因子取「最近一个共同交易日的
 * 精确值 ÷ 近似值」（拿不到精确值或近似值为 0 时因子为 1，即不校准）。
 * @param kline 新浪 K 线行（升序）
 * @param exactAmount 当日东财精确成交额（元；无则 null）
 * @returns 日期 → 校准后成交额（元）
 */
export const calibrateAmounts = (
  kline: readonly SinaKlineRow[],
  exactAmount: number | null,
): Map<string, number> => {
  const amounts = new Map<string, number>();
  const approx = new Map<string, number>();
  for (const row of kline) {
    if (row.volume === null || row.close === null) continue;
    approx.set(row.date, row.volume * row.close);
  }
  if (approx.size === 0) return amounts;

  let factor = 1;
  if (exactAmount !== null && exactAmount > 0) {
    // 最近一个交易日（升序最后一个）做校准点
    const latestDate = kline[kline.length - 1]?.date;
    const latestApprox = latestDate === undefined ? undefined : approx.get(latestDate);
    if (latestApprox !== undefined && latestApprox > 0) {
      factor = exactAmount / latestApprox;
    }
  }
  for (const [date, value] of approx) {
    amounts.set(date, value * factor);
  }
  return amounts;
};

/**
 * 刷新日频数据（行情 + 资金流 + 成交额历史）
 * @param deps 宿主能力
 * @param repo 宽基跟踪仓储
 * @param onProgress 每完成一个请求回调一次（进度条计数）
 * @returns 刷新结果（告警 + 落库行数）
 */
export const refreshDaily = async (
  deps: BroadDeps,
  repo: BroadRepo,
  onProgress?: (progress: BroadScanProgress) => void,
): Promise<DailyRefreshResult> => {
  const etfs = TRACKED_ETFS;
  const total = 1 + etfs.length * 2;
  let done = 0;
  const tick = (): void => {
    done += 1;
    onProgress?.({ done, total });
  };
  const warnings: string[] = [];

  // 1) 行情快照：ETF + 宽基指数一个批量（失败直接抛错，刷新中断）
  const secids = [...etfs.map(etfSecid), ...TRACKED_INDICES.map((item) => item.secid)];
  const quotes = await fetchQuoteBatch(deps, secids, tick);
  const quoteByCode = new Map<string, QuoteRow>(quotes.map((row) => [row.code, row]));
  const indexQuotes: QuoteRow[] = [];
  for (const index of TRACKED_INDICES) {
    const quote = quoteByCode.get(index.code);
    if (quote) indexQuotes.push({ ...quote, name: index.name });
  }

  // 2) 逐 ETF：资金流（东财）+ 日 K（新浪，成交额历史）
  const rows: EtfDailyRow[] = [];
  let first = true;
  for (const etf of etfs) {
    if (!first) await deps.format.delay(EM_FFLOW_DELAY_MS);
    first = false;

    let flowRows;
    try {
      flowRows = await fetchFflowDays(deps, etfSecid(etf), tick);
    } catch (error) {
      tick();
      warnings.push(`${etf.name}（${etf.code}）资金流取数失败：${errorMessage(error)}`);
      continue;
    }
    if (flowRows.length === 0) {
      warnings.push(`${etf.name}（${etf.code}）资金流上游无数据`);
    }

    let klineRows: SinaKlineRow[] = [];
    try {
      klineRows = await fetchSinaKline(deps, etfSinaSymbol(etf), FFLOW_DAYS, tick);
    } catch (error) {
      tick();
      warnings.push(`${etf.name}（${etf.code}）日K取数失败，成交额留空：${errorMessage(error)}`);
    }

    const quote = quoteByCode.get(etf.code);
    const amounts = calibrateAmounts(klineRows, quote?.amount ?? null);
    for (const flow of flowRows) {
      rows.push({
        date: flow.date,
        code: etf.code,
        price: flow.close,
        changePercent: flow.changePercent,
        amount: amounts.get(flow.date) ?? null,
        mainInflow: flow.mainInflow,
        superInflow: flow.superInflow,
        bigInflow: flow.bigInflow,
        midInflow: flow.midInflow,
        smallInflow: flow.smallInflow,
      });
    }
  }

  await repo.saveDailyRows(rows);
  await repo.saveMeta({ dailyRefreshedAt: Date.now(), indexQuotes, warnings });
  return { warnings, rowCount: rows.length };
};

/**
 * 同步季度数据（份额申赎 + 持有人结构）
 * @param deps 宿主能力
 * @param repo 宽基跟踪仓储
 * @param onProgress 每完成一个请求回调一次（进度条计数）
 * @returns 同步结果（告警 + 落库行数）
 */
export const syncQuarter = async (
  deps: BroadDeps,
  repo: BroadRepo,
  onProgress?: (progress: BroadScanProgress) => void,
): Promise<QuarterSyncResult> => {
  const etfs = TRACKED_ETFS;
  const total = etfs.length * 2;
  let done = 0;
  const tick = (): void => {
    done += 1;
    onProgress?.({ done, total });
  };
  const warnings: string[] = [];
  const quarters: EtfQuarterRow[] = [];
  const holders: EtfHolderRow[] = [];

  let first = true;
  for (const etf of etfs) {
    if (!first) await deps.format.delay(EM_F10_DELAY_MS);
    first = false;

    try {
      quarters.push(...(await fetchGmbdRows(deps, etf.code, tick)));
    } catch (error) {
      tick();
      warnings.push(`${etf.name}（${etf.code}）份额申赎取数失败：${errorMessage(error)}`);
    }
    await deps.format.delay(EM_F10_DELAY_MS);

    try {
      holders.push(...(await fetchCyrjgRows(deps, etf.code, tick)));
    } catch (error) {
      tick();
      warnings.push(`${etf.name}（${etf.code}）持有人结构取数失败：${errorMessage(error)}`);
    }
  }

  if (quarters.length > 0) await repo.saveQuarterRows(quarters);
  if (holders.length > 0) await repo.saveHolderRows(holders);
  await repo.saveMeta({ quarterRefreshedAt: Date.now(), warnings });
  return { warnings, quarterCount: quarters.length, holderCount: holders.length };
};
