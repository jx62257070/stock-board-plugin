/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 取数层
 *
 * 从宿主 `src/common/api/futures-ccpm.api.ts` 移植，两处适配：
 * - 网络走 `ctx.consume('app:http')`（Tauri 直连 / 浏览器 /stock-proxy，白名单已含
 *   cffex.com.cn；上游仅 HTTP 无 HTTPS）；持久缓存走 ctx.db（storage.ts），不再碰宿主 SQLite；
 * - 日期用 dayjs（构建产物内联，宿主同款依赖）。
 *
 * 上游：`http://www.cffex.com.cn/sj/ccpm/{yyyymm}/{dd}/{product}_1.csv`（GBK 编码，
 * 静态文件，非披露日 302 到错误页）。响应体按原始字节读入后 TextDecoder('gbk')
 * 解码——任何按 UTF-8 的解码都会中文乱码。
 */
import dayjs from 'dayjs';
import {
  CCPM_CACHE_TTL_MS,
  CCPM_CSV_URL_TEMPLATE,
  CCPM_FETCH_CONCURRENCY,
  CCPM_FETCH_DELAY_MS,
  CCPM_SERIES_DAYS,
  CCPM_SERIES_MAX_PROBE_DAYS,
} from './constants';
import { mapWithConcurrency } from './concurrency';
import { parseCcpmCsv } from './parse';
import { aggregateCcpmByMember } from './compute';
import type { FuturesRepo } from './storage';
import type { FuturesDeps } from './types';
import type { CcpmMemberDayPoint, CcpmMemberSeries, CcpmProductDayData } from './types';

/** 会话内缓存条目（TTL 内直接命中，避免重复拉同一披露文件） */
interface CcpmCacheEntry {
  /** 写入时刻（毫秒时间戳） */
  at: number;
  /** 拉取结果（null = 非披露日 / 无数据，负缓存同样生效） */
  data: CcpmProductDayData | null;
}

/**
 * 取数器（持有 repo + deps 的闭包门面；页面与 MCP 工具共用）
 */
export interface FuturesDataApi {
  /**
   * 拉取某品种某披露日的 CCPM 数据（会话缓存 + ctx.db 持久缓存两级）
   * @param product 品种代码（IF / IH / IC / IM / T / TF / TS / TL）
   * @param day 交易日 yyyyMMdd
   * @param forceRefresh 跳过缓存强制回源（手动刷新用）
   * @returns 品种单日数据；非披露日 / 上游异常返回 null
   */
  fetchProductDay: (product: string, day: string, forceRefresh?: boolean) => Promise<CcpmProductDayData | null>;
  /**
   * 从某天起向前探测最近一个有披露的交易日（跳过周末；节假日按无数据自然跳过）
   * @param product 品种代码
   * @param fromDay 起始日 yyyyMMdd（含当天）
   * @param maxProbeDays 最多向前探测的自然日数
   * @returns 最近披露日及其数据；窗口内全无数据时返回 null
   */
  findLatestDay: (
    product: string,
    fromDay: string,
    maxProbeDays?: number,
  ) => Promise<{ day: string; data: CcpmProductDayData } | null>;
  /**
   * 席位合并净持仓时序：回看近 N 个披露日，逐日按会员聚合
   * @param memberName 席位（会员）名称
   * @param products 参与聚合的品种列表
   * @param endDay 锚点交易日 yyyyMMdd（含）
   * @param days 回看披露日数量
   * @returns 时序数据（点列按交易日升序）
   */
  fetchMemberSeries: (
    memberName: string,
    products: readonly string[],
    endDay: string,
    days?: number,
  ) => Promise<CcpmMemberSeries>;
}

/** 会话内数据缓存（key = product|yyyyMMdd；模块级，同会话共享） */
const dayCache = new Map<string, CcpmCacheEntry>();

/**
 * 构造上游 CSV 地址
 * @param product 品种代码
 * @param day 交易日 yyyyMMdd
 * @returns 完整 URL
 */
const buildCcpmUrl = (product: string, day: string): string =>
  CCPM_CSV_URL_TEMPLATE.replace('{yyyymm}', day.slice(0, 6)).replace('{dd}', day.slice(6, 8))
    .replace('{product}', product);

/**
 * 创建取数器
 * @param repo 本地快照仓储（ctx.db）
 * @param deps 宿主能力依赖（app:http / app:format）
 * @returns 取数器
 */
