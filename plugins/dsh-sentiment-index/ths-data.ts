/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 同花顺取数层（主源）
 *
 * 混合源架构（2026-10-30 王总确认）：东财行情域封禁窗口式反复，全链路依赖单点
 * 不可接受 —— 板块清单 / 板块日 K / 当日快照字段全部切**同花顺**（dsh-mainline
 * 跑了数月的既有链路，深度 ≈500 日、白送涨跌家数与净流入），东财只保留两个
 * 不可替代的点：fflow 逐日小单拆分（散户提纯核心，全网唯一）与涨停 / 炸板 / 跌停池。
 * 东财封禁时散户因子当日缺席（权重自动重分配），价量与热度照常累积，恢复后自动补。
 *
 * 数据源与编码（实测 2026-10-30，解析参照 dsh-mainline 的 ths-data.ts）：
 * - 行业清单 `q.10jqka.com.cn/thshy/`（88xxxx，90 个）、概念清单 `q.10jqka.com.cn/gn/`
 *   （885xxx 为主 + 30xxxx 新概念）——都是 **GBK** HTML，链接形如
 *   `…/detail/code/<code>/`；表格自带当日快照
 *   `涨跌幅 / 成交额(亿元) / 净流入(亿元) / 上涨家数 / 下跌家数 / 领涨股`。
 *   ⚠️ 表格每页 50 行，需按 ajax 形态翻页（翻页失败只降级不抛错）。
 * - 板块日 K `d.10jqka.com.cn/v6/line/48_<code>/<复权>/<file>.js`（行业与概念同
 *   48 市场号）：JSONP `({"data":"日期,开,高,低,收,量,额,…;…"})`，行内字段序
 *   `日期,开,高,低,收,成交量,成交额`；回退链 当年01→当年00→近端last→去年。
 * - 两处都要带同花顺 Referer（`q.10jqka.com.cn` / `10jqka.com.cn` 已在代理白名单）。
 */
import {
  SCAN_DELAY_MS,
  THS_BOARD_KLINE_URL_ATTEMPTS,
  THS_BOARD_KLINE_URL_BASE,
  THS_BOARD_KLINE_URL_MIDDLE,
  THS_HTTP_SERVER_ERROR_MIN,
  THS_INDUSTRY_CODE_PREFIX,
  THS_LIST_MAX_PAGES,
  THS_LIST_PAGE_URL,
  THS_LIST_URL,
  THS_REFERER,
  YUAN_PER_YI,
} from './constants';
import type { BoardKind, SentimentDeps } from './types';

/** 清单页里 `…/detail/code/<code>/" … >名称</a>` 的名称提取 */
const BOARD_LIST_ANCHOR_PATTERN =
  /href="[^"]*\/detail\/code\/(\d{6})\/"[^>]*>([^<]{1,20})<\/a>/g;

/** 清单页表格行 */
const BOARD_ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/g;

/** 行内单元格 */
const BOARD_CELL_PATTERN = /<td[^>]*>([\s\S]*?)<\/td>/g;

/** 行内 HTML 标签（取纯文本用） */
const HTML_TAG_PATTERN = /<[^>]*>/g;

/** 快照行识别用的板块代码（行内锚点） */
const BOARD_ROW_CODE_PATTERN = /\/detail\/code\/(\d{6})\//;

/** 快照行的最少单元格数（列：序号/板块/涨跌幅/量/额/净流入/上涨/下跌/均价/领涨股/最新价/涨跌幅） */
const BOARD_ROW_MIN_CELLS = 12;

/** 快照行单元格下标（实测列头顺序固定，行业与概念共用同一模板） */
const BOARD_CELL_INDEX = {
  NAME: 1,
  CHANGE_PERCENT: 2,
  AMOUNT: 4,
  NET_INFLOW: 5,
  RISE: 6,
  FALL: 7,
  LEADER: 9,
} as const;

