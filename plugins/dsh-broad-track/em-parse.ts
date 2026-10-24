/**
 * 插件 dsh-broad-track（宽基跟踪）· 解析层（纯函数）
 *
 * 四个解析器，全部是「文本进、结构出」的纯函数，不碰网络与宿主能力：
 * - `parseUlistQuotes`：ulist.np 批量行情 JSON → `QuoteRow[]`；
 * - `parseFflowKlines`：fflow daykline JSON → 逐日资金流行；
 * - `extractF10Object` + `parseGmbdTable` / `parseCyrjgTable`：
 *   F10 `var xxx_apidata={content:"<table>…"}` 形态 → 季度份额 / 持有人结构行。
 *
 * 数值口径：占位符（`-` / `--` / 空）与非数一律 null，绝不当 0 用；
 * 千分位逗号与百分号在解析时剥掉。
 */
import {
  EM_FFLOW_FIELD,
  EM_FFLOW_ROW_FIELDS,
  EM_F10_CYRJG_FIELD,
  EM_F10_CYRJG_ROW_CELLS,
  EM_F10_GMBD_FIELD,
  EM_F10_GMBD_ROW_CELLS,
  EM_ULIST_FIELD,
} from './constants';
import type { EtfHolderRow, EtfQuarterRow, QuoteRow } from './types';

/** ulist 响应体的一行 diff（字段为上游原值） */
interface UlistDiff {
  /** 代码 */
  f12?: unknown;
  /** 名称 */
  f14?: unknown;
  /** 最新价 */
  f2?: unknown;
  /** 涨跌幅 */
  f3?: unknown;
  /** 成交额 */
  f6?: unknown;
}

/** ulist 响应体形态 */
interface UlistPayload {
  data?: { diff?: unknown };
}

/** fflow 响应体形态 */
interface FflowPayload {
  data?: { klines?: unknown };
}

/** fflow 解析出的单日行 */
export interface FflowDayRow {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 主力净流入（元） */
  mainInflow: number | null;
  /** 小单净流入（元） */
  smallInflow: number | null;
  /** 中单净流入（元） */
  midInflow: number | null;
  /** 大单净流入（元） */
  bigInflow: number | null;
  /** 超大单净流入（元） */
  superInflow: number | null;
  /** 收盘价（元） */
  close: number | null;
  /** 涨跌幅（%） */
  changePercent: number | null;
}

/** F10 响应体的数据对象（content 为 HTML 表格文本） */
interface F10Object {
  content?: unknown;
}

/** 新浪 K 线响应的一行 */
interface SinaKlineItem {
  /** 日期 */
  day?: unknown;
  /** 收盘价 */
  close?: unknown;
  /** 成交量（股） */
  volume?: unknown;
}

/** 代表「无数据」的占位文本 */
const VALUE_PLACEHOLDER = new Set(['-', '--', '', '—', 'N/A']);

/** 报告期日期形态：YYYY-MM-DD */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** HTML 表格行 */
const ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/g;

/** HTML 单元格 */
const CELL_PATTERN = /<td[^>]*>([\s\S]*?)<\/td>/g;

/** HTML 标签 */
const TAG_PATTERN = /<[^>]*>/g;

/**
 * 单元格 / 字段的数值解析（千分位与百分号剥离；占位与非数为 null）
 * @param raw 原始文本
 * @returns 数值；无法解析为 null
 */
