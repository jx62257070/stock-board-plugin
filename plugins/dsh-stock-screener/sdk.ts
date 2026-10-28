/**
 * 插件 dsh-stock-screener · stock-sdk 实例构造
 *
 * fetchImpl 走宿主 `app:http`（Tauri 由 Rust 直连、浏览器走 /stock-proxy，
 * 与宿主内置版完全同一条通道），并在收口处先做东财镜像域改道。
 * JSONP 类源（腾讯行情 / 分时）由 SDK 自行 script 注入，不经此通道。
 */
import { StockSDK } from 'stock-sdk';
import type { HttpService } from '../../host/types/plugin.types';
import { rerouteEastmoneyHost } from './eastmoney-reroute';

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
 *
 * 实例级缓存（代码表 / 交易日历 / 板块映射）按实例隔离：插件持有独立实例，
 * 与宿主互不干扰；整个插件（页面 + Agent 工具）共用这一份。
 * @param http 宿主受控网络请求服务
 * @returns stock-sdk 实例
 */
export const createScreenerSdk = (http: HttpService): StockSDK => {
  const reroutingFetch: typeof fetch = (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return http.fetch(rerouteEastmoneyHost(target), init);
  };
  return new StockSDK({
    fetchImpl: reroutingFetch,
    ...SDK_REQUEST_OPTIONS,
  });
};
