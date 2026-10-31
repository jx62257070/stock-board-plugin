/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 采集编排（混合源）
 *
 * 一次采集（用户点击触发，不轮询）：
 * 1. 当日快照：**同花顺清单**（行业 thshy + 概念 gn，各含当日快照字段）——
 *    失败降级链：refs 缓存 → 宿主 fetchIndustryBoards（行业，缺当日快照）→ 抛错；
 * 2. 全市场分母：宿主 fetchMarketTurnover（腾讯，主选）→ 东财指数日K（次选）→ 本地缓存；
 * 3. 增量历史：关注板块逐板块「**同花顺年K**（价量额，必须成功）+ **东财 fflow**（小单拆分，尽力）」，
 *    与本地按日期合并（并发 ≤3 + 每请求 500ms 错峰；单板块失败不阻塞，隔 2s 补采一轮）；
 * 4. 涨停池：东财 push2ex（基准日 1 请求，首次安装回补近 30 个交易日）+ 炸板 / 跌停池总数；
 * 5. 重算指数：全部板块全量重算（纯函数）→ 落库 → 看板响应式刷新。
 *
 * 混源降级语义（2026-10-30 混合源改造，王总确认）：
 * - 同花顺（主源）不可用 → 整轮采集 block（清单是板块全集的来源，无可绕过）；
 * - 东财 fflow 不可用 → **不 block**：散户因子当日缺席（权重自动重分配），
 *   价量与热度照常累积，恢复后采集自动补历史；fflow 失败不进失败清单（不重试）；
 * - 东财分母不可用 → 腾讯主选已兜住；两级都失败才用本地缓存序列。
 *
 * 落定口径：本地时间 < 15:30 且分母序列末位是当日时，当日视为未落定 ——
 * 分母裁掉当日、板块合并只留 ≤ 基准日的行、快照字段不写（半日 bar 落库会永久污染分位序列）。
 */
import {
  DEFAULT_WATCH_CONCEPT_TOP,
  DEFAULT_WATCH_INDUSTRY_TOP,
  fflowMissNotice,
  LIMIT_UP_BACKFILL_DAYS,
  MAX_HISTORY_DAYS,
  SCAN_CONCURRENCY,
  SCAN_DELAY_MS,
  SCAN_RETRY_DELAY_MS,
  SCAN_STEPS,
  SETTLE_MINUTES,
  TAIL_KEEP_DAYS,
} from './constants';
import {
  fetchBoardFflow,
  fetchEmBoardUniverse,
  fetchMarketSeries,
  fetchPoolTotal,
  matchThsToEm,
} from './em-data';
import { buildMarketMap, computeIndexSeries } from './judge';
import type { SentimentRepo } from './storage';
import { fetchThsBoardList, fetchThsBoardKline } from './ths-data';
import type {
  BoardDay,
  BoardHistory,
  BoardRef,
  IndexPoint,
  MarketPoint,
  ScanFailure,
  ScanMeta,
  ScanProgress,
  ScanResult,
  SentimentDeps,
} from './types';

/** 采集入参（单板块重试 / 进度回调） */
export interface RunScanOptions {
  /** 只采集这些板块（失败清单重试用；缺省 = 全部关注板块） */
  onlyCodes?: readonly string[];
  /** 进度回调 */
  onProgress?: (progress: ScanProgress) => void;
}

/** 清单快照行（THS 与宿主兜底共用的统一形态） */
interface SnapshotRow {
  code: string;
  name: string;
  pctChg: number | null;
  amount: number | null;
  turnover: number | null;
  mainNet: number | null;
  upCount: number | null;
  downCount: number | null;
}

/**
 * 本地时间当日 0 点起的分钟数（落定判定用）
 * @param now 当前时间
 * @returns 分钟数
 */
const minutesOfDay = (now: Date): number => now.getHours() * 60 + now.getMinutes();

/**
 * 本地日期 YYYY-MM-DD
 * @param now 当前时间
 * @returns 日期串
 */
const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * 「东财行业名 → 板块」匹配器（涨停池 hybk 与板块同为东财口径，等值 + 前缀兜底）
 * @param boards 板块清单（只用行业板块）
 * @returns 匹配函数（未命中 null）
 */
