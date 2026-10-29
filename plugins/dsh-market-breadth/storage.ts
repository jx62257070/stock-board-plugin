/**
 * 插件 dsh-market-breadth（市场宽度）· 本地积累仓储（ctx.db）
 *
 * 两张插件表（物理名 `plugin_dsh_market_breadth_*`；Tauri 端 SQLite /
 * 浏览器端 JSON 表仿真，⚠️ 列声明只写业务列，id / created_at / updated_at 由宿主维护）：
 * - `minute_point`：分钟点，(date, time) 组合唯一（同分钟覆盖），按日滚存最近 3 日；
 * - `day_bar`：日 bar，date 唯一（upsert 幂等），滚存 250 日。
 *
 * 积累口径自宿主 `src/common/api/market-breadth-db.api.ts` 移植：
 * - 分钟点：每轮全市场快照 ingest 一点（同分钟去重），按日滚存最近 3 日；
 * - 日 bar：快照行情时间 ≥ 15:00 视为收盘定稿，用当日最后一个分钟点聚合
 *   upsert 落库（幂等）；周末/节假日打开页面时行情时间落在最近交易日，
 *   同样触发该日定稿，天然补齐断档。
 *
 * 历史迁移说明：宿主旧版把宽度数据存 appStorage（localStorage），本插件首版
 * 不做旧数据迁移——历史可由快照重新逐日积累（README 已写明）。
 */
import { ref } from 'vue';
import {
  BREADTH_BAR_CLOSE_MINUTE,
  BREADTH_BAR_KEEP_DAYS,
  BREADTH_BAR_TABLE,
  BREADTH_BAR_COLUMNS,
  BREADTH_DAY_SERIES_KEEP_DAYS,
  BREADTH_MINUTE_TABLE,
  BREADTH_MINUTE_COLUMNS,
  MINUTE_MS,
} from './constants';
import { appendBreadthPoint, computeMarketBreadth, toDayKey, toMinuteOfDay } from './compute-breadth';
import type { PluginDatabase, PluginDbRow } from '../../host/types/plugin.types';
import type { BreadthDayBar, BreadthPoint, BreadthRuntime, MarketBreadth } from './types';

/**
 * 库行 → 分钟点（脏数据兜底：数值列非有限数一律 0，arms 非法为 null）
 * @param row 库里的一行
 * @returns 分钟点
 */
const hydrateMinute = (row: PluginDbRow<Record<string, unknown>>): BreadthPoint => {
  const num = (key: string, fallback = 0): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const arms = row.arms;
  return {
    time: num('time'),
    upCount: num('up_count'),
    downCount: num('down_count'),
    flatCount: num('flat_count'),
    upVol: num('up_vol'),
    downVol: num('down_vol'),
    arms: typeof arms === 'number' && Number.isFinite(arms) ? arms : null,
    activeCount: num('active_count'),
    activeTotal: num('active_total'),
  };
};

/**
 * 库行 → 日 bar（兜底口径同分钟点）
 * @param row 库里的一行
 * @returns 日 bar
 */
const hydrateBar = (row: PluginDbRow<Record<string, unknown>>): BreadthDayBar => {
  const num = (key: string, fallback = 0): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const arms = row.arms;
  const date = row.date;
  return {
    date: typeof date === 'string' ? date : '',
    upCount: num('up_count'),
    downCount: num('down_count'),
    upVol: num('up_vol'),
    downVol: num('down_vol'),
    arms: typeof arms === 'number' && Number.isFinite(arms) ? arms : null,
    activeCount: num('active_count'),
    activeTotal: num('active_total'),
  };
};

/**
 * 市场宽度本地积累仓储（读口响应式，写口幂等 upsert）
 */
