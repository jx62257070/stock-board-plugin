/**
 * 插件 dsh-broad-track（宽基跟踪）· 全部常量
 *
 * 定位：跟踪宽基 ETF 的流入流出，预估「国家队」持仓与操作。
 * 国家队（中央汇金 / 汇金资管 / 证金 / 梧桐树 / 国新等）在 A 股的主要动作是
 * **申购宽基 ETF**（而非买个股）——它的足迹留在三处：
 * 1. **日频**：宽基 ETF 的二级市场资金流（主力 / 超大单净流入）与成交额异动；
 * 2. **季频**：定期报告披露的份额申赎（期间申购 / 赎回 / 期末总份额）；
 * 3. **半年频**：持有人结构（机构持有比例）佐证。
 *
 * 数据源（2026-10-25 本机实测，证据见 README「数据源与口径」）：
 * - 行情快照（ETF / 指数）：`push2delay.eastmoney.com/api/qt/ulist.np/get`；
 * - ETF 每日资金流：`push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get`
 *   （klines 行 = 日期,主力,小单,中单,大单,超大单,五路净占比,收盘价,涨跌幅,0,0）；
 * - 季度份额申赎：`fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&mode=0`
 *   （⚠️ mode 参数必须带：0 = 份额规模变动，1 = 净资产规模变动）；
 * - 半年度持有人结构：同接口 `type=cyrjg`。
 *
 * ⚠️ **多源降级链（2026-10-25 新增，务必先读）**
 *
 * 本机出口会**整域**掐断东财行情域（`push2` / `push2delay` / `push2his` 及其
 * 数字镜像在 TCP 层被 RST，表现为 `fetch failed` / `other side closed`，
 * **不是 HTTP 错误码**）。2026-10-25 凌晨实测：8 个域 × 2 条路径共 16 次探测，
 * 全部断连；同刻 `fundf10` / 新浪 / 腾讯 / `datacenter-web` 全部 200。
 *
 * 因此日频取数**不再单点依赖东财行情域**，而是「主源 → 降级源」两段式：
 * - 行情快照：东财 `ulist` →（失败）宿主 `app:quotes`（腾讯源，宿主已处理 GBK 转码）；
 * - 每日资金流：东财 `push2his` `fflow` →（失败）东财 `push2delay` `fflow`
 *   →（失败）新浪 `MoneyFlow.ssl_qsfx_zjlrqs`（**只给主力 + 超大单两档**）。
 *
 * ⚠️ 降级到新浪资金流时**只有主力与超大单两档**，小单 / 中单 / 大单为 `null`
 * （留空而不是当 0 用 —— 见 `em-parse.ts` 数值口径纪律）。信号引擎只用主力口径，
 * 故降级后信号判定仍成立。
 *
 * ⚠️ 资金流历史条数：宿主 `SERVER_API.md` 记录（2026-09-18 实测）——
 * **同参数下 `push2his` 返回 121 条（自 2026-03-27 起），`push2delay` 只回当日 1 条**
 * （`lmt=0` 也一样）。故资金流主源取 `push2his`，`push2delay` 降级仅作兜底
 * （此时历史只有 1 天，页面时间线会很短，但口径与主源一致）。
 *
 * ⚠️ 宿主能力（网络请求与限速节拍）**不由本模块 import**，而是以 `deps` 形式
 * 沿调用链注入：本插件最终以单文件产物分发，运行时拿不到任何宿主模块。
 */

/** 插件 id */
export const BROAD_PLUGIN_ID = 'dsh-broad-track';

/** 左侧导航路径（菜单贡献点带 component 时自动注册该路由） */
export const BROAD_MENU_PATH = '/broad-track';

/** 左侧导航标题 */
export const BROAD_MENU_TITLE = '宽基跟踪';

/** 菜单图标（MenuIcon 的 key：funds = 趋势线） */
export const BROAD_MENU_ICON = 'funds';

/** 页面标题 */
export const BROAD_PAGE_TITLE = '宽基跟踪';

/** 页面副标题（口径与硬约束） */
export const BROAD_PAGE_SUBTITLE =
  '跟踪宽基 ETF 的流入流出，预估国家队持仓与操作：日频看二级市场资金流（主力 / 超大单净流入）与成交额异动，'
  + '季频看份额申赎（申购 / 赎回），半年频看持有人结构；持仓预估 = 披露锚点 + 报告期后净申购按机构占比分摊。辅助研究工具，预估不构成投资建议。';

// ---------- 宽基 ETF 清单 ----------

/** 一只被跟踪的宽基 ETF */
export interface TrackedEtf {
  /** 6 位裸代码（如 `510300`） */
  code: string;
  /** 展示名（稳定口径，不随上游改名） */
  name: string;
  /** 跟踪的宽基指数名（展示用） */
  indexName: string;
  /** 东财 secid 市场前缀：`1.` = 沪，`0.` = 深 */
  market: '1' | '0';
}

/**
 * 被跟踪的宽基 ETF 清单（17 只）
 *
 * 选样口径：国家队的主战场是**规模大、跟踪主流宽基指数**的 ETF —— 汇金等公告增持
 * 的对象集中在此。每只指数取规模最大的 2-4 只，覆盖沪 / 深两个市场。
 * 清单固定写死（不搞用户自定义）：样本外的 ETF 对「国家队操作」没有解释力。
 *
 * ⚠️ **中证1000 收 4 只（2026-10-28 扩充）**：2024-02 救市时汇金同时大额申购了
 * 南方 512100 / 华夏 159845 / 广发 560010（富国 159629 同期跟进）——只跟踪南方一只
 * 会系统性低估当时中证1000 方向的进场强度。159845 / 159629 在深市（走深交所
 * fund_jjgm），560010 在沪市（走上交所全市场快照）。
 *
 * ⚠️ **组合指数仍是基准日固定市值权重**：晚于基准日（序列首日）才有份额的
 * 新成员不会进入指数权重（指数口径不变、量纲连续），但会进入总份额 / 净申赎柱
 * —— 柱的金额量级会随成员补齐逐步变大，确认门槛据此可能需要重新校准。
 */