const createIndustryMatcher = (
  boards: readonly BoardRef[],
): ((industry: string) => BoardRef | null) => {
  const byName = new Map(boards.map((board) => [board.name, board]));
  return (industry: string): BoardRef | null => {
    if (!industry) return null;
    const exact = byName.get(industry);
    if (exact) return exact;
    // 前缀兜底：上游截断长名（光学光电 → 光学光电子）
    let hit: BoardRef | null = null;
    let hits = 0;
    for (const board of boards) {
      if (board.name.startsWith(industry) || industry.startsWith(board.name)) {
        hit = board;
        hits += 1;
      }
    }
    return hits === 1 ? hit : null;
  };
};

/**
 * 解析落定基准日
 * @param market 沪深成交额序列（升序，含未落定日）
 * @param now 当前时间
 * @returns 基准日、被排除的未落定日、裁掉未落定日后的序列
 */
const resolveSettle = (
  market: readonly MarketPoint[],
  now: Date,
): { asOf: string; excludedDate: string; market: MarketPoint[] } => {
  const last = market[market.length - 1];
  if (!last) return { asOf: '', excludedDate: '', market: [] };
  const excludedDate =
    last.date === localDate(now) && minutesOfDay(now) < SETTLE_MINUTES ? last.date : '';
  const settled = excludedDate ? market.slice(0, -1) : [...market];
  return { asOf: settled[settled.length - 1]?.date ?? '', excludedDate, market: settled };
};

/**
 * 用日 K / fflow / 快照字段 / 涨停数合并出板块序列（同日覆盖、快照字段保留）
 *
 * 合并语义（冒烟 `scripts/check-sentiment-index.mjs` 有断言）：
 * 日 K 覆盖价量额并按相邻收盘价补涨跌幅（快照没给时）；fflow 不开新行
 * （两接口日历出入时以日 K 为准）；快照字段只在快照日 ≤ 基准日时合并；
 * 结果裁掉基准日之后的行并截到历史上限。
 * @param existing 本地已有序列
 * @param ref 板块清单项
 * @param klines 日 K 行（可空：本轮取数失败）
 * @param fflows 资金拆分行（可空）
 * @param snapshot 当日快照行（可空）
 * @param snapshotDate 快照所属交易日（空串 = 不合并快照）
 * @param limitUpByDate 交易日 → 板块内涨停家数（可空）
 * @param settleDate 基准日（裁掉晚于它的行）
 * @returns 合并后的板块序列
 */
export const mergeBoardDays = (
  existing: BoardHistory | undefined,
  ref: BoardRef,
  klines:
    | readonly {
        date: string;
        open: number | null;
        high: number | null;
        low: number | null;
        close: number | null;
        volume: number | null;
        amount: number | null;
      }[]
    | null,
  fflows: readonly { date: string; mainNet: number | null; mainRatio: number | null; smallNet: number | null; smallRatio: number | null }[] | null,
  snapshot: SnapshotRow | null,
  snapshotDate: string,
  limitUpByDate: ReadonlyMap<string, number>,
  settleDate: string,
): BoardHistory => {
  const byDate = new Map<string, BoardDay>();
  for (const day of existing?.days ?? []) byDate.set(day.date, { ...day });

  // 1) 日 K：价量额覆盖；涨跌幅按相邻收盘价补（快照没给时），首日无前收记 0
  let previousClose: number | null = null;
  for (const row of klines ?? []) {
    const day = byDate.get(row.date) ?? {
      date: row.date,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null,
      amount: null,
      pctChg: null,
      mainNet: null,
      mainRatio: null,
      smallNet: null,
      smallRatio: null,
      upCount: null,
      downCount: null,
      turnover: null,
      limitUpCount: null,
    };
    day.open = row.open ?? day.open;
    day.high = row.high ?? day.high;
    day.low = row.low ?? day.low;
    day.close = row.close ?? day.close;
    day.volume = row.volume ?? day.volume;
    day.amount = row.amount ?? day.amount;
    if (day.pctChg === null && row.close !== null && previousClose !== null && previousClose > 0) {
      day.pctChg = ((row.close - previousClose) / previousClose) * 100;
    }
    previousClose = row.close ?? day.close ?? previousClose;
    byDate.set(row.date, day);
  }

  // 2) fflow：资金拆分覆盖（不覆盖已有的快照日涨跌幅）
  for (const row of fflows ?? []) {
    const day = byDate.get(row.date);
    if (!day) continue; // fflow 不开新行：上游两接口日历偶有出入时以日 K 为准
    day.mainNet = row.mainNet;
    day.mainRatio = row.mainRatio;
    day.smallNet = row.smallNet;
    day.smallRatio = row.smallRatio;
  }

  // 3) 当日快照字段：只在快照日 = 基准日（未落定日被排除）时合并
  if (snapshot && snapshotDate && snapshotDate <= settleDate) {
    const day = byDate.get(snapshotDate);
    if (day) {
      day.pctChg = snapshot.pctChg ?? day.pctChg;
      day.amount = snapshot.amount ?? day.amount;
      day.upCount = snapshot.upCount;
      day.downCount = snapshot.downCount;
      day.turnover = snapshot.turnover;
    }
  }

  // 4) 涨停数（涨停池按行业聚合，概念板块不在映射里恒缺席）
  for (const [date, count] of limitUpByDate) {
    const day = byDate.get(date);
    if (day) day.limitUpCount = count;
  }

  const days = [...byDate.values()]
    .filter((day) => day.date <= settleDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-MAX_HISTORY_DAYS);
  return { code: ref.code, name: ref.name, kind: ref.kind, days };
};

