/**
 * 插件 dsh-market-breadth · stock-sdk 实例构造
 *
 * 写法对标 dsh-stock-screener 的 sdk.ts：fetchImpl 走宿主 `app:http`（Tauri 由
 * Rust 直连、浏览器走 /stock-proxy，与宿主内置版完全同一条通道），并在收口处
 * 先做东财镜像域改道。
 */
import { StockSDK } from 'stock-sdk';
import type { FullQuote } from 'stock-sdk';
import {
  MARKET_SNAPSHOT_BATCH_SIZE,
  MARKET_SNAPSHOT_CONCURRENCY,
} from './constants';
import { rerouteEastmoneyHost } from './eastmoney-reroute';
import type { HttpService } from '../../host/types/plugin.types';

/** SDK 请求选项（对齐宿主 `constants/sdk.constants.ts`） */
const SDK_REQUEST_OPTIONS = {
  /** 单请求超时（毫秒） */
  timeout: 10_000,
  /** 上游为公共接口，对限频敏感，仅重试 1 次以避免失败时放大流量 */
  retry: {
    maxRetries: 1,
  },
} as const;

/**
 * 构造插件自用的 SDK 实例
 * @param http 宿主受控网络请求服务
 * @returns stock-sdk 实例
 */
export const createBreadthSdk = (http: HttpService): StockSDK => {
  const reroutingFetch: typeof fetch = (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return http.fetch(rerouteEastmoneyHost(target), init);
  };
  return new StockSDK({
    fetchImpl: reroutingFetch,
    ...SDK_REQUEST_OPTIONS,
  });
};

/**
 * 构造全市场快照取数函数（东财源，小并发分页：并发 3 / 每页 500）
 *
 * 口径同宿主 fetchAllMarketQuotes：并发页数压在 3（东财反爬红线），不要调高。
 * @param sdk stock-sdk 实例
 * @returns 全市场快照取数函数
 */
export const createFullMarketFetcher = (sdk: StockSDK): (() => Promise<FullQuote[]>) => {
  const fetchAllQuotes = async (): Promise<FullQuote[]> =>
    sdk.batch.cn({
      batchSize: MARKET_SNAPSHOT_BATCH_SIZE,
      concurrency: MARKET_SNAPSHOT_CONCURRENCY,
    });
  return fetchAllQuotes;
};