export const TRACKED_ETFS: readonly TrackedEtf[] = [
  { code: '510300', name: '沪深300ETF华泰柏瑞', indexName: '沪深300', market: '1' },
  { code: '510330', name: '沪深300ETF华夏', indexName: '沪深300', market: '1' },
  { code: '510310', name: '沪深300ETF易方达', indexName: '沪深300', market: '1' },
  { code: '159919', name: '沪深300ETF嘉实', indexName: '沪深300', market: '0' },
  { code: '510050', name: '上证50ETF华夏', indexName: '上证50', market: '1' },
  { code: '510100', name: '上证50ETF易方达', indexName: '上证50', market: '1' },
  { code: '510500', name: '中证500ETF南方', indexName: '中证500', market: '1' },
  { code: '512500', name: '中证500ETF华夏', indexName: '中证500', market: '1' },
  { code: '159922', name: '中证500ETF嘉实', indexName: '中证500', market: '0' },
  { code: '512100', name: '中证1000ETF南方', indexName: '中证1000', market: '1' },
  { code: '159845', name: '中证1000ETF华夏', indexName: '中证1000', market: '0' },
  { code: '560010', name: '中证1000ETF广发', indexName: '中证1000', market: '1' },
  { code: '159629', name: '中证1000ETF富国', indexName: '中证1000', market: '0' },
  { code: '588000', name: '科创50ETF华夏', indexName: '科创50', market: '1' },
  { code: '588080', name: '科创50ETF易方达', indexName: '科创50', market: '1' },
  { code: '159915', name: '创业板ETF易方达', indexName: '创业板指', market: '0' },
  { code: '159952', name: '创业板ETF广发', indexName: '创业板指', market: '0' },
];

/**
 * 被跟踪的宽基指数（东财 secid 形态；顺序即展示顺序）
 *
 * `sinaSymbol` 是同一条指数的新浪符号（降级源用）：沪深 / 上证系列走 `sh`，
 * 深证系列（创业板指 399006）走 `sz`。
 */
export const TRACKED_INDICES: readonly {
  secid: string;
  code: string;
  name: string;
  sinaSymbol: string;
}[] = [
  { secid: '1.000300', code: '000300', name: '沪深300', sinaSymbol: 'sh000300' },
  { secid: '1.000016', code: '000016', name: '上证50', sinaSymbol: 'sh000016' },
  { secid: '1.000905', code: '000905', name: '中证500', sinaSymbol: 'sh000905' },
  { secid: '1.000852', code: '000852', name: '中证1000', sinaSymbol: 'sh000852' },
  { secid: '0.399006', code: '399006', name: '创业板指', sinaSymbol: 'sz399006' },
  { secid: '1.000688', code: '000688', name: '科创50', sinaSymbol: 'sh000688' },
];

/**
 * 代码 → 东财 secid（`1.510300` / `0.159919`）
 * @param etf 被跟踪的 ETF
 * @returns secid
 */
export const etfSecid = (etf: TrackedEtf): string => `${etf.market}.${etf.code}`;

/**
 * 代码 → 新浪符号（`sh510300` / `sz159915`）
 *
 * 同一符号同时用于新浪日 K 与新浪资金流（两个接口同用一套符号）。
 * @param etf 被跟踪的 ETF
 * @returns 新浪符号
 */
export const etfSinaSymbol = (etf: TrackedEtf): string =>
  `${etf.market === '1' ? 'sh' : 'sz'}${etf.code}`;

/** ETF 代码 → 清单条目（找不到返回 undefined） */
export const ETF_BY_CODE = new Map<string, TrackedEtf>(
  TRACKED_ETFS.map((etf) => [etf.code, etf]),
);

// ---------- 份额序列数据源（国家队观测的主口径） ----------

/**
 * 上交所逐日 ETF 份额（单日全市场，一次请求拿全部沪市 ETF）
 *
 * `STAT_DATE` 传日期即可回溯历史（实测 2024-02-05 有数据）。
 * 上游对**无 cookie / 无 Referer** 的请求会返回空体，故必须带 Referer。
 *
 * ⚠️ 白名单：`query.sse.com.cn` / `www.sse.com.cn` 需在宿主
 * `STOCK_PROXY_ALLOWED_HOSTS` 与 Tauri capabilities 内放行（见 README）。
 */
export const SSE_SHARE_URL =
  'https://query.sse.com.cn/commonQuery.do'
  + '?isPagination=true&pageHelp.pageSize=10000&pageHelp.pageNo=1'
  + '&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1'
  + '&sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&STAT_DATE={date}';

/** 上交所请求 Referer */
export const SSE_SHARE_REFERER = 'https://www.sse.com.cn/';

/** 上交所份额接口的日期占位符 */
export const SSE_SHARE_DATE_TOKEN = '{date}';

/**
 * 深交所逐日份额历史（`fund_jjgm`，按代码 + 日期区间）
 *
 * 单个区间上限约 110 个交易日，调用方需分窗（见 `share-data.ts` 的分窗逻辑）。
 * ⚠️ 该域实测偶发整域断连（连首页都不通），需重试 + 降级。
 */
export const SZSE_SHARE_URL =
  'https://fund.szse.cn/api/report/ShowReport/data'
  + '?SHOWTYPE=JSON&CATALOGID=fund_jjgm&TABKEY=tab1&txtDm={code}'
  + '&txtStart={start}&txtEnd={end}&PAGENO={page}';

/** 深交所份额接口 Referer */
export const SZSE_SHARE_REFERER = 'https://fund.szse.cn/';

/** 深交所份额接口占位符 */
export const SZSE_SHARE_CODE_TOKEN = '{code}';
/** 深交所份额接口占位符（起始日） */
export const SZSE_SHARE_START_TOKEN = '{start}';
/** 深交所份额接口占位符（结束日） */
export const SZSE_SHARE_END_TOKEN = '{end}';
/** 深交所份额接口占位符（页码） */
export const SZSE_SHARE_PAGE_TOKEN = '{page}';

/** 深交所单窗口最大天数（上游限制约 110 个交易日，留余量取 100 天） */
export const SZSE_SHARE_WINDOW_DAYS = 100;

/**
 * 腾讯历史日 K（收盘价；份额折算金额需要它）
 *
 * 显式日期区间形态：`param=<symbol>,day,<开始>,<结束>,<条数>`。
 *
 * ⚠️ **端点必须是 `kline/kline` 而不是 `fqkline/get`**（2026-10-25 实测）：
 * - `fqkline/get` 已被腾讯 WAF 拦死 —— 任何 Referer / UA 组合都返回 **HTTP 501**
 *   + 一段 `waf.tencent.com/501page.html` 跳转脚本（不是 JSON，解析器会拿到空数组）；
 * - `kline/kline`（同域 `web.ifzq.gtimg.cn`）**HTTP 200**，返回键 `day`（不复权），
 *   实测 `param=sh510300,day,2024-01-01,2026-10-24,800` → **678 行**，覆盖
 *   2024-01-02 ~ 2026-10-23，正是回测需要的完整窗口。
 *
 * ⚠️ **不要带复权参数**（`qfq` / `none`）：
 * - 带 `qfq` → 该端点只回 `{version:…}`，**没有任何 K 线数组**（行数为 0）；
 * - 不带 → 回 `day` 键 = **不复权**序列（正是我们要的口径）。
 *
 * ⚠️ 符号必须带市场前缀（`sh510300` / `sz159915`），只给 6 位代码会返回空 `data`。
 *
 * 份额折算金额用**不复权价**：那才是当日真实成交价与市值。
 */
