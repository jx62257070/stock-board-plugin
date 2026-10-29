/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 类型定义
 *
 * CCPM 数据类型从宿主 `src/common/types/futures.types.ts` 期货机构行为段复制
 * （插件禁 import 宿主 src/，契约保持一致；字段口径以宿主为准）。
 *
 * 原始行 = 三榜（成交量 / 持买单量 / 持卖单量）按【合约 + 会员】并集归并后的行；
 * 未上榜的指标记 null（不记 0，避免污染占比与合并计算）。
 */

/* ==================== CCPM 数据类型（源自宿主 futures.types.ts） ==================== */

/** 三榜并集归并后的原始行（未计算指标） */
export interface CcpmMemberRow {
  /** 完整合约代码（如 IF2611） */
  instrumentId: string;
  /** 会员简称（代客口径） */
  memberName: string;
  /** 成交量（手），未上榜为 null */
  volume: number | null;
  /** 成交量较上一交易日增减，未上榜为 null */
  volumeChg: number | null;
  /** 持买单量（手），未上榜为 null */
  buyPos: number | null;
  /** 多单较上一交易日增减，未上榜为 null */
  buyChg: number | null;
  /** 持卖单量（手），未上榜为 null */
  sellPos: number | null;
  /** 空单较上一交易日增减，未上榜为 null */
  sellChg: number | null;
}

/** 行为标签（算法自动识别，仅供分析） */
export type CcpmBehaviorTag = 'hedge' | 'long' | 'short';

/** 合约整体合计（该合约全部上榜会员求和） */
export interface CcpmInstrumentTotals {
  /** 合约代码 */
  instrumentId: string;
  /** 上榜总成交量（手） */
  volume: number;
  /** 上榜总多单（手） */
  buy: number;
  /** 上榜总空单（手） */
  sell: number;
}

/** 单合约维度：原始行 + 计算指标 */
export interface CcpmMemberStats extends CcpmMemberRow {
  /** 净持仓 = buyPos − sellPos（两侧都未上榜时为 null） */
  netPos: number | null;
  /** 净增减 = buyChg − sellChg（两侧都未上榜时为 null） */
  netChg: number | null;
  /** 多头占比（%）：buyPos ÷ 该合约上榜总多单 × 100，未上榜为 null */
  buyRatio: number | null;
  /** 空头占比（%）：sellPos ÷ 该合约上榜总空单 × 100，未上榜为 null */
  sellRatio: number | null;
  /** 行为标签；数据不足以判定（任一侧未上榜 / 全平）时为 null */
  tag: CcpmBehaviorTag | null;
  /** 标签判定依据（hover tooltip 展示）；无标签时说明原因 */
  tagReason: string | null;
}

/** 品种单日数据（一个品种一个披露文件解析 + 归并后的完整结果） */
export interface CcpmProductDayData {
  /** 交易日（yyyyMMdd，取自 CSV 数据行） */
  tradingDay: string;
  /** 品种代码（IF / IH / …） */
  product: string;
  /** 当日挂牌且披露的合约列表（按 CSV 出现顺序） */
  instruments: string[];
  /** 三榜并集归并后的原始行（全部合约） */
  rows: CcpmMemberRow[];
  /** 合约 → 整体合计 */
  totals: Record<string, CcpmInstrumentTotals>;
}

/** 跨合约 / 跨品种聚合行（一行一个会员） */
export interface CcpmAggregateRow {
  /** 会员简称 */
  memberName: string;
  /** 合并多单（上榜合约求和，null 侧记 0） */
  totalBuy: number;
  /** 合并空单 */
  totalSell: number;
  /** 合并净持仓 = totalBuy − totalSell */
  totalNet: number;
  /** 合并多头增减 */
  totalBuyChg: number;
  /** 合并空头增减 */
  totalSellChg: number;
  /** 合并净增减 = totalBuyChg − totalSellChg */
  totalNetChg: number;
  /** 合并成交量（仅同品种口径参与，跨品种口径不合并成交量） */
  totalVolume: number;
  /** 上榜合约数（该会员有数据的合约数） */
  coveredCount: number;
  /** 该口径下的合约总数（品种合约数 / 全股指合约数之和） */
  totalCount: number;
  /** coveredCount < totalCount：合并结果为部分头寸，页面必须红字提示 */
  isPartial: boolean;
  /** 行为标签（与单合约同一套规则，作用于合并后的多空总量与增减；无法判定时 null） */
  tag: CcpmBehaviorTag | null;
  /** 标签判定依据；无标签时说明原因 */
  tagReason: string | null;
}

