/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 本地仓储
 *
 * 三张插件表（落 `plugin_dsh_sentiment_index_*`；Tauri 端 SQLite / 浏览器端 appStorage 仿真）：
 * - `board_history`：每板块一行，逐日事实整体存 `days` json 列 —— 关注板块持有
 *   日 K + fflow + 快照字段的**全量回补历史**；非关注行业板块只有安装日起每日追加的
 *   快照行。逐日行的存储形态为什么不按「板块 × 交易日」一行：ctx.db 无批量插入，
 *   首扫上万行逐条 IPC 不可接受（dsh-mainline 的既有结论），见插件 README；
 * - `index_daily`：每板块一行，逐日指数（双指数 + 因子原始值 + 分位）存 `series` json 列，
 *   每次采集后**全量重算**再落库 —— 分位只依赖 ≤ 当日的数据，历史行永不漂移；
 * - `scan_meta`：键值行 —— 关注清单 / 板块清单缓存 / 沪深成交额序列 / 采集元信息。
 *
 * 水合与 upsert 的主键登记必须同形（`${table}:${key}`）—— dsh-mainline 踩过
 * 「重启后首扫整批重复插入」的坑，这里从水合起就用同形键。
 */
import { ref } from 'vue';
import { MAX_HISTORY_DAYS } from './constants';
import type { PluginDatabase, PluginDbColumn, PluginDbRow } from '../../host/types/plugin.types';
import type {
  BoardHistory,
  BoardKind,
  BoardRef,
  IndexPoint,
  MarketPoint,
  ScanMeta,
  SentimentSnapshot,
} from './types';

/** 板块事实表名（物理表 `plugin_dsh_sentiment_index_board_history`） */
export const SENTIMENT_BOARD_TABLE = 'board_history';

/** 指数结果表名（物理表 `plugin_dsh_sentiment_index_index_daily`） */
export const SENTIMENT_INDEX_TABLE = 'index_daily';

/** 采集元信息表名（物理表 `plugin_dsh_sentiment_index_scan_meta`） */
export const SENTIMENT_META_TABLE = 'scan_meta';

/** 元信息键：上次采集元信息 */
export const META_KEY_LAST_SCAN = 'last_scan';

/** 元信息键：沪深成交额序列（同源分母） */
export const META_KEY_MARKET = 'market_series';

/** 元信息键：板块清单缓存（关注管理搜索用） */
export const META_KEY_REFS = 'board_refs';

/** 元信息键：关注题材代码清单 */
export const META_KEY_WATCHLIST = 'watchlist';

/** 元信息键：THS→BK 名称映射（fflow 散户因子的前提） */
export const META_KEY_EM_MAP = 'em_map';

/**
 * 板块事实表的列声明
 *
 * ⚠️ 只声明**业务列**：`id` / `created_at` / `updated_at` 由宿主自动维护，
 * 插件重复声明会让建表语句出现两个同名列。
 */
export const BOARD_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'board_code', type: 'text', indexed: true },
  { name: 'board_name', type: 'text' },
  { name: 'board_kind', type: 'text' },
  { name: 'days', type: 'json' },
];

/** 指数结果表的列声明 */
export const INDEX_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'board_code', type: 'text', indexed: true },
  { name: 'series', type: 'json' },
];

/** 元信息表的列声明（键值行） */
export const META_COLUMNS: readonly PluginDbColumn[] = [
  { name: 'meta_key', type: 'text', indexed: true },
  { name: 'meta_value', type: 'json' },
];

/** 板块事实表的一行 */
interface BoardRow extends Record<string, unknown> {
  board_code: string;
  board_name: string;
  board_kind: string;
  days: unknown;
}

/** 指数结果表的一行 */
interface IndexRow extends Record<string, unknown> {
  board_code: string;
  series: unknown;
}

/** 元信息表的一行 */
interface MetaRow extends Record<string, unknown> {
  meta_key: string;
  meta_value: unknown;
}

/**
 * 把库里读出的 json 值还原成板块逐日数据（脏行一律过滤，宁缺毋错）
 * @param value json 列值
 * @returns 逐日数据（升序）
 */
