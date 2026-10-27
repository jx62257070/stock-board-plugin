/**
 * 插件 dsh-broad-track（宽基跟踪）· 份额序列取数层
 *
 * 本模块是「国家队观测」的主口径取数层，与 `em-data.ts`（二级市场资金流）
 * 平行且独立。三条链路：
 *
 * 1. **上交所逐日份额**（`share-data.ts` → `fetchSseShareSnapshot`）：
 *    单日全市场一次请求拿全部沪市 ETF 的份额（实测 924 只），历史按日回溯。
 *    这是沪市份额的**权威口径**，也是整套方案的地基。
 * 2. **深交所逐日份额**（`fetchSzseShareHistory`）：
 *    `fund_jjgm` 按代码 + 日期区间查，区间上限约 110 交易日（需分窗）。
 * 3. **腾讯历史收盘价**（`fetchTencentKline`）：
 *    份额变动 × 收盘价 = 估算净申赎金额；价格缺失时金额留 `null`。
 *
 * ⚠️ **频率纪律**：交易所域对高频请求会掐连接（`fetch failed`）。
 * 本模块**串行**请求 + 固定间隔 + 小步重试；历史回填由调用方分日驱动，
 * 进度可断点续传（已入库的日期不再请求）。
 *
 * ⚠️ 宿主能力（网络请求与限速节拍）以 `deps` 形式注入，本模块不 import 宿主模块。
 */
import {
  EXCHANGE_DELAY_MS,
  EXCHANGE_FETCH_ATTEMPTS,
  EXCHANGE_RETRY_DELAY_MS,
  SSE_SHARE_DATE_TOKEN,
  SSE_SHARE_REFERER,
  SSE_SHARE_URL,
  SZSE_SHARE_CODE_TOKEN,
  SZSE_SHARE_END_TOKEN,
  SZSE_SHARE_PAGE_TOKEN,
  SZSE_SHARE_REFERER,
  SZSE_SHARE_START_TOKEN,
  SZSE_SHARE_URL,
  SZSE_SHARE_WINDOW_DAYS,
  TENCENT_KLINE_COUNT_TOKEN,
  TENCENT_KLINE_END_TOKEN,
  TENCENT_KLINE_REFERER,
  TENCENT_KLINE_START_TOKEN,
  TENCENT_KLINE_SYMBOL_TOKEN,
  TENCENT_KLINE_URL,
} from './constants';
import {
  parseSseShareSnapshot,
  parseSzseShareHistory,
  parseTencentKline,
} from './share-parse';
import type { SseShareRow, SzseShareRow, TencentKlineRow } from './share-parse';
import type { BroadDeps } from './types';

/**
 * 带重试的一次 GET（交易所域掐连接是常态，小步重试即恢复）
 * @param deps 宿主能力
 * @param url 请求地址
 * @param referer Referer 头
 * @returns 响应文本
 */
