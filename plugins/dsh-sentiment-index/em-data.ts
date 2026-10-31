/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 东财取数层（fflow 小单 + 池子）
 *
 * 混合源架构下东财只承担两个不可替代的点（其余全在同花顺 ths-data.ts / 宿主分母）：
 * - **fflow daykline 逐日资金拆分**（fields2 到 f61）：散户提纯核心，全网唯一 ——
 *   列序实测 日期/主力净额/小单净额/中单净额/大单净额/超大单净额/五档净占比，
 *   小单净占比在下标 7（f58），深度约 121 交易日（2026-03-27 起）。
 *   ⚠️ 封禁窗口式反复（2026-10-30 实测，接口路径粒度）——连接被拒不重试（对封禁中
 *   上游连发只会延长封禁），调用方按「因子缺席」降级，恢复后自动补历史；
 * - **涨停 / 炸板 / 跌停池**（push2ex，一直未被风控波及）；
 * - **沪深指数日 K**（分母次选：主分母是宿主 fetchMarketTurnover 腾讯源）。
 *
 * 频率红线：调用方并发 ≤3 + 每请求 500ms 错峰；本层只做 HTTP 5xx 的原地小步重试。
 */
import {
  EM_CLIST_MAX_PAGES,
  EM_CLIST_PAGE_SIZE,
  EM_CLIST_URL_TEMPLATE,
  EM_FETCH_ATTEMPTS,
  EM_FS_CONCEPT,
  EM_FS_INDUSTRY,
  EM_FFLOW_URL_TEMPLATE,
  EM_KLINE_URL_TEMPLATE,
  EM_MARKET_SECIDS,
  EM_POOL_PATH_LIMIT_DOWN,
  EM_POOL_PATH_ZHA_BAN,
  EM_POOL_URL_TEMPLATE,
  EM_REFERER,
  EM_THS_TO_EM_ALIAS,
  KLINE_YEARS_BACK,
  SCAN_DELAY_MS,
} from './constants';
import type { SentimentDeps } from './types';

/** fflow 行的最少字段数（fields2 到 f61 = 11 列；上游若回旧口径少于 8 列则小单缺席） */
const FFLOW_MIN_FIELDS = 8;

/** fflow 行内字段下标（日期/主力额/小单额/中单额/大单额/超大单额/主力占比/小单占比…） */
const FFLOW_FIELD = {
  DATE: 0,
  MAIN_NET: 1,
  SMALL_NET: 2,
  MAIN_RATIO: 6,
  SMALL_RATIO: 7,
} as const;

/** 日 K 行的最少字段数（指数分母只用日期 + 成交额两列，但脏行按 7 列标准丢弃） */
const KLINE_MIN_FIELDS = 7;

/** 日 K 行内字段下标（实测顺序：日期/开/收/高/低/量/额） */
const KLINE_FIELD = {
  DATE: 0,
  AMOUNT: 6,
} as const;

/** 日期字段形态：YYYY-MM-DD */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 数值字段（`"-"` / 空 / 非数一律 null —— 绝不把「无数据」当 0）
 * @param value 原始字段值
 * @returns 数值；无法解析为 null
 */
const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || text === '-') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

// ---------- 解析（纯函数，可离线冒烟） ----------

/** fflow 解析行（逐日资金拆分；小单 = 散户估算口径） */
export interface FflowRow {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 主力净流入（元） */
  mainNet: number | null;
  /** 主力净占比（%） */
  mainRatio: number | null;
  /** 小单净流入（元） */
  smallNet: number | null;
  /** 小单净占比（%） */
  smallRatio: number | null;
}

/** 指数日 K 解析行（分母用，只要日期与成交额） */
export interface IndexAmountRow {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 成交额（元） */
  amount: number;
}

/**
 * 解析东财 fflow daykline JSON（纯函数）
 * @param text 响应文本（UTF-8 JSON）
 * @returns 逐日资金拆分（升序；日期不合法的脏行丢弃）
 */
export const parseFflowJson = (text: string): FflowRow[] => {
  let payload: { data?: { klines?: unknown } };
  try {
    payload = JSON.parse(text) as { data?: { klines?: unknown } };
  } catch {
    return [];
  }
  const klines = payload.data?.klines;
  if (!Array.isArray(klines)) return [];

  const rows: FflowRow[] = [];
  for (const raw of klines) {
    if (typeof raw !== 'string') continue;
    const fields = raw.split(',');
    if (fields.length < FFLOW_MIN_FIELDS) continue;
    const date = fields[FFLOW_FIELD.DATE];
    if (!DATE_PATTERN.test(date)) continue;
    rows.push({
      date,
      mainNet: toNumber(fields[FFLOW_FIELD.MAIN_NET]),
      mainRatio: toNumber(fields[FFLOW_FIELD.MAIN_RATIO]),
      smallNet: toNumber(fields[FFLOW_FIELD.SMALL_NET]),
      smallRatio: toNumber(fields[FFLOW_FIELD.SMALL_RATIO]),
    });
  }
  return rows;
};