const parseDays = (value: unknown): BoardHistory['days'] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BoardHistory['days'][number] => {
    if (!item || typeof item !== 'object') return false;
    const day = item as { date?: unknown };
    return typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date);
  });
};

/**
 * 把库里读出的 json 值还原成板块清单（脏行过滤）
 * @param value json 列值
 * @returns 板块清单
 */
const parseRefs = (value: unknown): BoardRef[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is BoardRef =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { code?: unknown }).code === 'string' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      ((item as { kind?: unknown }).kind === 'industry' || (item as { kind?: unknown }).kind === 'concept'),
  );
};

/**
 * 把库里读出的 json 值还原成指数序列（脏行过滤）
 * @param value json 列值
 * @returns 逐日指数（升序）
 */
const parseSeries = (value: unknown): IndexPoint[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is IndexPoint => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as { date?: unknown }).date === 'string';
  });
};

/**
 * 板块类别字段（脏值兜底为行业）
 * @param value 库里的类别字段
 * @returns 板块类别
 */
const toKind = (value: unknown): BoardKind => (value === 'concept' ? 'concept' : 'industry');

/**
 * 一次采集要落库的完整结果
 */
export interface SaveScanInput {
  /** 板块事实（关注板块全量合并 + 非关注行业今日快照行；调用方已裁掉未落定日） */
  boards: readonly BoardHistory[];
  /** 沪深成交额序列（升序） */
  market: readonly MarketPoint[];
  /** 采集元信息 */
  meta: ScanMeta;
  /** 关注板块的逐日指数（code → 序列；与 boards 里的关注板块一一对应） */
  indexByCode: ReadonlyMap<string, readonly IndexPoint[]>;
}

/** 保存结果（页内汇报用） */
export interface SaveScanOutput {
  /** 新增的板块 × 交易日事实行数 */
  addedRows: number;
  /** 新增的指数行数 */
  addedIndexRows: number;
}

/** 散户情绪指数仓储 */
export interface SentimentRepo {
  /**
   * 读当前快照（响应式；采集落库后自动更新）
   * @returns 快照
   */
  snapshot: () => SentimentSnapshot;
  /**
   * 落库一次采集结果（板块行 / 指数行 / 元信息全部 upsert，同日重扫不产生重复行）
   * @param input 采集结果
   * @returns 新增行数统计
   */
  saveScan: (input: SaveScanInput) => Promise<SaveScanOutput>;
  /**
   * 更新关注题材清单（只影响后续采集与筛选，不删除已落库历史）
   * @param codes 板块代码清单
   */
  setWatchlist: (codes: readonly string[]) => Promise<void>;
  /**
   * 保存板块清单缓存（关注管理搜索用；采集清单页成功后调用）
   * @param refs 板块清单
   */
  saveRefs: (refs: readonly BoardRef[]) => Promise<void>;
  /**
   * 保存 THS→BK 名称映射（与现有映射合并后的全量；fflow 散户因子的前提）
   * @param map 映射（thsCode → bkCode）
   */
  saveEmMap: (map: Readonly<Record<string, string>>) => Promise<void>;
}

/**
 * 建表并水合快照
 * @param db 插件通用数据库（`ctx.db`）
 * @returns 散户情绪指数仓储
 */
