/**
 * 插件 dsh-broad-track（宽基跟踪）· 取数层（东方财富 + 新浪）
 *
 * 四个 fetch 包装，全部走宿主 `app:http`（Tauri 走 Rust 直连 / 浏览器走 /stock-proxy，
 * `eastmoney.com` / `sina.cn` / `sinajs.cn` / `sina.com.cn` 均已在代理白名单与
 * Tauri capabilities 内，无需新增配置）。
 *
 * 频率纪律（东财会封 IP）：
 * - 同上游**串行** + 请求之间留间隔（行情域 600ms / F10 域 600ms）；
 * - 东财掐连接是常态（`fetch failed`，非 HTTP 错误码）→ 原地小步重试是唯一有效兜底；
 * - 只由用户点击「刷新日频 / 同步季度」触发，**不轮询**；结果落库后重进页面不再联网。
 *
 * 请求量估算（清单 14 只 ETF + 6 指数）：
 * - 刷新日频：ulist 行情 1 + ulist 指数 1 + fflow 14 ≈ 16 次；
 * - 同步季度：gmbd 14 + cyrjg 14 = 28 次。
 *
 * ⚠️ **多源降级（2026-10-25）**：本机出口会整域掐断东财行情域
 * （`push2` / `push2delay` / `push2his` 全系 TCP RST）。故：
 * - 行情快照：`fetchQuoteBatch` → 失败则 `fetchSinaHqQuotes`；
 * - 每日资金流：`fetchFflowDays` → `push2his` 失败则 `push2delay` →
 *   再失败则新浪 `MoneyFlow.ssl_qsfx_zjlrqs`（**只有主力 + 超大单两档**）。
 * 详见 `constants.ts` 头注释的口径说明。
 *
 * ⚠️ 宿主能力（网络请求与限速节拍）**不由本模块 import**，而是以 `deps` 形式沿调用链注入：
 * 本插件最终以单文件产物分发，运行时拿不到任何宿主模块。
 */
import {
  EM_F10_ARCHIVES_URL,
  EM_F10_CODE_TOKEN,
  EM_F10_GMBD_MODE_SHARES,
  EM_F10_MODE_TOKEN,
  EM_F10_QUERY,
  EM_F10_REFERER,
  EM_F10_TYPE_CYRJG,
  EM_F10_TYPE_GMBD,
  EM_F10_TYPE_TOKEN,
  EM_F10_VAR_CYRJG,
  EM_F10_VAR_GMBD,
  EM_FETCH_ATTEMPTS,
  EM_FETCH_RETRY_DELAY_MS,
  EM_FFLOW_FALLBACK_URL,
  EM_FFLOW_LIMIT_TOKEN,
  EM_FFLOW_QUERY,
  EM_FFLOW_SECID_TOKEN,
  EM_FFLOW_URL,
  EM_QUOTE_REFERER,
  EM_ULIST_DELAY_MS,
  EM_ULIST_QUERY,
  EM_ULIST_SECIDS_TOKEN,
  EM_ULIST_URL,
  FFLOW_DAYS,
  SINA_HQ_REFERER,
  SINA_HQ_URL,
  SINA_KLINE_REFERER,
  SINA_KLINE_URL,
  SINA_MONEYFLOW_LIMIT_TOKEN,
  SINA_MONEYFLOW_QUERY,
  SINA_MONEYFLOW_SYMBOL_TOKEN,
  SINA_MONEYFLOW_URL,
  ULIST_BATCH_SIZE,
} from './constants';
import {
  extractF10Object,
  parseCyrjgTable,
  parseFflowKlines,
  parseGmbdTable,
  parseSinaHqQuotes,
  parseSinaKline,
  parseSinaMoneyFlow,
  parseUlistQuotes,
} from './em-parse';
import type { FflowDayRow, SinaKlineRow } from './em-parse';
import type { BroadDeps, EtfHolderRow, EtfQuarterRow, QuoteRow } from './types';

/**
 * 带原地重试的一次请求（东财掐连接是常态，等一小会重试即恢复）
 * @param deps 宿主能力
 * @param url 请求地址
 * @param referer Referer 头
 * @returns 响应文本
 */
