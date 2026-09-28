/**
 * 插件 dsh-stock-screener · 新浪日 K 取数 + 会话内缓存
 *
 * 自宿主 `api/sina-kline.api.ts` + `api/kline-cache.api.ts` 移植并收窄为「仅日 K」：
 * 选股器的两个消费方（MA 回测 / 信号扫描）都只用日 K。
 *
 * 缓存策略（对应「历史行情不变」这一前提）：
 * - 首次请求某票 ⇒ 取满（≈7.5 年）或按 barLimit 收窄，写入**会话内**缓存（Map）；
 * - 之后请求 ⇒ 只向新浪补「缓存最新日期 → 现在」的缺口；
 * - 缓存仍新鲜（当日已终值 / 盘中 TTL 内 / 中间无工作日）⇒ 零网络请求直接返回。
 *
 * 与宿主的差异：宿主落 SQLite（stock-board.db，跨会话），插件改为**会话内 Map** ——
 * 整池扫描（store: false）依旧不写缓存，行为与宿主一致；差别仅在应用重启后
 * 首次回测需要重新取一次全量历史（单票一次请求，可接受）。
 *
 * ⚠️ 新浪日 K 为不复权：除权日附近指标可能失真（宿主侧同款已知限制）。
 */
import dayjs from 'dayjs';
import type { HttpService } from '../../host/types/plugin.types';
import {
  KLINE_CACHE_SOURCE,
  KLINE_DATE_FORMAT,
  KLINE_DAILY_FINAL_HOUR,
  KLINE_DAILY_FINAL_MINUTE,
  KLINE_TAIL_MARGIN_BARS,
  KLINE_TAIL_MIN_DATALEN,
  KLINE_TAIL_TTL_MS,
  KLINE_TRADING_WEEKDAYS,
  SINA_DAILY_SCALE,
  SINA_KLINE_MAX_BARS,
  SINA_REFERER,
} from './constants';
import type { KlineBar, KlineCacheMeta, KlineCacheOptions } from './types';

/** 新浪 K 线原始记录（数值均为字符串） */
interface SinaKlineRaw {
  /** 日 K 为 YYYY-MM-DD */
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** 会话内缓存条目（水位 + bar 序列） */
interface KlineCacheEntry {
  /** 缓存水位 */
  meta: KlineCacheMeta;
  /** 日 K 序列（时间升序） */
  bars: KlineBar[];
}

/**
 * 解析新浪 JSONP 文本：剥离 `var _=(` 前缀与尾部 `);`
 *
 * 上游在参数越界或缺数据时返回 `var _=(null);`，这里显式报错，
 * 避免下游拿到 null 后抛出难以定位的异常
 * @param text 响应原文
 * @returns 解析后的原始记录数组
 */
const parseJsonp = (text: string): SinaKlineRaw[] => {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`新浪 K 线响应解析失败：${text.slice(0, 80)}`);
  }
  const parsed = JSON.parse(text.slice(start + 1, end)) as SinaKlineRaw[] | null;
  if (!Array.isArray(parsed)) {
    throw new Error('新浪 K 线响应为空（可能参数越界或该标的无数据）');
  }
  return parsed;
};

/**
 * 拉取新浪日 K 并转为插件 K 线结构（时间升序）
 * @param http 宿主受控网络请求服务
 * @param symbol 完整符号（sh600519 形态，新浪前缀一致可直接使用）
 * @param barLimit 请求根数（收敛到 [1, SINA_KLINE_MAX_BARS]）
 * @returns 日 K 序列
 */
