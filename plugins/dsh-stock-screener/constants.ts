/**
 * 插件 dsh-stock-screener（选股器）· 常量
 *
 * 收纳：插件身份与菜单、筛选 / 回测参数、信号模板、扫描并发与股票池档位、
 * 新浪日 K 参数、格式化单位、全部界面文案。
 */
import type { StockChangeType, ZTPoolType } from 'stock-sdk';
import type { EodFilters, SignalKey } from './types';

// ---------- 插件身份与菜单 ----------

/** 插件 id（= 目录名 = manifest.id；同时是 db 表名与存储命名空间的一部分，定了不能改） */
export const SCREENER_PLUGIN_ID = 'dsh-stock-screener';

/** 插件展示名 */
export const SCREENER_PLUGIN_NAME = '选股器';

/** 插件版本（与 manifest.json 保持一致，构建脚本会校验） */
export const SCREENER_PLUGIN_VERSION = '1.0.0';

/** 左侧导航菜单路径（沿用宿主内置版的历史路径，老书签直达） */
export const SCREENER_MENU_PATH = '/screener';

/** 左侧导航菜单标题 */
export const SCREENER_MENU_TITLE = '选股器';

/** 左侧导航菜单图标（宿主 MenuIcon 的 key） */
export const SCREENER_MENU_ICON = 'filter';

/** 插件贡献的 Agent MCP 服务器 key（管理弹窗展示与归属记账用） */
export const SCREENER_MCP_KEY = 'stock-screener';

/**
 * 插件贡献的 Agent MCP 服务器资源 id（负数段约定，避开内置 -1 ~ -4）
 */
export const SCREENER_MCP_ID = -101;

// ---------- 页面结构 ----------

/** 工具 tab 值 */
export const SCREENER_TAB_BASIC = 'basic';
export const SCREENER_TAB_SCANNER = 'scanner';
export const SCREENER_TAB_EOD = 'eod';

/** 工具 tab 选项（基础筛选 / 信号扫描 / 尾盘选股） */
export const SCREENER_TOOL_TABS: readonly { label: string; value: string }[] = [
  { label: '基础筛选', value: SCREENER_TAB_BASIC },
  { label: '信号扫描', value: SCREENER_TAB_SCANNER },
  { label: '尾盘选股', value: SCREENER_TAB_EOD },
];

// ---------- 基础筛选 / 回测 ----------

/** 筛选结果默认条数 */
export const SCREENER_TOP_N = 20;

/** 筛选结果条数选项 */
export const SCREENER_TOP_N_OPTIONS = [10, 20, 50] as const;

/** 回测初始资金（元，SDK 默认口径） */
export const BACKTEST_INITIAL_CAPITAL = 100_000;

/** 回测费率（A 股口径：佣金双边 + 卖出印花税） */
export const BACKTEST_FEE = {
  buy: 0.0003,
  sell: 0.0013,
} as const;

/** 回测默认区间（自然日），与宿主 K 线页口径一致取近一年 */
export const BACKTEST_RANGE_DAYS = 365;

/** 回测有效最少 bar 数（低于该值 MA20 无意义，直接报错） */
export const BACKTEST_MIN_BARS = 40;

// ---------- 信号模板 ----------

/** 信号模板选项（label / desc 展示用，value 为 SignalKey） */
export const SIGNAL_TEMPLATES: readonly {
  key: SignalKey;
  label: string;
  desc: string;
}[] = [
  { key: 'ma_golden', label: 'MA金叉', desc: '短期均线上穿长期均线' },
  { key: 'ma_death', label: 'MA死叉', desc: '短期均线下穿长期均线' },
  { key: 'macd_golden', label: 'MACD金叉', desc: 'DIF 上穿 DEA' },
  { key: 'macd_death', label: 'MACD死叉', desc: 'DIF 下穿 DEA' },
  { key: 'rsi_oversold', label: 'RSI超卖', desc: 'RSI 低于 30' },
  { key: 'rsi_overbought', label: 'RSI超买', desc: 'RSI 高于 70' },
  { key: 'boll_upper', label: 'BOLL上轨', desc: '收盘价突破上轨' },
  { key: 'boll_lower', label: 'BOLL下轨', desc: '收盘价跌破下轨' },
] as const satisfies readonly {
  key: SignalKey;
  label: string;
  desc: string;
}[];

/** 信号扫描并发数（克制频率，避免触发上游反爬） */
export const SCAN_CONCURRENCY = 3;