const fetchTextWithRetry = async (
  deps: BroadDeps,
  url: string,
  referer: string,
): Promise<string> => {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < EM_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.format.delay(EM_FETCH_RETRY_DELAY_MS);
    try {
      const response = await deps.http.fetch(url, { headers: { Referer: referer } });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      return await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
};

/**
 * 取一次响应并按 GBK 解码（新浪 hq 源用；纯 ASCII 内容不受影响）
 *
 * 宿主的 `app:http` 是**字节透传**（Tauri 走 Rust 直连），新浪 hq 的中文名是
 * GBK 编码 —— 直接 `response.text()` 会按 UTF-8 解出乱码。故这里取
 * `arrayBuffer()` 后按 GBK 解码。
 *
 * ⚠️ `TextDecoder` 的 `gbk` 标签在浏览器 / Tauri WebView / Node 18+ 均受支持
 * （WHATWG Encoding 标准把 gbk 列为必需编码）。若运行环境不支持，退回 UTF-8
 * 解码（数值字段不受影响，只有中文名会乱码）。
 * @param deps 宿主能力
 * @param url 请求地址
 * @param referer Referer 头
 * @returns 解码后的响应文本
 */
const fetchTextGbk = async (
  deps: BroadDeps,
  url: string,
  referer: string,
): Promise<string> => {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < EM_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.format.delay(EM_FETCH_RETRY_DELAY_MS);
    try {
      const response = await deps.http.fetch(url, { headers: { Referer: referer } });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const buffer = await response.arrayBuffer();
      try {
        return new TextDecoder('gbk').decode(buffer);
      } catch {
        return new TextDecoder('utf-8').decode(buffer);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
};

/**
 * 分批一个 secid 清单（保持顺序；ulist 单批上限见 ULIST_BATCH_SIZE）
 * @param secids secid 清单
 * @returns secid 分批
 */
export const chunkSecids = (secids: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  for (let index = 0; index < secids.length; index += ULIST_BATCH_SIZE) {
    chunks.push(secids.slice(index, index + ULIST_BATCH_SIZE));
  }
  return chunks;
};

/**
 * 批量拉取行情快照（ETF 与指数共用；分批串行）
 *
 * 主源是东财 `ulist.np`；**该域被掐断时自动降级到新浪 hq**
 * （新浪一次请求即可带全部标的，且与腾讯源交叉核对过价格 / 涨跌幅 / 成交额一致）。
 *
 * ⚠️ 降级后返回的行里 `code` 是 6 位裸码（东财 secid 的第二段），
 * 与主源口径一致，调用方无需区分。
 * @param deps 宿主能力
 * @param secids secid 清单（如 `1.510300` / `1.000300`）
 * @param onRequest 每完成一个批次请求回调一次（进度条计数）
 * @returns 行情行（按上游顺序；个别 secid 缺席 = 上游无数据，不报错）
 */
export const fetchQuoteBatch = async (
  deps: BroadDeps,
  secids: readonly string[],
  onRequest?: () => void,
): Promise<QuoteRow[]> => {
  const merged: QuoteRow[] = [];
  let first = true;
  for (const chunk of chunkSecids(secids)) {
    if (!first) await deps.format.delay(EM_ULIST_DELAY_MS);
    first = false;
    const query = EM_ULIST_QUERY.replace(EM_ULIST_SECIDS_TOKEN, chunk.join(','));
    const text = await fetchTextWithRetry(deps, `${EM_ULIST_URL}?${query}`, EM_QUOTE_REFERER);
    merged.push(...parseUlistQuotes(text));
    onRequest?.();
  }
  return merged;
};

/**
 * 批量拉取行情快照（**新浪降级源**）
 *
 * 东财行情域整域不可达时接管：一次请求带全部新浪符号，GBK 解码后解析。
 * @param deps 宿主能力
 * @param symbols 新浪符号清单（如 `sh510300` / `sh000300`）
 * @returns 行情行（按上游顺序）
 */
export const fetchSinaHqQuotes = async (
  deps: BroadDeps,
  symbols: readonly string[],
): Promise<QuoteRow[]> => {
  if (symbols.length === 0) return [];
  const url = SINA_HQ_URL.replace('{symbols}', symbols.join(','));
  const text = await fetchTextGbk(deps, url, SINA_HQ_REFERER);
  return parseSinaHqQuotes(text);
};

/**
 * 拉取单只 ETF 的每日资金流（近 FFLOW_DAYS 个交易日，降序）
 *
 * 三级降级链（2026-10-25）：
 * 1. 东财 `push2his`（**主源**，历史完整 —— 121 条）；
 * 2. 东财 `push2delay`（同构，但历史被截断为当日 1 条）；
 * 3. 新浪 `MoneyFlow.ssl_qsfx_zjlrqs`（**只有主力 + 超大单两档**）。
 *
 * @param deps 宿主能力
 * @param secid ETF secid（`1.510300` 形态）
 * @param sinaSymbol 新浪符号（`sh510300` 形态；降级到新浪时用）
 * @param onRequest 每完成一次请求回调一次（进度条计数；**降级链只计一次** ——
 *   对用户而言这是同一步骤的取数，重试不额外占用进度条）
 * @returns 逐日资金流行（降序，首行最新）；空数据返回空数组
 */
export const fetchFflowDays = async (
  deps: BroadDeps,
  secid: string,
  sinaSymbol: string,
  onRequest?: () => void,
): Promise<FflowDayRow[]> => {
  const query = EM_FFLOW_QUERY.replace(EM_FFLOW_SECID_TOKEN, secid).replace(
    EM_FFLOW_LIMIT_TOKEN,
    String(FFLOW_DAYS),
  );

  // ① 主源 push2his（历史完整）
  try {
    const text = await fetchTextWithRetry(deps, `${EM_FFLOW_URL}?${query}`, EM_QUOTE_REFERER);
    const rows = parseFflowKlines(text);
    if (rows.length > 0) {
      onRequest?.();
      return rows;
    }
  } catch {
    // 落到②继续
  }

  // ② 域内互备 push2delay（历史仅当日 1 条，口径与主源一致）
  try {
    const text = await fetchTextWithRetry(
      deps,
      `${EM_FFLOW_FALLBACK_URL}?${query}`,
      EM_QUOTE_REFERER,
    );
    const rows = parseFflowKlines(text);
    if (rows.length > 0) {
      onRequest?.();
      return rows;
    }
  } catch {
    // 落到③继续
  }

  // ③ 二级降级新浪（两档口径）
  const sinaQuery = SINA_MONEYFLOW_QUERY
    .replace(SINA_MONEYFLOW_SYMBOL_TOKEN, sinaSymbol)
    .replace(SINA_MONEYFLOW_LIMIT_TOKEN, String(FFLOW_DAYS));
  const sinaText = await fetchTextWithRetry(deps, `${SINA_MONEYFLOW_URL}?${sinaQuery}`, SINA_KLINE_REFERER);
  onRequest?.();
  return parseSinaMoneyFlow(sinaText);
};

/**
 * 拉取单只 ETF 的季度份额申赎（F10 `type=gmbd&mode=0`，降序）
 * @param deps 宿主能力
 * @param code 6 位裸代码
 * @param onRequest 每完成一次请求回调一次（进度条计数）
 * @returns 季度行（降序）；空表返回空数组
 */
export const fetchGmbdRows = async (
  deps: BroadDeps,
  code: string,
  onRequest?: () => void,
): Promise<EtfQuarterRow[]> => {
  const query = EM_F10_QUERY.replace(EM_F10_TYPE_TOKEN, EM_F10_TYPE_GMBD)
    .replace(EM_F10_MODE_TOKEN, EM_F10_GMBD_MODE_SHARES)
    .replace(EM_F10_CODE_TOKEN, code);
  const text = await fetchTextWithRetry(
    deps,
    `${EM_F10_ARCHIVES_URL}?${query}`,
    EM_F10_REFERER,
  );
  onRequest?.();
  const payload = extractF10Object(text, EM_F10_VAR_GMBD);
  if (!payload || typeof payload.content !== 'string') return [];
  return parseGmbdTable(payload.content, code);
};

/**
 * 拉取单只 ETF 的持有人结构（F10 `type=cyrjg`，降序）
 * @param deps 宿主能力
 * @param code 6 位裸代码
 * @param onRequest 每完成一次请求回调一次（进度条计数）
 * @returns 持有人结构行（降序）；空表返回空数组
 */
export const fetchCyrjgRows = async (
  deps: BroadDeps,
  code: string,
  onRequest?: () => void,
): Promise<EtfHolderRow[]> => {
  const query = EM_F10_QUERY.replace(EM_F10_TYPE_TOKEN, EM_F10_TYPE_CYRJG)
    .replace(EM_F10_MODE_TOKEN, '')
    .replace(EM_F10_CODE_TOKEN, code);
  const text = await fetchTextWithRetry(
    deps,
    `${EM_F10_ARCHIVES_URL}?${query}`,
    EM_F10_REFERER,
  );
  onRequest?.();
  const payload = extractF10Object(text, EM_F10_VAR_CYRJG);
  if (!payload || typeof payload.content !== 'string') return [];
  return parseCyrjgTable(payload.content, code);
};

/**
 * 拉取单只 ETF 的新浪日 K（近 N 个交易日，升序）
 *
 * 用途只有一个：**成交额历史**。东财 K 线在 push2delay 上不可用（rc=102），
 * 同花顺 line 对 ETF 404；新浪 K 线给成交量（股）× 收盘价 ≈ 成交额，
 * 由 scan 层用当日东财精确成交额校准（见 `calibrateAmounts`）。
 * @param deps 宿主能力
 * @param symbol 新浪代码（`sh510300` / `sz159915`）
 * @param days 交易日数
 * @param onRequest 每完成一次请求回调一次（进度条计数）
 * @returns 逐日 K 线行（升序）；空数据返回空数组
 */
export const fetchSinaKline = async (
  deps: BroadDeps,
  symbol: string,
  days: number,
  onRequest?: () => void,
): Promise<SinaKlineRow[]> => {
  const url = `${SINA_KLINE_URL}?symbol=${symbol}&scale=240&ma=no&datalen=${days}`;
  const text = await fetchTextWithRetry(deps, url, SINA_KLINE_REFERER);
  onRequest?.();
  return parseSinaKline(text);
};
