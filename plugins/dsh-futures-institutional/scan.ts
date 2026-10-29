/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 历史同步编排
 *
 * 一次性同步任务（用户点击「同步历史」触发，非轮询 —— 形态参照 dsh-mainline）：
 * 对每个品种从今天起向前回溯 N 个自然日，逐日拉取 CCPM CSV 并落 ctx.db
 * （正缓存定稿数据 / 负缓存探测落空），重启后回看历史不再回源。
 *
 * 频率红线：同一上游并发 ≤ CCPM_FETCH_CONCURRENCY（3），请求间 ≥ 500ms 错峰
 * （错峰在 data.ts 的 throttle 里按「距上次触达上游」补足，这里只用并发限制）。
 */
import dayjs from 'dayjs';
import {
  CCPM_FETCH_CONCURRENCY,
  CCPM_PRODUCTS,
  CCPM_SYNC_HISTORY_DAYS,
} from './constants';
import { mapWithConcurrency } from './concurrency';
import type { FuturesRepo } from './storage';
import type { FuturesDataApi } from './data';
import type { FuturesDeps } from './types';
import type { CcpmProductCode } from './constants';

/** 同步进度回调载荷 */
export interface FuturesSyncProgress {
  /** 已完成品种数 */
  done: number;
  /** 品种总数 */
  total: number;
  /** 当前品种代码 */
  product: string;
}

/** 同步结果 */
export interface FuturesSyncResult {
  /** 落库有数据的（品种, 交易日）数 */
  hitDays: number;
  /** 落库负缓存的（品种, 交易日）数 */
  missDays: number;
  /** 同步的品种列表 */
  products: readonly string[];
  /** 回溯自然日数 */
  days: number;
}

/**
 * 生成回溯自然日序列（含今天，向前 days 天）
 * @param days 回溯自然日数
 * @returns yyyyMMdd 列表（今天在前）
 */
const buildProbeDays = (days: number): string[] => {
  const today = dayjs().format('YYYYMMDD');
  const list: string[] = [];
  let cursor = dayjs(today, 'YYYYMMDD');
  for (let i = 0; i < days; i += 1) {
    list.push(cursor.format('YYYYMMDD'));
    cursor = cursor.subtract(1, 'day');
  }
  return list;
};

/**
 * 执行一次历史同步（用户点击触发；重复点击由调用方防重入）
 * @param repo 本地快照仓储
 * @param data 取数器
 * @param deps 宿主能力依赖（进度提醒用 notify，可缺席）
 * @param onProgress 进度回调（可选）
 * @param days 回溯自然日数（默认 CCPM_SYNC_HISTORY_DAYS）
 * @returns 同步结果摘要
 */
export const syncHistory = async (
  repo: FuturesRepo,
  data: FuturesDataApi,
  deps: FuturesDeps,
  onProgress?: (progress: FuturesSyncProgress) => void,
  days = CCPM_SYNC_HISTORY_DAYS,
): Promise<FuturesSyncResult> => {
  const probeDays = buildProbeDays(days);
  const products = CCPM_PRODUCTS.map((item) => item.code) as readonly CcpmProductCode[];
  let done = 0;
  let hitDays = 0;
  let missDays = 0;

  await mapWithConcurrency(
    products,
    async (product) => {
      for (const day of probeDays) {
        // fetchProductDay 自带两级缓存：库里已有的日直接命中，只回源缺失日
        const result = await data.fetchProductDay(product, day);
        if (result !== null) {
          hitDays += 1;
        } else {
          missDays += 1;
        }
      }
      done += 1;
      onProgress?.({ done, total: products.length, product });
    },
    { concurrency: CCPM_FETCH_CONCURRENCY },
  );

  const meta = { at: Date.now(), days, products };
  await repo.writeSyncMeta(meta).catch(() => undefined);
  deps.notify?.notify({
    title: '历史同步完成',
    body: `${products.length} 个品种回溯 ${days} 天，命中披露日 ${hitDays} 个`,
    tone: 'flat',
  });
  return { hitDays, missDays, products, days };
};