/**
 * 非关注行业板块的快照行序列（只有快照字段，只保留尾部 TAIL_KEEP_DAYS 天）
 * @param existing 本地已有序列
 * @param ref 板块清单项
 * @param snapshot 当日快照行
 * @param snapshotDate 快照所属交易日（空串 = 本轮不追加）
 * @param settleDate 基准日
 * @returns 板块序列
 */
export const tailBoardDays = (
  existing: BoardHistory | undefined,
  ref: BoardRef,
  snapshot: SnapshotRow | null,
  snapshotDate: string,
  settleDate: string,
): BoardHistory => {
  const byDate = new Map<string, BoardDay>();
  for (const day of existing?.days ?? []) byDate.set(day.date, { ...day });
  if (snapshot && snapshotDate && snapshotDate <= settleDate) {
    byDate.set(snapshotDate, {
      date: snapshotDate,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null,
      amount: snapshot.amount,
      pctChg: snapshot.pctChg,
      mainNet: snapshot.mainNet,
      mainRatio: null,
      smallNet: null,
      smallRatio: null,
      upCount: snapshot.upCount,
      downCount: snapshot.downCount,
      turnover: snapshot.turnover,
      limitUpCount: null,
    });
  }
  const days = [...byDate.values()]
    .filter((day) => day.date <= settleDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-TAIL_KEEP_DAYS);
  return { code: ref.code, name: ref.name, kind: ref.kind, days };
};

/**
 * 解析关注清单：已有清单 → 首扫按快照默认（行业成交额前 N + 概念主力净额前 N）
 * @param current 当前关注清单
 * @param industryRows 行业快照行
 * @param conceptRows 概念快照行
 * @returns 关注清单
 */
const resolveWatchlist = (
  current: readonly string[],
  industryRows: readonly SnapshotRow[],
  conceptRows: readonly SnapshotRow[],
): string[] => {
  if (current.length > 0) return [...current];
  const topIndustry = [...industryRows]
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, DEFAULT_WATCH_INDUSTRY_TOP)
    .map((row) => row.code);
  const topConcept = [...conceptRows]
    .sort((a, b) => (b.mainNet ?? 0) - (a.mainNet ?? 0))
    .slice(0, DEFAULT_WATCH_CONCEPT_TOP)
    .map((row) => row.code);
  return [...topIndustry, ...topConcept];
};

/** 单板块增量取数结果（THS 必须成功；fflow 尽力） */
interface WatchFetch {
  /** THS 年 K 行（失败为 null） */
  klines: Awaited<ReturnType<typeof fetchThsBoardKline>> | null;
  /** fflow 资金拆分行（失败 / 东财封禁为 null） */
  fflows: Awaited<ReturnType<typeof fetchBoardFflow>> | null;
}