/** 快照行里代表「无数据」的占位文本 */
const VALUE_PLACEHOLDER = new Set(['-', '--', '', '—']);

/** 年 K 行内字段下标（0 起）：日期 / 开 / 高 / 低 / 收 / 成交量 / 成交额 */
const KLINE_FIELD = {
  DATE: 0,
  OPEN: 1,
  HIGH: 2,
  LOW: 3,
  CLOSE: 4,
  VOLUME: 5,
  AMOUNT: 6,
} as const;

/** 年 K 行的最少字段数（少于 7 段视为脏行丢弃） */
const KLINE_MIN_FIELDS = 7;

/** 年 K 日期字段形态：YYYYMMDD */
const KLINE_DATE_LENGTH = 8;

// ---------- 解析（纯函数，可离线冒烟） ----------

/** THS 板块日 K 解析行（与 em-data 的 KlineRow 同形，跨源复用合并层） */
export interface ThsKlineRow {
  /** 交易日 YYYY-MM-DD */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** 成交量（股） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
}

/** THS 板块快照行（与 em-data 的 ClistRow 同形；换手率 THS 清单页无此列恒 null） */
export interface ThsSnapshotRow {
  /** 板块代码（88xxxx / 885xxx / 30xxxx） */
  code: string;
  /** 板块名称 */
  name: string;
  /** 涨跌幅（%） */
  pctChg: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 换手率（%）：THS 清单页无此列，恒 null（因子缺席自动重分配） */
  turnover: null;
  /** 净流入（元；THS 口径与东财主力净流入不可直接比较） */
  mainNet: number | null;
  /** 上涨家数 */
  upCount: number | null;
  /** 下跌家数 */
  downCount: number | null;
}

/**
 * 按 GBK 解码响应体（同花顺清单页为 GBK；无 TextDecoder('gbk') 时退回 UTF-8）
 * @param buffer 响应原始字节
 * @returns 解码后的文本
 */
export const decodeGbk = (buffer: ArrayBuffer): string => {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
};

/**
 * 单元格纯文本（去标签、解码常见实体、收空白）
 * @param html 单元格 HTML
 * @returns 纯文本
 */
