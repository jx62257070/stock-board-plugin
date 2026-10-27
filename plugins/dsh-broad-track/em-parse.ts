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
  SINA_HQ_FIELD,
  SINA_HQ_MIN_FIELDS,
  SINA_MONEYFLOW_FIELD,
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

/** JS 字符串字面量里的常见转义（`\n` 等）→ 实际字符 */
const JS_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/**
 * 读取一个 JS 字符串字面量的内容（双引号或单引号包裹）
 *
 * 处理反斜杠转义：`\\` `\"` `\'` `\n` `\t` `\uXXXX` `\xNN`；
 * 未知转义按「反斜杠 + 字符」原样保留。
 * @param text 全文
 * @param start 起始引号所在下标
 * @returns 字符串内容与结束下标（结束下标指向闭合引号之后）；不是字符串字面量返回 null
 */
const readJsStringLiteral = (
  text: string,
  start: number,
): { value: string; end: number } | null => {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;

  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) return null;
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      }
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 2, index + 4))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16));
        index += 4;
        continue;
      }
      value += JS_ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
    index += 1;
  }
  return null;
};

/**
 * 跳过一个 JS 值（对象 / 数组 / 原始字面量），返回其结束后的下标
 *
 * 字符串字面量整体跳过（其中的括号不参与配对）。
 * @param text 全文
 * @param start 值的起始下标
 * @returns 值结束后的下标
 */
const skipJsValue = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;

  const char = text[index];
  if (char === '"' || char === "'") {
    const literal = readJsStringLiteral(text, index);
    return literal === null ? index + 1 : literal.end;
  }
  if (char === '{' || char === '[') {
    const close = char === '{' ? '}' : ']';
    let depth = 0;
    while (index < text.length) {
      const current = text[index];
      if (current === '"' || current === "'") {
        const literal = readJsStringLiteral(text, index);
        index = literal === null ? index + 1 : literal.end;
        continue;
      }
      if (current === char) depth += 1;
      else if (current === close) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return index;
  }
  // 原始字面量（数字 / true / false / null）：读到分隔符为止
  while (index < text.length && !/[,}\]\s]/.test(text[index])) index += 1;
  return index;
};

/**
 * 在 JS 对象字面量的**直属属性**里取一个字符串型属性的值
 *
 * 单遍扫描对象体的顶层键值对：只认对象自身的属性，嵌套对象 / 数组整体跳过 ——
 * F10 响应的 `data` 数组里就带 `content` 之类的字段，认错层级会取到脏值。
 * @param text 全文
 * @param objectStart 对象字面量左花括号下标
 * @param key 目标属性名
 * @returns 属性值；不存在 / 非字符串返回 null
 */
const readJsObjectStringProp = (text: string, objectStart: number, key: string): string | null => {
  let index = objectStart + 1;
  while (index < text.length) {
    // 跳过空白与属性分隔逗号
    while (index < text.length && /[\s,]/.test(text[index])) index += 1;
    if (index >= text.length) return null;
    if (text[index] === '}') return null;

    // 读属性名（标识符或引号包裹）
    let propName: string;
    if (text[index] === '"' || text[index] === "'") {
      const literal = readJsStringLiteral(text, index);
      if (literal === null) return null;
      propName = literal.value;
      index = literal.end;
    } else {
      const nameStart = index;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) index += 1;
      if (index === nameStart) return null;
      propName = text.slice(nameStart, index);
    }

    // 冒号
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== ':') return null;
    index += 1;

    // 值
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === '"' || text[index] === "'") {
      const literal = readJsStringLiteral(text, index);
      if (literal === null) return null;
      if (propName === key) return literal.value;
      index = literal.end;
      continue;
    }
    index = skipJsValue(text, index);
  }
  return null;
};

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

/**
 * 新浪 hq 响应的一行：`var hq_str_sh510300="……";`
 *
 * 捕获组：1 = 新浪符号（`sh510300`），2 = 引号内的数据体（可为空串）。
 */
const SINA_HQ_LINE_PATTERN = /var\s+hq_str_([a-z]{2}\d{6})="([^"]*)"/gi;

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
 * 解析新浪 hq 批量行情响应（纯函数）
 *
 * 响应形态：每行一个 `var hq_str_<symbol>="名称,今开,昨收,最新价,…,日期,时间,…"`；
 * 字段下标见 `SINA_HQ_FIELD`。上游对无效代码返回 `hq_str_<symbol>=""`（空串），
 * 此时丢弃该行。
 *
 * ⚠️ **涨跌幅是自算的**：新浪 hq 不直接给涨跌幅，用
 * `(最新价 − 昨收) ÷ 昨收 × 100` 推出（实测 510300 on 2026-10-23 → 1.73%，
 * 与腾讯源完全一致）；昨收为 0（停牌 / 无数据）时置 null，不当 0 用。
 *
 * ⚠️ **响应是 GBK 编码**：调用方需先按 GBK 解码再传入（本插件走宿主的字节透传
 * 通道，故由取数层负责转码，见 `em-data.ts`）。
 * @param text 响应文本（已按 GBK 解码）
 * @returns 行情行（按上游顺序）；脏行已丢弃
 */
