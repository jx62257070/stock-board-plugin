/**
 * 插件 dsh-broad-track（宽基跟踪）· 类型定义
 *
 * 数据流：
 * - 日频：ulist 行情快照 + fflow 资金流日 K → `EtfDailyRow`（落库 `etf_daily`）；
 * - 季频：F10 `gmbd` 份额申赎 → `EtfQuarterRow`（落库 `etf_quarter`）；
 * - 半年频：F10 `cyrjg` 持有人结构 → `EtfHolderRow`（落库 `etf_holders`）；
 * - 锚点：用户编辑的 `AnchorHolding[]`（落库 `anchor` 表）。
 * 展示口径全部由 `estimate.ts` 从落库数据现算（读库即渲染，零联网）。
 */
// 宿主服务契约只需要**类型**：`import type` 打包后完全消失，产物里不存在任何
// 宿主模块的引用，但源码仍然享受完整的类型检查
import type {
  FormatService,
  HttpService,
  UiKitService,
} from '../../host/types/plugin.types';
import type { SignalLevel } from './constants';

/**
 * 插件运行所需的宿主能力（依赖注入容器）
 *
 * 单文件产物形态下没有 import 可用，所有宿主依赖只能从 ctx 上来
 * （`plugin.ts` 在 `apply(ctx)` 里取齐后沿调用链传下）。
 */
export interface BroadDeps {
  /** 受控网络请求（走宿主上游通道，域名白名单内） */
  http: HttpService;
  /** 格式化与涨跌语义（百分比 / 涨跌色 / 限速节拍） */
  format: FormatService;
  /** 宿主 UI Kit（卡片 / 表格 / 按钮 / 标签 / 空态 / 图标 / 弹窗） */
  ui: UiKitService;
}

/**
 * 一只 ETF 在一个交易日的**份额**行（落库 `etf_share_daily`）
 *
 * 这是本插件观测「国家队操作」的主口径：份额变动 = 真实申赎，
 * 与二级市场资金流（谁在买卖）不同。
 */
export interface EtfShareRow {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 6 位裸代码 */
  code: string;
  /** 期末总份额（亿份） */
  sharesYi: number;
  /** 较上一有数据交易日的份额变动（亿份；正 = 净申购） */
  deltaYi: number;
  /** 当日收盘价（元；缺失为 null） */
  price: number | null;
  /** 估算净申赎金额（亿元 = deltaYi × price；价格缺失为 null） */
  amountYi: number | null;
  /** 数据来源标记（上交所 / 深交所） */
  source: ShareSource;
}

/** 份额数据来源 */
export type ShareSource = 'sse' | 'szse';

/**
 * 组合（宽基口径合计）的一个交易日份额快照
 *
 * 组合份额 = 清单内全部 ETF 的份额之和；组合等权指数 = 各 ETF 收盘价等权平均。
 */
export interface ComboSharePoint {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 组合总份额（亿份） */
  totalSharesYi: number;
  /** 组合份额日变动（亿份；正 = 净申购） */
  deltaSharesYi: number;
  /** 组合估算净申赎金额（亿元；价格缺失为 null） */
  netFlowYi: number | null;
  /** 组合等权平均收盘价（元；缺失为 null） */
  avgPrice: number | null;
  /** 参与合计的 ETF 只数 */
  memberCount: number;
}

/** 份额口径的信号档位 */
export type ShareSignalLevel = 'none' | 'enter' | 'exit';

/**
 * 国家队操作战役的生命周期状态（一波操作的完整轨迹）
 *
 * 观望 → 疑似进场 → 确认进场 → 进场结束 → 持仓观望
 *      → 疑似退场 → 确认退场 → 退场结束（宽基轻仓/清仓）→ 观望
 *
 * - 疑似 = 部分证据（连续同向 2 日，或单日申赎额达确认门槛一半）；
 * - 确认 = 全部证据（连续天数 + 段内累计金额 + 指数位置，三条件齐）；
 * - 结束 = 方向段终止（方向反转，或连续静默兜底），同时固化本波战役统计。
 */
