/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 采集编排（混合源）
 *
 * 一次采集（用户点击触发，不轮询）：
 * 1. 当日快照：**同花顺清单**（行业 thshy + 概念 gn，各含当日快照字段）——
 *    失败降级链：refs 缓存 → 宿主 fetchIndustryBoards（行业，缺当日快照）→ 抛错；
 * 2. 全市场分母：宿主 fetchMarketTurnover（腾讯，主选）→ 东财指数日K（次选）→ 本地缓存；
 * 3. 增量历史：三段各守各的频率红线 —— **同花顺年K**（价量额，必须成功）并发 ≤3 +
 *    500ms 错峰、失败隔 2s 补采一轮；**东财 fflow**（小单拆分，尽力）走**串行慢车道**
 *    （前置探测 + 1.2s 间隔 + 连拒熔断，dsh-mainline 实测红线）；**东财 clist 四档
 *    资金快照**（自积累主通道）在车道后追加当日行 —— 与本地按日期合并；
 * 4. 涨停池：东财 push2ex（基准日 1 请求，首次安装回补近 30 个交易日）+ 炸板 / 跌停池总数；
 * 5. 重算指数：全部板块全量重算（纯函数）→ 落库 → 看板响应式刷新。
 *
 * 混源降级语义（2026-10-30 混合源改造，王总确认）：
 * - 同花顺（主源）不可用 → 整轮采集 block（清单是板块全集的来源，无可绕过）；
 * - 东财 fflow 不可用 → **不 block**：散户因子当日缺席（权重自动重分配），
 *   价量与热度照常累积，恢复后采集自动补历史；fflow 失败不进失败清单（不重试），
 *   封禁窗口内由前置探测 / 连拒熔断整段跳过 —— 对封禁中上游连发只会延长封禁；
 * - clist 四档快照（push2 域，走桥）与 fflow 历史接口**互相独立**：fflow 全灭期间
 *   散户因子仍靠快照逐日自积累（无 121 日回补，分位窗口自安装日起算）；
 * - 东财分母不可用 → 腾讯主选已兜住；两级都失败才用本地缓存序列。
 *
 * 落定口径：本地时间 < 15:30 且分母序列末位是当日时，当日视为未落定 ——
 * 分母裁掉当日、板块合并只留 ≤ 基准日的行、快照字段不写（半日 bar 落库会永久污染分位序列）。
 */
import {
  DEFAULT_WATCH_CONCEPT_TOP,
  DEFAULT_WATCH_INDUSTRY_TOP,
  EM_BLOCKED_NOTICE,
  EM_FFLOW_BLOCK_ABORT_RUNS,
  EM_FFLOW_BLOCK_COOLDOWN_MS,
  EM_FFLOW_SCAN_DELAY_MS,
  fflowMissNotice,
  LIMIT_UP_BACKFILL_DAYS,
  MAX_HISTORY_DAYS,
  SCAN_CONCURRENCY,
  SCAN_DELAY_MS,
  SCAN_RETRY_DELAY_MS,
  SCAN_STEPS,
  SENTIMENT_PLUGIN_ID,
  SETTLE_MINUTES,
  TAIL_KEEP_DAYS,
} from './constants';
import {
  fetchBoardFflow,
  fetchBoardFundSnapshot,
  fetchEmBoardUniverse,
  fetchMarketSeries,
  fetchPoolTotal,
  isConnectionError,
  matchThsToEm,
  probeEmFflow,
} from './em-data';
import { getEmBridgeDiagnostic, resetEmBridgeDiagnostic } from './em-bridge';
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

/** fflow 串行慢车道的结果（缺席计数 + 封禁判定，横幅文案分级用） */
interface FflowLaneResult {
  /** 散户因子缺席的板块数（无映射 / 取数失败 / 熔断跳过都算） */
  missCount: number;
  /** 东财是否判定处于封禁窗口（探测 blocked 或车道内连拒熔断） */
  blocked: boolean;
  /** 首个缺席原因（横幅透出，定位桥 / 映射 / 上游哪一环出的问题；空串 = 全量到齐） */
  missReason: string;
}

/**
 * THS 年 K 段（必须成功；并发 ≤3 + 500ms 错峰，失败隔 2s 补采一轮）
 *
 * fflow 已拆到独立的串行慢车道（`runFflowLane`）：两个上游各有各的频率红线，
 * 混在同一个 worker 循环里会让东财跟着同花顺的节奏连发 —— 2026-10-31 前整轮
 * 0/20 全拒的主因。THS 成功的板块在此占位（fflows 先置 null，等车道回填）。
 * @param deps 宿主能力集合
 * @param targets 待采集板块
 * @param data 取数结果落点
 * @param failures THS 失败清单（落点）
 * @param onProgress 进度回调
 * @returns void
 */
