/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 插件内类型
 *
 * 分层与 dsh-mainline 同构：
 * - `em-data.ts` 只做解析与取数（解析是**纯函数**，可离线冒烟）；
 * - `judge.ts` 是纯函数指标层：输入板块日线 + 全市场分母，输出逐日因子 / 双指数 / 背离标记；
 * - `storage.ts` 承载三张 ctx.db 表的水合与落库；
 * - `scan.ts` 编排一次采集（用户点击触发）。
 *
 * 存储形态与开发方案 §3 的差异（实现定论，README 有说明）：板块逐日事实与逐日指数
 * **按 json 列整列存**（每板块一行），而不是逐「板块 × 交易日」一行 —— ctx.db 无批量
 * 插入，首扫上万行逐条 IPC 的代价不可接受（dsh-mainline 同款血泪结论）；
 * 表数量与方案一致（事实表 / 结果表 / 元信息表三张），表名对齐 `board_history` /
 * `index_daily` / `scan_meta`。
 */
import type { NotifyService } from '../../host/types/notify.types';
import type { FormatService, HttpService, MarketService, UiKitService } from '../../host/types/plugin.types';
import type { KindFilter, ScanStep } from './constants';

/**
 * 插件运行所需的宿主能力（依赖注入容器）
 *
 * 单文件产物形态下没有 import 可用，所有宿主依赖只能从 ctx 上来，
 * 由 `plugin.ts` 在 `apply(ctx)` 里取好后沿调用链注入。
 */
export interface SentimentDeps {
  /** 受控网络请求（走宿主上游通道，域名白名单内） */
  http: HttpService;
  /** 格式化与涨跌语义（trend / percent / delay） */
  format: FormatService;
  /** 市场剖面数据（涨停池） */
  market: MarketService;
  /** 宿主 UI Kit（卡片 / 表格 / 按钮 / 弹窗 / 空态 / 图标） */
  ui: UiKitService;
  /** 应用级浮窗（可缺席：缺席时降级为页内提示条，不阻塞采集） */
  notify?: NotifyService;
}

/** 板块类别 */
export type BoardKind = 'industry' | 'concept';

/** 板块清单里的一项（代码 + 名称 + 类别，关注管理搜索与落库共用） */
export interface BoardRef {
  /** 东财板块代码（BKxxxx） */
  code: string;
  /** 板块名称 */
  name: string;
  /** 板块类别 */
  kind: BoardKind;
}

/**
 * 板块单日数据（事实表 `board_history` 的 days json 列元素）
 *
 * 字段来源三处合并：板块日 K（价量额）、fflow daykline（资金拆分）、
 * 当日快照 + 涨停池（涨跌家数 / 换手 / 涨停数，只可能落在被扫描的交易日）。
 * `undefined` = 未采集（不等于 0），数值列一律可空。
 */
export interface BoardDay {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 开盘点位 */
  open: number | null;
  /** 最高点位 */
  high: number | null;
  /** 最低点位 */
  low: number | null;
  /** 收盘点位 */
  close: number | null;
  /** 成交量（手） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 涨跌幅（%）；日 K 与快照都有时以快照为准（上游原值口径） */
  pctChg: number | null;
  /** 主力净流入（元，fflow） */
  mainNet: number | null;
  /** 主力净占比（%，fflow） */
  mainRatio: number | null;
  /** 小单净流入（元，fflow）—— 散户因子核心列 */
  smallNet: number | null;
  /** 小单净占比（%，fflow f58）—— 散户因子核心列 */
  smallRatio: number | null;
  /** 上涨家数（当日快照字段，历史不可回补） */
  upCount: number | null;
  /** 下跌家数（当日快照字段，历史不可回补） */
  downCount: number | null;
  /** 板块换手率（%，clist f8，实测通过才有值） */
  turnover: number | null;
  /** 板块内涨停家数（涨停池按行业归属聚合；概念板块无行业映射为 null） */
  limitUpCount: number | null;
}

