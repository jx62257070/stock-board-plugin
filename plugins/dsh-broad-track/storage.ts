/**
 * 插件 dsh-broad-track（宽基跟踪）· 本地快照仓储
 *
 * 四张表（插件独立表，物理名 `plugin_dsh_broad_track_*`；Tauri 端 SQLite /
 * 浏览器端 JSON 表仿真）：
 * - `etf_daily`：一只 ETF 一个交易日一行（资金流五路 + 行情），
 *   **唯一键（date, code）**，刷新时按日 upsert；
 * - `etf_quarter`：一只 ETF 一个报告期一行（份额申赎），唯一键（code, period_end）；
 * - `etf_holders`：一只 ETF 一期持有人结构，唯一键（code, period_end）；
 * - `anchor`：键值行，存国家队持仓锚点清单（`AnchorHolding[]` 的 JSON）；
 * - `scan_meta`：键值行，存刷新元信息（时间戳 / 告警 / 指数快照）。
 *
 * 语义：日频表只追加最近 FFLOW_DAYS 天（窗口滚动，旧行保留但界面只读窗口内的），
 * 季度 / 持有人 / 锚点都是 upsert（上游改数后同步即覆盖）。
 * 读库即渲染整页，重进页面零联网（频率纪律：重接口只在用户点击时触发）。
 *
 * ⚠️ 列声明只写业务列：`id` / `created_at` / `updated_at` 由宿主自动维护，
 * 插件重复声明会让建表语句出现同名列（SQLite 报 duplicate column name）。
 */
import { ref } from 'vue';
import type {
  AnchorHolding,
  BroadMeta,
  BroadSnapshot,
  EtfDailyRow,
  EtfHolderRow,
  EtfQuarterRow,
} from './types';
import type { PluginDatabase, PluginDbColumn, PluginDbRow } from '../../host/types/plugin.types';

/** 日频表名（物理表 `plugin_dsh_broad_track_etf_daily`） */
export const BROAD_DAILY_TABLE = 'etf_daily';

/** 季度份额表名 */
export const BROAD_QUARTER_TABLE = 'etf_quarter';

/** 持有人结构表名 */
export const BROAD_HOLDERS_TABLE = 'etf_holders';

/** 锚点表名 */
export const BROAD_ANCHOR_TABLE = 'anchor';

/** 元信息表名 */
export const BROAD_META_TABLE = 'scan_meta';

/** 元信息在表里的键 */
export const BROAD_META_KEY = 'broad_meta';

/** 锚点在表里的键 */
export const BROAD_ANCHOR_KEY = 'anchor_holdings';

/** 日频表的列声明（date + code 组合唯一；资金流五路全存） */
export const BROAD_DAILY_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'date', type: 'text', indexed: true },
  { name: 'code', type: 'text', indexed: true },
  { name: 'price', type: 'real' },
  { name: 'change_percent', type: 'real' },
  { name: 'amount', type: 'real' },
  { name: 'main_inflow', type: 'real' },
  { name: 'super_inflow', type: 'real' },
  { name: 'big_inflow', type: 'real' },
  { name: 'mid_inflow', type: 'real' },
  { name: 'small_inflow', type: 'real' },
];

/** 季度份额表的列声明 */
export const BROAD_QUARTER_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'code', type: 'text', indexed: true },
  { name: 'period_end', type: 'text', indexed: true },
  { name: 'subscribe_yi', type: 'real' },
  { name: 'redeem_yi', type: 'real' },
  { name: 'shares_end_yi', type: 'real' },
  { name: 'net_asset_yi', type: 'real' },
  { name: 'asset_change_rate', type: 'real' },
];

/** 持有人结构表的列声明 */
export const BROAD_HOLDERS_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'code', type: 'text', indexed: true },
  { name: 'period_end', type: 'text', indexed: true },
  { name: 'inst_ratio', type: 'real' },
  { name: 'total_shares_yi', type: 'real' },
];

/** 锚点表的列声明（键值行；value 存 `AnchorHolding[]` 的 JSON） */
export const BROAD_ANCHOR_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'anchor_key', type: 'text', indexed: true },
  { name: 'anchor_value', type: 'json' },
];

/** 元信息表的列声明（键值行） */
export const BROAD_META_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'meta_key', type: 'text', indexed: true },
  { name: 'meta_value', type: 'json' },
];

/** 锚点表的一行 */
interface AnchorRow extends Record<string, unknown> {
  /** 键 */
  anchor_key: string;
  /** 值（json 列） */
  anchor_value: unknown;
}

