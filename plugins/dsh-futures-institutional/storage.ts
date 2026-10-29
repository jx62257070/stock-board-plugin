/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 本地快照仓储（ctx.db）
 *
 * 两张插件表（物理表 `plugin_dsh_futures_institutional_*`；Tauri 端 SQLite /
 * 浏览器端 appStorage JSON 仿真，插件永不写 SQL）：
 * - `ccpm_day_cache`：每【品种 × 披露日】一行，品种单日数据整体存 `json` 列 ——
 *   语义沿用宿主 `ccpm_day_cache` 表（V9 迁移）缓存口径：正缓存（has_data=1）
 *   披露日定稿数据永久有效；负缓存（has_data=0）非披露日探测落空，按 TTL 过期。
 *   ⚠️ 宿主旧表数据**不做迁移**（中金所历史文件可重取，首版挂载后用户点
 *   「同步历史」重新回填，见 README）。
 * - `sync_meta`：键值行，存最近一次历史同步的范围与时刻。
 */
import { CCPM_CACHE_TTL_MS } from './constants';
import type { PluginDatabase, PluginDbColumn, PluginDbRow } from '../../host/types/plugin.types';
import type { CcpmProductDayData } from './types';

/** 品种单日缓存表名（物理表 `plugin_<id>_ccpm_day_cache`） */
export const CCPM_DAY_TABLE = 'ccpm_day_cache';

/** 同步元信息表名（物理表 `plugin_<id>_sync_meta`） */
export const SYNC_META_TABLE = 'sync_meta';

/** 同步元信息键：最近一次历史同步 */
export const SYNC_META_KEY = 'last_sync';

/**
 * 品种单日缓存表的列声明
 *
 * ⚠️ 只声明业务列：`id` / `created_at` / `updated_at` 由宿主固定追加并自动维护，
 * 插件重复声明会导致建表语句出现同名列（宿主 toColumnMap 拒绝并报错）。
 */
export const CCPM_DAY_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'product', type: 'text', indexed: true },
  { name: 'trading_day', type: 'text', indexed: true },
  { name: 'has_data', type: 'integer' },
  { name: 'data_json', type: 'json' },
  { name: 'fetched_at', type: 'integer' },
];

/** 同步元信息表的列声明（键值行） */
export const SYNC_META_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'meta_key', type: 'text', indexed: true },
  { name: 'meta_value', type: 'json' },
];

/** 库内一条品种单日缓存（data 为 null 时即负缓存） */
export interface CcpmDayCacheRecord {
  /** 品种代码 */
  product: string;
  /** 交易日 yyyyMMdd */
  tradingDay: string;
  /** 拉取结果（null = 已知无披露数据） */
  data: CcpmProductDayData | null;
  /** 写入时刻（毫秒时间戳） */
  fetchedAt: number;
}

/** 最近一次历史同步元信息 */
export interface FuturesSyncMeta {
  /** 同步完成的时刻（毫秒时间戳） */
  at: number;
  /** 本次回溯的披露日数 */
  days: number;
  /** 参与回填的品种列表 */
  products: readonly string[];
}

/** 品种单日缓存表的一行（库内形态） */
interface DayRow extends Record<string, unknown> {
  /** 品种代码 */
  product: string;
  /** 交易日 yyyyMMdd */
  trading_day: string;
  /** 1 = 有数据，0 = 负缓存 */
  has_data: number;
  /** 品种单日数据（json 列；负缓存为 null） */
  data_json: CcpmProductDayData | null;
  /** 写入时刻 */
  fetched_at: number;
}

/** 元信息表的一行 */
interface MetaRow extends Record<string, unknown> {
  /** 键 */
  meta_key: string;
  /** 值（json 列） */
  meta_value: unknown;
}

