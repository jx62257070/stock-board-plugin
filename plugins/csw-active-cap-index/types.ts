/**
 * 插件 csw-active-cap-index（活跃市值与指数贡献）· 数据形状与契约扩展
 *
 * 本插件最终以**单文件产物**形态分发（zip 包，运行时由宿主动态装载），
 * 运行时拿不到任何宿主模块 —— 所有宿主能力只能由 `plugin.ts` 在 `apply(ctx)`
 * 里从服务容器取好、沿调用链注入下来。
 *
 * 数据形状分三层：
 * - **上游原始行**（`ClistRawRow` / `IndexRawRow`）：东财 clist / ulist 返回的
 *   `f2`/`f6`/… 字段，`fltt=2` 已把数值归一成 number，缺数据时是 `'-'`；
 * - **统一行情行**（`StockRow`）：把原始字段解析成可计算的 null 化结构，
 *   活跃榜 / 贡献榜共用；
 * - **视图行**（`ActiveDisplayRow` / `ContributionRow`）：在统一行上补展示派生量
 *   （名次、比例条宽度、贡献占比）。
 */

/**
 * 宿主契约扩展：`app:market-data`（市场剖面数据服务）
 *
 * 该服务由**较新版本的宿主**提供（`whf-stock-board` 的 `pc/plugin/setup.ts` 里
 * `provide('app:market-data', …)`），本仓库的 `host/` 类型快照还没收录 ——
 * 这里按官方约定（`declare module` 扩展 `AppServiceMap`）在插件侧声明契约，
 * 维护者下次 `pnpm sync:host` 同步后即可删掉这段扩展。
 *
 * 插件把它当**可选依赖**用：`consume` 返回 undefined 时占比卡降级为 `--`，
 * 不影响主体功能，因此不写进 `inject`。
 */
export interface MarketDataService {
  /**
   * 实时成交额快照（市场总览「实时成交额」模块同源）
   * @returns 快照（本插件只读 `turnover` 字段 = 两市实时总成交额，单位元）
   */
  fetchRealtimeTurnover: () => Promise<{ turnover?: number | null }>;
}

declare module '../../host/types/plugin.types' {
  interface AppServiceMap {
    /** 市场剖面数据（较新宿主提供；老版本宿主缺席，插件自行降级） */
    'app:market-data': MarketDataService;
  }
}

/** 指数选择键（与 `INDEX_TABS` / `INDEX_SCOPE_PREFIX` 的 value 对应） */
export type IndexKey = 'sh' | 'sz' | 'cyb';

/** 东财 clist 原始行（只声明本插件用到的字段；`fltt=2` 下缺数据为 `'-'`） */
export interface ClistRawRow {
  /** 现价（元） */
  f2?: number | string;
  /** 涨跌幅（%） */
  f3?: number | string;
  /** 成交额（元） */
  f6?: number | string;
  /** 裸代码（如 `600519`） */
  f12?: string;
  /** 名称 */
  f14?: string;
  /** 总市值（元） */
  f20?: number | string;
  /** 流通市值（元） */
  f21?: number | string;
}

/** 东财 ulist 指数原始行（只声明本插件用到的字段） */
export interface IndexRawRow {
  /** 点位 */
  f2?: number | string;
  /** 涨跌幅（%） */
  f3?: number | string;
  /** 涨跌点（点） */
  f4?: number | string;
  /** 名称（用于按名称圈定三只指数） */
  f14?: string;
  /** 样本总市值（元；上证 = 沪市全样本总市值，精确口径） */
  f20?: number | string;
}

/** 三指数快照（key 见 `IndexKey`；某一指数上游缺失时对应键缺省） */
export type IndexSnapshotMap = Partial<Record<IndexKey, IndexRawRow>>;

/** 统一行情行（clist 原始行解析后的可计算结构，全部数值已 null 化） */
export interface StockRow {
  /** 裸代码（`600519`） */
  code: string;
  /** 名称 */
  name: string;
  /** 现价（元；缺数据 null） */
  price: number | null;
  /** 涨跌幅（%；缺数据 null） */
  changePct: number | null;
  /** 成交额（元；缺数据 null） */
  amount: number | null;
  /** 总市值（元；缺数据 null） */
  totalCap: number | null;
  /** 流通市值（元；缺数据 null） */
  floatCap: number | null;
}