export const TENCENT_KLINE_URL =
  'https://web.ifzq.gtimg.cn/appstock/app/kline/kline'
  + '?param={symbol},day,{start},{end},{count}';

/** 腾讯日 K Referer */
export const TENCENT_KLINE_REFERER = 'https://gu.qq.com/';

/** 腾讯日 K 占位符 */
export const TENCENT_KLINE_SYMBOL_TOKEN = '{symbol}';
/** 腾讯日 K 占位符（起始日） */
export const TENCENT_KLINE_START_TOKEN = '{start}';
/** 腾讯日 K 占位符（结束日） */
export const TENCENT_KLINE_END_TOKEN = '{end}';
/** 腾讯日 K 占位符（条数） */
export const TENCENT_KLINE_COUNT_TOKEN = '{count}';

/** 交易所域请求间隔（毫秒）—— 交易所对高频请求会掐连接 */
export const EXCHANGE_DELAY_MS = 350;

/** 交易所域重试次数 */
export const EXCHANGE_FETCH_ATTEMPTS = 3;

/** 交易所域重试间隔（毫秒） */
export const EXCHANGE_RETRY_DELAY_MS = 1200;

/**
 * 份额序列回溯起点（2024-01-01）
 *
 * 覆盖用户关心的全部历史拐点：2024-02 的 2800 点底部进场、2024-09 的 924 行情、
 * 2025-04 的关税战护盘、2026-01 的规模减持退场。
 */
export const SHARE_HISTORY_START = '2024-01-01';

/** 份额序列保留天数（上游按日全量给，这里只做兜底上限） */
export const SHARE_HISTORY_MAX_DAYS = 1200;

// ---------- 份额折算（合并 / 拆分）中和 ----------

/**
 * 折算候选的份额倍数下界（折算后 ÷ 折算前）
 *
 * 份额合并（如 2 份合 1 份）倍数 < 1。实测两只：510310 于 2024-09-20 合并
 * 倍数 0.512（当日 delta_yi = -595 亿份 ≈ -951 亿元假赎回）、510100 于
 * 2025-03-07 合并倍数 0.496。0.75 以下的单日份额收缩才值得怀疑 ——
 * 真实国家队级赎回（如 2026-01 的减持战役）单日也就 ±10~20%。
 */
export const SHARE_SPLIT_RATIO_MIN = 0.75;

/**
 * 折算候选的份额倍数上界
 *
 * 份额拆分（1 拆 2）倍数 > 1。1.35 以上才候选；2024-02-05 汇金救市时
 * 512100 单日 +132.8% 是真申购（价格没翻倍），靠价格确认排除。
 */
export const SHARE_SPLIT_RATIO_MAX = 1.35;

/**
 * 折算的价格确认容差（相对误差）
 *
 * 折算日（前后）价格必然出现 ≈ 1/份额倍数 的跳变（合并 → 价格约翻倍）。
 * 实测：510310 合并 1.9546 : 1，价格 1.597 → 3.213（倍差 2.0116，误差 2.9%）；
 * 510100 合并 2 : 1，价格 1.333 → 2.666（倍差 2.0005，误差 0.8%）。
 * ±12% 容差足以容纳折算日当天的正常涨跌，同时排除真申赎（价格纹丝不动）。
 */
export const SHARE_SPLIT_PRICE_TOLERANCE = 0.12;

/** 价格确认窗口（折算行之后的 N 个交易日内必须看到价格跳变） */
export const SHARE_SPLIT_CONFIRM_DAYS = 3;

// ---------- 份额口径信号参数 ----------

/**
 * 「国家队进场」判定：深度回调 + 连续净申购
 *
 * - 份额连续净增天数 ≥ SIGNAL_ENTER_STREAK；
 * - 且组合指数距前高回撤达标（≤ SIGNAL_ENTER_DRAWDOWN_PCT，即「从高点跌够了」）；
 * - 且区间净申购金额 ≥ SIGNAL_ENTER_MIN_AMOUNT（亿元）。
 */
export const SIGNAL_ENTER_STREAK = 3;

/**
 * 进场信号的回撤阈值（%，负数）
 *
 * 实测对比（2024-01~2026-10 真实 678 交易日回测）：-8% 档进场 17 次、胜率 63%、
 * 平均持有收益 +6.79%；旧的全样本分位口径（16 次 / 63% / 6.87%）数字接近，
 * 但它在逐日判定时用了未来数据（前视），实盘不可复算 —— 回撤口径只用截至当日的
 * 历史，且回答的是「从高点跌了多少」而不是虚的「历史排名」。
 */
export const SIGNAL_ENTER_DRAWDOWN_PCT = -8;

/** 进场信号的最小区间净申购金额（亿元） */
export const SIGNAL_ENTER_MIN_AMOUNT = 20;

/**
 * 「国家队退场」判定：接近前高 + 连续净赎回
 *
 * - 份额连续净减天数 ≥ SIGNAL_EXIT_STREAK；
 * - 且组合指数接近前高（距前高回撤 ≥ SIGNAL_EXIT_NEAR_HIGH_PCT，即「涨到高点附近」）；
 * - 且区间净赎回金额 ≥ SIGNAL_EXIT_MIN_AMOUNT（亿元，绝对值）。
 *
 * STREAK=5 的依据（2026-10-28 参数扫描，.ai/bt/scan-exit-params.cjs，679 交易日）：
 * streak 2→6 天信号后 20 日均持收益单调改善（+1.16 → -0.56%），3 天易被噪音触发；
 * MIN_AMOUNT 10~50 亿无区分度、NEAR_HIGH_PCT=-2 最优（放宽反而变差），均维持不动。
 */
export const SIGNAL_EXIT_STREAK = 5;

/** 退场信号的「接近前高」阈值（%，负数；-2 = 距前高不足 2%） */
export const SIGNAL_EXIT_NEAR_HIGH_PCT = -2;

/** 退场信号的最小区间净赎回金额（亿元，绝对值） */
export const SIGNAL_EXIT_MIN_AMOUNT = 20;

/** 回测评估的持有期（交易日）—— 信号出现后按此持有期算收益 */
export const BACKTEST_HOLD_DAYS = 20;