/** 板块历史（事实表 `board_history` 一行；days 升序） */
export interface BoardHistory {
  /** 东财板块代码 */
  code: string;
  /** 板块名称 */
  name: string;
  /** 板块类别 */
  kind: BoardKind;
  /** 逐日数据（升序） */
  days: BoardDay[];
}

/** 全市场单日总成交额（东财沪深指数日 K 相加，**同源分母**） */
export interface MarketPoint {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 沪深两市合计成交额（元） */
  totalAmount: number;
}

/** 单日因子原始值（全部板块级；null = 该日无数据，绝不当 0 用） */
export interface FactorValues {
  /** 成交占比（%）= 板块成交额 ÷ 沪深两市成交额 */
  amountShare: number | null;
  /** 相对放量 = 当日成交额 ÷ 自身过去 20 日均额 */
  volumeRatio: number | null;
  /** 板块换手率（%，快照字段） */
  turnover: number | null;
  /** 小单净占比（%，fflow f58） */
  smallNetRatio: number | null;
  /** 涨跌幅（%） */
  pctChg: number | null;
  /** 上涨家数占比（%） */
  upRatio: number | null;
  /** 涨停占比（%）= 涨停家数 ÷ (上涨 + 下跌家数) */
  limitUpRatio: number | null;
  /** 涨停家数（原始值，tooltip 用） */
  limitUpCount: number | null;
}

/** 单日因子分位（0~100，各自对该板块近 250 日历史取分位） */
export interface FactorPercentiles {
  amountShare: number | null;
  volumeRatio: number | null;
  turnover: number | null;
  smallNetRatio: number | null;
  upRatio: number | null;
  limitUpRatio: number | null;
}

/** 指数结果表 `index_daily` 的序列元素（逐日，含因子原始值与分位） */
export interface IndexPoint {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 题材资金热度指数（0~100） */
  heatIndex: number | null;
  /** 散户情绪指数（0~100）—— 主指标 */
  retailIndex: number | null;
  /** 因子原始值（tooltip 用） */
  factors: FactorValues;
  /** 因子分位（tooltip 与回测调参用） */
  percentiles: FactorPercentiles;
}

/** 背离类型（方案 §4.3 两条） */
export type DivergenceKind = 'blunt' | 'fade';

/** 背离标记（打在主图上的点位） */
export interface DivergenceMark {
  /** 交易日 */
  date: string;
  /** 背离类型 */
  kind: DivergenceKind;
}

/** 板块排行行（排行表 / 列表行的视图模型） */
export interface RankRow {
  /** 板块代码 */
  code: string;
  /** 板块名称 */
  name: string;
  /** 板块类别 */
  kind: BoardKind;
  /** 是否在关注清单 */
  watched: boolean;
  /** 散户情绪指数（最新截面；无历史为 null） */
  retailIndex: number | null;
  /** 热度指数（最新截面；无历史为 null） */
  heatIndex: number | null;
  /** 成交占比（%，最新） */
  amountShare: number | null;
  /** 小单净占比（%，最新） */
  smallRatio: number | null;
  /** 涨跌幅（%，最新） */
  pctChg: number | null;
  /** 当日成交额（元，最新） */
  amount: number | null;
  /** 该板块最新数据日（基准日对照，判断滞后） */
  asOf: string;
  /** 滞后基准日的交易日数（0 = 不滞后；无数据为 null） */
  staleDays: number | null;
  /** 数据是否中断（历史为空） */
  noData: boolean;
}

/** 全市场情绪条摘要（当日快照聚合） */
export interface MoodSummary {
  /** 基准交易日 */
  asOf: string;
  /** 两市成交额（元） */
  totalAmount: number | null;
  /** 较前一交易日变化（%，成交额口径） */
  amountChangePct: number | null;
  /** 上涨家数合计（行业口径） */
  riseCount: number | null;
  /** 下跌家数合计（行业口径） */
  fallCount: number | null;
  /** 全市场涨停家数（涨停池） */
  limitUpCount: number | null;
  /** 连板 ≥2 家数（涨停池） */
  streak2Count: number | null;
  /** 炸板家数（炸板池；取数失败为 null） */
  zhaBanCount: number | null;
  /** 跌停家数（跌停池；取数失败为 null） */
  limitDownCount: number | null;
}

