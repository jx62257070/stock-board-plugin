/**
 * 插件 dsh-broad-track（宽基跟踪）· 份额序列同步编排
 *
 * 这是「国家队进出」的主口径取数流程，与 `scan.ts` 的资金流刷新**并行独立**：
 * - 资金流刷新（`scan.ts`）：29 次请求，拿二级市场痕迹（辅助列）；
 * - 份额同步（本模块）：拿真实申赎（主口径）。
 *
 * **增量入库**（用户明确要求：历史回测要入库，不能每次全量查）：
 * - 沪市：上交所按日全量。已入库的日期直接跳过（`existingShareDates`），
 *   只补「缺失日期 + 最近 N 天重刷」（上游改数时以新值为准）；
 * - 深市：`fund_jjgm` 按代码 + 区间，一次拿一只 ETF 的整段历史，
 *   **增量粒度是「每只 ETF × 每段区间」**，比逐日粗但请求数少一个量级。
 *
 * **断点续传**：每拿到一天就落库（`saveShareRows`），中途失败后重跑
 * 只补缺失部分 —— 678 个交易日的回填不需要一次跑完。
 *
 * ⚠️ **跳过非交易日**（性能关键）：上交所对非交易日返回**空响应体**，
 * 而空体按失败处理会**触发 3 次重试** —— 一次请求变三次，678 天回填要多打
 * 2000 次无效请求。故先拉腾讯日 K，用它的日期集合当**交易日历**，
 * 只对真实交易日发上交所请求。日历拿不到时（价格源整体不可达）退回「全日期请求」。
 */
import {
  EXCHANGE_DELAY_MS,
  SHARE_HISTORY_MAX_DAYS,
  SHARE_HISTORY_START,
  TRACKED_ETFS,
} from './constants';
import {
  addDays,
  fetchSseShareSnapshot,
  fetchSzseShareHistory,
  fetchTencentKline,
} from './share-data';
import { computeShareChanges } from './share-parse';
import type { SseShareRow, SzseShareRow, TencentKlineRow } from './share-parse';
import type { BroadDeps, BroadScanProgress, EtfShareRow } from './types';
import type { BroadRepo } from './storage';

/**
 * 同步结果
 */
export interface ShareSyncResult {
  /** 降级与告警（空数组 = 一切正常） */
  warnings: string[];
  /** 落库的份额行数 */
  rowCount: number;
  /** 本次回源请求次数 */
  requestCount: number;
  /** 覆盖的日期区间（YYYY-MM-DD；空串 = 无数据） */
  earliestDate: string;
  /** 覆盖的日期区间（YYYY-MM-DD；空串 = 无数据） */
  latestDate: string;
  /** 因非交易日而跳过的日期数（省下的请求） */
  skippedNonTradingDays: number;
}

/** 同步选项 */
export interface ShareSyncOptions {
  /** 回溯起点（YYYY-MM-DD；默认 SHARE_HISTORY_START） */
  startDate?: string;
  /** 回溯终点（YYYY-MM-DD；默认今天） */
  endDate?: string;
  /** 最近多少天强制重刷（上游改数时以新值为准；默认 5） */
  refreshRecentDays?: number;
  /** 是否跳过深市（深市域被掐时用） */
  skipSzse?: boolean;
  /** 沪市并发度（默认 6；实测 8 稳定无失败） */
  concurrency?: number;
  /** 单次同步最多回填多少个交易日（默认不限；用于分批回填） */
  maxDays?: number;
}

/** 沪市默认并发度（实测 8 并发 12 请求 846ms、零失败） */
const DEFAULT_SSE_CONCURRENCY = 6;

/**
 * 取今天的日期串（本地时区，YYYY-MM-DD）
 * @returns 日期串
 */
const todayString = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * 生成日期序列（升序）
 * @param start 起始日（YYYY-MM-DD）
 * @param end 结束日（YYYY-MM-DD）
 * @returns 日期序列（升序）
 */
