/**
 * 插件 dsh-futures-institutional · 大盘指数日 K 取数（曲线对照用）
 *
 * 数据源：腾讯行情 K 线 `web.ifzq.gtimg.cn/appstock/app/newfqkline/get`（域已在宿主
 * app:http 白名单 `gtimg.cn` 内；免 Token）。口径对齐宿主 `turnover.api.ts` 的实测结论：
 * 行结构 `[日期, 开, 收, 高, 低, 成交量(手), {}, …]`，取下标 0（日期）与 2（收盘）。
 * 为什么不用东财 push2his：东财行情域对宿主 reqwest 指纹不稳（dsh-sentiment-index
 * 2026-10-31 实测），腾讯域长期稳定。
 *
 * 会话级缓存：日 K 按天定稿，一次拉 400 根（≈1.5 年）后进程内复用，不重复请求。
 */
import {
  INDEX_COMBO_KLINE_URL,
  INDEX_COMBO_KLINE_REFERER,
  INDEX_COMBO_KLINE_MAX_DAYS,
} from './constants';
import type { HttpService } from '../../host/types/plugin.types';

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

/** 会话内缓存：symbol → （date → 收盘价） */
const closeCache = new Map<string, Map<string, number>>();

/**
 * 拉取单只指数的日 K 收盘表（会话缓存；失败抛错由调用方决定降级）
 * @param http 宿主受控网络请求（app:http）
 * @param symbol 腾讯符号形态（如 `sh000001`）
 * @returns 交易日（yyyy-MM-dd）→ 收盘价
 */
export const fetchIndexCloses = async (http: HttpService, symbol: string): Promise<Map<string, number>> => {
  const cached = closeCache.get(symbol);
  if (cached) {
    return cached;
  }
  const url = `${INDEX_COMBO_KLINE_URL}?param=${symbol},day,,,${INDEX_COMBO_KLINE_MAX_DAYS},qfq`;
  const response = await http.fetch(url, { headers: { Referer: INDEX_COMBO_KLINE_REFERER } });
  if (!response.ok) {
    throw new Error(`腾讯日K HTTP ${response.status}（${symbol}）`);
  }
  const body = (await response.json()) as TencentKlineResponse;
  const rows = body.data?.[symbol]?.qfqday ?? body.data?.[symbol]?.day ?? [];
  const map = new Map<string, number>();
  for (const row of rows) {
    const date = row[0];
    const close = Number(row[2]);
    if (date && Number.isFinite(close) && close > 0) {
      map.set(date, close);
    }
  }
  if (map.size === 0) {
    throw new Error(`腾讯日K无数据（${symbol}）`);
  }
  closeCache.set(symbol, map);
  return map;
};