/**
 * 解析东财指数日 K JSON 为成交额序列（纯函数，分母降级用）
 * @param text 响应文本（UTF-8 JSON）
 * @returns 逐日成交额（升序；脏行丢弃）
 */
export const parseIndexAmountsJson = (text: string): IndexAmountRow[] => {
  let payload: { data?: { klines?: unknown } };
  try {
    payload = JSON.parse(text) as { data?: { klines?: unknown } };
  } catch {
    return [];
  }
  const klines = payload.data?.klines;
  if (!Array.isArray(klines)) return [];

  const rows: IndexAmountRow[] = [];
  for (const raw of klines) {
    if (typeof raw !== 'string') continue;
    const fields = raw.split(',');
    if (fields.length < KLINE_MIN_FIELDS) continue;
    const date = fields[KLINE_FIELD.DATE];
    if (!DATE_PATTERN.test(date)) continue;
    const amount = toNumber(fields[KLINE_FIELD.AMOUNT]);
    if (amount !== null && amount > 0) rows.push({ date, amount });
  }
  return rows;
};

/**
 * 解析东财池子（涨停 / 炸板 / 跌停共用）的总数字段（纯函数）
 * @param text 响应文本（UTF-8 JSON）
 * @returns 池子总数；解析不到为 null
 */
export const parsePoolTotal = (text: string): number | null => {
  try {
    const payload = JSON.parse(text) as { data?: { total?: unknown } };
    return toNumber(payload.data?.total);
  } catch {
    return null;
  }
};

// ---------- 板块清单（BK 码映射用，尽力拉取） ----------

/** 东财板块清单行（映射用：BK 代码 + 名称） */
export interface EmBoardRow {
  /** 东财板块代码（BKxxxx） */
  code: string;
  /** 板块名称 */
  name: string;
}

/**
 * 拉取东财板块清单全表（行业 t:2 + 概念 t:3；**尽力拉取**，只用于 THS→BK 名称映射）
 *
 * 映射是 fflow（散户因子）的前提：THS 与东财是两套板块代码体系，只有名称可对齐
 * （等值 → 剥罗马后缀 → 别名表，同 dsh-mainline 的 matchThsToEm）。clist 被封禁时
 * 返回空数组，由调用方用 scan_meta 缓存的映射兜底；映射缺失的板块散户因子缺席。
 * @param deps 宿主能力集合
 * @returns 东财板块行（行业 + 概念合并；失败返回空数组不抛错）
 */
export const fetchEmBoardUniverse = async (deps: SentimentDeps): Promise<EmBoardRow[]> => {
  const merged = new Map<string, EmBoardRow>();
  for (const fs of [EM_FS_INDUSTRY, EM_FS_CONCEPT]) {
    for (let page = 1; page <= EM_CLIST_MAX_PAGES; page += 1) {
      if (page > 1) await deps.format.delay(SCAN_DELAY_MS);
      const url = EM_CLIST_URL_TEMPLATE
        .replace('{pn}', String(page))
        .replace('{pz}', String(EM_CLIST_PAGE_SIZE))
        .replace('{fs}', fs);
      try {
        const rows = parseClistBoardJson(await fetchText(deps, url));
        if (rows.length === 0) break;
        for (const row of rows) if (!merged.has(row.code)) merged.set(row.code, row);
      } catch (error) {
        console.warn('[plugin] dsh-sentiment-index 东财板块清单取数失败（映射降级用缓存）', error);
        break;
      }
    }
  }
  return [...merged.values()];
};

/** 清单行字段键（避免裸字符串） */
const EM_BOARD_FIELD = {
  CODE: 'f12',
  NAME: 'f14',
} as const;

/**
 * 解析东财板块清单 JSON（纯函数：只要 BK 代码与名称）
 * @param text 响应文本（UTF-8 JSON）
 * @returns 板块行（按代码去重）
 */