const runThsPass = async (
  deps: SentimentDeps,
  targets: readonly BoardRef[],
  data: Map<string, WatchFetch>,
  failures: Map<string, string>,
  onProgress?: (progress: ScanProgress) => void,
): Promise<void> => {
  let done = 0;

  const runPass = async (passTargets: readonly BoardRef[], delayMs: number): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < passTargets.length) {
        const target = passTargets[cursor];
        cursor += 1;
        onProgress?.({ step: SCAN_STEPS.HISTORY, done, total: targets.length, current: target.name });
        try {
          const klines = await fetchThsBoardKline(deps, target.code, new Date().getFullYear());
          data.set(target.code, { klines, fflows: null });
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
};

/**
 * 东财 fflow 串行慢车道（散户因子唯一来源，全网不可替代）
 *
 * 2026-10-31 改造，对齐 dsh-mainline 实测红线「间隔 ≥1s 正常、短时连发立刻拒连
 * （TCP RST）、停顿约 20s 恢复」：
 * 1. 前置 `probeEmFflow`（单板块 lmt=1 轻量探测）：封禁中 → 整段跳过，0 次无效请求；
 * 2. 逐板块**串行**拉取，相邻请求隔 `EM_FFLOW_SCAN_DELAY_MS`；
 * 3. 连接被拒不重试（对封禁中上游连发只会延长封禁）：首拒停
 *    `EM_FFLOW_BLOCK_COOLDOWN_MS` 等窗口自愈再继续；连续 `EM_FFLOW_BLOCK_ABORT_RUNS`
 *    次被拒即熔断跳出，剩余板块记缺席、不再发请求；
 * 4. 缺席板块不进失败清单（fflow 是尽力源）；恢复后下次采集按 lmt=0 全量自动补历史。
 *
 * THS 失败的板块不进车道：fflow 不开新行（mergeBoardDays 以日 K 日历为准），没有
 * 日 K 就没处挂资金拆分。
 * @param deps 宿主能力集合
 * @param targets 待采集板块（THS 段已跑完）
 * @param emMap THS 代码 → 东财 BK 代码映射
 * @param data 取数结果落点（只回填 THS 成功板块的 fflows）
 * @param onProgress 进度回调（车道内 current 标注「资金拆分」；进度条已满、只换文案属预期）
 * @returns 缺席数与封禁判定
 */
const runFflowLane = async (
  deps: SentimentDeps,
  targets: readonly BoardRef[],
  emMap: Readonly<Record<string, string>>,
  data: Map<string, WatchFetch>,
  onProgress?: (progress: ScanProgress) => void,
): Promise<FflowLaneResult> => {
  let missCount = 0;

  // 无映射的板块直接记缺席（映射是 fflow 的前提，不猜映射 —— 同 runScan 的口径）
  const laneBoards: { target: BoardRef; bkCode: string }[] = [];
  for (const target of targets) {
    if (!data.has(target.code)) continue;
    const bkCode = emMap[target.code] ?? '';
    if (!bkCode) {
      missCount += 1;
      continue;
    }
    laneBoards.push({ target, bkCode });
  }
  if (laneBoards.length === 0) {
    return {
      missCount,
      blocked: false,
      missReason:
        missCount > 0 ? 'THS→BK 名称映射未命中（映射清单未取到且缓存为空，映射层见 em-data）' : '',
    };
  }

  // 前置探测：封禁中整段跳过（2026-10-31 前这里会接着连发 20 发并全数被拒）
  const probe = await probeEmFflow(deps);
  if (probe.kind === 'blocked') {
    return {
      missCount: missCount + laneBoards.length,
      blocked: true,
      missReason: `探测连接被拒（${probe.message || '连接层错误'}）`,
    };
  }

  let consecutiveBlocked = 0;
  let aborted = false;
  let firstMissReason = '';
  for (let index = 0; index < laneBoards.length; index += 1) {
    const { target, bkCode } = laneBoards[index];
    onProgress?.({
      step: SCAN_STEPS.HISTORY,
      done: targets.length,
      total: targets.length,
      current: `资金拆分 · ${target.name}`,
    });
    try {
      const fflows = await fetchBoardFflow(deps, bkCode);
      const entry = data.get(target.code);
      if (entry) entry.fflows = fflows;
      consecutiveBlocked = 0;
    } catch (error) {
      missCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!firstMissReason) firstMissReason = message;
      if (isConnectionError(message)) {
        consecutiveBlocked += 1;
        if (consecutiveBlocked >= EM_FFLOW_BLOCK_ABORT_RUNS) {
          // 熔断：封禁窗口仍开着，剩余板块不再连发（等恢复后采集自动补历史）
          missCount += laneBoards.length - 1 - index;
          aborted = true;
          break;
        }
        // 首拒：停一拍等封禁窗口自愈（实测约 20s），后续板块还能救回来
        await deps.format.delay(EM_FFLOW_BLOCK_COOLDOWN_MS);
      }
      // HTTP / 解析类失败：正常缺席，按常规节奏继续（fetchText 内已有小步重试）
    }
    if (index < laneBoards.length - 1) await deps.format.delay(EM_FFLOW_SCAN_DELAY_MS);
  }
  // 可诊断性：缺席必有一个「为什么」——桥失败（回退日志在 em-bridge） / 数据空 / HTTP 错误，
  // 这里汇总首个原因，devtools console 过滤插件 id 即可定位
  if (firstMissReason) {
    console.warn(
      `[plugin] ${SENTIMENT_PLUGIN_ID} fflow 串行车道缺席 ${missCount}/${laneBoards.length}，`
      + `首个失败原因：${firstMissReason}`,
    );
  }
  return { missCount, blocked: aborted, missReason: firstMissReason };
};