export interface BreadthRepo {
  /**
   * 当前快照（响应式读口；bars 日期升序、minutes 为 date → 升序点列）
   * @returns 日 bar 列表与分钟点按日映射
   */
  snapshot: () => {
    /** 日 bar 序列（日期升序） */
    bars: BreadthDayBar[];
    /** 分钟点按日映射（date → 升序点列） */
    minutes: Map<string, BreadthPoint[]>;
  };
  /**
   * 消化一轮全市场快照：计算宽度统计 + 积累分钟点 + 收盘定稿日 bar
   * @param runtime 取数运行时（拉全市场快照）
   * @returns 当轮市场宽度统计（供 UI 直接消费）；取数失败抛错由调用方兜底
   */
  ingest: (runtime: BreadthRuntime) => Promise<MarketBreadth>;
  /**
   * 从库重算某日的日 bar（用该日已存的分钟点末点覆盖 upsert；幂等）
   * @param date 本地日键 YYYY-MM-DD
   * @returns 是否写入了 bar（该日无分钟点或未到收盘时间为 false）
   */
  rebuildBar: (date: string) => Promise<boolean>;
}

/**
 * 判断一分钟点是否已收盘定稿（本地时区分钟数 ≥ 15:00）
 * @param point 分钟点
 * @returns 是否收盘定稿
 */
const isPointClosed = (point: BreadthPoint): boolean =>
  toMinuteOfDay(point.time) >= BREADTH_BAR_CLOSE_MINUTE;

/**
 * 建表并水合快照
 * @param db 插件通用数据库（`ctx.db`）
 * @returns 市场宽度仓储
 */