/** 元信息表的一行 */
interface MetaRow extends Record<string, unknown> {
  /** 键 */
  meta_key: string;
  /** 值（json 列） */
  meta_value: unknown;
}

/** 宽基跟踪仓储 */
export interface BroadRepo {
  /**
   * 读当前快照（响应式；刷新落库后自动更新）
   * @returns 快照
   */
  snapshot: () => BroadSnapshot;
  /**
   * 落库日频行（按 (date, code) upsert）
   * @param rows 日频行
   */
  saveDailyRows: (rows: readonly EtfDailyRow[]) => Promise<void>;
  /**
   * 落库季度行（按 (code, period_end) upsert）
   * @param rows 季度行
   */
  saveQuarterRows: (rows: readonly EtfQuarterRow[]) => Promise<void>;
  /**
   * 落库持有人结构行（按 (code, period_end) upsert）
   * @param rows 持有人结构行
   */
  saveHolderRows: (rows: readonly EtfHolderRow[]) => Promise<void>;
  /**
   * 保存锚点清单（全量替换）
   * @param anchors 锚点清单
   */
  saveAnchors: (anchors: readonly AnchorHolding[]) => Promise<void>;
  /**
   * 合并更新元信息（读改写）
   * @param patch 待更新字段
   */
  saveMeta: (patch: Partial<BroadMeta>) => Promise<void>;
}

/**
 * 数值列水合（脏数据兜底：非数一律 null）
 * @param row 库里的一行
 * @param key 列名
 * @returns 数值或 null
 */
const num = (row: PluginDbRow<Record<string, unknown>>, key: string): number | null => {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * 文本列水合（非字符串一律空串）
 * @param row 库里的一行
 * @param key 列名
 * @returns 文本
 */
const text = (row: PluginDbRow<Record<string, unknown>>, key: string): string =>
  typeof row[key] === 'string' ? (row[key] as string) : '';

/**
 * 库里的日频行还原成展示行
 * @param row 库里的一行
 * @returns 日频行
 */
const hydrateDaily = (row: PluginDbRow<Record<string, unknown>>): EtfDailyRow => ({
  date: text(row, 'date'),
  code: text(row, 'code'),
  price: num(row, 'price'),
  changePercent: num(row, 'change_percent'),
  amount: num(row, 'amount'),
  mainInflow: num(row, 'main_inflow'),
  superInflow: num(row, 'super_inflow'),
  bigInflow: num(row, 'big_inflow'),
  midInflow: num(row, 'mid_inflow'),
  smallInflow: num(row, 'small_inflow'),
});

/**
 * 库里的季度行还原成展示行
 * @param row 库里的一行
 * @returns 季度行
 */
const hydrateQuarter = (row: PluginDbRow<Record<string, unknown>>): EtfQuarterRow => ({
  code: text(row, 'code'),
  periodEnd: text(row, 'period_end'),
  subscribeYi: num(row, 'subscribe_yi'),
  redeemYi: num(row, 'redeem_yi'),
  sharesEndYi: num(row, 'shares_end_yi'),
  netAssetYi: num(row, 'net_asset_yi'),
  assetChangeRate: num(row, 'asset_change_rate'),
});

/**
 * 库里的持有人行还原成展示行
 * @param row 库里的一行
 * @returns 持有人结构行
 */
const hydrateHolder = (row: PluginDbRow<Record<string, unknown>>): EtfHolderRow => ({
  code: text(row, 'code'),
  periodEnd: text(row, 'period_end'),
  instRatio: num(row, 'inst_ratio'),
  totalSharesYi: num(row, 'total_shares_yi'),
});

/**
 * 锚点 JSON 清洗（坏条目丢弃：代码非字符串 / 份额非有限数）
 * @param value 库里的 json 值
 * @returns 锚点清单；全坏返回 null
 */
const sanitizeAnchors = (value: unknown): AnchorHolding[] | null => {
  if (!Array.isArray(value)) return null;
  const anchors: AnchorHolding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.code !== 'string' || typeof row.sharesYi !== 'number') continue;
    if (!Number.isFinite(row.sharesYi)) continue;
    anchors.push({
      code: row.code,
      periodEnd: typeof row.periodEnd === 'string' ? row.periodEnd : '',
      sharesYi: row.sharesYi,
      source: typeof row.source === 'string' ? row.source : '',
    });
  }
  return anchors;
};

/** 空元信息（从未刷新过） */
const EMPTY_META: BroadMeta = {
  dailyRefreshedAt: null,
  quarterRefreshedAt: null,
  warnings: [],
  indexQuotes: [],
};