// ---------- 战役生命周期（疑似 / 确认 / 结束三段式） ----------

/**
 * 「疑似」档的连续同向天数（低于确认档的 SIGNAL_*_STREAK）
 *
 * 2026-10-27 变体回测（679 交易日真实份额序列，31 次确认战役）：
 * - S1（连续 2 日 或 单日过半）：疑似 194 次、转化 16%、平均领先确认 3.0 日；
 * - S2（仅连续 2 日）：129 次、24%、2.3 日；
 * - S3（仅单日过半）：187 次、17%、2.9 日。
 * 取 S1：多 0.7 日领先量。疑似层定位是预警（界面上明确标注「疑似」），
 * 误报成本低于漏掉单日百亿级首日动作（如 2024-01-16 的 2875 亿战役首日）。
 */
export const CAMPAIGN_SUSPECT_STREAK = 2;

/** 「疑似」档的单日申赎额系数（单日净申赎 ≥ 确认门槛 × 该系数即触发疑似） */
export const CAMPAIGN_SUSPECT_AMOUNT_FACTOR = 0.5;

/**
 * 「战役结束」的静默兜底天数：连续 N 个交易日份额零变动 → 战役结束
 *
 * 2026-10-27 回测：组合份额是 11 只 ETF 求和，日频上几乎不会精确为 0，
 * 该条款实际从不触发（233 段方向段全部由方向反转收尾）——保留它只是语义兜底
 * （上游缺数导致的假静默不该挂死状态机）。
 */
export const CAMPAIGN_SILENT_END_DAYS = 3;

/** 退场完成度 ≥ 该百分比（本轮退场累计 ÷ 此前累计进场余额）判「清仓」 */
export const EXIT_COMPLETION_CLEARED_PCT = 80;

/** 退场完成度 ≥ 该百分比判「轻仓」（< 该值为「减仓中」） */
export const EXIT_COMPLETION_LIGHT_PCT = 50;

/**
 * 战役卡最多展示的战役数（取最近的 N 场「有意义」战役）
 *
 * 方向段状态机会把 1 日小抖动也开成战役（真实序列 679 日 → 233 场），
 * 卡片只展示已确认、或疑似金额达标的战役并限量，避免淹没重点。
 */
export const CAMPAIGN_CARD_MAX = 15;

// ---------- 数据源 ----------

/** 东财行情域要求带 Referer，否则可能被拒 */
export const EM_QUOTE_REFERER = 'https://quote.eastmoney.com/';

/** 天天基金 F10 要求带 Referer，否则可能被拒 */
export const EM_F10_REFERER = 'https://fundf10.eastmoney.com/';

/** 批量行情快照（ETF 与指数共用；ulist.np 支持多 secid） */
export const EM_ULIST_URL = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get';

/** ulist 查询串（`{secids}` 由取数层替换；fltt=2&invt=2 保证数值为真值小数） */
export const EM_ULIST_QUERY =
  'secids={secids}&fields=f12,f14,f2,f3,f6,f18&fltt=2&invt=2';

/** ulist 查询串里 secids 的占位符 */
export const EM_ULIST_SECIDS_TOKEN = '{secids}';

/**
 * 新浪批量行情快照（降级源；东财行情域被掐断时接管）
 *
 * 一次请求可带多个代码（逗号分隔），单次上限远超本插件的 20 个标的。
 */
export const SINA_HQ_URL = 'https://hq.sinajs.cn/list={symbols}';

/** 新浪要求带 Referer，否则返回空体 */
export const SINA_HQ_REFERER = 'https://finance.sina.com.cn';

/**
 * 新浪 hq 响应行的字段下标（实测口径，0 起）
 *
 * 响应形态：`var hq_str_sh510300="名称,今开,昨收,最新价,最高,最低,买一价,卖一价,
 * 成交量(股),成交额(元),买一量,买一价,…,日期,时间,状态,…"`。
 *
 * 与腾讯源交叉核对（510300 on 2026-10-23）：最新价 4.178 / 昨收 4.107 /
 * 涨跌幅 1.73% / 成交额 15423238067 元 / 成交量 3755608213 股 —— 全部一致。
 */
export const SINA_HQ_FIELD = {
  /** 名称 */
  NAME: 0,
  /** 今开 */
  OPEN: 1,
  /** 昨收 */
  PRE_CLOSE: 2,
  /** 最新价 */
  PRICE: 3,
  /** 最高 */
  HIGH: 4,
  /** 最低 */
  LOW: 5,
  /** 成交量（股） */
  VOLUME: 8,
  /** 成交额（元） */
  AMOUNT: 9,
  /** 日期（YYYY-MM-DD） */
  DATE: 30,
  /** 时间（HH:mm:ss） */
  TIME: 31,
} as const;

/** 新浪 hq 一行的最少字段数（脏行少于该值丢弃） */
export const SINA_HQ_MIN_FIELDS = 32;

/** ulist 行里各字段的键 */
export const EM_ULIST_FIELD = {
  /** 代码 */
  CODE: 'f12',
  /** 名称 */
  NAME: 'f14',
  /** 最新价 */
  PRICE: 'f2',
  /** 涨跌幅（%） */
  CHANGE_PERCENT: 'f3',
  /** 成交额（元） */
  AMOUNT: 'f6',
  /** 昨收 */
  PRE_CLOSE: 'f18',
} as const;

/**
 * ETF 每日资金流日 K（主源：push2his）
 *
 * ⚠️ **为什么主源是 push2his 而不是 push2delay**：宿主 `SERVER_API.md` 记录
 * （2026-09-18 实测）—— 同参数下 `push2his` 返回 **121 条**（自 2026-03-27 起），
 * 而 `push2delay` **只回当日 1 条**（`lmt=0` 也一样）。插件要 30 个交易日的资金流
 * 历史（近 5 日 / 20 日均值 / 信号时间线都靠它），故必须走 push2his。
 */
export const EM_FFLOW_URL = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get';

/**
 * ETF 每日资金流日 K（降级源：push2delay）
 *
 * 与主源同构同参数，但**历史被截断为当日 1 条** —— 仅作东财域内互备，
 * 用来在 push2his 被掐而 push2delay 尚通时保住「当天有数」。
 */
export const EM_FFLOW_FALLBACK_URL =
  'https://push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get';

/** 资金流查询串（`{secid}` 由取数层替换） */
export const EM_FFLOW_QUERY =
  'secids={secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&klt=101&lmt={limit}';

/** 资金流查询串里 secid 的占位符 */
export const EM_FFLOW_SECID_TOKEN = '{secid}';

/** 资金流查询串里 limit 的占位符 */
export const EM_FFLOW_LIMIT_TOKEN = '{limit}';