export const createSentimentRepo = async (db: PluginDatabase): Promise<SentimentRepo> => {
  await db.ensureTable(SENTIMENT_BOARD_TABLE, BOARD_COLUMNS);
  await db.ensureTable(SENTIMENT_INDEX_TABLE, INDEX_COLUMNS);
  await db.ensureTable(SENTIMENT_META_TABLE, META_COLUMNS);

  const boards = ref<BoardHistory[]>([]);
  const market = ref<MarketPoint[]>([]);
  const meta = ref<ScanMeta | null>(null);
  const refs = ref<BoardRef[]>([]);
  const watchlist = ref<string[]>([]);
  const emMap = ref<Record<string, string>>({});
  const indexByCode = ref<Map<string, IndexPoint[]>>(new Map());

  /** 行主键登记（upsert 定位；键必须与写入查找键同形） */
  const rowIds = new Map<string, number>();

  // ---- 水合：板块事实表（历史行按代码排序，首屏顺序稳定）----
  // 重复行按 updated_at 去重保留最新一行并删除冗余（早前版本的登记缺陷防御）
  const boardRows = await db.select<BoardRow>(SENTIMENT_BOARD_TABLE, {
    orderBy: { column: 'board_code' },
  });
  const newestBoardByKey = new Map<string, PluginDbRow<BoardRow>>();
  const redundantBoardIds: number[] = [];
  for (const row of boardRows) {
    if (!row.board_code) continue;
    const current = newestBoardByKey.get(row.board_code);
    if (!current) {
      newestBoardByKey.set(row.board_code, row);
      continue;
    }
    const keep = row.updatedAt >= current.updatedAt ? row : current;
    redundantBoardIds.push(keep === row ? current.id : row.id);
    newestBoardByKey.set(row.board_code, keep);
  }
  for (const id of redundantBoardIds) await db.remove(SENTIMENT_BOARD_TABLE, id);

  for (const row of newestBoardByKey.values()) {
    rowIds.set(`${SENTIMENT_BOARD_TABLE}:${row.board_code}`, row.id);
    boards.value.push({
      code: row.board_code,
      name: row.board_name || row.board_code,
      kind: toKind(row.board_kind),
      days: parseDays(row.days),
    });
  }

  // ---- 水合：指数结果表 ----
  const indexRows = await db.select<IndexRow>(SENTIMENT_INDEX_TABLE, {
    orderBy: { column: 'board_code' },
  });
  const newestIndexByKey = new Map<string, PluginDbRow<IndexRow>>();
  const redundantIndexIds: number[] = [];
  for (const row of indexRows) {
    if (!row.board_code) continue;
    const current = newestIndexByKey.get(row.board_code);
    if (!current) {
      newestIndexByKey.set(row.board_code, row);
      continue;
    }
    const keep = row.updatedAt >= current.updatedAt ? row : current;
    redundantIndexIds.push(keep === row ? current.id : row.id);
    newestIndexByKey.set(row.board_code, keep);
  }
  for (const id of redundantIndexIds) await db.remove(SENTIMENT_INDEX_TABLE, id);

  const indexMap = new Map<string, IndexPoint[]>();
  for (const row of newestIndexByKey.values()) {
    rowIds.set(`${SENTIMENT_INDEX_TABLE}:${row.board_code}`, row.id);
    indexMap.set(row.board_code, parseSeries(row.series));
  }
  indexByCode.value = indexMap;

  // ---- 水合：元信息表 ----
  const metaRows = await db.select<MetaRow>(SENTIMENT_META_TABLE, {
    orderBy: { column: 'meta_key' },
  });
  for (const row of metaRows) {
    if (!row.meta_key) continue;
    // 键值行按「键」唯一：同名键多行时保留最新一行（防御早前主键登记缺陷）
    const lookupKey = `${SENTIMENT_META_TABLE}:${row.meta_key}`;
    const existingId = rowIds.get(lookupKey);
    if (existingId !== undefined) {
      const existingRow = metaRows.find((item) => item.id === existingId);
      if (existingRow && existingRow.updatedAt >= row.updatedAt) continue;
      await db.remove(SENTIMENT_META_TABLE, existingId);
    }
    rowIds.set(lookupKey, row.id);
    if (row.meta_key === META_KEY_LAST_SCAN && row.meta_value && typeof row.meta_value === 'object') {
      meta.value = row.meta_value as ScanMeta;
    }
    if (row.meta_key === META_KEY_MARKET && Array.isArray(row.meta_value)) {
      market.value = (row.meta_value as MarketPoint[]).filter(
        (point) => typeof point?.date === 'string' && Number.isFinite(point?.totalAmount),
      );
    }
    if (row.meta_key === META_KEY_REFS) refs.value = parseRefs(row.meta_value);
    if (row.meta_key === META_KEY_WATCHLIST && Array.isArray(row.meta_value)) {
      watchlist.value = row.meta_value.filter((item): item is string => typeof item === 'string');
    }
    if (row.meta_key === META_KEY_EM_MAP && row.meta_value && typeof row.meta_value === 'object') {
      const raw = row.meta_value as Record<string, unknown>;
      const parsed: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof key === 'string' && typeof value === 'string') parsed[key] = value;
      }
      emMap.value = parsed;
    }
  }

  /**
   * 写一行（存在则更新，不存在则插入并登记主键）
   * @param table 表名
   * @param key 业务键
   * @param columns 列值
   */
  const upsert = async (
    table: string,
    key: string,
    columns: Record<string, unknown>,
  ): Promise<void> => {
    const lookupKey = `${table}:${key}`;
    const id = rowIds.get(lookupKey);
    if (id === undefined) {
      rowIds.set(lookupKey, await db.insert(table, columns));
      return;
    }
    await db.update(table, id, columns);
  };

  /**
   * 写元信息键（存在则更新，不存在则插入）
   * @param key 元信息键
   * @param value 值（json 列）
   */
  const upsertMeta = async (key: string, value: unknown): Promise<void> => {
    await upsert(SENTIMENT_META_TABLE, key, { meta_key: key, meta_value: value });
  };

  return {
    snapshot: (): SentimentSnapshot => ({
      boards: boards.value,
      market: market.value,
      meta: meta.value,
      refs: refs.value,
      watchlist: watchlist.value,
      emMap: emMap.value,
    }),

    saveScan: async (input: SaveScanInput): Promise<SaveScanOutput> => {
      let addedRows = 0;
      let addedIndexRows = 0;
      const nextIndexMap = new Map(indexByCode.value);

      for (const board of input.boards) {
        const days = board.days.slice(-MAX_HISTORY_DAYS);
        // 新增行数按「新日期数」差分统计（同日重扫 upsert 不计入新增）
        const existing = boards.value.find((item) => item.code === board.code);
        if (existing) {
          const knownDates = new Set(existing.days.map((day) => day.date));
          addedRows += days.filter((day) => !knownDates.has(day.date)).length;
        } else {
          addedRows += days.length;
        }
        await upsert(SENTIMENT_BOARD_TABLE, board.code, {
          board_code: board.code,
          board_name: board.name,
          board_kind: board.kind,
          days,
        });
      }

      for (const [code, series] of input.indexByCode) {
        const trimmed = series.slice(-MAX_HISTORY_DAYS);
        const existing = nextIndexMap.get(code);
        if (existing) {
          const knownDates = new Set(existing.map((point) => point.date));
          addedIndexRows += trimmed.filter((point) => !knownDates.has(point.date)).length;
        } else {
          addedIndexRows += trimmed.length;
        }
        nextIndexMap.set(code, trimmed);
        await upsert(SENTIMENT_INDEX_TABLE, code, { series: trimmed });
      }

      await upsertMeta(META_KEY_MARKET, input.market);
      await upsertMeta(META_KEY_LAST_SCAN, input.meta);

      // 内存快照同步换新引用（界面与判定层都是 computed，靠引用变化驱动）；
      // 未出现在本轮结果里的板块保留原样（例如本轮清单页失败时用缓存清单）
      const inputCodes = new Set(input.boards.map((board) => board.code));
      boards.value = input.boards
        .map((board) => ({ ...board, days: board.days.slice(-MAX_HISTORY_DAYS) }))
        .concat(boards.value.filter((board) => !inputCodes.has(board.code)))
        .sort((a, b) => a.code.localeCompare(b.code));
      market.value = [...input.market];
      meta.value = input.meta;
      indexByCode.value = nextIndexMap;

      return { addedRows, addedIndexRows };
    },

    setWatchlist: async (codes: readonly string[]): Promise<void> => {
      watchlist.value = [...codes];
      await upsertMeta(META_KEY_WATCHLIST, watchlist.value);
    },

    saveRefs: async (nextRefs: readonly BoardRef[]): Promise<void> => {
      refs.value = [...nextRefs];
      await upsertMeta(META_KEY_REFS, refs.value);
    },

    saveEmMap: async (map: Readonly<Record<string, string>>): Promise<void> => {
      emMap.value = { ...map };
      await upsertMeta(META_KEY_EM_MAP, emMap.value);
    },
  };
};

declare module '../../host/types/plugin.types' {
  /** 本插件对外贡献的服务 */
  interface AppServiceMap {
    /** 散户情绪指数快照仓储（读快照重算指标，不联网；由 dsh-sentiment-index 提供） */
    'sentiment:repo': SentimentRepo;
  }
}