/**
 * 拉取关注板块的增量历史（THS 年K 必须 + EM fflow 尽力 + clist 四档快照自积累；
 * 三段各守各的频率红线与降级语义）
 *
 * fflow 的前提是 THS→BK 名称映射（`emMap`）：映射缺失的板块散户因子缺席（不猜映射）。
 * @param deps 宿主能力集合
 * @param targets 待采集板块
 * @param emMap THS 代码 → 东财 BK 代码映射
 * @param fundDate 四档资金快照的落库交易日（空串 = 盘中未落定，整步跳过）
 * @param onProgress 进度回调（首轮计数）
 * @returns 板块代码 → 取数结果、THS 失败清单、fflow 缺席数、fflow 封禁判定
 */
const fetchWatchHistories = async (
  deps: SentimentDeps,
  targets: readonly BoardRef[],
  emMap: Readonly<Record<string, string>>,
  fundDate: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<{
  data: Map<string, WatchFetch>;
  failures: Map<string, string>;
  fflowMissCount: number;
  fflowBlocked: boolean;
  fflowMissReason: string;
}> => {
  const data = new Map<string, WatchFetch>();
  const failures = new Map<string, string>();
  resetEmBridgeDiagnostic();
  await runThsPass(deps, targets, data, failures, onProgress);
  const lane = await runFflowLane(deps, targets, emMap, data, onProgress);

  // 东财 clist 四档资金快照（自积累主通道，2026-10-31）：置于 fflow 车道**之后**
  // 追加，同日以快照值覆盖（clist 当日截面比 fflow 日线的当日行更晚落定、更接近
  // 终值）。fundDate 为空（盘中未落定）整步跳过 —— 半日值入库会永久污染分位序列；
  // 桥 / http 全部失败时静默降级（当日散户因子缺席，不阻塞采集）。
  if (fundDate) {
    const fundRows = await fetchBoardFundSnapshot(deps).catch(() => null);
    if (fundRows && fundRows.size > 0) {
      const thsByBk = new Map(Object.entries(emMap).map(([thsCode, bkCode]) => [bkCode, thsCode]));
      for (const [bkCode, row] of fundRows) {
        const thsCode = thsByBk.get(bkCode);
        const entry = thsCode ? data.get(thsCode) : undefined;
        if (!entry) continue;
        entry.fflows = [
          ...(entry.fflows ?? []),
          {
            date: fundDate,
            mainNet: row.mainNet,
            mainRatio: row.mainRatio,
            smallNet: row.smallNet,
            smallRatio: row.smallRatio,
          },
        ];
      }
    }
  }

  return {
    data,
    failures,
    fflowMissCount: lane.missCount,
    fflowBlocked: lane.blocked,
    // 桥诊断不并入 reason：映射等原因与桥状态是两个独立事实（映射失败可能正是桥失败
    // 的结果），由调用方拼接两者 —— 桥成功时 getEmBridgeDiagnostic 为空串自然省略
    fflowMissReason: lane.missReason,
  };
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
    // 报错带上下文：连接层失败（error sending request）≈ 对方限流拉黑，稍后自愈
    throw new Error(
      `同花顺清单不可用${listError ? `（${listError}）` : '（接口返回空数据）'}`
      + ' —— 若为「error sending request」多为对方限流拉黑（频繁采集触发），等几十分钟自愈后重试',
    );
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
  // 快照日：未落定日被排除时本轮不写快照字段（防半日值入库）——历史步的
  // 四档资金快照与步骤 5 的当日快照合并共用这一个判定
  const snapshotDate = settle.excludedDate ? '' : settle.asOf;
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

  const fetched = await fetchWatchHistories(deps, targetRefs, emMap, snapshotDate, onProgress);

  // fflow 缺席提示（东财封禁中不 block，只提示散户因子缺席；经 ScanResult 透出给页面）
  // 封禁判定（前置探测 blocked / 车道连拒熔断）用 EM_BLOCKED_NOTICE 讲清机制，
  // 其余部分缺席按数报（v1.1.0 分子颠倒已修：全部缺席显示 20/20 而非 0/20）；
  // 失败原因与桥状态并列透出 —— 「映射未命中 + 桥未就绪」即桥失败的因果链，一眼定位
  const bridgeDiag = getEmBridgeDiagnostic();
  const reasonParts = [fetched.fflowMissReason, bridgeDiag].filter(Boolean);
  const missNotice =
    fetched.fflowMissCount === 0 || fetched.failures.size >= targetRefs.length
      ? ''
      : fetched.fflowBlocked
        ? EM_BLOCKED_NOTICE
        : `${fflowMissNotice(fetched.fflowMissCount, targetRefs.length)}`
          + (reasonParts.length > 0 ? ` 首个失败原因：${reasonParts.join('；')}` : '');

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