/**
 * 新浪个股资金流历史（**二级降级源**：东财行情域整域不可达时接管）
 *
 * 路径 `MoneyFlow.ssl_qsfx_zjlrqs`，按 `daima`（新浪符号，如 `sh510300`）查。
 * 响应是 JSON 数组，每行字段（实测口径）：
 * - `opendate`：日期（YYYY-MM-DD）
 * - `trade`：收盘价
 * - `changeratio`：涨跌幅（**小数**，需 ×100 换成百分数）
 * - `netamount`：**主力净流入（元）**
 * - `r0_net`：**超大单净流入（元）**
 * - `ratioamount` / `r0_ratio`：主力 / 超大单的净流入占成交额比（小数）
 *
 * ⚠️ **口径边界（重要）**：新浪该接口**只给主力与超大单两档**，
 * 没有小单 / 中单 / 大单分档 → 降级时这三档留 `null`（不当 0 用）。
 * 另注：新浪的 `netamount` 与东财的「主力净额」**不是同一套口径**
 * （实测 510300 on 2026-10-23：新浪 netamount 13.09 亿 vs 东财主力 0.61 亿，
 * 量级差 ~21 倍），故降级数据与东财数据**不可混作同一时间序列比较**，
 * README 已标注该口径断点。
 */
export const SINA_MONEYFLOW_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs';

/** 新浪资金流查询串（`{symbol}` 由取数层替换为新浪符号；`{limit}` 为条数） */
export const SINA_MONEYFLOW_QUERY = 'page=1&num={limit}&sort=opendate&asc=0&daima={symbol}';

/** 新浪资金流查询串占位符 */
export const SINA_MONEYFLOW_SYMBOL_TOKEN = '{symbol}';
export const SINA_MONEYFLOW_LIMIT_TOKEN = '{limit}';

/** 新浪资金流行里的字段名（实测口径） */
export const SINA_MONEYFLOW_FIELD = {
  /** 日期 */
  DATE: 'opendate',
  /** 收盘价 */
  CLOSE: 'trade',
  /** 涨跌幅（小数） */
  CHANGE_PERCENT: 'changeratio',
  /** 主力净流入（元） */
  MAIN: 'netamount',
  /** 超大单净流入（元） */
  SUPER: 'r0_net',
} as const;


/**
 * 资金流 klines 行的字段下标（0 起，实测口径）
 *
 * 五类资金净额相加 ≈ 0（主动买卖守恒），且「主力 = 大单 + 超大单」严格成立
 * （2026-10-23 510300 实测：131186320 + (-69916928) = 61269392 = 主力净额）。
 */
export const EM_FFLOW_FIELD = {
  /** 日期（YYYY-MM-DD） */
  DATE: 0,
  /** 主力净流入（元） */
  MAIN: 1,
  /** 小单净流入（元） */
  SMALL: 2,
  /** 中单净流入（元） */
  MID: 3,
  /** 大单净流入（元） */
  BIG: 4,
  /** 超大单净流入（元） */
  SUPER: 5,
  /** 主力净占比（%） */
  MAIN_RATIO: 6,
  /** 收盘价 */
  CLOSE: 11,
  /** 涨跌幅（%） */
  CHANGE_PERCENT: 12,
} as const;

/** 资金流 klines 一行的字段数（15 段；脏行少于该值丢弃） */
export const EM_FFLOW_ROW_FIELDS = 15;

/** 天天基金 F10 档案数据接口（份额申赎 / 持有人结构共用基址） */
export const EM_F10_ARCHIVES_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';

/** F10 份额规模变动的 type（⚠️ mode=0 才是份额；1 是净资产） */
export const EM_F10_TYPE_GMBD = 'gmbd';

/** F10 份额规模变动的 mode（0 = 份额规模变动表） */
export const EM_F10_GMBD_MODE_SHARES = '0';

/** F10 持有人结构的 type */
export const EM_F10_TYPE_CYRJG = 'cyrjg';

/** 新浪日 K 基址（成交额历史来源：东财 K 线在 push2delay 上 rc=102 不可用，同花顺 line 对 ETF 404） */
export const SINA_KLINE_URL =
  'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData';

/** 新浪要求带 Referer，否则可能被拒 */
export const SINA_KLINE_REFERER = 'https://finance.sina.com.cn';

/** F10 查询串（`{type}` / `{mode}` / `{code}` 由取数层替换；rt 破缓存） */
export const EM_F10_QUERY = 'type={type}&mode={mode}&code={code}&rt=0';

/** F10 查询串占位符 */
export const EM_F10_TYPE_TOKEN = '{type}';
export const EM_F10_MODE_TOKEN = '{mode}';
export const EM_F10_CODE_TOKEN = '{code}';

/** F10 响应体里数据对象的 JS 变量名（份额变动 / 持有人结构不同） */
export const EM_F10_VAR_GMBD = 'gmbd_apidata';
export const EM_F10_VAR_CYRJG = 'apidata';

/** 份额变动表的列（表头顺序固定，实测） */
export const EM_F10_GMBD_FIELD = {
  /** 报告期（YYYY-MM-DD） */
  PERIOD_END: 0,
  /** 期间申购（亿份） */
  SUBSCRIBE: 1,
  /** 期间赎回（亿份） */
  REDEEM: 2,
  /** 期末总份额（亿份） */
  SHARES_END: 3,
  /** 期末净资产（亿元） */
  NET_ASSET: 4,
  /** 净资产变动率（%） */
  ASSET_CHANGE_RATE: 5,
} as const;

/** 份额变动表一行的最少单元格数 */
export const EM_F10_GMBD_ROW_CELLS = 6;

/** 持有人结构表的列（表头顺序固定，实测） */
export const EM_F10_CYRJG_FIELD = {
  /** 公告日期（YYYY-MM-DD） */
  PERIOD_END: 0,
  /** 机构持有比例（%） */
  INST_RATIO: 1,
  /** 个人持有比例（%） */
  PERSON_RATIO: 2,
  /** 内部持有比例（%） */
  INTERNAL_RATIO: 3,
  /** 总份额（亿份） */
  TOTAL_SHARES: 4,
} as const;

/** 持有人结构表一行的最少单元格数 */
export const EM_F10_CYRJG_ROW_CELLS = 5;

// ---------- 频率与重试 ----------

/** 东财行情域（fflow）逐 ETF 请求间隔（毫秒；同上游必须错峰） */
export const EM_FFLOW_DELAY_MS = 600;

/** 东财 F10 域逐 ETF 请求间隔（毫秒） */
export const EM_F10_DELAY_MS = 600;