const cellText = (html: string): string =>
  html
    .replace(HTML_TAG_PATTERN, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();

/**
 * 单元格数值（占位符与非数一律 null，绝不当 0 用）
 * @param html 单元格 HTML
 * @returns 数值；无法解析为 null
 */
const cellNumber = (html: string): number | null => {
  const text = cellText(html).replace(/,/g, '');
  if (VALUE_PLACEHOLDER.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/**
 * 解析清单页 HTML 的板块锚点（纯函数；行业只留 881xxx，概念留 885xxx/30xxxx）
 * @param html 清单页 HTML（已按 GBK 解码）
 * @param kind 板块类别
 * @returns 板块清单（按页面出现顺序去重）
 */
export const parseBoardListHtml = (html: string, kind: BoardKind): { code: string; name: string }[] => {
  const seen = new Set<string>();
  const boards: { code: string; name: string }[] = [];
  for (const match of html.matchAll(BOARD_LIST_ANCHOR_PATTERN)) {
    const code = match[1];
    const name = match[2].trim();
    const okPrefix =
      kind === 'industry'
        ? code.startsWith(THS_INDUSTRY_CODE_PREFIX)
        : code.startsWith('885') || code.startsWith('30');
    if (!okPrefix || !name || seen.has(code)) continue;
    seen.add(code);
    boards.push({ code, name });
  }
  return boards;
};

/**
 * 解析清单页的快照行（纯函数；列序实测见 BOARD_CELL_INDEX）
 * @param html 清单页 HTML（已按 GBK 解码）
 * @param kind 板块类别
 * @returns 快照行（按页面顺序去重）
 */
export const parseBoardListSnapshotHtml = (html: string, kind: BoardKind): ThsSnapshotRow[] => {
  const rows: ThsSnapshotRow[] = [];
  const seen = new Set<string>();
  for (const rowMatch of html.matchAll(BOARD_ROW_PATTERN)) {
    const rowHtml = rowMatch[1];
    const codeMatch = BOARD_ROW_CODE_PATTERN.exec(rowHtml);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    const okPrefix =
      kind === 'industry'
        ? code.startsWith(THS_INDUSTRY_CODE_PREFIX)
        : code.startsWith('885') || code.startsWith('30');
    if (!okPrefix || seen.has(code)) continue;
    const cells = [...rowHtml.matchAll(BOARD_CELL_PATTERN)].map((cell) => cell[1]);
    if (cells.length < BOARD_ROW_MIN_CELLS) continue;
    seen.add(code);
    const amountYi = cellNumber(cells[BOARD_CELL_INDEX.AMOUNT]);
    const netYi = cellNumber(cells[BOARD_CELL_INDEX.NET_INFLOW]);
    rows.push({
      code,
      name: cellText(cells[BOARD_CELL_INDEX.NAME]) || code,
      pctChg: cellNumber(cells[BOARD_CELL_INDEX.CHANGE_PERCENT]),
      amount: amountYi === null ? null : amountYi * YUAN_PER_YI,
      turnover: null,
      mainNet: netYi === null ? null : netYi * YUAN_PER_YI,
      upCount: cellNumber(cells[BOARD_CELL_INDEX.RISE]),
      downCount: cellNumber(cells[BOARD_CELL_INDEX.FALL]),
    });
  }
  return rows;
};

/**
 * 解析同花顺板块日 K 的 JSONP 文本（纯函数）
 *
 * 涨跌幅由相邻收盘价比值算出（接口无该字段），首日记 0。
 * @param text JSONP 文本
 * @returns 逐日行情（升序）；空数据返回空数组
 */
export const parseKlineJsonp = (text: string): ThsKlineRow[] => {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) return [];

  let payload: { data?: unknown };
  try {
    payload = JSON.parse(text.slice(start + 1, end)) as { data?: unknown };
  } catch {
    return [];
  }
  if (typeof payload.data !== 'string' || payload.data.length === 0) return [];

  const days: ThsKlineRow[] = [];
  let previousClose: number | null = null;
  for (const row of payload.data.split(';')) {
    const fields = row.split(',');
    if (fields.length < KLINE_MIN_FIELDS) continue;
    const rawDate = fields[KLINE_FIELD.DATE];
    const close = Number(fields[KLINE_FIELD.CLOSE]);
    const amount = Number(fields[KLINE_FIELD.AMOUNT]);
    if (rawDate.length !== KLINE_DATE_LENGTH || !Number.isFinite(close) || close <= 0) continue;
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    const open = Number(fields[KLINE_FIELD.OPEN]);
    const high = Number(fields[KLINE_FIELD.HIGH]);
    const low = Number(fields[KLINE_FIELD.LOW]);
    const volume = Number(fields[KLINE_FIELD.VOLUME]);
    previousClose = previousClose ?? close;
    days.push({
      date,
      open: Number.isFinite(open) && open > 0 ? open : null,
      high: Number.isFinite(high) && high > 0 ? high : null,
      low: Number.isFinite(low) && low > 0 ? low : null,
      close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : null,
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    });
  }
  return days;
};

// ---------- 取数 ----------

/**
 * 拉取一个类别的清单页 HTML（GBK 解码；`{page}` 由调用方替换）
 * @param deps 宿主能力集合
 * @param kind 板块类别
 * @param page 页码（首页传 0 走 THS_LIST_URL，其余走翻页 URL）
 * @returns HTML 文本
 */
const fetchListHtml = async (deps: SentimentDeps, kind: BoardKind, page: number): Promise<string> => {
  const url =
    page <= 0 ? THS_LIST_URL[kind] : `${THS_LIST_PAGE_URL[kind]}${page}/ajax/1/`;
  const response = await deps.http.fetch(url, { headers: { Referer: THS_REFERER } });
  if (!response.ok) throw new Error(`同花顺${kind === 'industry' ? '行业' : '概念'}清单第 ${page || 1} 页 HTTP ${response.status}`);
  return decodeGbk(await response.arrayBuffer());
};

/**
 * 拉取一个类别的板块清单 + 当日快照（首页给锚点全表 + 第一页表格，翻页补齐）
 *
 * 翻页失败只降级不抛错（快照行变少但清单仍在）；解析全空才抛错。
 * @param deps 宿主能力集合
 * @param kind 板块类别
 * @returns 板块清单与快照行
 */
export const fetchThsBoardList = async (
  deps: SentimentDeps,
  kind: BoardKind,
): Promise<{ refs: { code: string; name: string }[]; rows: ThsSnapshotRow[] }> => {
  const firstHtml = await fetchListHtml(deps, kind, 0);
  const refs = parseBoardListHtml(firstHtml, kind);
  const pages: ThsSnapshotRow[][] = [parseBoardListSnapshotHtml(firstHtml, kind)];

  const seen = new Set(pages[0].map((row) => row.code));
  for (let page = 2; page <= THS_LIST_MAX_PAGES; page += 1) {
    try {
      await deps.format.delay(SCAN_DELAY_MS);
      const pageRows = parseBoardListSnapshotHtml(await fetchListHtml(deps, kind, page), kind);
      if (pageRows.length === 0 || pageRows.every((row) => seen.has(row.code))) break;
      for (const row of pageRows) seen.add(row.code);
      pages.push(pageRows);
    } catch (error) {
      console.warn(`[plugin] dsh-sentiment-index 同花顺清单第 ${page} 页取数失败（降级跳过）`, error);
      break;
    }
  }

  const rows = pages.flat();
  if (refs.length === 0 && rows.length === 0) {
    throw new Error(`同花顺${kind === 'industry' ? '行业' : '概念'}清单解析为空`);
  }
  return { refs: refs.length > 0 ? refs : rows.map((row) => ({ code: row.code, name: row.name })), rows };
};

/**
 * 拉取单个板块的日 K（当年 → 近端 last → 去年，各试前复权与不复权）
 * @param deps 宿主能力集合
 * @param code 板块代码（88xxxx / 885xxx，行业与概念同 48 市场号）
 * @param year 当前年份
 * @returns 逐日行情（升序）；全部候选失败抛错
 */
export const fetchThsBoardKline = async (
  deps: SentimentDeps,
  code: string,
  year: number,
): Promise<ThsKlineRow[]> => {
  const files = [String(year), 'last', String(year - 1)];
  const adjusts = ['01', '00'];
  let lastError = '';
  for (const file of files) {
    for (const adjust of adjusts) {
      const url = `${THS_BOARD_KLINE_URL_BASE}${code}${THS_BOARD_KLINE_URL_MIDDLE}${adjust}/${file}.js`;
      for (let attempt = 0; attempt < THS_BOARD_KLINE_URL_ATTEMPTS; attempt += 1) {
        try {
          const response = await deps.http.fetch(url, { headers: { Referer: THS_REFERER } });
          if (!response.ok) {
            lastError = `HTTP ${response.status}`;
            // 5xx 网关瞬时簇：同候选原地小步重试一次再换（dsh-mainline 实测有效）
            if (response.status >= THS_HTTP_SERVER_ERROR_MIN && attempt + 1 < THS_BOARD_KLINE_URL_ATTEMPTS) {
              await deps.format.delay(SCAN_DELAY_MS);
              continue;
            }
            break;
          }
          const days = parseKlineJsonp(decodeGbk(await response.arrayBuffer()));
          if (days.length > 0) return days;
          lastError = '空数据';
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          break;
        }
      }
    }
  }
  throw new Error(`同花顺板块日K不可用：${code}（${lastError}）`);
};