export const parseNumber = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null;
  const text = raw.replace(/,/g, '').replace(/%/g, '').trim();
  if (VALUE_PLACEHOLDER.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/**
 * 解析 ulist.np 批量行情响应（纯函数）
 *
 * 上游对个别 secid 缺数据时该条目不出现（调用方按缺失兜底）；
 * `fltt=2&invt=2` 下数值为真值小数。
 * @param text 响应文本
 * @returns 行情行（按上游顺序）
 */
export const parseUlistQuotes = (text: string): QuoteRow[] => {
  let payload: UlistPayload;
  try {
    payload = JSON.parse(text) as UlistPayload;
  } catch {
    return [];
  }
  const diff = payload.data?.diff;
  if (!Array.isArray(diff)) return [];

  const rows: QuoteRow[] = [];
  for (const item of diff) {
    if (!item || typeof item !== 'object') continue;
    const row = item as UlistDiff;
    const code = typeof row[EM_ULIST_FIELD.CODE] === 'string' ? (row[EM_ULIST_FIELD.CODE] as string) : '';
    if (!code) continue;
    rows.push({
      code,
      name: typeof row[EM_ULIST_FIELD.NAME] === 'string' ? (row[EM_ULIST_FIELD.NAME] as string) : '',
      price: parseNumber(row[EM_ULIST_FIELD.PRICE] as string | null | undefined),
      changePercent: parseNumber(row[EM_ULIST_FIELD.CHANGE_PERCENT] as string | null | undefined),
      amount: parseNumber(row[EM_ULIST_FIELD.AMOUNT] as string | null | undefined),
    });
  }
  return rows;
};

/**
 * 解析 fflow daykline 响应（纯函数）
 *
 * klines 每行是 15 段逗号分隔文本，字段下标见 `EM_FFLOW_FIELD`；
 * 首行即最新交易日（上游按日期降序返回），解析后保持原序（降序）。
 * @param text 响应文本
 * @returns 逐日资金流行（降序）；空数据 / 脏响应返回空数组
 */
export const parseFflowKlines = (text: string): FflowDayRow[] => {
  let payload: FflowPayload;
  try {
    payload = JSON.parse(text) as FflowPayload;
  } catch {
    return [];
  }
  const klines = payload.data?.klines;
  if (!Array.isArray(klines)) return [];

  const rows: FflowDayRow[] = [];
  for (const line of klines) {
    if (typeof line !== 'string') continue;
    const fields = line.split(',');
    if (fields.length < EM_FFLOW_ROW_FIELDS) continue;
    const date = fields[EM_FFLOW_FIELD.DATE];
    if (!DATE_PATTERN.test(date)) continue;
    rows.push({
      date,
      mainInflow: parseNumber(fields[EM_FFLOW_FIELD.MAIN]),
      smallInflow: parseNumber(fields[EM_FFLOW_FIELD.SMALL]),
      midInflow: parseNumber(fields[EM_FFLOW_FIELD.MID]),
      bigInflow: parseNumber(fields[EM_FFLOW_FIELD.BIG]),
      superInflow: parseNumber(fields[EM_FFLOW_FIELD.SUPER]),
      close: parseNumber(fields[EM_FFLOW_FIELD.CLOSE]),
      changePercent: parseNumber(fields[EM_FFLOW_FIELD.CHANGE_PERCENT]),
    });
  }
  return rows;
};

/**
 * 从 F10 响应体里剥出数据对象（`var xxx_apidata={…}` 形态）
 *
 * 手写括号配对扫描（不用正则）：content 里是整张 HTML 表格，
 * 正则稍有不慎就会截断；扫描时正确处理字符串内的转义与花括号。
 * @param text 响应文本
 * @param varName 数据对象的 JS 变量名（`gmbd_apidata` / `apidata`）
 * @returns 数据对象；形态不符返回 null
 */
export const extractF10Object = (text: string, varName: string): F10Object | null => {
  const marker = `var ${varName}=`;
  const start = text.indexOf(marker);
  if (start < 0) return null;

  const from = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const objectText = text.slice(from, index + 1);
        try {
          return JSON.parse(objectText) as F10Object;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/**
 * 单元格纯文本（去标签、收空白）
 * @param html 单元格 HTML
 * @returns 纯文本
 */
const cellText = (html: string): string =>
  html.replace(TAG_PATTERN, '').replace(/&nbsp;/gi, ' ').trim();

/**
 * 解析份额规模变动表（`type=gmbd&mode=0` 的 content HTML，纯函数）
 *
 * 表头顺序固定：日期 / 期间申购（亿份）/ 期间赎回（亿份）/ 期末总份额（亿份）/
 * 期末净资产（亿元）/ 净资产变动率。上游按报告期降序返回，解析后保持原序。
 * @param html content HTML 文本
 * @param code 6 位裸代码（拼进行里）
 * @returns 季度行（降序）；空表返回空数组
 */
export const parseGmbdTable = (html: string, code: string): EtfQuarterRow[] => {
  const rows: EtfQuarterRow[] = [];
  for (const rowMatch of html.matchAll(ROW_PATTERN)) {
    const cells = [...rowMatch[1].matchAll(CELL_PATTERN)].map((cell) => cell[1]);
    if (cells.length < EM_F10_GMBD_ROW_CELLS) continue;
    const periodEnd = cellText(cells[EM_F10_GMBD_FIELD.PERIOD_END]);
    if (!DATE_PATTERN.test(periodEnd)) continue;
    rows.push({
      code,
      periodEnd,
      subscribeYi: parseNumber(cellText(cells[EM_F10_GMBD_FIELD.SUBSCRIBE])),
      redeemYi: parseNumber(cellText(cells[EM_F10_GMBD_FIELD.REDEEM])),
      sharesEndYi: parseNumber(cellText(cells[EM_F10_GMBD_FIELD.SHARES_END])),
      netAssetYi: parseNumber(cellText(cells[EM_F10_GMBD_FIELD.NET_ASSET])),
      assetChangeRate: parseNumber(cellText(cells[EM_F10_GMBD_FIELD.ASSET_CHANGE_RATE])),
    });
  }
  return rows;
};

/**
 * 解析持有人结构表（`type=cyrjg` 的 content HTML，纯函数）
 *
 * 表头顺序固定：公告日期 / 机构持有比例 / 个人持有比例 / 内部持有比例 / 总份额（亿份）。
 * 上游按公告日期降序返回，解析后保持原序。
 * @param html content HTML 文本
 * @param code 6 位裸代码（拼进行里）
 * @returns 持有人结构行（降序）；空表返回空数组
 */
export const parseCyrjgTable = (html: string, code: string): EtfHolderRow[] => {
  const rows: EtfHolderRow[] = [];
  for (const rowMatch of html.matchAll(ROW_PATTERN)) {
    const cells = [...rowMatch[1].matchAll(CELL_PATTERN)].map((cell) => cell[1]);
    if (cells.length < EM_F10_CYRJG_ROW_CELLS) continue;
    const periodEnd = cellText(cells[EM_F10_CYRJG_FIELD.PERIOD_END]);
    if (!DATE_PATTERN.test(periodEnd)) continue;
    rows.push({
      code,
      periodEnd,
      instRatio: parseNumber(cellText(cells[EM_F10_CYRJG_FIELD.INST_RATIO])),
      totalSharesYi: parseNumber(cellText(cells[EM_F10_CYRJG_FIELD.TOTAL_SHARES])),
    });
  }
  return rows;
};

/** 新浪 K 线解析出的单日行 */
export interface SinaKlineRow {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 收盘价（元） */
  close: number | null;
  /** 成交量（股） */
  volume: number | null;
}

/**
 * 解析新浪日 K 响应（纯函数）
 *
 * 响应是 JSON 数组文本，字段为字符串（`{"day":"2026-10-23","close":"4.178","volume":"3755608213"}`）；
 * 上游按日期升序返回，解析后保持原序。
 * @param text 响应文本
 * @returns 逐日 K 线行（升序）；空数据 / 脏响应返回空数组
 */
export const parseSinaKline = (text: string): SinaKlineRow[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const rows: SinaKlineRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const row = item as SinaKlineItem;
    const date = typeof row.day === 'string' ? row.day : '';
    if (!DATE_PATTERN.test(date)) continue;
    rows.push({
      date,
      close: parseNumber(typeof row.close === 'string' ? row.close : null),
      volume: parseNumber(typeof row.volume === 'string' ? row.volume : null),
    });
  }
  return rows;
};