/** ulist 批量请求间隔（毫秒；一次刷新只发一两次，仍留间隔） */
export const EM_ULIST_DELAY_MS = 600;

/** 单请求尝试次数（含首次；东财会掐连接，原地小步重试是唯一有效兜底） */
export const EM_FETCH_ATTEMPTS = 3;

/** 重试间隔（毫秒） */
export const EM_FETCH_RETRY_DELAY_MS = 1500;

// ---------- 取数量 ----------

/** 资金流一次拉取的交易日数（近 5 日 / 20 日均值 / 信号时间线都靠它） */
export const FFLOW_DAYS = 30;

/** ulist 单批 secid 数上限（ETF 14 + 指数 6 = 20，一批搞定） */
export const ULIST_BATCH_SIZE = 40;

// ---------- 预估模型 ----------

/**
 * 国家队在宽基 ETF 机构持仓中的占比（默认粗估）
 *
 * 宽基 ETF 的机构持有人里，国家队（汇金 / 证金 / 梧桐树 / 国新等）占绝对大头，
 * 其余是险资 / 券商自营 / 联接基金等。0.8 是兼顾口径透明的粗估，用户可在
 * 「编辑锚点」面板改。
 */
export const NATIONAL_TEAM_OF_INST_RATIO = 0.8;

/** 持有人结构缺失时机构持有比例的兜底值（0-1） */
export const INST_RATIO_FALLBACK = 0.6;

/** 默认锚点报告期（年报期；用户未配锚点时按该期持有人结构推算） */
export const ANCHOR_DEFAULT_PERIOD = '2025-12-31';

/** 预估金额 / 净流入的展示单位换算（元 → 亿元） */
export const YUAN_PER_YI = 1e8;

/** 预估份额的展示单位（亿份） */
export const YI_SHARES = 1e8;

// ---------- 操作信号阈值 ----------

/** 信号档位（纯字符串联合，禁 enum） */
export const SIGNAL_LEVEL = {
  /** 大跌 + 资金流入 + 成交异动：典型护盘买入 */
  STRONG_BUY: 'strong_buy',
  /** 下跌 + 资金净流入：可能出手 */
  BUY: 'buy',
  /** 无显著信号 */
  WATCH: 'watch',
  /** 上涨 + 连续净流出：疑似撤退 */
  SELL: 'sell',
} as const;

/** 信号档位取值类型 */
export type SignalLevel = (typeof SIGNAL_LEVEL)[keyof typeof SIGNAL_LEVEL];

/** 信号档位中文文案 */
export const SIGNAL_LEVEL_LABEL: Record<SignalLevel, string> = {
  strong_buy: '强买入',
  buy: '买入',
  watch: '观察',
  sell: '撤退',
};

/** 信号档位徽标样式（买入用涨色弱底、撤退用跌色弱底、观察中性） */
export const SIGNAL_LEVEL_BADGE_CLASS: Record<SignalLevel, string> = {
  strong_buy: 'bg-up-weak text-up',
  buy: 'bg-up-weak text-up',
  watch: 'bg-flat-weak/60 text-text-tertiary',
  sell: 'bg-down-weak text-down',
};

/** 信号时间线色块类名（与徽标同色系） */
export const SIGNAL_LEVEL_BLOCK_CLASS: Record<SignalLevel, string> = {
  strong_buy: 'bg-up',
  buy: 'bg-up-light',
  watch: 'bg-flat-weak',
  sell: 'bg-down-light',
};

/** 「强买入」的宽基指数等权平均跌幅阈值（%；≤ 该值） */
export const SIGNAL_INDEX_DROP_STRONG = -1.5;

/** 「买入」的宽基指数等权平均跌幅阈值（%） */
export const SIGNAL_INDEX_DROP_BUY = -0.5;

/** 「撤退」的宽基指数等权平均涨幅阈值（%；≥ 该值） */
export const SIGNAL_INDEX_RISE_SELL = 0.5;

/** 「强买入」的成交额放大倍数阈值（当日合计 ÷ 近 20 日均值） */
export const SIGNAL_AMOUNT_SURGE = 1.5;

/** 「撤退」的主力净流出连续天数 */
export const SIGNAL_SELL_STREAK = 3;

/** 信号时间线展示的交易日数 */
export const SIGNAL_TIMELINE_DAYS = 20;

/** 汇总卡「近 N 日主力净流入」的 N */
export const MAIN_INFLOW_RECENT_DAYS = 5;

// ---------- 界面文案 ----------

/** 刷新日频数据按钮文案 */
export const BROAD_REFRESH_BUTTON = '刷新日频';

/** 同步季度数据按钮文案 */
export const BROAD_SYNC_BUTTON = '同步季度';

/** 刷新中按钮文案前缀 */
export const BROAD_RUNNING = '进行中';

/** 日频刷新失败文案前缀 */
export const BROAD_REFRESH_FAILED = '刷新失败';

/** 季度同步失败文案前缀 */
export const BROAD_SYNC_FAILED = '同步失败';

/** 首次空态文案 */
export const BROAD_EMPTY_TEXT =
  '还没有宽基数据——点「刷新日频」拉取宽基 ETF 的资金流与行情（一次约 16 次串行请求，结果落本地库，重进页面不联网）；'
  + '「同步季度」拉取份额申赎与持有人结构，用于持仓预估。';

/** 指标缺失占位 */
export const BROAD_PLACEHOLDER = '—';

/** 页头字段标签 */
export const BROAD_HEADER_LABEL = {
  dailyAt: '日频更新',
  quarterAt: '季度更新',
  etfCount: '跟踪 ETF',
  dayCount: '日频天数',
} as const;

/** 汇总卡标题 */
export const BROAD_SUMMARY_TITLE = '国家队持仓预估（宽基口径合计）';

/** 汇总卡字段标签 */
export const BROAD_SUMMARY_LABEL = {
  estTotal: '预估持仓',
  delta: '较锚点',
  mainToday: '当日主力净流入',
  mainRecent: '近5日主力净流入',
  anchorNote: '锚点',
} as const;

/** 持仓预估卡的方法论说明（折叠展示，口径透明） */
export const BROAD_MODEL_NOTE =
  '预估口径：预估持仓份额 = 披露锚点份额 + 锚点报告期之后各季「期间申购 − 期间赎回」净申购 × 国家队占比；'
  + '预估持仓金额 = 预估份额 × 最新价。国家队占比默认取「机构持有比例 × 80%」，可在「编辑锚点」里调整。'
  + '净赎回季按同比例分摊是粗估（国家队未必同比例赎回），定期报告披露后会与真实持仓有偏差。';