/**
 * 全市场快照请求治理：每页标的数（上游 clist 单页上限约 500）
 *
 * ⚠️ 东财系接口高频请求会封 IP：并发不得超过 3（约 11 页 → 4 轮），
 * 且全市场快照只能由用户点击触发，不做轮询。
 */
export const MARKET_SNAPSHOT_BATCH_SIZE = 500;
export const MARKET_SNAPSHOT_CONCURRENCY = 3;

/**
 * 信号扫描单票请求的日 K 根数
 *
 * 扫描只用 MA(5,10) / MACD(12,26,9) / RSI(6,12) / BOLL(20)，
 * 最长回看是 MACD 的慢线 EMA26，120 根足够预热且留足余量。
 */
export const SCAN_KLINE_BARS = 120;

/** 尾盘选股分时强度筛选的并发数（腾讯 JSONP 源，保守并发） */
export const EOD_TIMELINE_CONCURRENCY = 2;

/** 尾盘选股默认过滤条件（参考尾盘选股法常用参数） */
export const EOD_FILTERS_DEFAULT: EodFilters = {
  marketCapMin: 50,
  marketCapMax: 200,
  volumeRatioMin: 1.2,
  changePercentMin: 3,
  changePercentMax: 5,
  turnoverRateMin: 5,
  turnoverRateMax: 10,
  excludeST: true,
  timelineAboveAvgRatioMin: 80,
};

/** 涨停 / 强势股池选项（value 为 SDK ZTPoolType 成员） */
export const SCAN_ZT_POOL_OPTIONS: readonly { label: string; value: ZTPoolType }[] = [
  { label: '涨停池', value: 'zt' },
  { label: '强势股', value: 'strong' },
  { label: '昨日涨停', value: 'yesterday' },
  { label: '次新股', value: 'sub_new' },
  { label: '炸板池', value: 'broken' },
  { label: '跌停池', value: 'dt' },
] as const satisfies readonly { label: string; value: ZTPoolType }[];

/** 盘口异动池选项（value 为 SDK StockChangeType 成员） */
export const SCAN_STOCK_CHANGE_OPTIONS: readonly { label: string; value: StockChangeType }[] = [
  { label: '火箭发射', value: 'rocket_launch' },
  { label: '大笔买入', value: 'large_buy' },
  { label: '大单扫货', value: 'big_buy_order' },
  { label: '封涨停板', value: 'limit_up_seal' },
  { label: '向上缺口', value: 'gap_up' },
  { label: '60日新高', value: 'high_60d' },
] as const satisfies readonly { label: string; value: StockChangeType }[];

/** 榜单 TopN 选项 */
export const SCAN_TOP_N_OPTIONS = [20, 50, 100] as const;

/** 板块成分股截取数量选项 */
export const SCAN_BOARD_LIMIT_OPTIONS = [30, 50, 80] as const;

// ---------- 股票池来源 ----------

/** 股票池来源 tab 选项 */
export const POOL_SOURCE_TABS: readonly { label: string; value: string }[] = [
  { label: '自选股', value: 'watchlist' },
  { label: '手选板块', value: 'board' },
  { label: '榜单 TopN', value: 'ranking' },
  { label: '涨停·强势池', value: 'zt_pool' },
  { label: '盘口异动池', value: 'stock_changes' },
];

/** 榜单排序字段选项 */
export const RANKING_FIELD_OPTIONS: readonly { label: string; value: string }[] = [
  { label: '按成交额', value: 'amount' },
  { label: '按涨幅', value: 'changePercent' },
  { label: '按换手率', value: 'turnoverRate' },
];

/** 板块类型选项 */
export const BOARD_TYPE_OPTIONS: readonly { label: string; value: string }[] = [
  { label: '行业板块', value: 'industry' },
  { label: '概念板块', value: 'concept' },
];

/** 各股票池来源的说明文案 */
export const POOL_SOURCE_HINTS: Record<string, string> = {
  watchlist: '使用当前全部分组自选的去重股票池',
  board: '所选板块成分股按配置数量截取',
  ranking: '全市场快照按所选字段降序取 TopN',
  zt_pool: '涨停 / 强势股池按 TopN 截取',
  stock_changes: '盘口异动按类型去重后取 TopN',
};

// ---------- 新浪日 K（取数与会话缓存） ----------

/** 新浪上游要求的 Referer（缺失返回 403） */
export const SINA_REFERER = 'https://finance.sina.com.cn';