export const createFuturesDataApi = (repo: FuturesRepo, deps: FuturesDeps): FuturesDataApi => {
/** 上次真正触达上游的时刻（毫秒时间戳；闭包内共享，保证请求间错峰） */
let lastNetworkAt = 0;

/**
 * 上游错峰：距上次触达上游不足 CCPM_FETCH_DELAY_MS 时补足间隔
 */
const throttle = async (): Promise<void> => {
  const gap = Date.now() - lastNetworkAt;
  if (gap < CCPM_FETCH_DELAY_MS) {
    await deps.format.delay(CCPM_FETCH_DELAY_MS - gap);
  }
  lastNetworkAt = Date.now();
};

  /**
   * 读 ctx.db 持久缓存并判定是否可用（正缓存永久有效，负缓存按 TTL 过期）
   * @param product 品种代码
   * @param day 交易日 yyyyMMdd
   * @returns 可用缓存数据；null = 无可用缓存（回源）；undefined = 无记录
   */
  const readPersistentCache = async (
    product: string,
    day: string,
  ): Promise<CcpmProductDayData | null | undefined> => {
    const record = await repo.readDay(product, day).catch(() => null);
    if (!record) {
      return undefined;
    }
    if (record.data !== null) {
      return record.data;
    }
    return Date.now() - record.fetchedAt < CCPM_CACHE_TTL_MS ? null : undefined;
  };

  const fetchProductDay = async (
    product: string,
    day: string,
    forceRefresh = false,
  ): Promise<CcpmProductDayData | null> => {
    const cacheKey = `${product}|${day}`;
    const cached = dayCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.at < CCPM_CACHE_TTL_MS) {
      return cached.data;
    }

    if (!forceRefresh) {
      const persisted = await readPersistentCache(product, day);
      if (persisted !== undefined) {
        dayCache.set(cacheKey, { at: Date.now(), data: persisted });
        return persisted;
      }
    }

    let data: CcpmProductDayData | null = null;
    // 是否真正触达上游（区分「上游明确无披露」可落负缓存 与 「网络异常」不可落库）
    let reached = false;
    try {
      await throttle();
      const response = await deps.http.fetch(buildCcpmUrl(product, day), {
        headers: { Accept: 'text/csv,*/*' },
      });
      reached = true;
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buffer);
        data = parseCcpmCsv(text, product);
      }
    } catch {
      // 网络 / 上游异常按「无数据」处理，由调用方走空态 + 重试
      data = null;
    }

    const at = Date.now();
    dayCache.set(cacheKey, { at, data });
    // 写透持久层：仅触达上游的结果才落库（网络异常不污染负缓存）
    if (reached) {
      void repo
        .writeDay({ product, tradingDay: day, data, fetchedAt: at })
        .catch(() => undefined);
    }
    return data;
  };

  const findLatestDay = async (
    product: string,
    fromDay: string,
    maxProbeDays = CCPM_SERIES_MAX_PROBE_DAYS,
  ): Promise<{ day: string; data: CcpmProductDayData } | null> => {
    let cursor = dayjs(fromDay, 'YYYYMMDD');
    for (let i = 0; i < maxProbeDays; i += 1) {
      const day = cursor.format('YYYYMMDD');
      const data = await fetchProductDay(product, day);
      if (data) {
        return { day, data };
      }
      cursor = cursor.subtract(1, 'day');
    }
    return null;
  };

  const fetchMemberSeries = async (
    memberName: string,
    products: readonly string[],
    endDay: string,
    days = CCPM_SERIES_DAYS,
  ): Promise<CcpmMemberSeries> => {
    // 以第一个品种为日历锚点探测披露日序列（各品种披露日历一致）
    const anchor = await findLatestDay(products[0] ?? 'IF', endDay);
    if (!anchor) {
      return { memberName, products, points: [] };
    }

    // 从锚点继续向前收齐 days 个披露日（同一次探测循环，复用已拉数据）
    const dayList: string[] = [anchor.day];
    let cursor = dayjs(anchor.day, 'YYYYMMDD').subtract(1, 'day');
    let probed = 1;
    while (dayList.length < days && probed < CCPM_SERIES_MAX_PROBE_DAYS) {
      const day = cursor.format('YYYYMMDD');
      const data = await fetchProductDay(products[0] ?? 'IF', day);
      if (data) {
        dayList.push(day);
      }
      cursor = cursor.subtract(1, 'day');
      probed += 1;
    }

    // 逐披露日 × 逐品种拉取后按会员聚合（并发受限 + 错峰，避免对上游突发压力）
    const perDay = await mapWithConcurrency(
      dayList,
      async (day) => {
        const dayDataList = await mapWithConcurrency(
          products,
          (product) => fetchProductDay(product, day),
          { concurrency: CCPM_FETCH_CONCURRENCY },
        );
        const valid = dayDataList.filter((item): item is CcpmProductDayData => item !== null);
        const aggregated = aggregateCcpmByMember(valid, memberName);
        const point: CcpmMemberDayPoint | null = aggregated[0]
          ? {
              tradingDay: day,
              totalBuy: aggregated[0].totalBuy,
              totalSell: aggregated[0].totalSell,
              totalNet: aggregated[0].totalNet,
              totalNetChg: aggregated[0].totalNetChg,
              coveredCount: aggregated[0].coveredCount,
              totalCount: aggregated[0].totalCount,
            }
          : null;
        return point;
      },
      { concurrency: CCPM_FETCH_CONCURRENCY },
    );

    const points = perDay
      .filter((point): point is CcpmMemberDayPoint => point !== null)
      .sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
    return { memberName, products, points };
  };

  return { fetchProductDay, findLatestDay, fetchMemberSeries };
};
