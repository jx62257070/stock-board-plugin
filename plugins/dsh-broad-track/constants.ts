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
 * 数据源（2026-10-24 本机实测，证据见 README「数据源与口径」）：
 * - 行情快照（ETF / 指数）：`push2delay.eastmoney.com/api/qt/ulist.np/get`；
 * - ETF 每日资金流：`push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get`
 *   （klines 行 = 日期,主力,小单,中单,大单,超大单,五路净占比,收盘价,涨跌幅,0,0）；
 * - 季度份额申赎：`fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&mode=0`
 *   （⚠️ mode 参数必须带：0 = 份额规模变动，1 = 净资产规模变动）；
 * - 半年度持有人结构：同接口 `type=cyrjg`。
 *
 * ⚠️ 本机出口封禁 push2 / push2his 域（宿主 `eastmoney-reroute.ts` 有记录），
 * K 线类接口在 push2delay 上不可用，故本插件不用东财 K 线；价格与涨跌幅
 * 从资金流接口的收盘价 / 涨跌幅字段拿（f62 / f63），不引入第二条价格链。
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
 * 被跟踪的宽基 ETF 清单（14 只）
 *
 * 选样口径：国家队的主战场是**规模大、跟踪主流宽基指数**的 ETF —— 汇金等公告增持
 * 的对象集中在此。每只指数取规模最大的 2-4 只，覆盖沪 / 深两个市场。
 * 清单固定写死（不搞用户自定义）：样本外的 ETF 对「国家队操作」没有解释力。
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
  { code: '588000', name: '科创50ETF华夏', indexName: '科创50', market: '1' },
  { code: '588080', name: '科创50ETF易方达', indexName: '科创50', market: '1' },
  { code: '159915', name: '创业板ETF易方达', indexName: '创业板指', market: '0' },
  { code: '159952', name: '创业板ETF广发', indexName: '创业板指', market: '0' },
];

/** 被跟踪的宽基指数（东财 secid 形态；顺序即展示顺序） */
export const TRACKED_INDICES: readonly { secid: string; code: string; name: string }[] = [
  { secid: '1.000300', code: '000300', name: '沪深300' },
  { secid: '1.000016', code: '000016', name: '上证50' },
  { secid: '1.000905', code: '000905', name: '中证500' },
  { secid: '1.000852', code: '000852', name: '中证1000' },
  { secid: '0.399006', code: '399006', name: '创业板指' },
  { secid: '1.000688', code: '000688', name: '科创50' },
];

/**
 * 代码 → 东财 secid（`1.510300` / `0.159919`）
 * @param etf 被跟踪的 ETF
 * @returns secid
 */
export const etfSecid = (etf: TrackedEtf): string => `${etf.market}.${etf.code}`;

/**
 * 代码 → 新浪 K 线代码（`sh510300` / `sz159915`）
 * @param etf 被跟踪的 ETF
 * @returns 新浪代码
 */
export const etfSinaSymbol = (etf: TrackedEtf): string =>
  `${etf.market === '1' ? 'sh' : 'sz'}${etf.code}`;

/** ETF 代码 → 清单条目（找不到返回 undefined） */
export const ETF_BY_CODE = new Map<string, TrackedEtf>(
  TRACKED_ETFS.map((etf) => [etf.code, etf]),
);

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

/** ETF 每日资金流日 K（push2delay 实测可用；push2 同款被出口封禁） */
export const EM_FFLOW_URL = 'https://push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get';

/** 资金流查询串（`{secid}` 由取数层替换） */
export const EM_FFLOW_QUERY =
  'secids={secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&klt=101&lmt={limit}';

/** 资金流查询串里 secid 的占位符 */
export const EM_FFLOW_SECID_TOKEN = '{secid}';

/** 资金流查询串里 limit 的占位符 */
export const EM_FFLOW_LIMIT_TOKEN = '{limit}';

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
  /** 总份额（亿份） */
  TOTAL_SHARES: 3,
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

/** 免责声明（页脚固定展示） */
export const BROAD_DISCLAIMER =
  '本页为资金流痕迹的推定工具，不构成投资建议：国家队无公开每日持仓，「预估持仓」由披露锚点 + 份额申赎分摊推算，'
  + '与真实持仓必然存在偏差；「操作信号」只是二级市场资金流形态的归类。'
  + '数据只在点击按钮时请求上游，落本地插件库；季频数据以上游定期报告为准。';