/** 一次采集的元信息（落库，供启动直读与页头展示） */
export interface ScanMeta {
  /** 上次采集完成时间（毫秒时间戳） */
  scannedAt: number;
  /** 全板块统一基准交易日（各指数口径日） */
  asOf: string;
  /** 因「当日未落定」被排除的日期（空串 = 无） */
  excludedDate: string;
  /** 关注题材数 */
  watchCount: number;
  /** 首次采集时间（毫秒时间戳；判「历史回补是否已做」） */
  firstScanAt: number | null;
  /** 涨停池历史已回补至的交易日（空串 = 未回补） */
  limitUpBackfillDate: string;
  /** 本轮失败的板块（保留本地旧数据，界面列失败清单可重试） */
  failures: readonly ScanFailure[];
  /** 换手率字段（clist f8）是否采到过值（实测冒烟结论） */
  turnoverSeen: boolean;
  /** 基准日全市场涨停家数（涨停池；未采集为 null） */
  limitUpTotal: number | null;
  /** 基准日连板 ≥2 家数（涨停池；未采集为 null） */
  streak2Count: number | null;
  /** 基准日炸板家数（炸板池；取数失败为 null） */
  zhaBanCount: number | null;
  /** 基准日跌停家数（跌停池；取数失败为 null） */
  limitDownCount: number | null;
}

/** 单板块采集失败记录 */
export interface ScanFailure {
  /** 板块代码 */
  code: string;
  /** 板块名称 */
  name: string;
  /** 失败原因（上游原始报错摘要） */
  error: string;
}

/** 采集进度（五步流程分段） */
export interface ScanProgress {
  /** 当前步骤 */
  step: ScanStep;
  /** 已完成单元数（板块数 / 日期数） */
  done: number;
  /** 本步单元总数 */
  total: number;
  /** 当前正在处理的单元（如板块名，进度卡展示用；可缺席） */
  current?: string;
}

/** 一次采集的结果（页内提示与浮窗汇报用） */
export interface ScanResult {
  /** 基准交易日 */
  asOf: string;
  /** 被排除的未落定日（空串 = 无） */
  excludedDate: string;
  /** 本轮新增的板块 × 交易日行数 */
  addedRows: number;
  /** 失败板块清单 */
  failures: readonly ScanFailure[];
  /** 是否首次采集（触发了涨停池 30 日回补） */
  firstScan: boolean;
  /** 散户因子缺席提示（东财限流中部分板块 fflow 缺席；空串 = 全量到齐） */
  fflowMissNotice: string;
}

/** 本地快照（启动时读库得到，看板渲染**不联网**） */
export interface SentimentSnapshot {
  /**
   * 板块事实表（升序 days）
   *
   * 关注板块持有全量回补历史（日 K + fflow + 快照字段）；非关注行业板块只有
   * 安装日起每日追加的快照行（排行表「行业」chip 的今日截面数据源）；
   * 未关注的概念板块不落库（只在 refs 清单缓存里，供关注管理搜索）。
   */
  boards: BoardHistory[];
  /** 沪深两市成交额序列（分母） */
  market: MarketPoint[];
  /** 采集元信息；从未采集过为 null */
  meta: ScanMeta | null;
  /** 板块清单缓存（关注管理搜索用） */
  refs: BoardRef[];
  /** 关注题材代码清单 */
  watchlist: readonly string[];
  /** THS 代码 → 东财 BK 代码名称映射（fflow 散户因子的前提；fflow 缺失时缺席降级） */
  emMap: Readonly<Record<string, string>>;
}

/** 排行表排序键 */
export type RankSortKey =
  | 'retailIndex'
  | 'heatIndex'
  | 'amountShare'
  | 'smallRatio'
  | 'pctChg';

/** 详情主图形态 */
export type ChartMode = 'kline' | 'line';

/** 当前筛选与排序状态（视图层组装行的输入） */
export interface RankQuery {
  /** kind 筛选 */
  kind: KindFilter;
  /** 排序键 */
  sortKey: RankSortKey;
  /** 是否降序 */
  sortDesc: boolean;
}