/**
 * 并发拉取关注板块的增量历史（THS 年K 必须 + EM fflow 尽力；失败补采一轮）
 *
 * fflow 的前提是 THS→BK 名称映射（`emMap`）：映射缺失的板块散户因子缺席（不猜映射）。
 * @param deps 宿主能力集合
 * @param targets 待采集板块
 * @param emMap THS 代码 → 东财 BK 代码映射
 * @param onProgress 进度回调（首轮计数）
 * @returns 板块代码 → 取数结果、THS 失败清单、fflow 缺席数
 */
const fetchWatchHistories = async (
  deps: SentimentDeps,
  targets: readonly BoardRef[],
  emMap: Readonly<Record<string, string>>,
  onProgress?: (progress: ScanProgress) => void,
): Promise<{
  data: Map<string, WatchFetch>;
  failures: Map<string, string>;
  fflowMissCount: number;
}> => {
  const data = new Map<string, WatchFetch>();
  const failures = new Map<string, string>();
  let fflowMissCount = 0;
  let done = 0;

  const runPass = async (passTargets: readonly BoardRef[], delayMs: number): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < passTargets.length) {
        const target = passTargets[cursor];
        cursor += 1;
        onProgress?.({ step: SCAN_STEPS.HISTORY, done, total: targets.length, current: target.name });
        try {
          // 两个请求分属不同上游（d.10jqka / push2his），各自受并发与错峰约束；
          // fflow 失败 / 无映射只记缺席数（散户因子缺席降级），不影响板块成功与否
          const klines = await fetchThsBoardKline(deps, target.code, new Date().getFullYear());
          const bkCode = emMap[target.code] ?? null;
          const fflows = bkCode
            ? await fetchBoardFflow(deps, bkCode).catch(() => null)
            : null;
          if (fflows === null) fflowMissCount += 1;
          data.set(target.code, { klines, fflows });
          failures.delete(target.code);
        } catch (error) {
          failures.set(target.code, error instanceof Error ? error.message : String(error));
        }
        done += 1;
        onProgress?.({ step: SCAN_STEPS.HISTORY, done, total: targets.length, current: target.name });
        await deps.format.delay(delayMs);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, passTargets.length) }, () => worker()),
    );
  };

  await runPass(targets, SCAN_DELAY_MS);
  if (failures.size > 0 && failures.size < targets.length) {
    await deps.format.delay(SCAN_RETRY_DELAY_MS);
    await runPass(
      targets.filter((target) => failures.has(target.code)),
      SCAN_RETRY_DELAY_MS,
    );
  }
  return { data, failures, fflowMissCount };
};

/**
 * 执行一次采集并落库（混合源）
 * @param repo 散户情绪指数仓储
 * @param deps 宿主能力集合
 * @param options 入参（单板块重试 / 进度回调）
 * @returns 采集结果
 */