export const parseSinaHqQuotes = (text: string): QuoteRow[] => {
  const rows: QuoteRow[] = [];
  // 每行形如：var hq_str_sh510300="……";
  for (const match of text.matchAll(SINA_HQ_LINE_PATTERN)) {
    const symbol = match[1];
    const body = match[2];
    if (!body) continue;
    const fields = body.split(',');
    if (fields.length < SINA_HQ_MIN_FIELDS) continue;

    const code = symbol.replace(/^(?:sh|sz)/, '');
    if (!code) continue;

    const price = parseNumber(fields[SINA_HQ_FIELD.PRICE]);
    const preClose = parseNumber(fields[SINA_HQ_FIELD.PRE_CLOSE]);
    const changePercent =
      price !== null && preClose !== null && preClose !== 0
        ? ((price - preClose) / preClose) * 100
        : null;

    rows.push({
      code,
      name: fields[SINA_HQ_FIELD.NAME] ?? '',
      price,
      changePercent,
      amount: parseNumber(fields[SINA_HQ_FIELD.AMOUNT]),
    });
  }
  return rows;
};

/**
 * 解析新浪个股资金流历史（纯函数）
 *
 * 响应是 JSON 数组文本，每行字段见 `SINA_MONEYFLOW_FIELD`；
 * 上游按日期降序返回（最新在前），解析后保持原序。
 *
 * ⚠️ **口径边界**：新浪该接口**只给主力与超大单两档**，
 * 小单 / 中单 / 大单一律 `null`（留空而非当 0 用 —— 数值口径纪律）。
 * @param text 响应文本
 * @returns 逐日资金流行（降序）；空数据 / 脏响应返回空数组
 */
export const parseSinaMoneyFlow = (text: string): FflowDayRow[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const rows: FflowDayRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const date = typeof row[SINA_MONEYFLOW_FIELD.DATE] === 'string'
      ? (row[SINA_MONEYFLOW_FIELD.DATE] as string)
      : '';
    if (!DATE_PATTERN.test(date)) continue;

    // 涨跌幅是小数（0.0170441），统一换算成百分数（1.70）
    const rawChange = parseNumber(
      typeof row[SINA_MONEYFLOW_FIELD.CHANGE_PERCENT] === 'string'
        ? (row[SINA_MONEYFLOW_FIELD.CHANGE_PERCENT] as string)
        : null,
    );

    rows.push({
      date,
      mainInflow: parseNumber(
        typeof row[SINA_MONEYFLOW_FIELD.MAIN] === 'string'
          ? (row[SINA_MONEYFLOW_FIELD.MAIN] as string)
          : null,
      ),
      superInflow: parseNumber(
        typeof row[SINA_MONEYFLOW_FIELD.SUPER] === 'string'
          ? (row[SINA_MONEYFLOW_FIELD.SUPER] as string)
          : null,
      ),
      smallInflow: null,
      midInflow: null,
      bigInflow: null,
      close: parseNumber(
        typeof row[SINA_MONEYFLOW_FIELD.CLOSE] === 'string'
          ? (row[SINA_MONEYFLOW_FIELD.CLOSE] as string)
          : null,
      ),
      changePercent: rawChange === null ? null : rawChange * 100,
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
 * 从 F10 响应体里剥出数据对象（`var xxx_apidata={content:"<table>…"}` 形态）
 *
 * ⚠️ 上游给的是 **JavaScript 对象字面量**（`{content:"…"}`，key 不带引号），
 * **不是合法 JSON** —— 直接 `JSON.parse` 会在第 2 个字符就抛
 * "Expected property name"。故这里改用手写扫描：定位对象体，在其直属属性里
 * 找 `content` 键，并按 JS 字符串字面量规则解码（含 `\\` `\"` `\n` `\uXXXX` 等转义）。
 *
 * 只取直属属性（深度 1）：嵌套结构与 `summary` / `data` 等兄弟字段一律跳过。
 * @param text 响应文本
 * @param varName 数据对象的 JS 变量名（`gmbd_apidata` / `apidata`）
 * @returns 数据对象；形态不符返回 null
 */
export const extractF10Object = (text: string, varName: string): F10Object | null => {
  const marker = `var ${varName}=`;
  const start = text.indexOf(marker);
  if (start < 0) return null;

  const objectStart = text.indexOf('{', start + marker.length);
  if (objectStart < 0) return null;

  const content = readJsObjectStringProp(text, objectStart, 'content');
  if (content === null) return null;
  return { content };
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
