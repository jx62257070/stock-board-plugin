/**
 * 插件 dsh-history-review · 新浪指数月K取数
 *
 * 复用宿主已验证的新浪 K 线源（quotes.sina.cn，免 Token）：`monthly` 周期一次拿到
 * 上游全部月 K 历史（实测 `sh000001` 覆盖 1990-12 至今，datalen=1000 未触顶）。
 * ⚠️ 不用 stock-sdk 的东财 K 线：东财行情域本机封禁（宿主 SERVER_API.md 红线）。
 * 网络走宿主 `app:http` 受控通道（Tauri 由 Rust 直连、浏览器走 /stock-proxy，
 * `sina.cn` 在宿主白名单内），请求自带新浪上游要求的 Referer。
 */
import dayjs from 'dayjs';
import type { HttpService } from '../../host/types/plugin.types';
import type { MonthlyBar } from './types';

/** 新浪上游要求的 Referer（缺失返回 403；Tauri 直连时必须自带） */
const SINA_REFERER = 'https://finance.sina.com.cn';

/** 月 K 的 scale 周期分钟数 */
const MONTHLY_SCALE = 7200;

/** 月 K 请求根数（一次拿上游全历史） */
const MONTHLY_DATALEN = 1000;

/** 新浪 K 线原始记录（数值均为字符串） */
interface SinaKlineRaw {
  /** 月K 为 YYYY-MM-DD */
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * 解析新浪 JSONP 文本：剥离首行注释、`var _=(` 前缀与尾部 `);`
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
 * 构造指数月K取数函数（绑定宿主网络通道）
 * @param http 宿主受控网络请求服务
 * @returns 拉取单只指数全部月 K 的函数（升序；脏数据已过滤）
 */
export const createIndexMonthlyFetcher = (
  http: HttpService,
): ((symbol: string) => Promise<MonthlyBar[]>) => {
  /**
   * 拉取单只指数的全部月 K（升序）
   * @param symbol 指数符号（新浪形态，如 `sh000001`）
   * @returns 月 K 序列（升序；脏数据已过滤）
   */
  return async (symbol: string): Promise<MonthlyBar[]> => {
    const url =
      `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=` +
      `/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${MONTHLY_SCALE}&ma=no&datalen=${MONTHLY_DATALEN}`;
    const response = await http.fetch(url, { headers: { Referer: SINA_REFERER } });
    if (!response.ok) {
      throw new Error(`新浪 K 线请求失败：${response.status}`);
    }
    return parseJsonp(await response.text())
      .map((raw) => ({
        // 空格为本地时区解析，与 A 股交易日口径一致
        month: dayjs(raw.day.replace(/-/g, '/')).format('YYYY-MM'),
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
      }))
      .filter(
        (bar) =>
          bar.month !== 'Invalid Date' && Number.isFinite(bar.close) && bar.close > 0,
      );
  };
};