/** 活跃榜展示行（统一行 + 名次与展示派生量） */
export interface ActiveDisplayRow extends StockRow {
  /** 成交额名次（1 起） */
  rank: number;
  /** 是否达到活跃门槛（比例条按此决定着色） */
  isActive: boolean;
  /** 占活跃成交额比（%；分母缺失时 null） */
  amountShare: number | null;
  /** 比例条宽度（0~1，相对榜内最大成交额） */
  amountBarRatio: number;
}

/** 活跃市值视图（指南针 0AMV 近似口径的一次计算结果） */
export interface ActiveView {
  /** 达到门槛的活跃股行（来自成交额 Top 300） */
  activeRows: StockRow[];
  /** 活跃榜展示行（成交额前 100，带名次与比例条） */
  displayRows: ActiveDisplayRow[];
  /** 活跃市值 = 活跃股流通市值合计（元；全缺数据 null） */
  activeCap: number | null;
  /** 活跃家数 */
  activeCount: number;
  /** 活跃成交额合计（元；全缺数据 null） */
  activeAmount: number | null;
  /** 活跃成交额占两市实时总成交额比（%；分母缺失 null） */
  amountShareOfMarket: number | null;
}

/** 贡献榜行（统一行 + 权重与贡献派生量） */
export interface ContributionRow extends StockRow {
  /** 权重 = 总市值 ÷ 样本总市值 × 100（%；分母缺失 null） */
  weight: number | null;
  /** 贡献点（点；总市值 / 涨跌幅缺失时 null，已过滤） */
  points: number | null;
  /** 贡献占比 = |贡献点| ÷ |指数实际涨跌点| × 100（%；无法对账时 null） */
  share: number | null;
}

/** 指数贡献视图（通达信口径的一次计算结果） */
export interface ContributionView {
  /** 指数点位 */
  indexPrice: number | null;
  /** 指数涨跌幅（%） */
  indexChangePct: number | null;
  /** 指数实际涨跌点（点） */
  indexChangePoints: number | null;
  /** 样本总市值（元；权重归一分母） */
  scopeTotalCap: number | null;
  /** 拉指数榜（贡献点降序，前 `CONTRIB_SIDE_ROWS` 条） */
  positive: ContributionRow[];
  /** 拖指数榜（贡献点升序取最负，前 `CONTRIB_SIDE_ROWS` 条） */
  negative: ContributionRow[];
  /** 进入计算的样本数 */
  sampleCount: number;
  /** 正贡献家数 */
  positiveCount: number;
  /** 负贡献家数 */
  negativeCount: number;
  /** 样本合计贡献点（点；可对账） */
  samplePointsSum: number | null;
  /** 覆盖率 = 样本合计 ÷ 指数实际涨跌点 × 100（%；全样本时应为 100） */
  coverage: number | null;
}

/** 交易日活跃市值快照（本插件数据表的行形状；type 别名以兼容 `Record<string, unknown>` 约束） */
export type DailySnapshotRow = {
  /** 交易日（`YYYY-MM-DD`） */
  date: string;
  /** 活跃市值（元） */
  activeCap: number;
  /** 活跃家数 */
  activeCount: number;
  /** 活跃成交额（元） */
  activeAmount: number;
}

/** 趋势曲线用快照点（升序） */
export interface TrendPoint {
  /** 交易日（`YYYY-MM-DD`） */
  date: string;
  /** 活跃市值（元） */
  activeCap: number | null;
}

/**
 * 页面组件的共享状态（只读视图：apply 闭包经 getter 暴露响应式值，
 * 组件不持有可变状态，写路径全部收口在 `refresh`）
 */
export interface PageState {
  /** 全市场成交额 Top 300 统一行（首轮成功前 null） */
  readonly rows: StockRow[] | null;
  /** 贡献候选池（总市值 Top 200 ∪ 成交额 Top 300，已去重） */
  readonly candidates: StockRow[];
  /** 三指数快照 */
  readonly indices: IndexSnapshotMap | null;
  /** 两市实时总成交额（元；服务缺席 / 上游缺失 null） */
  readonly totalAmount: number | null;
  /** 交易日快照历史（升序） */
  readonly history: TrendPoint[];
  /** 最后一轮成功时间戳（毫秒；0 = 尚未成功） */
  readonly updatedAt: number;
  /** 最后一轮错误文案（空串 = 无错误） */
  readonly error: string;
}
