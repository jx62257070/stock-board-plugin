/**
 * 插件 dsh-broad-track（宽基跟踪）· 份额序列解析（纯函数）
 *
 * 本模块只做「文本 → 结构」的转换，不碰网络与宿主能力，因此可以喂固定
 * fixture 做断言测试（见 `scripts/check-broad-track-parse.mjs`）。
 *
 * 三个上游的口径：
 * - **上交所** `query.sse.com.cn/commonQuery.do`（单日全市场 924 只 ETF）：
 *   `result[]` 每行 `{ STAT_DATE, ETF_TYPE, SEC_CODE, NUM, SEC_NAME, TOT_VOL }`，
 *   `TOT_VOL` 单位**万份**（`510300` = `3524268.77` → 352.4269 亿份）。
 * - **深交所** `fund.szse.cn/api/report/ShowReport`（`CATALOGID=fund_jjgm`）：
 *   按代码 + 日期区间查逐日份额，`data[]` 每行 `{ size_date, current_size, … }`，
 *   `current_size` 单位同样是**万份**。
 * - **腾讯** `web.ifzq.gtimg.cn/appstock/app/kline/kline`（历史收盘价）：
 *   `data.<symbol>.day` 每行 `[date, open, close, high, low, volume, …]`。
 *
 * ⚠️ **份额是「份数」不是「金额」**：净申赎金额需要用当日收盘价折算
 * （Δ份额 × 收盘价），价格缺失时只保留份额变动、金额留 `null`。
 */

/** 上交所单日份额行（解析后） */
export interface SseShareRow {
  /** 6 位裸代码 */
  code: string;
  /** 上游名称 */
  name: string;
  /** 该行对应的统计日（YYYY-MM-DD） */
  date: string;
  /** 总份额（亿份） */
  sharesYi: number;
}

/** 深交所逐日份额行（解析后） */
export interface SzseShareRow {
  /** 6 位裸代码 */
  code: string;
  /** 份额日期（YYYY-MM-DD） */
  date: string;
  /** 总份额（亿份） */
  sharesYi: number;
}

/** 腾讯日 K 一行（只取本插件需要的字段） */
export interface TencentKlineRow {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 收盘价（元，不复权口径与份额折算一致） */
  close: number;
  /** 成交量（手） */
  volume: number;
}

/** 万份 → 亿份的换算系数（1 万份 = 1e4 份；1 亿份 = 1e8 份） */
const WAN_TO_YI = 1e4 / 1e8;

/**
 * 安全转数字（非有限数返回 null）
 * @param value 未知值
 * @returns 数值或 null
 */
const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // 上游数字可能带千分位逗号
    const cleaned = value.replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * 规范化日期（`2026-10-23` / `2026/10/23` → `2026-10-23`）
 * @param value 上游日期串
 * @returns 规范化日期；不可识别返回空串
 */
export const normalizeDate = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(trimmed);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

/**
 * 解析上交所「单日全市场 ETF 份额」响应
 *
 * 上游形态：`{ result: [ { STAT_DATE, SEC_CODE, SEC_NAME, TOT_VOL }, … ] }`。
 * 坏行（缺代码 / 份额非数）直接丢弃，不抛错 —— 上游偶尔混脏行。
 * @param text 响应文本（JSON）
 * @param fallbackDate 上游未带 STAT_DATE 时用的日期（形如 `2026-10-23`）
 * @returns 份额行（按上游顺序）
 */
export const parseSseShareSnapshot = (text: string, fallbackDate: string): SseShareRow[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];

  const rows: SseShareRow[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const code = typeof row.SEC_CODE === 'string' ? row.SEC_CODE.trim() : '';
    if (!/^\d{6}$/.test(code)) continue;
    const rawShares = toNumber(row.TOT_VOL);
    if (rawShares === null || rawShares <= 0) continue;
    const date = normalizeDate(row.STAT_DATE) || normalizeDate(fallbackDate);
    if (!date) continue;
    rows.push({
      code,
      name: typeof row.SEC_NAME === 'string' ? row.SEC_NAME.trim() : '',
      date,
      sharesYi: rawShares * WAN_TO_YI,
    });
  }
  return rows;
};

/**
 * 解析深交所 `fund_jjgm`（逐日份额）响应
 *
 * 上游形态：`[ { metadata: { pagecount }, data: [ { size_date, current_size } ] } ]`。
 * @param text 响应文本（JSON）
 * @param code 6 位裸代码（上游不带代码时用它补齐）
 * @returns 份额行（按上游顺序）
 */
export const parseSzseShareHistory = (text: string, code: string): SzseShareRow[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const rows: SzseShareRow[] = [];
  for (const block of payload) {
    if (!block || typeof block !== 'object') continue;
    const data = (block as { data?: unknown }).data;
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const date = normalizeDate(row.size_date);
      if (!date) continue;
      const rawShares = toNumber(row.current_size);
      if (rawShares === null || rawShares <= 0) continue;
      rows.push({ code, date, sharesYi: rawShares * WAN_TO_YI });
    }
  }
  return rows;
};