export type ShareLifecycleState =
  | 'watching'
  | 'entry_suspected'
  | 'entry_confirmed'
  | 'entry_done'
  | 'holding'
  | 'exit_suspected'
  | 'exit_confirmed'
  | 'exit_done';

/** 退场完成度档位（按本轮退场累计 ÷ 此前累计进场余额估算，非国家队专属口径） */
export type ShareExitCompletion = 'partial' | 'light' | 'cleared';

/**
 * 一波国家队操作战役（方向段级别的完整轨迹）
 *
 * 战役 = 一个方向段（连续同向份额变动）。疑似日 / 确认日 / 结束日分别记录，
 * 结束时固化段内累计净申赎与「估算持仓余额」。
 */
export interface ShareCampaignWave {
  /** 战役方向 */
  level: Exclude<ShareSignalLevel, 'none'>;
  /** 段起始日（YYYY-MM-DD） */
  startDate: string;
  /** 疑似日（首个部分证据日；全程未触发为 null） */
  suspectDate: string | null;
  /** 确认日（全部证据齐备日；未确认为 null） */
  confirmDate: string | null;
  /** 结束日（方向反转 / 静默兜底 / 数据末尾） */
  endDate: string;
  /** 结束原因：reversal = 方向反转；silent = 连续静默；eof = 数据末尾 */
  endReason: 'reversal' | 'silent' | 'eof';
  /** 段内交易日数 */
  days: number;
  /** 段内累计净申赎金额（亿元；进场为正、退场为负） */
  netFlowYi: number;
  /** 结束后的估算持仓余额（亿元；Σ进场 − Σ退场，含全市场噪音） */
  balanceYi: number;
  /** 退场完成度（仅退场战役有；余额占比口径） */
  exitCompletion: ShareExitCompletion | null;
  /** 确认依据（确认日当天的证据链；未确认为空） */
  evidences: string[];
}

/**
 * 一个交易日的份额口径信号（现算不落库）
 */
export interface ShareSignalDay {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 组合总份额（亿份） */
  totalSharesYi: number;
  /** 当日份额变动（亿份） */
  deltaSharesYi: number;
  /** 当日估算净申赎金额（亿元；缺失为 null） */
  netFlowYi: number | null;
  /** 组合等权指数（点位；缺失为 null） */
  indexLevel: number | null;
  /** 组合指数距前高的回撤（%，≤0；0 = 处于新高；缺失为 null） */
  drawdownPct: number | null;
  /** 截至当日的连续净增 / 净减天数（正数 = 连续净增） */
  changeStreak: number;
  /** 信号档位 */
  level: ShareSignalLevel;
  /** 当日所处的战役生命周期状态 */
  lifecycle: ShareLifecycleState;
  /** 触发依据（人类可读） */
  evidences: string[];
}

/**
 * 历史回测的一段评估（现算不落库）
 *
 * 评估对象是「份额口径信号」：信号出现后的持有期收益 vs 基准。
 */
export interface ShareBacktestStat {
  /** 信号档位 */
  level: ShareSignalLevel;
  /** 信号出现次数 */
  count: number;
  /** 信号出现后第 1 日的平均收益（%） */
  avgReturn1d: number | null;
  /** 信号出现后第 N 日（持有期）的平均收益（%） */
  avgReturnHold: number | null;
  /** 持有期内上涨的次数 */
  winCount: number;
  /** 持有期收益率（%） */
  winRate: number | null;
  /** 样本明细（信号日期 + 后续收益） */
  samples: ShareBacktestSample[];
}

/** 回测的一条样本 */
export interface ShareBacktestSample {
  /** 信号日期（YYYY-MM-DD） */
  date: string;
  /** 信号档位 */
  level: ShareSignalLevel;
  /** 信号后第 1 日收益（%） */
  return1d: number | null;
  /** 信号后第 N 日收益（%） */
  returnHold: number | null;
  /** 信号时的指数点位 */
  indexLevel: number | null;
}