export const createBreadthRepo = async (db: PluginDatabase): Promise<BreadthRepo> => {
  await db.ensureTable(BREADTH_MINUTE_TABLE, BREADTH_MINUTE_COLUMNS);
  await db.ensureTable(BREADTH_BAR_TABLE, BREADTH_BAR_COLUMNS);

  /** 日 bar（响应式，日期升序） */
  const bars = ref<BreadthDayBar[]>([]);
  /** 分钟点按日映射（响应式，date → 升序点列） */
  const minutes = ref<Map<string, BreadthPoint[]>>(new Map());

  // ---------- 水合：读库即渲染，不联网 ----------

  const storedBars = await db.select<Record<string, unknown>>(BREADTH_BAR_TABLE, {
    orderBy: { column: 'date' },
  });
  bars.value = storedBars
    .map(hydrateBar)
    .filter((bar) => bar.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date));

  const storedMinutes = await db.select<Record<string, unknown>>(BREADTH_MINUTE_TABLE, {
    orderBy: { column: 'time' },
  });
  const minuteMap = new Map<string, BreadthPoint[]>();
  for (const row of storedMinutes.map(hydrateMinute)) {
    const rowDate = (row as unknown as { date?: unknown }).date;
    if (typeof rowDate !== 'string') continue;
    const bucket = minuteMap.get(rowDate);
    if (bucket) bucket.push(row);
    else minuteMap.set(rowDate, [row]);
  }
  minutes.value = minuteMap;

  /**
   * 分钟点行 upsert（同 (date, time) 已存在则更新）
   * @param date 本地日键
   * @param point 分钟点（time 已取整到分钟）
   */
  const upsertMinute = async (date: string, point: BreadthPoint): Promise<void> => {
    const existing = await db.select<Record<string, unknown>>(BREADTH_MINUTE_TABLE, {
      where: { date, time: point.time },
    });
    const record: Record<string, unknown> = {
      date,
      time: point.time,
      up_count: point.upCount,
      down_count: point.downCount,
      flat_count: point.flatCount,
      up_vol: point.upVol,
      down_vol: point.downVol,
      arms: point.arms,
      active_count: point.activeCount ?? null,
      active_total: point.activeTotal ?? null,
    };
    const first = existing[0];
    if (first !== undefined) {
      await db.update(BREADTH_MINUTE_TABLE, first.id, record);
    } else {
      await db.insert(BREADTH_MINUTE_TABLE, record);
    }
  };

  /**
   * 分钟点按日滚存：只保留最近 N 日（bar 落库后旧分时无用）
   * @param dayMap 当前全量映射
   */
  const pruneMinuteDays = async (dayMap: Map<string, BreadthPoint[]>): Promise<void> => {
    const dates = [...dayMap.keys()].sort();
    while (dates.length > BREADTH_DAY_SERIES_KEEP_DAYS) {
      const stale = dates.shift();
      if (stale === undefined) break;
      dayMap.delete(stale);
      const rows = await db.select<Record<string, unknown>>(BREADTH_MINUTE_TABLE, {
        where: { date: stale },
      });
      for (const row of rows) await db.remove(BREADTH_MINUTE_TABLE, row.id);
    }
  };

  /**
   * 日 bar upsert（同 date 已存在则更新，幂等）+ 滚存 250 日
   * @param bar 日 bar
   */
  const upsertBar = async (bar: BreadthDayBar): Promise<void> => {
    const existing = await db.select<Record<string, unknown>>(BREADTH_BAR_TABLE, {
      where: { date: bar.date },
    });
    const record: Record<string, unknown> = {
      date: bar.date,
      up_count: bar.upCount,
      down_count: bar.downCount,
      up_vol: bar.upVol,
      down_vol: bar.downVol,
      arms: bar.arms,
      active_count: bar.activeCount ?? null,
      active_total: bar.activeTotal ?? null,
    };
    const first = existing[0];
    if (first !== undefined) await db.update(BREADTH_BAR_TABLE, first.id, record);
    else await db.insert(BREADTH_BAR_TABLE, record);

    const index = bars.value.findIndex((item) => item.date === bar.date);
    if (index >= 0) bars.value[index] = bar;
    else bars.value = [...bars.value, bar].sort((a, b) => a.date.localeCompare(b.date));

    if (bars.value.length > BREADTH_BAR_KEEP_DAYS) {
      const stale = bars.value.slice(0, bars.value.length - BREADTH_BAR_KEEP_DAYS);
      bars.value = bars.value.slice(-BREADTH_BAR_KEEP_DAYS);
      for (const item of stale) {
        const row = await db.select<Record<string, unknown>>(BREADTH_BAR_TABLE, {
          where: { date: item.date },
        });
        const firstRow = row[0];
        if (firstRow !== undefined) await db.remove(BREADTH_BAR_TABLE, firstRow.id);
      }
    }
  };

  return {
    snapshot: () => ({ bars: bars.value, minutes: minutes.value }),

    ingest: async (runtime: BreadthRuntime): Promise<MarketBreadth> => {
      const quotes = await runtime.fetchAllQuotes();
      const breadth = computeMarketBreadth(quotes);

      // 行情时间取快照最大时间戳（缺省回退当前时间）
      let quoteTs = 0;
      for (const quote of quotes) {
        if (quote.timestamp !== null && quote.timestamp > quoteTs) quoteTs = quote.timestamp;
      }
      if (quoteTs === 0) quoteTs = Date.now();
      const quoteDay = toDayKey(quoteTs);
      const today = toDayKey(Date.now());

      const dayMap = new Map(minutes.value);
      if (quoteDay === today) {
        const point: BreadthPoint = {
          time: Math.floor(quoteTs / MINUTE_MS) * MINUTE_MS,
          upCount: breadth.upCount,
          downCount: breadth.downCount,
          flatCount: breadth.flatCount,
          upVol: breadth.upVol,
          downVol: breadth.downVol,
          arms: breadth.arms,
          activeCount: breadth.activeCount,
          activeTotal: breadth.activeTotal,
        };
        dayMap.set(today, appendBreadthPoint(dayMap.get(today) ?? [], point));
        await pruneMinuteDays(dayMap);
        minutes.value = dayMap;
        await upsertMinute(today, point);
      }

      // 收盘定稿：所有已存日期里「最后一点 ≥ 15:00」的都 upsert 日 bar（幂等）
      for (const [date, points] of dayMap) {
        const last = points.at(-1);
        if (!last || !isPointClosed(last)) continue;
        await upsertBar({
          date,
          upCount: last.upCount,
          downCount: last.downCount,
          upVol: last.upVol,
          downVol: last.downVol,
          arms: last.arms,
          activeCount: last.activeCount,
          activeTotal: last.activeTotal,
        });
      }
      return breadth;
    },

    rebuildBar: async (date: string): Promise<boolean> => {
      const points = minutes.value.get(date) ?? [];
      const last = points.at(-1);
      if (!last || !isPointClosed(last)) return false;
      await upsertBar({
        date,
        upCount: last.upCount,
        downCount: last.downCount,
        upVol: last.upVol,
        downVol: last.downVol,
        arms: last.arms,
        activeCount: last.activeCount,
        activeTotal: last.activeTotal,
      });
      return true;
    },
  };
};
