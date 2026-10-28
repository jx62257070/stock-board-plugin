/**
 * 插件 csw-active-cap-index · 常量
 *
 * 上游地址、字段、阈值与展示常量集中于此（项目规范：禁止散落字面量）。
 * 所有上游口径都经过实测（2026-10）：clist 单页上限 100、指数 ulist 的
 * `f20` = 样本总市值、push2delay 在部分网络下会断连需回落 push2。
 */
import type { IndexKey } from './types';

// —— 上游地址（双域回落；与宿主行情全景同源） ——

/** 东财 clist 主域（push2delay） */
export const CLIST_PRIMARY = 'https://push2delay.eastmoney.com/api/qt/clist/get';

/** 东财 clist 回落域（push2） */
export const CLIST_FALLBACK = 'https://push2.eastmoney.com/api/qt/clist/get';

/** 东财 ulist 主域（指数精确 secid 查询） */
export const ULIST_PRIMARY = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get';

/** 东财 ulist 回落域 */
export const ULIST_FALLBACK = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

// —— 上游参数 ——

/** 沪深 A 股全集（深主板 + 创业板 + 沪主板 + 科创板，与宿主口径一致） */
export const FS_ALL_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

/** 个股字段：f2 现价 / f3 涨跌幅% / f6 成交额 / f12 代码 / f14 名称 / f20 总市值 / f21 流通市值 */
export const STOCK_FIELDS = 'f2,f3,f6,f12,f14,f20,f21';

/** 指数字段：f2 点位 / f3 涨跌幅% / f4 涨跌点 / f12 代码 / f14 名称 / f20 样本总市值 */
export const INDEX_FIELDS = 'f2,f3,f4,f12,f14,f20';

/** 指数 secids：上证指数 / 深证成指 / 创业板指 */
export const INDEX_SECIDS = '1.000001,0.399001,0.399006';

// —— 展示与口径 ——

/** 指数选择项（value 与 `INDEX_SCOPE_PREFIX` 对应） */
export const INDEX_TABS: readonly { value: IndexKey; label: string }[] = [
  { value: 'sh', label: '上证指数' },
  { value: 'sz', label: '深证成指' },
  { value: 'cyb', label: '创业板指' },
];

/** 指数 → 候选个股代码前缀圈定（近似口径：上证含科创板，深证成指含主板 + 创业板） */
export const INDEX_SCOPE_PREFIX: Record<IndexKey, readonly string[]> = {
  sh: ['60', '68'],
  sz: ['00', '30'],
  cyb: ['30'],
};

// —— 取数节奏 ——

/** 单页条数上限（2026-10 实测上游 pz 夹到 100） */
export const PAGE_SIZE = 100;

/** 成交额榜页数（Top 300：活跃市值统计池 + 贡献候选池） */
export const TURNOVER_PAGES = 3;

/** 总市值权重池页数（Top 200，贡献榜补「大市值低成交」一端） */
export const CAP_PAGES = 2;

/** 同上游连续请求的错峰间隔（毫秒；与宿主 `format.delay` 的限速建议一致） */
export const REQUEST_GAP_MS = 400;

/** 单请求超时（毫秒；防 push2delay 挂起拖死整轮） */
export const REQUEST_TIMEOUT_MS = 12_000;

/** 双域回落失败后的整体重试轮数（1 = 首轮 + 重试一轮，每请求最多 4 次尝试） */
export const RETRY_ROUNDS = 1;

/** 重试前的等待（毫秒） */
export const RETRY_GAP_MS = 800;

// —— 0AMV 口径 ——

/** 趋势曲线展示的交易日数 */
export const HISTORY_DAYS = 60;

/** 均线窗口（对齐 0AMV 经典用法里的 5 日均线） */
export const MA_WINDOW = 5;

/** 交易日快照表名（物理表名 `plugin_csw_active_cap_index_daily_snapshots`） */
export const DAILY_TABLE = 'daily_snapshots';

/** 两市实时总成交额低于该值（元）视为非交易快照（节假日 / 停市），不记入历史 */
export const MIN_TRADING_AMOUNT = 1e11;

/** 活跃门槛 select 选项（value：成交额门槛，单位亿元） */
export const THRESHOLD_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '0.5', label: '成交额 ≥ 5000万' },
  { value: '1', label: '成交额 ≥ 1亿' },
  { value: '2', label: '成交额 ≥ 2亿' },
];

/** 活跃榜展示条数选项 */
export const TOP_N_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '20', label: 'Top 20' },
  { value: '50', label: 'Top 50' },
  { value: '100', label: 'Top 100' },
];

// —— 通达信贡献口径 ——

/** 贡献榜单侧条数（正负各一榜） */
export const CONTRIB_SIDE_ROWS = 10;

/** 活跃榜截取条数（Top 300 里展示成交额前 100 行） */
export const ACTIVE_BOARD_ROWS = 100;