export const parseClistBoardJson = (text: string): EmBoardRow[] => {
  let payload: { data?: { diff?: unknown } };
  try {
    payload = JSON.parse(text) as { data?: { diff?: unknown } };
  } catch {
    return [];
  }
  const diff = payload.data?.diff;
  const rawRows: unknown[] = Array.isArray(diff)
    ? diff
    : diff && typeof diff === 'object'
      ? Object.values(diff)
      : [];
  const rows: EmBoardRow[] = [];
  const seen = new Set<string>();
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const code = typeof row[EM_BOARD_FIELD.CODE] === 'string' ? String(row[EM_BOARD_FIELD.CODE]).trim() : '';
    const name = typeof row[EM_BOARD_FIELD.NAME] === 'string' ? String(row[EM_BOARD_FIELD.NAME]).trim() : '';
    if (!code.startsWith('BK') || !name || seen.has(code)) continue;
    seen.add(code);
    rows.push({ code, name });
  }
  return rows;
};

/** 东财板块名尾部的罗马数字（Ⅱ / Ⅲ 等，二级 / 三级行业标记） */
const EM_ROMAN_SUFFIX_PATTERN = /[\u2160-\u2169]+$/;

/**
 * 「同花顺板块名 → 东财板块」名称映射（纯函数）
 *
 * 匹配只做同层级语义等价的三级：名称等值 → 剥东财罗马数字后缀（重名时优先无后缀）
 * → 别名表（词序颠倒 / 申万改名）。**不做前缀兜底**：命中的多是「东财粗一级」的板块，
 * 硬映射会把成分不同的板块当成同一个 —— 映射不上就不猜（散户因子如实缺席）。
 * @param thsBoards 同花顺板块清单（code + name）
 * @param emBoards 东财板块清单（code + name）
 * @returns thsCode → bkCode 映射
 */
export const matchThsToEm = (
  thsBoards: readonly { code: string; name: string }[],
  emBoards: readonly EmBoardRow[],
): Record<string, string> => {
  const exact = new Map<string, string>();
  const stripped = new Map<string, string>();
  for (const board of emBoards) {
    if (!exact.has(board.name)) exact.set(board.name, board.code);
    // 罗马后缀可能带前导空格（上游「银行 Ⅱ / 银行Ⅱ」两种形态都出现过），一并剥掉
    const base = board.name.replace(/\s+/g, '').replace(EM_ROMAN_SUFFIX_PATTERN, '');
    if (base !== board.name.replace(/\s+/g, '') && !stripped.has(base)) stripped.set(base, board.code);
  }
  const map: Record<string, string> = {};
  for (const board of thsBoards) {
    const key = board.name.replace(/\s+/g, '');
    const target =
      exact.get(key) ??
      stripped.get(key) ??
      exact.get(EM_THS_TO_EM_ALIAS[board.name] ?? '') ??
      null;
    if (target) map[board.code] = target;
  }
  return map;
};

// ---------- fflow 与池子 ----------

/**
 * 连接层失败（TCP RST / DNS / 拒连）的报错特征
 *
 * Tauri plugin-http（reqwest）报 `error sending request for url (…)`，
 * 浏览器 fetch 抛 `fetch failed` / `Failed to fetch`。这类失败对「临时封禁中」的
 * 上游短间隔重试毫无意义（还会加重风控），与 HTTP 5xx 的瞬时抖动要区分对待。
 */
const CONNECTION_ERROR_PATTERN = /error sending request|fetch failed|failed to fetch|network|ECONN|socket|UND_ERR/i;

/**
 * 判断一条报错是否为连接层失败（对端掐连接 / 网络不可达）
 * @param message 报错文本
 * @returns 是否连接层失败
 */
export const isConnectionError = (message: string): boolean =>
  CONNECTION_ERROR_PATTERN.test(message);

/**
 * 带 Referer 的受控请求
 *
 * 重试策略按错误分层：连接被拒（上游临时封禁中）只试 1 次立即放弃；
 * HTTP 非 2xx / 解析异常保持原地小步重试（网关瞬时簇稍等自愈）。
 * @param deps 宿主能力集合
 * @param url 目标地址
 * @returns 响应文本
 */
const fetchText = async (deps: SentimentDeps, url: string): Promise<string> => {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < EM_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.format.delay(SCAN_DELAY_MS);
    try {
      const response = await deps.http.fetch(url, { headers: { Referer: EM_REFERER } });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      return await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isConnectionError(lastError)) break; // 连接被拒：重试无意义，立即上抛
    }
  }
  throw new Error(lastError);
};

/** 东财 ff-low 可达性探测结果 */
export interface EmFflowProbe {
  /** fflow 是否可用 */
  ok: boolean;
  /** ok 可用 / blocked 连接被拒（临时封禁中）/ error 其他错误 */
  kind: 'ok' | 'blocked' | 'error';
  /** 失败时的上游原始报错 */
  message: string;
}