/** 新浪日 K 单次请求根数上限（实测超过 1970 条上游返回 null） */
export const SINA_KLINE_MAX_BARS = 1900;

/** 日 K 的新浪 scale 参数（240 分钟 = 日线） */
export const SINA_DAILY_SCALE = 240;

/** 缓存口径（数据源 + 复权方式；口径不一致时整票作废重取） */
export const KLINE_CACHE_SOURCE = 'sina-none';

/** 日期展示 / 缓存水位格式（本地时区，与 A 股交易日口径一致） */
export const KLINE_DATE_FORMAT = 'YYYY-MM-DD';

/** A 股交易日的星期序（Date.getDay()：0 为周日，6 为周六） */
export const KLINE_TRADING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** 补尾部时请求根数的下限（库中最新 bar 当日仍可能变化，至少要重取它本身） */
export const KLINE_TAIL_MIN_DATALEN = 5;

/** 补尾部时请求根数的安全余量（覆盖自然日→交易日的折算误差与节假日错算） */
export const KLINE_TAIL_MARGIN_BARS = 5;

/** 盘中「补尾部」的最小间隔（毫秒）：避免来回切票时重复打上游 */
export const KLINE_TAIL_TTL_MS = 30_000;

/** 当日日 K 视为终值的时刻（时）—— A 股连续竞价 15:00 结束 */
export const KLINE_DAILY_FINAL_HOUR = 15;

/** 当日日 K 视为终值的时刻（分）—— 取 15:05 留余量（盘后固定价格交易 15:05 起） */
export const KLINE_DAILY_FINAL_MINUTE = 5;

// ---------- 格式化 ----------

/** 数值占位符（与宿主口径一致） */
export const NUMBER_PLACEHOLDER = '--';

/** 价格 / 百分比默认小数位 */
export const PRICE_DEFAULT_DIGITS = 2;

/** 万与亿、亿与万亿的进率（成交额格式化用） */
export const WAN_PER_YI = 10_000;
export const WAN_PER_WANYI = 100_000_000;

/** 成交额单位文案 */
export const AMOUNT_UNITS = {
  WAN: '万',
  YI: '亿',
  WANYI: '万亿',
} as const;

// ---------- 界面文案 ----------

/** 基础筛选卡片标题 */
export const BASIC_FILTER_CARD_TITLE = '筛选条件（留空表示不过滤）';

/** 筛选按钮文案（进行中态由组件拼接） */
export const BASIC_FILTER_BUTTON = '开始筛选（全市场）';
export const BASIC_FILTER_BUTTON_BUSY = '筛选中...';

/** 筛选失败提示 */
export const BASIC_FILTER_ERROR = '筛选失败，请稍后重试（全市场快照可能被上游限频）';

/** 筛选结果卡标题 */
export const BASIC_RESULT_CARD_TITLE = '筛选结果';

/** 筛选空结果 / 未开始提示 */
export const BASIC_RESULT_EMPTY = '无符合条件的标的，试着放宽条件';
export const BASIC_RESULT_IDLE = '设置条件后点击「开始筛选」';

/** 回测卡标题 */
export const BACKTEST_CARD_TITLE = '简单回测（MA5/20 金叉死叉策略 · 近一年日K · 含费）';

/** 回测输入提示 */
export const BACKTEST_INPUT_LABEL = '标的（600519 / sh600519 均可）';
export const BACKTEST_INPUT_PLACEHOLDER = 'sh600519';
export const BACKTEST_BUTTON = '开始回测';
export const BACKTEST_BUTTON_BUSY = '回测中...';
export const BACKTEST_HINT = '可从筛选结果点「回测」快速填入';
export const BACKTEST_ERROR = '回测失败，请检查标的后重试';
export const BACKTEST_IDLE = '输入标的或从筛选结果点「回测」查看策略对比';
export const BACKTEST_DISCLAIMER = '回测为简化模型（全仓进出、固定费率），不构成投资建议';
export const BACKTEST_DISCLAIMER_TAG = '提示';

/** 回测指标块标题 */
export const BACKTEST_METRIC_LABELS = {
  totalReturn: '策略总收益',
  buyHoldReturn: '买入持有基准',
  winRate: '胜率',
  maxDrawdown: '最大回撤',
  tradeCount: '交易次数',
} as const;

