/**
 * 插件 dsh-market-breadth · 大盘指数 K 线取数（分时 / 日K）
 *
 * 日K：腾讯行情 K 线 `web.ifzq.gtimg.cn`（域在宿主 app:http 白名单 `gtimg.cn` 内，
 *   免 Token）。行结构口径对齐 dsh-futures-institutional 的实测结论：
 *   `[日期, 开, 收, 高, 低, 成交量(手), …]`，指数无复权概念直接取 `day` 数组，
 *   盘中最后一根为当日未定稿 bar。
 * 分时：新浪 1 分钟线 `quotes.sina.cn`（域在白名单 `sina.cn` 内；同宿主宽基 ETF
 *   分时口径 scale=1 / datalen=320），行结构 `{ day, open, high, low, close, volume }`，
 *   返回含少量昨日前缀，本地按「今日日键」过滤。
 * 为什么不用东财 push2his：东财行情域对宿主 reqwest 指纹不稳（dsh-sentiment-index
 *   2026-10-31 实测），腾讯 / 新浪域长期稳定。
 */
import {
  INDEX_DAY_KLINE_BARS,
  INDEX_DAY_KLINE_REFERER,
  INDEX_DAY_KLINE_URL,
  INDEX_MINUTE_DATALEN,
  INDEX_MINUTE_KLINE_URL,
  INDEX_MINUTE_REFERER,
  INDEX_MINUTE_SCALE,
} from './constants';
import { toDayKey } from './compute-breadth';
import type { HttpService } from '../../host/types/plugin.types';
import type { IndexDayBar, IndexMinutePoint } from './types';

/** 腾讯 K 线响应体（只需日 K 数组） */
interface TencentKlineResponse {
  data?: Record<
    string,
    {
      /** 前复权日 K（请求 qfq 时返回；指数无复权概念，一般直接落 day） */
      qfqday?: string[][];
      /** 不复权日 K（兜底） */
      day?: string[][];
    }
  >;
}

/** 新浪 K 线原始记录（数值均为字符串） */
interface SinaKlineRaw {
  /** 分钟线为 `YYYY-MM-DD HH:mm`（本地时区） */
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * 解析新浪 JSONP 文本：剥离 `var _=(` 前缀与尾部 `);`
 *
 * 上游在参数越界或缺数据时返回 `var _=(null);`，这里显式报错，
 * 避免下游拿到 null 后抛出难以定位的异常
 * @param text 响应原文
 * @returns 解析后的原始记录数组
 */
const parseSinaJsonp = (text: string): SinaKlineRaw[] => {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`新浪分钟线响应解析失败：${text.slice(0, 80)}`);
  }
  const parsed = JSON.parse(text.slice(start + 1, end)) as SinaKlineRaw[] | null;
  if (!Array.isArray(parsed)) {
    throw new Error('新浪分钟线响应为空（可能参数越界或该标的无数据）');
  }
  return parsed;
};

/**
 * 组装大盘指数 K 线取数器（绑定宿主网络通道，plugin.ts 构建后沿 runtime 注入）
 * @param http 宿主受控网络请求服务
 * @returns 取数器（日 K / 当日分钟线）
 */
export const createIndexKlineFetchers = (http: HttpService): {
  /** 拉取单只指数日 K（升序；脏数据已过滤） */
  fetchIndexDayKline: (symbol: string) => Promise<IndexDayBar[]>;
  /** 拉取单只指数当日 1 分钟线（升序） */
  fetchIndexMinuteLine: (symbol: string) => Promise<IndexMinutePoint[]>;
} => {
  /**
   * 拉取单只指数的日 K（腾讯源，升序）
   * @param symbol 指数符号（如 `sh000001`）
   * @returns 日 K 序列
   */
  const fetchIndexDayKline = async (symbol: string): Promise<IndexDayBar[]> => {
    const url = `${INDEX_DAY_KLINE_URL}?param=${symbol},day,,,${INDEX_DAY_KLINE_BARS},qfq`;
    const response = await http.fetch(url, { headers: { Referer: INDEX_DAY_KLINE_REFERER } });
    if (!response.ok) {
      throw new Error(`腾讯日K HTTP ${response.status}（${symbol}）`);
    }
    const body = (await response.json()) as TencentKlineResponse;
    // 行结构 [日期, 开, 收, 高, 低, 成交量(手), …]（dsh-futures-institutional 实测口径）
    const rows = body.data?.[symbol]?.qfqday ?? body.data?.[symbol]?.day ?? [];
    const bars = rows
      .map((row) => ({
        date: row[0] ?? '',
        open: Number(row[1]),
        close: Number(row[2]),
        high: Number(row[3]),
        low: Number(row[4]),
        volume: Number(row[5]),
      }))
      .filter(
        (bar) =>
          /^\d{4}-\d{2}-\d{2}$/.test(bar.date) &&
          [bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0) &&
          Number.isFinite(bar.volume),
      );
    if (bars.length === 0) {
      throw new Error(`腾讯日K无数据（${symbol}）`);
    }
    return bars;
  };

  /**
   * 拉取单只指数的当日 1 分钟线（新浪源，升序；返回的昨日前缀已按本地日键过滤）
   * @param symbol 指数符号（如 `sh000001`）
   * @returns 分钟点序列
   */
  const fetchIndexMinuteLine = async (symbol: string): Promise<IndexMinutePoint[]> => {
    const url =
      `${INDEX_MINUTE_KLINE_URL}?symbol=${symbol}&scale=${INDEX_MINUTE_SCALE}` +
      `&ma=no&datalen=${INDEX_MINUTE_DATALEN}`;
    // 浏览器态经宿主 /stock-proxy 转发（中间件补 Referer）；Tauri 态 Rust 直连自带 Referer
    const response = await http.fetch(url, { headers: { Referer: INDEX_MINUTE_REFERER } });
    if (!response.ok) {
      throw new Error(`新浪分钟线 HTTP ${response.status}（${symbol}）`);
    }
    const today = toDayKey(Date.now());
    return parseSinaJsonp(await response.text())
      .filter((raw) => raw.day.startsWith(today))
      .map((raw) => ({
        time: raw.day.slice(11, 16),
        close: Number(raw.close),
        volume: Number(raw.volume),
      }))
      .filter((point) => point.time !== '' && Number.isFinite(point.close) && point.close > 0);
  };

  return { fetchIndexDayKline, fetchIndexMinuteLine };
};