export const runScan = async (
  repo: SentimentRepo,
  deps: SentimentDeps,
  options: RunScanOptions = {},
): Promise<ScanResult> => {
  const { onProgress } = options;
  const retryOnly = options.onlyCodes ?? null;
  const before = repo.snapshot();
  const isFirstScan = before.meta === null;

  // ---- 1) 当日快照：同花顺清单（主源）→ refs 缓存 → 宿主行业清单兜底 ----
  onProgress?.({ step: SCAN_STEPS.SNAPSHOT, done: 0, total: 1 });
  let industryRows: SnapshotRow[] = [];
  let conceptRows: SnapshotRow[] = [];
  let listError = '';
  try {
    const [industry, concept] = await Promise.all([
      fetchThsBoardList(deps, 'industry'),
      fetchThsBoardList(deps, 'concept').catch(() => null),
    ]);
    industryRows = industry.rows;
    if (concept !== null) conceptRows = concept.rows;
  } catch (error) {
    listError = error instanceof Error ? error.message : String(error);
  }
  if (industryRows.length === 0 && before.refs.length > 0) {
    // 主源失败：从缓存清单恢复板块全集（只少今日快照，历史不受影响）
    industryRows = before.refs
      .filter((ref) => ref.kind === 'industry')
      .map((ref) => ({ code: ref.code, name: ref.name, pctChg: null, amount: null, turnover: null, mainNet: null, upCount: null, downCount: null }));
    conceptRows = before.refs
      .filter((ref) => ref.kind === 'concept')
      .map((ref) => ({ code: ref.code, name: ref.name, pctChg: null, amount: null, turnover: null, mainNet: null, upCount: null, downCount: null }));
  }
  if (industryRows.length === 0) {
    // refs 缓存也没有：主源不可用且无历史清单，本轮确实做不了（不引入东财 BK 码双体系）
    throw new Error(listError || '同花顺行业清单不可用（接口返回空数据）');
  }
  const refsAll: BoardRef[] = [
    ...industryRows.map((row) => ({ code: row.code, name: row.name, kind: 'industry' as const })),
    ...conceptRows.map((row) => ({ code: row.code, name: row.name, kind: 'concept' as const })),
  ];
  await repo.saveRefs(refsAll);

  // ---- 2) 全市场分母（腾讯主选 → 东财次选 → 本地缓存） ----
  onProgress?.({ step: SCAN_STEPS.MARKET, done: 0, total: 1 });
  let market: MarketPoint[] = await fetchMarketSeries(deps);
  if (market.length === 0 && before.market.length > 0) market = before.market;
  if (market.length === 0) throw new Error('沪深成交额序列不可用（腾讯与东财两级分母均失败）');
  const settle = resolveSettle(market, new Date());
  if (!settle.asOf) throw new Error('分母序列为空，无法确定基准交易日');
  const marketSettled = settle.market;
  const marketMap = buildMarketMap(marketSettled);
  const marketDates = marketSettled.map((point) => point.date);

  // ---- 3) 关注清单、THS→BK 映射与增量历史 ----
  const watchlist = resolveWatchlist(before.watchlist, industryRows, conceptRows);
  const snapshotByCode = new Map<string, SnapshotRow>();
  for (const row of [...industryRows, ...conceptRows]) snapshotByCode.set(row.code, row);
  const targetCodes = (retryOnly ?? watchlist).filter((code) => snapshotByCode.has(code));
  const targetRefs: BoardRef[] = targetCodes
    .map((code) => refsAll.find((item) => item.code === code))
    .filter((ref): ref is BoardRef => ref !== undefined);

  // THS→BK 名称映射（fflow 的前提）：东财 clist 尽力拉取 → 与缓存映射合并 → 落 scan_meta；
  // clist 被封禁时整表用缓存（首次安装撞封禁窗口 = 映射为空，散户因子缺席等恢复自动建）
  const emUniverse = await fetchEmBoardUniverse(deps);
  const emMapFresh = emUniverse.length > 0 ? matchThsToEm(refsAll, emUniverse) : {};
  const emMap: Record<string, string> = { ...before.emMap, ...emMapFresh };
  await repo.saveEmMap(emMap);

  const fetched = await fetchWatchHistories(deps, targetRefs, emMap, onProgress);

  // fflow 缺席提示（东财封禁中不 block，只提示散户因子缺席；经 ScanResult 透出给页面）
  const missNotice =
    fetched.fflowMissCount > 0 && fetched.failures.size < targetRefs.length
      ? fflowMissNotice(fetched.fflowMissCount, targetRefs.length)
      : '';

  // ---- 4) 涨停池（首扫回补近 30 个交易日） + 炸板 / 跌停池 ----
  onProgress?.({ step: SCAN_STEPS.LIMIT_UP, done: 0, total: 1 });
  const industryRefs = refsAll.filter((ref) => ref.kind === 'industry');
  const matchIndustry = createIndustryMatcher(industryRefs);
  const limitUpByBoardDate = new Map<string, Map<string, number>>(); // boardCode → date → count
  let limitUpTotal: number | null;
  let streak2Count: number | null = null;
  let limitUpBackfillDate = before.meta?.limitUpBackfillDate ?? '';

  /**
   * 聚合一天的涨停池到板块
   * @param date 交易日
   * @returns void
   */
  const aggregatePoolDay = async (date: string): Promise<void> => {
    const pool = await deps.market.fetchLimitUpPool(date);
    if (pool.length === 0) return;
    for (const member of pool) {
      const board = matchIndustry(member.industry ?? '');
      if (!board) continue;
      const byDate = limitUpByBoardDate.get(board.code) ?? new Map<string, number>();
      byDate.set(date, (byDate.get(date) ?? 0) + 1);
      limitUpByBoardDate.set(board.code, byDate);
    }
  };

  try {
    if (isFirstScan || !limitUpBackfillDate) {
      const backfillDates = marketDates.slice(-LIMIT_UP_BACKFILL_DAYS);
      for (let index = 0; index < backfillDates.length; index += 1) {
        const date = backfillDates[index];
        if (!date) continue;
        await aggregatePoolDay(date);
        onProgress?.({ step: SCAN_STEPS.LIMIT_UP, done: index + 1, total: backfillDates.length, current: date });
        if (index < backfillDates.length - 1) await deps.format.delay(SCAN_DELAY_MS);
      }
      limitUpBackfillDate = backfillDates[backfillDates.length - 1] ?? '';
    } else {
      await aggregatePoolDay(settle.asOf);
    }
  } catch (error) {
    console.warn('[plugin] dsh-sentiment-index 涨停池取数失败（板块内涨停数缺席）', error);
  }

  // 基准日全市场涨停 / 连板 ≥2（池子成员级统计，情绪条用）
  try {
    const pool = await deps.market.fetchLimitUpPool(settle.asOf);
    limitUpTotal = pool.length;
    streak2Count = pool.filter((member) => (member.continuousBoardCount ?? 1) >= 2).length;
  } catch {
    limitUpTotal = null;
  }
  const [zhaBanCount, limitDownCount] = await Promise.all([
    fetchPoolTotal(deps, 'zhaBan', settle.asOf),
    fetchPoolTotal(deps, 'limitDown', settle.asOf),
  ]);

  // ---- 5) 合并板块事实 + 全量重算指数 ----
  onProgress?.({ step: SCAN_STEPS.COMPUTE, done: 0, total: 1 });
  // 快照日：未落定日被排除时本轮不写快照字段（防半日值入库）
  const snapshotDate = settle.excludedDate ? '' : settle.asOf;
  const watchCodeSet = new Set(watchlist);
  const existingByCode = new Map(before.boards.map((board) => [board.code, board]));

  const mergedBoards: BoardHistory[] = [];
  for (const ref of refsAll) {
    const existing = existingByCode.get(ref.code);
    const snapshot = snapshotByCode.get(ref.code) ?? null;
    if (watchCodeSet.has(ref.code)) {
      const fetchedData = fetched.data.get(ref.code) ?? null;
      mergedBoards.push(
        mergeBoardDays(
          existing,
          ref,
          fetchedData?.klines ?? null,
          fetchedData?.fflows ?? null,
          snapshot,
          snapshotDate,
          limitUpByBoardDate.get(ref.code) ?? new Map<string, number>(),
          settle.asOf,
        ),
      );
    } else if (ref.kind === 'industry') {
      // 非关注行业板块只追加今日快照行（排行表「行业」chip 的今日截面）
      mergedBoards.push(tailBoardDays(existing, ref, snapshot, snapshotDate, settle.asOf));
    }
    // 非关注概念板块不落库（只在 refs 缓存里）
  }

  const indexByCode = new Map<string, IndexPoint[]>();
  for (const board of mergedBoards) {
    indexByCode.set(board.code, computeIndexSeries(board.days, marketMap));
  }

  const failures: ScanFailure[] = targetRefs
    .filter((ref) => fetched.failures.has(ref.code))
    .map((ref) => ({
      code: ref.code,
      name: ref.name,
      error: fetched.failures.get(ref.code) ?? '未知错误',
    }));

  const meta: ScanMeta = {
    scannedAt: Date.now(),
    asOf: settle.asOf,
    excludedDate: settle.excludedDate,
    watchCount: watchlist.length,
    firstScanAt: before.meta?.firstScanAt ?? Date.now(),
    limitUpBackfillDate,
    failures,
    turnoverSeen: before.meta?.turnoverSeen ?? false,
    limitUpTotal,
    streak2Count,
    zhaBanCount,
    limitDownCount,
  };

  const saved = await repo.saveScan({ boards: mergedBoards, market: marketSettled, meta, indexByCode });

  return {
    asOf: settle.asOf,
    excludedDate: settle.excludedDate,
    addedRows: saved.addedRows,
    failures,
    firstScan: isFirstScan,
    fflowMissNotice: missNotice,
  };
};