/**
 * 一只 ETF 在一个交易日的**两融余额**行（落库 `etf_margin_daily`）
 *
 * 融资余额是杠杆资金的仓位痕迹：国家队进场时杠杆去化（余额下降）= 筹码
 * 从弱手换到强手；退场时杠杆接力（余额上升）= 散户杠杆在接盘。
 * 是操作建议证据评分的独立维度（与份额、主力资金流互不重复）。
 */
export interface EtfMarginRow {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 6 位裸代码 */
  code: string;
  /** 融资余额（亿元；缺失为 null） */
  balanceYi: number | null;
  /** 当日融资净买入（亿元，正 = 杠杆加仓；缺失为 null） */
  netBuyYi: number | null;
}

/** ulist 批量行情的一行（ETF 或指数） */
export interface QuoteRow {
  /** 代码（ETF 为 6 位裸码，指数为 000300 形态） */
  code: string;
  /** 名称（上游口径） */
  name: string;
  /** 最新价（元 / 点位） */
  price: number | null;
  /** 涨跌幅（%） */
  changePercent: number | null;
  /** 成交额（元） */
  amount: number | null;
}

/** 一只 ETF 在一个交易日的日频行（落库 `etf_daily`） */
export interface EtfDailyRow {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 6 位裸代码 */
  code: string;
  /** 收盘价 / 最新价（元） */
  price: number | null;
  /** 涨跌幅（%） */
  changePercent: number | null;
  /** 当日成交额（元；ulist 快照口径，非 fflow 字段） */
  amount: number | null;
  /** 主力净流入（元） */
  mainInflow: number | null;
  /** 超大单净流入（元） */
  superInflow: number | null;
  /** 大单净流入（元） */
  bigInflow: number | null;
  /** 中单净流入（元） */
  midInflow: number | null;
  /** 小单净流入（元） */
  smallInflow: number | null;
}

/** 一只 ETF 在一个报告期的份额申赎行（落库 `etf_quarter`） */
export interface EtfQuarterRow {
  /** 6 位裸代码 */
  code: string;
  /** 报告期（YYYY-MM-DD；季末 / 半年末） */
  periodEnd: string;
  /** 期间申购（亿份） */
  subscribeYi: number | null;
  /** 期间赎回（亿份） */
  redeemYi: number | null;
  /** 期末总份额（亿份） */
  sharesEndYi: number | null;
  /** 期末净资产（亿元） */
  netAssetYi: number | null;
  /** 净资产变动率（%） */
  assetChangeRate: number | null;
}

/** 一只 ETF 在一期的持有人结构行（落库 `etf_holders`） */
export interface EtfHolderRow {
  /** 6 位裸代码 */
  code: string;
  /** 公告日期（YYYY-MM-DD；半年末 / 年末） */
  periodEnd: string;
  /** 机构持有比例（%，真值小数） */
  instRatio: number | null;
  /** 总份额（亿份） */
  totalSharesYi: number | null;
}

/** 国家队持仓锚点（一只 ETF 一条；用户可编辑） */
export interface AnchorHolding {
  /** 6 位裸代码 */
  code: string;
  /** 锚点报告期（YYYY-MM-DD） */
  periodEnd: string;
  /** 锚点持仓份额（亿份） */
  sharesYi: number;
  /** 来源说明（如「2025 年报披露整理」/「按持有人结构推算」） */
  source: string;
}

/** 扫描元信息（落库 `scan_meta`，界面页头展示） */
export interface BroadMeta {
  /** 日频刷新完成时间（毫秒时间戳；从未刷新为 null） */
  dailyRefreshedAt: number | null;
  /** 季度同步完成时间（毫秒时间戳；从未同步为 null） */
  quarterRefreshedAt: number | null;
  /** 最近一次刷新的降级与告警（空数组 = 一切正常） */
  warnings: string[];
  /** 最近一次刷新拿到的指数快照（页头展示；未刷新为空数组） */
  indexQuotes: QuoteRow[];
  /** 份额序列同步完成时间（毫秒时间戳；从未同步为 null） */
  shareSyncedAt: number | null;
  /** 份额序列已覆盖的最早日期（YYYY-MM-DD；未同步为空串） */
  shareEarliestDate: string;
  /** 份额序列已覆盖的最新日期（YYYY-MM-DD；未同步为空串） */
  shareLatestDate: string;
  /** 两融余额同步完成时间（毫秒时间戳；从未同步为 null） */
  marginSyncedAt: number | null;
}