/** 权益曲线图例 */
export const EQUITY_LEGEND_STRATEGY = '策略权益';
export const EQUITY_LEGEND_BUY_HOLD = '买入持有基准';

/** 信号扫描卡片标题 */
export const SCANNER_POOL_CARD_TITLE = '股票池来源';
export const SCANNER_SIGNAL_CARD_TITLE = '信号模板（可多选）';
export const SCANNER_RESULT_CARD_TITLE = '扫描结果';

/** 扫描按钮文案 */
export const SCANNER_SCAN_BUTTON = '开始扫描';
export const SCANNER_SCAN_BUTTON_BUSY = '扫描中...';
export const SCANNER_CANCEL_BUTTON = '取消';

/** 扫描提示文案 */
export const SCANNER_NO_SIGNAL = '请至少选择一个信号模板';
export const SCANNER_EMPTY_POOL = '股票池为空，请切换来源或补充选股范围';
export const SCANNER_NO_MATCH = '扫描完成，暂无标的命中所选信号';
export const SCANNER_FAILED = '扫描失败，请稍后重试';
export const SCANNER_RESULT_IDLE = '选择股票池和信号模板后开始扫描';
export const SCANNER_PROGRESS_STAGE_READY = '准备股票池';
export const SCANNER_PROGRESS_STAGE_SCAN = '技术信号扫描';

/**
 * 扫描进度尾缀（并发数展示）
 * @param concurrency 扫描并发数
 * @returns 形如 `· 并发 3` 的文案
 */
export const SCANNER_CONCURRENCY_HINT = (concurrency: number): string => `· 并发 ${concurrency}`;

/** 板块选择占位 */
export const BOARD_SELECT_PLACEHOLDER = '选择板块';
export const BOARD_LIMIT_LABEL = '成分数上限';
export const TOP_N_LABEL = 'TopN';

/** 尾盘选股卡片标题 */
export const EOD_FILTER_CARD_TITLE = '筛选条件';
export const EOD_RESULT_CARD_TITLE = '分析结果（按分时强度降序）';

/** 尾盘选股按钮文案 */
export const EOD_ANALYZE_BUTTON = '开始分析（全市场）';
export const EOD_ANALYZE_BUTTON_BUSY = '分析中...';
export const EOD_CANCEL_BUTTON = '取消';

/** 尾盘选股提示文案 */
export const EOD_ST_LABEL = '过滤 ST 股票';
export const EOD_TIMELINE_HINT =
  '分时强度 = 分时价格位于分时均价上方的时间占比，越大代表全天走势越强（尾盘选股法核心指标）';
export const EOD_EMPTY_RESULT = '分析完成，暂无符合条件的标的，试着放宽条件';
export const EOD_FAILED = '分析失败，请稍后重试（全市场快照可能被上游限频）';
export const EOD_RESULT_EMPTY = '无符合条件的标的，试着放宽条件';
export const EOD_RESULT_IDLE = '设置条件后点击「开始分析」';
export const EOD_PROGRESS_STAGE_QUOTES = '获取行情数据';
export const EOD_PROGRESS_STAGE_TIMELINE = '分时结构筛选';
export const EOD_PROGRESS_STAGE_READY = '准备中';

/**
 * 尾盘分析进度尾缀（并发数展示）
 * @param concurrency 分时并发数
 * @returns 形如 `· 分时并发 2` 的文案
 */
export const EOD_CONCURRENCY_HINT = (concurrency: number): string =>
  `· 分时并发 ${concurrency}`;

/** 表格列标题 */
export const COLUMN_LABEL_NAME = '个股';
export const COLUMN_LABEL_PRICE = '现价';
export const COLUMN_LABEL_CHANGE = '涨跌幅';
export const COLUMN_LABEL_TURNOVER = '换手率';
export const COLUMN_LABEL_VOLUME_RATIO = '量比';
export const COLUMN_LABEL_AMOUNT = '成交额';
export const COLUMN_LABEL_BACKTEST = '回测';
export const COLUMN_LABEL_MATCHED = '命中信号';
export const COLUMN_LABEL_ACTIONS = '操作';
export const COLUMN_LABEL_MARKET_CAP = '流通市值';
export const COLUMN_LABEL_TIMELINE_STRENGTH = '分时强度';

/**
 * 结果计数文案
 * @param count 命中条数
 * @returns 形如 `命中 12 只` 的文案
 */
export const HIT_COUNT_TEXT = (count: number): string => `命中 ${count} 只`;