const fetchTextWithRetry = async (
  deps: BroadDeps,
  url: string,
  referer: string,
): Promise<string> => {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < EXCHANGE_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.format.delay(EXCHANGE_RETRY_DELAY_MS);
    try {
      const response = await deps.http.fetch(url, { headers: { Referer: referer } });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const text = await response.text();
      // 交易所对无 cookie 的请求会返回空体 —— 空体按失败处理并重试
      if (text.trim() === '') {
        lastError = '上游返回空响应体';
        continue;
      }
      return text;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
};

/**
 * 取某个日期的上交所全市场 ETF 份额快照
 *
 * 一次请求即覆盖**全部沪市 ETF**（实测 924 只），调用方只取清单内的代码。
 * 非交易日 / 未来日期会返回空数组（上游给 `result: []`）。
 * @param deps 宿主能力
 * @param date 统计日（YYYY-MM-DD）
 * @returns 份额行（按上游顺序）；无数据返回空数组
 */
export const fetchSseShareSnapshot = async (
  deps: BroadDeps,
  date: string,
): Promise<SseShareRow[]> => {
  const url = SSE_SHARE_URL.replace(SSE_SHARE_DATE_TOKEN, date);
  const text = await fetchTextWithRetry(deps, url, SSE_SHARE_REFERER);
  return parseSseShareSnapshot(text, date);
};

/**
 * 取深市单只 ETF 的逐日份额历史（按日期区间，窗口自动分页 + 分窗）
 *
 * 上游单窗上限约 110 个交易日，故长区间拆成多个窗口串行请求；
 * 每个窗口内还可能多页（`pagecount`），逐页取完。
 * @param deps 宿主能力
 * @param code 6 位裸代码
 * @param start 起始日（YYYY-MM-DD）
 * @param end 结束日（YYYY-MM-DD）
 * @returns 份额行（按上游顺序，跨窗口合并）
 */
export const fetchSzseShareHistory = async (
  deps: BroadDeps,
  code: string,
  start: string,
  end: string,
): Promise<SzseShareRow[]> => {
  const rows: SzseShareRow[] = [];
  let windowStart = start;
  while (windowStart <= end) {
    const windowEnd = addDays(windowStart, SZSE_SHARE_WINDOW_DAYS - 1);
    const cappedEnd = windowEnd > end ? end : windowEnd;
    rows.push(...(await fetchSzseWindow(deps, code, windowStart, cappedEnd)));
    if (cappedEnd >= end) break;
    windowStart = addDays(cappedEnd, 1);
    await deps.format.delay(EXCHANGE_DELAY_MS);
  }
  return rows;
};

/**
 * 取深市单只 ETF 的一个日期窗口（内部逐页）
 * @param deps 宿主能力
 * @param code 6 位裸代码
 * @param start 起始日（YYYY-MM-DD）
 * @param end 结束日（YYYY-MM-DD）
 * @returns 份额行
 */
const fetchSzseWindow = async (
  deps: BroadDeps,
  code: string,
  start: string,
  end: string,
): Promise<SzseShareRow[]> => {
  const rows: SzseShareRow[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = SZSE_SHARE_URL
      .replace(SZSE_SHARE_CODE_TOKEN, code)
      .replace(SZSE_SHARE_START_TOKEN, start)
      .replace(SZSE_SHARE_END_TOKEN, end)
      .replace(SZSE_SHARE_PAGE_TOKEN, String(page));
    const text = await fetchTextWithRetry(deps, url, SZSE_SHARE_REFERER);
    const pageRows = parseSzseShareHistory(text, code);
    rows.push(...pageRows);
    totalPages = readPageCount(text);
    page += 1;
    if (page > totalPages) break;
    await deps.format.delay(EXCHANGE_DELAY_MS);
  }
  return rows;
};

/**
 * 从深交所响应里读总页数（读不到按 1 页处理）
 * @param text 响应文本
 * @returns 页数
 */
const readPageCount = (text: string): number => {
  try {
    const payload = JSON.parse(text) as unknown;
    if (!Array.isArray(payload)) return 1;
    const block = payload[0];
    if (!block || typeof block !== 'object') return 1;
    const metadata = (block as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return 1;
    const count = (metadata as { pagecount?: unknown }).pagecount;
    const parsed = typeof count === 'number' ? count : Number(count);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  } catch {
    return 1;
  }
};

/**
 * 取腾讯历史日 K（收盘价 + 成交量）
 * @param deps 宿主能力
 * @param symbol 腾讯符号（如 `sh510300`）
 * @param start 起始日（YYYY-MM-DD）
 * @param end 结束日（YYYY-MM-DD）
 * @param count 最多取多少条
 * @returns 日 K 行（按上游顺序）
 */
export const fetchTencentKline = async (
  deps: BroadDeps,
  symbol: string,
  start: string,
  end: string,
  count: number,
): Promise<TencentKlineRow[]> => {
  const url = TENCENT_KLINE_URL
    .replace(TENCENT_KLINE_SYMBOL_TOKEN, symbol)
    .replace(TENCENT_KLINE_START_TOKEN, start)
    .replace(TENCENT_KLINE_END_TOKEN, end)
    .replace(TENCENT_KLINE_COUNT_TOKEN, String(count));
  const text = await fetchTextWithRetry(deps, url, TENCENT_KLINE_REFERER);
  return parseTencentKline(text, symbol);
};

/**
 * 日期加天数（返回 YYYY-MM-DD；非法日期返回空串）
 * @param date 起始日（YYYY-MM-DD）
 * @param days 天数（可负）
 * @returns 目标日期
 */
export const addDays = (date: string, days: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return '';
  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(base)) return '';
  const next = new Date(base + days * 86400000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