export const dateRange = (start: string, end: string): string[] => {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end && dates.length < SHARE_HISTORY_MAX_DAYS) {
    dates.push(cursor);
    const next = addDays(cursor, 1);
    if (next === '') break;
    cursor = next;
  }
  return dates;
};

/**
 * 按并发度执行任务（保序收集结果；单个任务失败不影响其他）
 * @param tasks 任务数组
 * @param limit 并发度
 * @returns 结果数组（与 tasks 同序；失败位置为 null）
 */
const runConcurrent = async <T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<(T | null)[]> => {
  const results: (T | null)[] = new Array(tasks.length).fill(null);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const slot = index;
      index += 1;
      if (slot >= tasks.length) return;
      try {
        results[slot] = await tasks[slot]();
      } catch {
        results[slot] = null;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker);
  await Promise.all(workers);
  return results;
};

/**
 * 取腾讯历史收盘价（每只 ETF 一次请求，覆盖整个窗口）
 *
 * ⚠️ **必须按 ETF 分开返回**：不同 ETF 的价格量级差异极大（510300 约 4 元、
 * 科创 50ETF 约 1 元），混在一张 map 里会让「某只 ETF 缺数据的日子被另一只
 * ETF 的价格顶上」，直接把组合指数算飞（实测会算出 +183% 的失真累计）。
 * @param deps 宿主能力
 * @param start 起始日
 * @param end 结束日
 * @returns 代码 → 日期 → 收盘价
 */
const fetchPriceMap = async (
  deps: BroadDeps,
  start: string,
  end: string,
): Promise<Map<string, Map<string, number>>> => {
  const results = await runConcurrent(
    TRACKED_ETFS.map((etf) => async () => {
      const symbol = `${etf.market === '1' ? 'sh' : 'sz'}${etf.code}`;
      try {
        return await fetchTencentKline(deps, symbol, start, end, SHARE_HISTORY_MAX_DAYS);
      } catch {
        return [] as TencentKlineRow[];
      }
    }),
    4,
  );
  const byCode = new Map<string, Map<string, number>>();
  TRACKED_ETFS.forEach((etf, index) => {
    const map = new Map<string, number>();
    for (const row of results[index] ?? []) {
      if (!map.has(row.date)) map.set(row.date, row.close);
    }
    byCode.set(etf.code, map);
  });
  return byCode;
};

/**
 * 同步份额序列（主口径）
 *
 * 流程：
 * 1. 读库里已有的份额日期 → 算出「缺失日期」与「需重刷日期」；
 * 2. 收盘价：腾讯一次拉一只 ETF 的全窗口历史（**顺带得到交易日历**）；
 * 3. 用交易日历裁剪待请求日期，跳过非交易日（省掉大量空体重试）；
 * 4. 沪市：并发逐日请求上交所全市场快照（一次覆盖全部沪市 ETF）；
 * 5. 深市：逐只 ETF 拉整段区间历史（增量粒度粗，请求数少）；
 * 6. 算份额变动与净申赎金额 → 分批落库。
 *
 * 每拿到一批就落库（断点续传）。
 * @param deps 宿主能力
 * @param repo 宽基跟踪仓储
 * @param onProgress 进度回调
 * @param options 同步选项
 * @returns 同步结果
 */