/**
 * fflow 前置探测：东财资金拆分端点是否可达（单板块 lmt=1 的轻量请求）
 *
 * 混合源下 fflow 只承载散户因子：不可达**不 block 采集**（调用方继续跑，
 * 因子缺席权重重分配），探测结果只用于给出可读提示。
 * @param deps 宿主能力集合
 * @returns 探测结果
 */
export const probeEmFflow = async (deps: SentimentDeps): Promise<EmFflowProbe> => {
  const url = `${EM_FFLOW_URL_TEMPLATE.replace('{secid}', encodeURIComponent('90.BK1036'))}&lmt=1`;
  try {
    const rows = parseFflowJson(await fetchText(deps, url));
    if (rows.length === 0) return { ok: false, kind: 'error', message: 'fflow 返回空数据' };
    return { ok: true, kind: 'ok', message: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: isConnectionError(message) ? 'blocked' : 'error', message };
  }
};

/**
 * 拉取单个板块的逐日资金拆分（fflow daykline，fields2 到 f61）
 * @param deps 宿主能力集合
 * @param boardCode 东财板块代码（BKxxxx）
 * @returns 逐日资金拆分（升序）；无有效数据抛错
 */
export const fetchBoardFflow = async (deps: SentimentDeps, boardCode: string): Promise<FflowRow[]> => {
  const url = EM_FFLOW_URL_TEMPLATE.replace('{secid}', encodeURIComponent(`90.${boardCode}`));
  const rows = parseFflowJson(await fetchText(deps, url));
  if (rows.length === 0) throw new Error(`板块资金拆分无数据：${boardCode}`);
  return rows;
};

/**
 * 拉取单只沪深指数的日 K 成交额（分母次选的一半）
 * @param deps 宿主能力集合
 * @param secid 指数 secid（1.000001 / 0.399001）
 * @returns 逐日成交额（元；升序）
 */
export const fetchIndexAmounts = async (
  deps: SentimentDeps,
  secid: string,
): Promise<IndexAmountRow[]> => {
  const beg = `${new Date().getFullYear() - KLINE_YEARS_BACK}0101`;
  const url = EM_KLINE_URL_TEMPLATE.replace('{secid}', encodeURIComponent(secid)).replace('{beg}', beg);
  return parseIndexAmountsJson(await fetchText(deps, url));
};

/**
 * 拉取沪深两市成交额序列（分母：主选宿主腾讯源，失败降级东财指数日K）
 * @param deps 宿主能力集合
 * @returns 逐日 {date, totalAmount}（升序）；两级都失败返回空数组由调用方用缓存兜底
 */
export const fetchMarketSeries = async (
  deps: SentimentDeps,
): Promise<{ date: string; totalAmount: number }[]> => {
  // 主选：宿主 fetchMarketTurnover（腾讯 ifzq 日 K，dsh-mainline 同款稳定通道）
  try {
    const host = await deps.market.fetchMarketTurnover();
    const points = host
      .filter((point) => point.date && point.totalAmount > 0)
      .map((point) => ({ date: point.date, totalAmount: point.totalAmount }));
    if (points.length > 0) return points;
  } catch (error) {
    console.warn('[plugin] dsh-sentiment-index 宿主分母取数失败，降级东财指数日K', error);
  }
  // 次选：东财沪深指数日 K 相加（封禁窗口内会失败，返回空由调用方用缓存兜底）
  try {
    const amounts = await Promise.all(EM_MARKET_SECIDS.map((secid) => fetchIndexAmounts(deps, secid)));
    const totals = new Map<string, number>();
    for (const series of amounts) {
      for (const point of series) totals.set(point.date, (totals.get(point.date) ?? 0) + point.amount);
    }
    return [...totals.entries()]
      .map(([date, totalAmount]) => ({ date, totalAmount }))
      .filter((point) => point.totalAmount > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
};

/**
 * 拉取池子总数（炸板 / 跌停；情绪条用）
 * @param deps 宿主能力集合
 * @param kind 池子类别
 * @param date 交易日（YYYY-MM-DD）
 * @returns 池子总数；取数失败为 null（情绪条该格显示占位，不阻塞）
 */
export const fetchPoolTotal = async (
  deps: SentimentDeps,
  kind: 'zhaBan' | 'limitDown',
  date: string,
): Promise<number | null> => {
  const path = kind === 'zhaBan' ? EM_POOL_PATH_ZHA_BAN : EM_POOL_PATH_LIMIT_DOWN;
  const url = EM_POOL_URL_TEMPLATE.replace('{path}', path).replace('{date}', date.replaceAll('-', ''));
  try {
    return parsePoolTotal(await fetchText(deps, url));
  } catch {
    return null;
  }
};