const fetchSinaDailyKline = async (
  http: HttpService,
  symbol: string,
  barLimit: number | undefined,
): Promise<KlineBar[]> => {
  const requestDatalen = Math.min(Math.max(barLimit ?? SINA_KLINE_MAX_BARS, 1), SINA_KLINE_MAX_BARS);
  const url =
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=` +
    `/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${SINA_DAILY_SCALE}&ma=no&datalen=${requestDatalen}`;

  // 浏览器态经宿主 /stock-proxy 转发（中间件补 Referer）；Tauri 态 Rust 直连自带 Referer
  const response = await http.fetch(url, { headers: { Referer: SINA_REFERER } });
  if (!response.ok) {
    throw new Error(`新浪 K 线请求失败：${response.status}`);
  }
  const rawList = parseJsonp(await response.text());

  return rawList
    .map((raw) => ({
      // 空格为本地时区解析，与 A 股交易日口径一致
      timestamp: dayjs(raw.day.replace(/-/g, '/')).valueOf(),
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
      volume: Number(raw.volume),
      turnover: 0,
    }))
    .filter((bar) => !Number.isNaN(bar.timestamp) && bar.open > 0);
};

/**
 * 参照时刻所属自然日的「日 K 终值时刻」时间戳
 * @param now 参照时间戳（毫秒）
 * @returns 该日 15:05 的时间戳（毫秒）
 */
const dailyFinalAt = (now: number): number =>
  dayjs(now)
    .startOf('day')
    .hour(KLINE_DAILY_FINAL_HOUR)
    .minute(KLINE_DAILY_FINAL_MINUTE)
    .valueOf();

/**
 * 判断 `(from, to]` 区间内是否存在可能的交易日
 *
 * 不用真实交易日历：本函数只用于**决定要不要回源**，宁可多问一次也不漏。
 * 工作日只是「可能有交易日」的宽松条件：周五收盘后到周日之间不含工作日 ⇒
 * 判定无需回源，周末打开应用不会再打一次上游。
 * @param from 起始交易日（不含）
 * @param to 结束日（含）
 * @returns 是否存在工作日
 */
const hasWeekdayBetween = (from: string, to: string): boolean => {
  const end = dayjs(to).startOf('day');
  let cursor = dayjs(from).startOf('day').add(1, 'day');
  while (!cursor.isAfter(end)) {
    if (KLINE_TRADING_WEEKDAYS.includes(cursor.day())) {
      return true;
    }
    cursor = cursor.add(1, 'day');
  }
  return false;
};

/**
 * 判断是否需要回源补「最新尾部」
 *
 * 1. 无水位 ⇒ 需要，走首次全量；
 * 2. 缓存内已有今日 bar ⇒ 已过 15:05 且上次取数也在其后 ⇒ 终值不回源；
 *    盘中按 KLINE_TAIL_TTL_MS 节流；
 * 3. 缓存最新 bar 早于今日 ⇒ 只有中间存在工作日才回源。
 * @param meta 缓存水位；从未取过传 null
 * @param now 当前时间戳（毫秒）
 * @returns 是否需要回源补尾部
 */
const shouldFetchKlineTail = (meta: KlineCacheMeta | null, now: number): boolean => {
  if (meta === null) {
    return true;
  }
  const today = dayjs(now).format(KLINE_DATE_FORMAT);
  if (meta.lastDate >= today) {
    const finalAt = dailyFinalAt(now);
    if (now >= finalAt) {
      return meta.fetchedAt < finalAt;
    }
    return now - meta.fetchedAt >= KLINE_TAIL_TTL_MS;
  }
  return hasWeekdayBetween(meta.lastDate, today);
};

/**
 * 计算「补齐缓存最新日期 → 现在」所需的请求根数
 *
 * 新浪只能按「最近 N 根」倒序返回，无法指定起始日期，故用自然日跨度折算：
 * 一周至多 5 个交易日 ⇒ `days × 5 / 7` 是交易日数的上限估计（节假日与
 * 长期停牌只会更少，故不会漏取）。下限取 KLINE_TAIL_MIN_DATALEN：
 * 缓存最后一根本身也可能在盘中变化，必须至少重取它一次。
 * @param lastDate 缓存最新 bar 的交易日（`YYYY-MM-DD`）
 * @param now 当前时间戳（毫秒）
 * @returns 请求根数
 */
const calcKlineTailDatalen = (lastDate: string, now: number): number => {
  const gapDays = Math.max(0, dayjs(now).startOf('day').diff(dayjs(lastDate).startOf('day'), 'day'));
  const estimated = Math.ceil((gapDays * 5) / 7) + KLINE_TAIL_MARGIN_BARS;
  return Math.min(Math.max(estimated, KLINE_TAIL_MIN_DATALEN), SINA_KLINE_MAX_BARS);
};

/**
 * 合并「会话缓存」与「本次取回」的 K 线序列
 *
 * 按 `timestamp` 去重：本次取回的同刻 bar 覆盖旧值（当日 bar 盘中持续变化，
 * 必须让新数据赢）。结果按时间升序。
 * @param cached 缓存序列（时间升序）
 * @param fetched 本次取回序列（时间升序）
 * @returns 合并后的序列（时间升序；入参均不修改）
 */
const mergeKlineBars = (cached: readonly KlineBar[], fetched: readonly KlineBar[]): KlineBar[] => {
  if (fetched.length === 0) {
    return [...cached];
  }
  if (cached.length === 0) {
    return [...fetched];
  }
  const byTimestamp = new Map<number, KlineBar>();
  for (const bar of cached) {
    byTimestamp.set(bar.timestamp, bar);
  }
  for (const bar of fetched) {
    byTimestamp.set(bar.timestamp, bar);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * 创建日 K 缓存取数器（插件内单例，页面与 Agent 工具共用）
 * @param http 宿主受控网络请求服务
 * @returns 带 `fetch` 的缓存取数器
 */
export const createKlineCache = (http: HttpService): { fetch: (symbol: string, options?: KlineCacheOptions) => Promise<KlineBar[]> } => {
  /** 会话内缓存（key = 完整符号；只存 store: true 的取数结果） */
  const cache = new Map<string, KlineCacheEntry>();

  return {
    /**
     * 拉取日 K（优先会话缓存，必要时只补缺口）
     * @param symbol 完整符号（`sh600519` 形态）
     * @param options 缓存策略（写入与否 / 首次请求根数上限）
     * @returns 日 K 序列（时间升序）
     * @throws 需要回源且上游请求失败、或响应为空时抛错
     */
    fetch: async (symbol: string, options?: KlineCacheOptions): Promise<KlineBar[]> => {
      const store = options?.store ?? true;
      const now = Date.now();
      const entry = cache.get(symbol) ?? null;
      const cachedBars = entry?.bars ?? [];

      // 缓存仍新鲜：已有完整历史且无需补尾部 ⇒ 零网络请求
      if (entry !== null && !shouldFetchKlineTail(entry.meta, now)) {
        return cachedBars;
      }

      // 已有缓存 ⇒ 只取缺口根数；首次取数且不落缓存 ⇒ 允许调用方收窄
      let barLimit: number | undefined;
      if (entry !== null) {
        barLimit = calcKlineTailDatalen(entry.meta.lastDate, now);
      } else if (!store) {
        barLimit = options?.barLimit;
      }

      const fetched = await fetchSinaDailyKline(http, symbol, barLimit);
      if (fetched.length === 0) {
        return cachedBars;
      }
      const merged = mergeKlineBars(cachedBars, fetched);

      if (store) {
        cache.set(symbol, {
          meta: {
            symbol,
            firstDate: dayjs(merged[0]!.timestamp).format(KLINE_DATE_FORMAT),
            lastDate: dayjs(merged[merged.length - 1]!.timestamp).format(KLINE_DATE_FORMAT),
            barCount: merged.length,
            fetchedAt: now,
            source: KLINE_CACHE_SOURCE,
          },
          bars: merged,
        });
      }

      return merged;
    },
  };
};