/**
 * 建表并水合快照
 * @param db 插件通用数据库（`ctx.db`）
 * @returns 宽基跟踪仓储
 */
export const createBroadRepo = async (db: PluginDatabase): Promise<BroadRepo> => {
  await db.ensureTable(BROAD_DAILY_TABLE, BROAD_DAILY_COLUMNS);
  await db.ensureTable(BROAD_QUARTER_TABLE, BROAD_QUARTER_COLUMNS);
  await db.ensureTable(BROAD_HOLDERS_TABLE, BROAD_HOLDERS_COLUMNS);
  await db.ensureTable(BROAD_ANCHOR_TABLE, BROAD_ANCHOR_COLUMNS);
  await db.ensureTable(BROAD_META_TABLE, BROAD_META_COLUMNS);

  const dailyByCode = ref<Map<string, EtfDailyRow[]>>(new Map());
  const quartersByCode = ref<Map<string, EtfQuarterRow[]>>(new Map());
  const holdersByCode = ref<Map<string, EtfHolderRow[]>>(new Map());
  const anchors = ref<AnchorHolding[]>([]);
  const meta = ref<BroadMeta>({ ...EMPTY_META });

  // ---------- 水合：读库即渲染，不联网 ----------

  const storedDaily = await db.select<Record<string, unknown>>(BROAD_DAILY_TABLE, {
    orderBy: { column: 'date' },
  });
  const dailyMap = new Map<string, EtfDailyRow[]>();
  for (const row of storedDaily.map(hydrateDaily)) {
    const bucket = dailyMap.get(row.code);
    if (bucket) bucket.push(row);
    else dailyMap.set(row.code, [row]);
  }
  dailyByCode.value = dailyMap;

  const storedQuarter = await db.select<Record<string, unknown>>(BROAD_QUARTER_TABLE, {
    orderBy: { column: 'period_end' },
  });
  const quarterMap = new Map<string, EtfQuarterRow[]>();
  for (const row of storedQuarter.map(hydrateQuarter)) {
    const bucket = quarterMap.get(row.code);
    if (bucket) bucket.push(row);
    else quarterMap.set(row.code, [row]);
  }
  quartersByCode.value = quarterMap;

  const storedHolders = await db.select<Record<string, unknown>>(BROAD_HOLDERS_TABLE, {
    orderBy: { column: 'period_end' },
  });
  const holderMap = new Map<string, EtfHolderRow[]>();
  for (const row of storedHolders.map(hydrateHolder)) {
    const bucket = holderMap.get(row.code);
    if (bucket) bucket.push(row);
    else holderMap.set(row.code, [row]);
  }
  holdersByCode.value = holderMap;

  const storedAnchors = await db.select<AnchorRow>(BROAD_ANCHOR_TABLE, {
    where: { anchor_key: BROAD_ANCHOR_KEY },
  });
  const sanitizedAnchors = sanitizeAnchors(storedAnchors[0]?.anchor_value);
  if (sanitizedAnchors) anchors.value = sanitizedAnchors;

  const storedMeta = await db.select<MetaRow>(BROAD_META_TABLE, {
    where: { meta_key: BROAD_META_KEY },
  });
  const metaValue = storedMeta[0]?.meta_value;
  if (metaValue && typeof metaValue === 'object') {
    meta.value = { ...EMPTY_META, ...(metaValue as Partial<BroadMeta>) };
  }

  // ---------- 快照出口 ----------

  /**
   * 当前快照（响应式读口）
   * @returns 快照
   */
  const snapshot = (): BroadSnapshot => {
    const dates = new Set<string>();
    for (const rows of dailyByCode.value.values()) {
      for (const row of rows) dates.add(row.date);
    }
    return {
      dailyByCode: dailyByCode.value,
      dailyDates: [...dates].sort(),
      quartersByCode: quartersByCode.value,
      holdersByCode: holdersByCode.value,
      anchors: anchors.value,
      meta: meta.value,
    };
  };

  /**
   * 日频行 upsert（同 (date, code) 已存在则更新）
   * @param rows 日频行
   */
  const saveDailyRows = async (rows: readonly EtfDailyRow[]): Promise<void> => {
    const map = new Map(dailyByCode.value);
    for (const row of rows) {
      const existing = await db.select<Record<string, unknown>>(BROAD_DAILY_TABLE, {
        where: { date: row.date, code: row.code },
      });
      const record: Record<string, unknown> = {
        date: row.date,
        code: row.code,
        price: row.price,
        change_percent: row.changePercent,
        amount: row.amount,
        main_inflow: row.mainInflow,
        super_inflow: row.superInflow,
        big_inflow: row.bigInflow,
        mid_inflow: row.midInflow,
        small_inflow: row.smallInflow,
      };
      if (existing.length > 0) {
        await db.update(BROAD_DAILY_TABLE, existing[0].id, record);
      } else {
        await db.insert(BROAD_DAILY_TABLE, record);
      }
      // 内存 map 同步（替换该 code 的该日期行）
      const bucket = map.get(row.code) ?? [];
      const index = bucket.findIndex((item) => item.date === row.date);
      if (index >= 0) bucket[index] = row;
      else bucket.push(row);
      bucket.sort((left, right) => (left.date < right.date ? -1 : 1));
      map.set(row.code, bucket);
    }
    dailyByCode.value = map;
  };

  /**
   * 季度行 upsert（同 (code, period_end) 已存在则更新）
   * @param rows 季度行
   */
  const saveQuarterRows = async (rows: readonly EtfQuarterRow[]): Promise<void> => {
    const map = new Map(quartersByCode.value);
    for (const row of rows) {
      const existing = await db.select<Record<string, unknown>>(BROAD_QUARTER_TABLE, {
        where: { code: row.code, period_end: row.periodEnd },
      });
      const record: Record<string, unknown> = {
        code: row.code,
        period_end: row.periodEnd,
        subscribe_yi: row.subscribeYi,
        redeem_yi: row.redeemYi,
        shares_end_yi: row.sharesEndYi,
        net_asset_yi: row.netAssetYi,
        asset_change_rate: row.assetChangeRate,
      };
      if (existing.length > 0) {
        await db.update(BROAD_QUARTER_TABLE, existing[0].id, record);
      } else {
        await db.insert(BROAD_QUARTER_TABLE, record);
      }
      const bucket = map.get(row.code) ?? [];
      const index = bucket.findIndex((item) => item.periodEnd === row.periodEnd);
      if (index >= 0) bucket[index] = row;
      else bucket.push(row);
      bucket.sort((left, right) => (left.periodEnd < right.periodEnd ? 1 : -1));
      map.set(row.code, bucket);
    }
    quartersByCode.value = map;
  };

  /**
   * 持有人结构行 upsert（同 (code, period_end) 已存在则更新）
   * @param rows 持有人结构行
   */
  const saveHolderRows = async (rows: readonly EtfHolderRow[]): Promise<void> => {
    const map = new Map(holdersByCode.value);
    for (const row of rows) {
      const existing = await db.select<Record<string, unknown>>(BROAD_HOLDERS_TABLE, {
        where: { code: row.code, period_end: row.periodEnd },
      });
      const record: Record<string, unknown> = {
        code: row.code,
        period_end: row.periodEnd,
        inst_ratio: row.instRatio,
        total_shares_yi: row.totalSharesYi,
      };
      if (existing.length > 0) {
        await db.update(BROAD_HOLDERS_TABLE, existing[0].id, record);
      } else {
        await db.insert(BROAD_HOLDERS_TABLE, record);
      }
      const bucket = map.get(row.code) ?? [];
      const index = bucket.findIndex((item) => item.periodEnd === row.periodEnd);
      if (index >= 0) bucket[index] = row;
      else bucket.push(row);
      bucket.sort((left, right) => (left.periodEnd < right.periodEnd ? 1 : -1));
      map.set(row.code, bucket);
    }
    holdersByCode.value = map;
  };

  /**
   * 保存锚点清单（全量替换；界面编辑后调用）
   * @param next 锚点清单
   */
  const saveAnchors = async (next: readonly AnchorHolding[]): Promise<void> => {
    await db.clear(BROAD_ANCHOR_TABLE);
    await db.insert(BROAD_ANCHOR_TABLE, {
      anchor_key: BROAD_ANCHOR_KEY,
      anchor_value: [...next],
    });
    anchors.value = sanitizeAnchors([...next]) ?? [];
  };

  /**
   * 合并更新元信息（读改写；同键先清后插，语义等价 upsert）
   * @param patch 待更新字段
   */
  const saveMeta = async (patch: Partial<BroadMeta>): Promise<void> => {
    const merged: BroadMeta = { ...meta.value, ...patch };
    await db.clear(BROAD_META_TABLE);
    await db.insert(BROAD_META_TABLE, {
      meta_key: BROAD_META_KEY,
      meta_value: merged,
    });
    meta.value = merged;
  };

  return {
    snapshot,
    saveDailyRows,
    saveQuarterRows,
    saveHolderRows,
    saveAnchors,
    saveMeta,
  };
};