/**
 * 解析腾讯日 K 响应（取收盘价 + 成交量）
 *
 * 上游形态：`{ data: { <symbol>: { day: [ [date, open, close, high, low, volume, …] ] } } }`。
 *
 * ⚠️ **优先取 `day`（不复权）而不是 `qfqday`（前复权）**，两个原因：
 * 1. **数据完整性**：腾讯的前复权序列起点更晚（实测 2024-03-04 起、640 行），
 *    不复权序列覆盖全部 678 个交易日（2024-01-02 起）—— 早复权会丢历史；
 * 2. **口径正确性**：份额折算金额用的是「当日实际成交价」，
 *    不复权价才是当日真实市值（分红日的价格跳空是真实的市值变化）。
 *
 * 复权序列（`qfqday`）仅作 `day` 缺失时的兜底。
 * @param text 响应文本（JSON）
 * @param symbol 腾讯符号（如 `sh510300`）
 * @returns 日 K 行（按上游顺序，通常升序）
 */export const parseTencentKline = (text: string, symbol: string): TencentKlineRow[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const node = (data as Record<string, unknown>)[symbol];
  if (!node || typeof node !== 'object') return [];

  const container = node as Record<string, unknown>;
  const list = Array.isArray(container.day)
    ? container.day
    : Array.isArray(container.qfqday)
      ? container.qfqday
      : null;
  if (!list) return [];

  const rows: TencentKlineRow[] = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const date = normalizeDate(item[0]);
    if (!date) continue;
    const close = toNumber(item[2]);
    if (close === null || close <= 0) continue;
    const volume = toNumber(item[5]);
    rows.push({ date, close, volume: volume === null ? 0 : volume });
  }
  return rows;
};

/**
 * 把逐只份额行汇总成「日期 → 代码 → 份额」的映射
 *
 * 同 (date, code) 重复出现时**后者覆盖前者**（上游改数时以最后一条为准）。
 * @param rows 份额行
 * @returns 嵌套映射
 */
export const groupSharesByDate = (
  rows: readonly (SseShareRow | SzseShareRow)[],
): Map<string, Map<string, number>> => {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let bucket = grouped.get(row.date);
    if (!bucket) {
      bucket = new Map<string, number>();
      grouped.set(row.date, bucket);
    }
    bucket.set(row.code, row.sharesYi);
  }
  return grouped;
};

/**
 * 计算「日期 → 代码 → 份额变动」与「净申赎金额」
 *
 * 变动 = 当日份额 − 前一交易日份额（前一交易日 = 排序后的上一个有数据的日期，
 * **不要求日历连续** —— 交易所假期会让日历出现空档，用「上一个有数据日」才是对的）。
 *
 * 金额（亿元）= 份额变动（亿份）× 收盘价（元）。价格缺失时金额为 `null`（不是 0）。
 *
 * ⚠️ **价格必须按 code 分开取**（`Map<code, Map<date, price>>`）：
 * 不同 ETF 的价格量级差异极大，混在一张 map 里会让某只 ETF 缺数据的日子
 * 被另一只 ETF 的价格顶上，直接把金额与指数算飞。
 * @param rows 逐只份额行（同一 code 的行会被合并成时间序列）
 * @param pricesByCode 代码 → 日期 → 收盘价
 * @returns 逐日逐只的份额变动与金额
 */
export const computeShareChanges = (
  rows: readonly (SseShareRow | SzseShareRow)[],
  pricesByCode: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, Map<string, { deltaYi: number; amountYi: number | null }>> => {
  // code → 按日期升序的份额序列
  const byCode = new Map<string, { date: string; sharesYi: number }[]>();
  for (const row of rows) {
    let bucket = byCode.get(row.code);
    if (!bucket) {
      bucket = [];
      byCode.set(row.code, bucket);
    }
    bucket.push({ date: row.date, sharesYi: row.sharesYi });
  }

  const changes = new Map<string, Map<string, { deltaYi: number; amountYi: number | null }>>();
  for (const [code, bucket] of byCode) {
    bucket.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
    const prices = pricesByCode.get(code);
    for (let index = 1; index < bucket.length; index += 1) {
      const previous = bucket[index - 1];
      const current = bucket[index];
      const deltaYi = current.sharesYi - previous.sharesYi;
      const price = prices?.get(current.date);
      let dayBucket = changes.get(current.date);
      if (!dayBucket) {
        dayBucket = new Map<string, { deltaYi: number; amountYi: number | null }>();
        changes.set(current.date, dayBucket);
      }
      dayBucket.set(code, {
        deltaYi,
        amountYi: price === undefined ? null : deltaYi * price,
      });
    }
  }
  return changes;
};
