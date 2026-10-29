/**
 * 插件 dsh-history-review · 本地仓储
 *
 * 快照持久化在插件 `ctx.storage`（`plugin:dsh-history-review` 命名空间的
 * `review-snapshot` 键，指数月 K 序列整体存 JSON，3 只宽基指数约百余 KB）：
 * 挂载时读一次水合成响应式快照，同步落库后写回 —— 重进页面零联网。
 * （宿主内置时代曾落 appStorage `panorama.review`，转插件后为独立命名空间，
 * 旧键成为孤儿数据无害；插件重装数据保留。）
 */
import { ref } from 'vue';
import { HISTORY_REVIEW_SNAPSHOT_KEY } from './constants';
import type { PluginStorage } from '../../host/types/plugin.types';
import { BULL_INDEX_LIST } from './constants';
import type { MonthlyBar, ReviewSyncMeta } from './types';

/** 插件 storage 里的快照结构（整体读写） */
interface ReviewSnapshotPayload {
  /** symbol → 月 K 序列（升序） */
  series: Record<string, MonthlyBar[]>;
  /** 最近一次完整同步时间（毫秒时间戳；从未同步为 null） */
  syncedAt: number | null;
}

/** 历史复盘行情仓储 */
export interface ReviewRepo {
  /**
   * 读当前快照（响应式；同步落库后自动更新）
   * @returns 各指数月 K 与最近同步时间（从未同步时 syncedAt 为 null）
   */
  snapshot: () => { series: Record<string, MonthlyBar[]>; syncedAt: number | null };
  /**
   * 落库一次同步结果（写插件 storage 并刷新内存快照）
   * @param series symbol → 月 K 序列
   * @param meta 同步元信息
   */
  saveSync: (series: Record<string, MonthlyBar[]>, meta: ReviewSyncMeta) => Promise<void>;
}

const EMPTY_PAYLOAD: ReviewSnapshotPayload = { series: {}, syncedAt: null };

/**
 * 从插件 storage 读快照（脏数据一律过滤成空快照）
 * @param storage 插件存储句柄
 * @returns 快照载荷
 */
const loadPayload = (storage: PluginStorage): ReviewSnapshotPayload => {
  const parsed = storage.get<Partial<ReviewSnapshotPayload>>(
    HISTORY_REVIEW_SNAPSHOT_KEY,
    EMPTY_PAYLOAD,
  );
  if (!parsed || typeof parsed !== 'object') return EMPTY_PAYLOAD;
  const series: Record<string, MonthlyBar[]> = {};
  for (const [symbol, bars] of Object.entries(parsed.series ?? {})) {
    if (!Array.isArray(bars)) continue;
    const clean = bars.filter(
      (bar): bar is MonthlyBar =>
        typeof bar === 'object' &&
        bar !== null &&
        typeof (bar as { month?: unknown }).month === 'string' &&
        Number.isFinite((bar as { close?: unknown }).close),
    );
    if (clean.length > 0) series[symbol] = clean;
  }
  return {
    series,
    syncedAt: typeof parsed.syncedAt === 'number' ? parsed.syncedAt : null,
  };
};

/**
 * 创建历史复盘行情仓储（挂载时水合一次）
 * @param storage 插件存储句柄（ctx.storage）
 * @returns 响应式快照仓储
 */
export const createReviewRepo = (storage: PluginStorage): ReviewRepo => {
  const payload = loadPayload(storage);
  const series = ref<Record<string, MonthlyBar[]>>(payload.series);
  const syncedAt = ref<number | null>(payload.syncedAt);

  return {
    snapshot: () => ({ series: series.value, syncedAt: syncedAt.value }),

    saveSync: async (nextSeries, meta): Promise<void> => {
      // 已知指数才落库：防止上游多返回未知符号时撑爆存储
      const clean: Record<string, MonthlyBar[]> = {};
      for (const symbol of BULL_INDEX_LIST) {
        const bars = nextSeries[symbol.symbol];
        if (!Array.isArray(bars) || bars.length === 0) continue;
        clean[symbol.symbol] = bars;
      }
      series.value = clean;
      syncedAt.value = meta.syncedAt;
      storage.set(HISTORY_REVIEW_SNAPSHOT_KEY, {
        series: clean,
        syncedAt: meta.syncedAt,
      } satisfies ReviewSnapshotPayload);
    },
  };
};