export const syncShareSeries = async (
  deps: BroadDeps,
  repo: BroadRepo,
  onProgress?: (progress: BroadScanProgress) => void,
  options: ShareSyncOptions = {},
): Promise<ShareSyncResult> => {
  const start = options.startDate ?? SHARE_HISTORY_START;
  const end = options.endDate ?? todayString();
  const refreshRecentDays = options.refreshRecentDays ?? 5;
  const concurrency = options.concurrency ?? DEFAULT_SSE_CONCURRENCY;
  const warnings: string[] = [];
  let requestCount = 0;

  // 1) 已有日期 → 缺失 / 重刷
  const existing = new Set(await repo.existingShareDates());
  const allDates = dateRange(start, end);
  const recentCutoff = addDays(end, -refreshRecentDays);
  const missingDates = allDates.filter(
    (date) => !existing.has(date) || date >= recentCutoff,
  );

  // 分批回填时只取最近的 N 天（下次继续往前补）
  const targetDates =
    options.maxDays === undefined
      ? missingDates
      : missingDates.slice(Math.max(0, missingDates.length - options.maxDays));

  // 2) 收盘价（腾讯，并发）—— 顺带得到交易日历
  //
  // ⚠️ 价格必须**先于**上交所份额请求取：腾讯日 K 的日期集合就是权威的
  // 「哪些天是交易日」，用它裁剪上交所请求日期，跳过非交易日（省掉大量
  // 必然返回空结果的请求）。
  const prices = await fetchPriceMap(deps, start, end);
  requestCount += TRACKED_ETFS.length;

  // 交易日历 = 腾讯日 K 日期的并集
  // （腾讯只在真实交易日给数据，正好当「哪些天是交易日」的权威来源）
  const tradingDays = new Set<string>();
  for (const map of prices.values()) {
    for (const date of map.keys()) tradingDays.add(date);
  }
  // 日历拿不到（价格源整体不可达）时退回「全日期请求」，不静默丢数据
  const sseTargetDates = tradingDays.size > 0
    ? targetDates.filter((date) => tradingDays.has(date))
    : targetDates;
  const skippedNonTrading = targetDates.length - sseTargetDates.length;

  // 进度总量：价格只数 + 沪市日期数 + 深市只数（与实际取数顺序一致）
  const szseEtfs = options.skipSzse
    ? []
    : TRACKED_ETFS.filter((etf) => etf.market === '0');
  const total = TRACKED_ETFS.length + sseTargetDates.length + szseEtfs.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    onProgress?.({ done, total });
  };

  // 价格这一段先推进进度条（取数已完成，只是记账）
  for (let index = 0; index < TRACKED_ETFS.length; index += 1) tick();
  // 3) 沪市：并发逐日全市场快照
  const trackedShCodes = new Set(
    TRACKED_ETFS.filter((etf) => etf.market === '1').map((etf) => etf.code),
  );
  const sseResults = await runConcurrent(
    sseTargetDates.map((date) => async () => {
      try {
        const rows = await fetchSseShareSnapshot(deps, date);
        return rows;
      } catch {
        return null;
      }
    }),
    concurrency,
  );
  requestCount += sseTargetDates.length;

  const sseRows: SseShareRow[] = [];
  let sseFailed = 0;
  sseTargetDates.forEach((_date, index) => {
    const rows = sseResults[index];
    if (!rows) {
      sseFailed += 1;
      return;
    }
    for (const row of rows) {
      if (trackedShCodes.has(row.code)) sseRows.push(row);
    }
    tick();
  });
  if (sseFailed > 0) {
    warnings.push(`上交所 ${sseFailed} / ${sseTargetDates.length} 个日期取数失败（已入库部分不受影响，可重试补缺）`);
  }
  if (sseTargetDates.length > 0 && sseRows.length === 0) {
    warnings.push('上交所份额全程不可达，沪市份额为空（可稍后重试，已入库部分不受影响）');
  }

  // 5) 深市：逐只拉整段区间历史
  const szseRows: SzseShareRow[] = [];
  for (const etf of szseEtfs) {
    try {
      const rows = await fetchSzseShareHistory(deps, etf.code, start, end);
      requestCount += 1;
      szseRows.push(...rows);
      tick();
    } catch (error) {
      requestCount += 1;
      tick();
      warnings.push(
        `${etf.name}（${etf.code}）深交所份额取数失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await deps.format.delay(EXCHANGE_DELAY_MS);
  }

  // 6) 算变动 + 落库
  //
  // ⚠️ **必须把「库里的份额」与「本次回源的份额」合并后再算变动**：
  // 份额变动 = 当日份额 − **上一有数据交易日**的份额。若只用本次回源的那批算，
  // 批内第一天永远没有「上一交易日」→ 变动算不出 → 该行被丢弃。
  // 后果：分批回填时**每批都丢一天变动**，增量入库变成「每次都缺一天」。
  // 合并后，批与批之间的衔接日能拿到上一批末尾的份额，变动连续。
  const allRows: (SseShareRow | SzseShareRow)[] = [...sseRows, ...szseRows];
  const storedByCode = repo.snapshot().sharesByCode;
  const storedLookup = new Map<string, Map<string, EtfShareRow>>();
  for (const [code, rows] of storedByCode) {
    const map = new Map<string, EtfShareRow>();
    for (const row of rows) map.set(row.date, row);
    storedLookup.set(code, map);
  }

  // 合并后的份额水平表：code → 日期 → 份额（亿份）
  const mergedShares = new Map<string, Map<string, number>>();
  for (const [code, map] of storedLookup) {
    const levels = new Map<string, number>();
    for (const [date, row] of map) levels.set(date, row.sharesYi);
    mergedShares.set(code, levels);
  }
  // 本次回源的份额覆盖同日（同日以新值为准 —— 上游改数时以新值为准）
  for (const row of allRows) {
    const levels = mergedShares.get(row.code) ?? new Map<string, number>();
    levels.set(row.date, row.sharesYi);
    mergedShares.set(row.code, levels);
  }

  // 合并后的序列算变动（按 code 分开取价：不同 ETF 价格量级差异大，混用会算飞）
  const mergedRows: (SseShareRow | SzseShareRow)[] = [];
  for (const [code, levels] of mergedShares) {
    const dates = [...levels.keys()].sort();
    for (const date of dates) {
      mergedRows.push({ code, date, sharesYi: levels.get(date) ?? 0, name: '' });
    }
  }
  const changes = computeShareChanges(mergedRows, prices);
  const sourceByCode = new Map<string, 'sse' | 'szse'>();
  for (const etf of TRACKED_ETFS) {
    sourceByCode.set(etf.code, etf.market === '1' ? 'sse' : 'szse');
  }

  // 本次回源覆盖的日期（只写这些行，不重写库里已有的旧行）
  const fetchedDates = new Set<string>();
  for (const row of allRows) fetchedDates.add(row.date);

  const saveRows: EtfShareRow[] = [];
  for (const [code, levels] of mergedShares) {
    const source = sourceByCode.get(code) ?? 'sse';
    const codePrices = prices.get(code) ?? new Map<string, number>();
    const dates = [...levels.keys()].sort();
    for (const date of dates) {
      if (!fetchedDates.has(date)) continue; // 本次没回源的日期不动它
      const sharesYi = levels.get(date) ?? 0;
      const price = codePrices.get(date) ?? null;
      const change = changes.get(date)?.get(code);
      if (change) {
        saveRows.push({
          date,
          code,
          sharesYi,
          deltaYi: change.deltaYi,
          price,
          amountYi: change.amountYi,
          source,
        });
        continue;
      }
      // 整条序列的**第一行**：没有上一交易日 → 变动天然未知。
      // 记 0（不是假装有变动）并把 amount 留 null，同时把份额水平存下来 ——
      // 这样下一次增量同步时它能当「上一交易日」的衔接点，链条不断。
      saveRows.push({
        date,
        code,
        sharesYi,
        deltaYi: 0,
        price,
        amountYi: null,
        source,
      });
    }
  }

  // 分批落库（每批落一次，支持断点续传）
  const batchSize = 400;
  for (let index = 0; index < saveRows.length; index += batchSize) {
    await repo.saveShareRows(saveRows.slice(index, index + batchSize));
  }

  // 覆盖区间（库里已有的 + 本次新增）
  const covered = new Set<string>(existing);
  for (const row of saveRows) covered.add(row.date);
  const coveredDates = [...covered].sort();
  const earliestDate = coveredDates[0] ?? '';
  const latestDate = coveredDates[coveredDates.length - 1] ?? '';

  await repo.saveMeta({
    shareSyncedAt: Date.now(),
    shareEarliestDate: earliestDate,
    shareLatestDate: latestDate,
    warnings,
  });

  return {
    warnings,
    rowCount: saveRows.length,
    requestCount,
    earliestDate,
    latestDate,
    skippedNonTradingDays: skippedNonTrading,
  };
};