/** 一只 ETF 的国家队持仓预估（展示口径，现算不落库） */
export interface EtfEstimate {
  /** 6 位裸代码 */
  code: string;
  /** 展示名 */
  name: string;
  /** 跟踪指数名 */
  indexName: string;
  /** 锚点份额（亿份） */
  anchorSharesYi: number;
  /** 锚点报告期 */
  anchorPeriodEnd: string;
  /** 锚点来源说明 */
  anchorSource: string;
  /** 锚点以来净申购合计（亿份） */
  netSubscribeYi: number;
  /** 滚动分摊份额（亿份；净申购 × 国家队占比） */
  rolledSharesYi: number;
  /** 预估持仓份额（亿份） */
  estSharesYi: number;
  /** 最新价（元） */
  latestPrice: number | null;
  /** 预估持仓金额（亿元；价格缺失为 null） */
  estAmountYi: number | null;
  /** 锚点折合金额（亿元；用同一最新价折算，缺失为 null） */
  anchorAmountYi: number | null;
  /** 预估较锚点变动（亿元；价格缺失为 null） */
  deltaYi: number | null;
  /** 最近报告期的期末总份额（亿份；无数据为 null） */
  sharesEndYi: number | null;
  /** 最近报告期的净资产（亿元；无数据为 null） */
  netAssetYi: number | null;
  /** 最近报告期的净申购（亿份；无数据为 null） */
  lastNetSubscribeYi: number | null;
  /** 最近报告期（YYYY-MM-DD；无数据为空串） */
  lastPeriodEnd: string;
  /** 最新机构持有比例（0-1；无数据为 null） */
  instRatio: number | null;
}

/** 一个交易日聚合后的信号输入（宽基口径合计） */
export interface SignalDayInput {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 宽基指数等权平均涨跌幅（%；无数据为 null） */
  indexAvgChange: number | null;
  /** 宽基 ETF 主力净流入合计（元） */
  mainInflowTotal: number;
  /** 宽基 ETF 成交额合计（元） */
  amountTotal: number;
  /** 近 20 日成交额均值（元；数据不足为 null） */
  amountAvg20: number | null;
  /** 截至当日的主力净流出连续天数（当日净流出才计数） */
  outflowStreak: number;
}

/** 一个交易日的信号判定结果 */
export interface SignalDayResult extends SignalDayInput {
  /** 信号档位 */
  level: SignalLevel;
  /** 触发依据（人类可读，逐条列出） */
  evidences: string[];
}

/** 宽基跟踪快照（repo 读出口径） */
export interface BroadSnapshot {
  /** 代码 → 日频行（升序；可能缺最近交易日） */
  dailyByCode: Map<string, EtfDailyRow[]>;
  /** 有日频数据的日期集合（升序） */
  dailyDates: string[];
  /** 代码 → 份额行（升序） */
  sharesByCode: Map<string, EtfShareRow[]>;
  /** 份额数据的日期集合（升序） */
  shareDates: string[];
  /** 代码 → 两融余额行（升序） */
  marginByCode: Map<string, EtfMarginRow[]>;
  /** 代码 → 季度行（按期降序） */
  quartersByCode: Map<string, EtfQuarterRow[]>;
  /** 代码 → 持有人结构行（按期降序） */
  holdersByCode: Map<string, EtfHolderRow[]>;
  /** 锚点清单（按清单顺序） */
  anchors: AnchorHolding[];
  /** 扫描元信息 */
  meta: BroadMeta;
}

/** 刷新进度载荷 */
export interface BroadScanProgress {
  /** 已完成请求数 */
  done: number;
  /** 预计请求总数 */
  total: number;
}