/** 操作信号卡标题 */
export const BROAD_SIGNAL_TITLE = '国家队操作信号（日频推定）';

/** 操作信号卡的口径说明 */
export const BROAD_SIGNAL_NOTE =
  '信号由宽基指数等权平均涨跌幅、宽基 ETF 主力净流入合计、成交额相对近 20 日均值的放大倍数合成：'
  + '「大跌 + 资金净流入 + 成交异动」视为护盘买入；「上涨 + 连续净流出」视为撤退。'
  + '这是二级市场痕迹的推定，不等同于官方公告。';

/** 信号证据标题 */
export const BROAD_SIGNAL_EVIDENCE_TITLE = '触发依据';

/** 信号时间线标题 */
export const BROAD_SIGNAL_TIMELINE_TITLE = '近20日信号';

/** ETF 明细表标题 */
export const BROAD_TABLE_TITLE = '宽基 ETF 明细';

/** 季度申赎表标题 */
export const BROAD_QUARTER_TABLE_TITLE = '季度份额申赎';

/** ETF 明细表列标题 */
export const BROAD_COLUMN_LABEL = {
  name: 'ETF',
  price: '最新价',
  changePercent: '涨跌幅',
  amount: '成交额',
  mainInflow: '当日主力净流入',
  mainRecent: '近5日主力净流入',
  superInflow: '当日超大单',
  sharesEnd: '期末份额',
  netSubscribe: '季净申购',
  netAsset: '净资产',
  estHolding: '预估国家队持仓',
} as const;

/** 季度申赎表列标题 */
export const BROAD_QUARTER_COLUMN_LABEL = {
  name: 'ETF',
  periodEnd: '报告期',
  subscribe: '期间申购',
  redeem: '期间赎回',
  netSubscribe: '净申购',
  sharesEnd: '期末份额',
  netAsset: '净资产',
  changeRate: '净资产变动率',
} as const;

/** 指数行情区标题 */
export const BROAD_INDEX_TITLE = '宽基指数';

/** 锚点编辑弹窗标题 */
export const BROAD_ANCHOR_TITLE = '编辑国家队持仓锚点';

/** 锚点编辑弹窗的口径说明 */
export const BROAD_ANCHOR_NOTE =
  '锚点 = 定期报告（或公开披露整理）的国家队持仓份额，是预估的起点。'
  + '可用「按持有人结构一键推算」填入粗估值（期末总份额 × 机构持有比例 × 国家队占比），再按披露数据手工校正。';

/** 一键推算按钮文案 */
export const BROAD_ANCHOR_AUTO = '按持有人结构一键推算';

/** 锚点保存按钮文案 */
export const BROAD_ANCHOR_SAVE = '保存锚点';

/** 锚点保存失败文案前缀 */
export const BROAD_ANCHOR_SAVE_FAILED = '锚点保存失败';

/** 锚点表格列标题 */
export const BROAD_ANCHOR_COLUMN_LABEL = {
  name: 'ETF',
  periodEnd: '锚点报告期',
  sharesYi: '锚点份额（亿份）',
  estAmount: '折合金额（亿元）',
} as const;

// ---------- 份额口径看板文案 ----------

/** 份额序列卡标题 */
export const BROAD_SHARE_TITLE = '宽基 ETF 份额序列（国家队主口径）';

/** 份额序列卡的口径说明 */
export const BROAD_SHARE_NOTE =
  '份额来自交易所官方逐日披露（上交所单日全市场 / 深交所 fund_jjgm），是真实申购赎回，'
  + '与二级市场资金流（谁在买卖）不同 —— 国家队的大额动作只能在份额上看到。'
  + '「估算净申赎」= 当日份额变动 × 当日收盘价，全市场口径（含散户与机构），不是国家队专属。';

/** 同步份额按钮文案 */
export const BROAD_SHARE_SYNC_BUTTON = '同步份额序列';

/** 同步份额失败文案前缀 */
export const BROAD_SHARE_SYNC_FAILED = '份额同步失败';

/** 同步份额进行中文案 */
export const BROAD_SHARE_SYNCING = '份额同步中';

/** 份额曲线卡标题 */
export const BROAD_SHARE_CHART_TITLE = '组合份额走势与每日净申赎';

/** 份额曲线卡的口径说明 */
export const BROAD_SHARE_CHART_NOTE =
  '三行同一时间刻度：组合总份额（蓝色折线 + 灰色虚线为国家队估算持仓，亿份）、每日估算净申赎（红 = 申购 / 绿 = 赎回，亿元）、逐日信号状态色带。'
  + '全历史按每天固定宽度铺开，左右拖动查看更早的交易日，滚轮缩放疏密（以光标处为锚点）。';

/** 份额卡「图解」按钮与帮助弹窗 */
export const BROAD_SHARE_HELP_BUTTON = '怎么看这张卡？';
export const BROAD_SHARE_HELP_TITLE = '份额序列卡怎么读';

/** 帮助弹窗：图上从上到下逐层解释（与全历史可拖动视图一致） */
export const BROAD_SHARE_HELP_LAYERS: { title: string; scope: string; answer: string }[] = [
  {
    title: '组合份额走势与每日净申赎（上行）',
    scope: '全历史 · 逐日 · 左右拖动查看',
    answer:
      '蓝色折线是清单内全部 ETF 的总份额（独立成行，右端即当前份额），灰色虚线是国家队估算持仓'
      + '（锚点 = 最近一期持有人结构推算或用户配置；之后国家队按「持有不动、仅在信号确认进出场时参与申赎」'
      + '的口径滚动估算，虚线呈阶梯状；量纲独立不与折线共刻度；锚点报告期之前无估算故不画；'
      + '季度数据或锚点缺失时整条不出现），柱是每日估算净申赎金额（Δ份额 × 当日收盘价，正 = 净申购）。'
      + '柱高按全历史最大值归一并开方压缩（小流量日也可见，同尺度下越大越高）。'
      + '标题下方读数行显示当前日期数据（含国家队估算份额与金额），随悬停 / 点击更新。',
  },
  {
    title: '信号状态色带（下行）',
    scope: '全历史同一时间刻度 · 逐日生命周期',
    answer:
      '每个交易日各处于生命周期哪一步，灰色观望打底：'
      + '红色实色 = 确认进场（连续同向 + 累计金额 + 回撤位置全齐），浅红 = 疑似进场（量级已达门槛、条件未全齐）；'
      + '绿色实色 = 确认退场，浅绿 = 疑似退场。只有量级达到确认门槛的疑似才会点亮色带，小抖动保持灰色。'
      + '红色沿用 A 股「红 = 买」的习惯。三行共用十字焦点线：悬停任意行出竖线，标题下方常驻读数行显示当天数据（日期 / 份额 / 净申赎 / 状态），点击钉住。',
  },
  {
    title: '怎么用',
    scope: '操作',
    answer:
      '按住左右拖动平移时间轴（首次自动对齐最新日），滚轮缩放疏密（上滚放大到逐日宽柱、下滚缩回全景），底部刻度定位季度；'
      + '悬停任意行出十字焦点线，标题下方读数行显示当天三行数据，点击钉住 / 再点取消；'
      + '战役卡列出已确认或疑似金额达标的最近 15 场战役，配合色带对照看。',
  },
];