/** 本地快照仓储（ctx.db 之上的类型化门面） */
export interface FuturesRepo {
  /**
   * 读一条品种单日缓存
   * @param product 品种代码
   * @param day 交易日 yyyyMMdd
   * @returns 缓存记录；无记录返回 null
   */
  readDay: (product: string, day: string) => Promise<CcpmDayCacheRecord | null>;
  /**
   * 写入（upsert）一条品种单日缓存
   * @param record product + tradingDay + data（null = 负缓存）
   */
  writeDay: (record: CcpmDayCacheRecord) => Promise<void>;
  /**
   * 读某品种最近 N 个交易日的缓存行（按交易日降序）
   * @param product 品种代码
   * @param limit 返回条数上限
   * @returns 缓存记录列表（交易日降序；含负缓存行，调用方按 hasData 过滤）
   */
  readRecentDays: (product: string, limit: number) => Promise<CcpmDayCacheRecord[]>;
  /**
   * 读最近一次历史同步元信息
   * @returns 元信息；从未同步过返回 null
   */
  readSyncMeta: () => Promise<FuturesSyncMeta | null>;
  /**
   * 写最近一次历史同步元信息（upsert）
   * @param meta 元信息
   */
  writeSyncMeta: (meta: FuturesSyncMeta) => Promise<void>;
}

/**
 * 判断负缓存是否仍在 TTL 内（正缓存永久有效，负缓存过期需重新探测）
 * @param record 缓存记录
 * @returns 是否可用（正缓存恒可用；负缓存 TTL 内可用）
 */
const isCacheUsable = (record: CcpmDayCacheRecord): boolean =>
  record.data !== null || Date.now() - record.fetchedAt < CCPM_CACHE_TTL_MS;

/**
 * 把库行还原成缓存记录（损坏 json 按未缓存处理）
 * @param row 库行
 * @returns 缓存记录
 */
const toRecord = (row: PluginDbRow<DayRow>): CcpmDayCacheRecord => {
  const hasData = Number(row.has_data) === 1;
  let data: CcpmProductDayData | null = null;
  if (hasData && row.data_json && typeof row.data_json === 'object') {
    data = row.data_json;
  }
  return {
    product: String(row.product),
    tradingDay: String(row.trading_day),
    data,
    fetchedAt: Number(row.fetched_at) || 0,
  };
};

/**
 * 创建本地快照仓储（建表幂等，挂载时调用一次）
 * @param db 插件通用数据库（ctx.db）
 * @returns 仓储实例
 */
export const createFuturesRepo = async (db: PluginDatabase): Promise<FuturesRepo> => {
  await db.ensureTable(CCPM_DAY_TABLE, CCPM_DAY_COLUMNS);
  await db.ensureTable(SYNC_META_TABLE, SYNC_META_COLUMNS);

  const repo: FuturesRepo = {
    async readDay(product, day) {
      const rows = await db.select<DayRow>(CCPM_DAY_TABLE, {
        where: { product, trading_day: day },
        limit: 1,
      });
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async writeDay(record) {
      const rows = await db.select<DayRow>(CCPM_DAY_TABLE, {
        where: { product: record.product, trading_day: record.tradingDay },
        limit: 1,
      });
      const payload: Record<string, unknown> = {
        has_data: record.data === null ? 0 : 1,
        data_json: record.data,
        fetched_at: record.fetchedAt,
      };
      if (rows[0]) {
        await db.update(CCPM_DAY_TABLE, rows[0].id, payload);
      } else {
        await db.insert(CCPM_DAY_TABLE, {
          product: record.product,
          trading_day: record.tradingDay,
          ...payload,
        });
      }
    },

    async readRecentDays(product, limit) {
      const rows = await db.select<DayRow>(CCPM_DAY_TABLE, {
        where: { product },
        orderBy: { column: 'trading_day', desc: true },
        limit,
      });
      return rows.map(toRecord).filter(isCacheUsable);
    },

    async readSyncMeta() {
      const rows = await db.select<MetaRow>(SYNC_META_TABLE, {
        where: { meta_key: SYNC_META_KEY },
        limit: 1,
      });
      const value = rows[0]?.meta_value;
      if (!value || typeof value !== 'object') {
        return null;
      }
      const meta = value as Partial<FuturesSyncMeta>;
      if (typeof meta.at !== 'number' || typeof meta.days !== 'number' || !Array.isArray(meta.products)) {
        return null;
      }
      return { at: meta.at, days: meta.days, products: meta.products };
    },

    async writeSyncMeta(meta) {
      const rows = await db.select<MetaRow>(SYNC_META_TABLE, {
        where: { meta_key: SYNC_META_KEY },
        limit: 1,
      });
      if (rows[0]) {
        await db.update(SYNC_META_TABLE, rows[0].id, { meta_value: meta });
      } else {
        await db.insert(SYNC_META_TABLE, { meta_key: SYNC_META_KEY, meta_value: meta });
      }
    },
  };

  return repo;
};