/** 聚合口径 */
export type CcpmScopeMode = 'contract' | 'product' | 'all';

/** 席位单日聚合点（时序图 / 跨品种明细用） */
export interface CcpmMemberDayPoint {
  /** 交易日 yyyyMMdd */
  tradingDay: string;
  /** 合并多单 */
  totalBuy: number;
  /** 合并空单 */
  totalSell: number;
  /** 合并净持仓 */
  totalNet: number;
  /** 合并净增减 */
  totalNetChg: number;
  /** 上榜合约数 / 口径合约总数（完整性） */
  coveredCount: number;
  totalCount: number;
}

/** 时序图数据：某席位近 N 个披露日的合并净持仓走势 */
export interface CcpmMemberSeries {
  /** 席位名 */
  memberName: string;
  /** 品种范围（同品种 or 全股指） */
  products: readonly string[];
  /** 按交易日升序的点列 */
  points: CcpmMemberDayPoint[];
}

/** 移仓换月条目（席位 × 近月 / 次月合约增减对比） */
export interface CcpmRollEntry {
  /** 会员简称 */
  memberName: string;
  /** 近月合约代码 */
  nearInstrument: string;
  /** 次月合约代码 */
  farInstrument: string;
  /** 近月多单增减 */
  nearBuyChg: number | null;
  /** 近月空单增减 */
  nearSellChg: number | null;
  /** 次月多单增减 */
  farBuyChg: number | null;
  /** 次月空单增减 */
  farSellChg: number | null;
  /** 疑似移仓（近月某方向减仓且次月同方向增仓，阈值判定） */
  rolling: boolean;
}

/* ==================== 插件运行时类型 ==================== */

import type {
  AgentAskService,
  FormatService,
  HttpService,
  UiKitService,
} from '../../host/types/plugin.types';
import type { NotifyService } from '../../host/types/notify.types';
import type { FuturesRepo } from './storage';
import type { FuturesDataApi } from './data';

/** AI 分析数据段（表格形态，组装进提示词） */
export interface CcpmAnalysisDataset {
  /** 段标题 */
  title: string;
  /** 列（label 展示名 / key 行键） */
  columns: ReadonlyArray<{ label: string; key: string }>;
  /** 行数据（键与 columns.key 对应） */
  rows: ReadonlyArray<Record<string, unknown>>;
}

/**
 * 宿主能力依赖链（单文件产物形态没有 import 可用，所有宿主依赖从 ctx 上来，
 * 沿调用链显式注入 —— 参照 dsh-broad-track 的 `BroadDeps` 做法）
 */
export interface FuturesDeps {
  /** 受控网络请求（app:http，白名单已含 cffex.com.cn） */
  http: HttpService;
  /** 格式化与限速节拍（app:format；delay 是上游错峰的唯一实现） */
  format: FormatService;
  /** 宿主 UI Kit（app:ui：Button / Tabs / Table / Tag / Card / …，看板 UI 全部走它） */
  ui: UiKitService;
  /** 应用级浮窗提醒（app:notify；缺席时静默降级） */
  notify: NotifyService | null;
  /** Agent 分析唤起（app:agent-ask；缺席时「AI 分析」按钮降级提示） */
  agentAsk: AgentAskService | null;
}

/** 插件取数运行时（repo + data + deps，页面与 MCP 工具共用） */
export interface FuturesRuntime {
  /** 本地快照仓储（ctx.db） */
  repo: FuturesRepo;
  /** 取数器（上游 CSV + 两级缓存） */
  data: FuturesDataApi;
  /** 宿主能力依赖 */
  deps: FuturesDeps;
}