/** 帮助弹窗：顶部汇总指标的逐项解释 */
export const BROAD_SHARE_HELP_METRICS: { label: string; text: string }[] = [
  { label: '组合总份额', text: '清单内全部 ETF 的当前份额合计（亿份）。' },
  { label: '当日估算净申赎', text: '最新交易日的份额变动 × 当日收盘价（亿元，正 = 净申购）。' },
  { label: '近5日净申赎', text: '最近 5 个交易日的估算净申赎合计。' },
  {
    label: '组合指数',
    text: '以 2024-01-02 为 100 的固定权重价格指数（按基准日市值加权、按基准日价格归一化），'
      + '144.6 ≈ 宽基组合累计上涨约 44.6%；与份额变动完全解耦，只反映价格。',
  },
  { label: '覆盖交易日', text: '份额库里已积累的交易日数量（首次全量回填约 680 个）。' },
];

/** 战役卡标题（生命周期） */
export const BROAD_WAVE_TITLE = '国家队操作战役（份额口径）';

/** 战役卡的口径说明 */
export const BROAD_WAVE_NOTE =
  '每场战役走完整生命周期：观望 → 疑似 → 确认 → 结束（进退场对称）。'
  + '「疑似」= 连续 2 日同向申赎，或单日净申赎达确认门槛一半；'
  + '「确认」还需累计金额达标 + 指数位置匹配（进场 = 距前高回撤 ≥ 8%，退场 = 距前高不足 2%）；'
  + '「结束」= 份额方向反转；退场结束按本轮退场 ÷ 此前进场余额标注完成度（减仓中 / 轻仓 / 清仓）。'
  + '卡片只展示已确认、或疑似金额达标的最近 15 场；右上角徽标是当前所处状态。';

/** 回测面板标题 */
export const BROAD_BACKTEST_TITLE = '信号回测';

/** 回测面板的口径说明 */
export const BROAD_BACKTEST_NOTE =
  '统计口径：每场已确认战役算一次样本（不按天重复计），收益 = 确认日到 N 个交易日后的组合指数涨跌幅。'
  + '样本量小，仅供研究参考，不构成投资建议。';

/** 回测字段标签 */
export const BROAD_BACKTEST_LABEL = {
  count: '信号次数',
  return1d: '次日平均',
  returnHold: '持有期平均',
  winRate: '胜率',
} as const;

/** 份额明细表标题 */
export const BROAD_SHARE_TABLE_TITLE = '逐只 ETF 份额明细';

/** 份额明细表列标题 */
export const BROAD_SHARE_COLUMN_LABEL = {
  name: 'ETF',
  index: '跟踪指数',
  shares: '总份额（亿份）',
  delta: '当日份额变动（亿份）',
  flow: '当日估算净申赎（亿元）',
  price: '收盘价',
  recent: '近5日份额变动（亿份）',
  source: '数据源',
} as const;

/** 数据源展示名 */
export const BROAD_SHARE_SOURCE_LABEL = {
  sse: '上交所',
  szse: '深交所',
} as const;

/** 份额卡字段标签 */
export const BROAD_SHARE_SUMMARY_LABEL = {
  totalShares: '组合总份额',
  todayFlow: '当日估算净申赎',
  recentFlow: '近5日净申赎',
  indexLevel: '组合指数',
  days: '覆盖交易日',
} as const;

/** 份额覆盖区间标签 */
export const BROAD_SHARE_RANGE_LABEL = '份额覆盖区间';

/** 信号档位展示文案（份额口径信号 = 「确认」档，三条件齐才触发） */
export const SHARE_SIGNAL_LABEL = {
  none: '无信号',
  enter: '确认进场',
  exit: '确认退场',
} as const;

/** 战役生命周期状态展示文案（8 状态） */
export const SHARE_LIFECYCLE_LABEL = {
  watching: '观望',
  entry_suspected: '疑似进场',
  entry_confirmed: '确认进场',
  entry_done: '进场结束',
  holding: '持仓观望',
  exit_suspected: '疑似退场',
  exit_confirmed: '确认退场',
  exit_done: '退场结束',
} as const;

/**
 * 生命周期状态徽标类名
 *
 * ⚠️ 只复用 SHARE_SIGNAL_BADGE_CLASS 里已有的三类（宿主白名单保证存在），
 * 新 Tailwind 类会因「宿主构建期扫不到」渲染成无样式（安装预检会拦）。
 */
export const SHARE_LIFECYCLE_BADGE_CLASS = {
  watching: 'bg-flat-weak text-text-tertiary',
  entry_suspected: 'bg-up-weak text-up',
  entry_confirmed: 'bg-up-weak text-up',
  entry_done: 'bg-flat-weak text-text-tertiary',
  holding: 'bg-flat-weak text-text-tertiary',
  exit_suspected: 'bg-down-weak text-down',
  exit_confirmed: 'bg-down-weak text-down',
  exit_done: 'bg-flat-weak text-text-tertiary',
} as const;

/** 退场完成度档位文案（余额占比口径，非国家队专属） */
export const SHARE_EXIT_COMPLETION_LABEL = {
  partial: '减仓中',
  light: '轻仓',
  cleared: '清仓',
} as const;

/** 信号档位徽标类名（红涨绿跌：进场 = 红，退场 = 绿） */
export const SHARE_SIGNAL_BADGE_CLASS = {
  none: 'bg-flat-weak text-text-tertiary',
  enter: 'bg-up-weak text-up',
  exit: 'bg-down-weak text-down',
} as const;

/** 免责声明（页脚固定展示） */
export const BROAD_DISCLAIMER =
  '本页为份额变动的推定工具，不构成投资建议：ETF 份额变动是全市场净申赎，不是国家队专属持仓；'
  + '「进场 / 退场」是基于「连续大额申赎 + 指数位置」的形态推定，与真实操作必然存在偏差。'
  + '数据只在点击按钮时请求上游，落本地插件库；份额来自交易所官方逐日披露。';
