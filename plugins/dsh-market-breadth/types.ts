/**
 * 插件 dsh-market-breadth（市场宽度）· 类型定义
 *
 * 数据管道（类型自宿主 `src/common/types/market-breadth.types.ts` 复制，口径注明）：
 * 全市场快照（stock-sdk FullQuote[]）→ MarketBreadth（当日统计）
 * → BreadthPoint（分钟点，同分钟去重，落 ctx.db `minute_point` 表）
 * → BreadthDayBar（收盘后聚合的日 bar，落 ctx.db `day_bar` 表）。
 * 历史无免费上游源，日线由本地按日积累，无法回填。
 */
import type { FullQuote } from 'stock-sdk';
import type { AgentAskService, UiKitService } from '../../host/types/plugin.types';
import type {
  ArmsStateKey,
  BreadthIndicatorKind,
  BreadthIndicatorViewKey,
} from './constants';

/**
 * 插件运行所需的宿主能力（依赖注入容器）
 *
 * 单文件产物形态下没有 import 可用，所有宿主依赖只能从 ctx 上来
 * （`plugin.ts` 在 `apply(ctx)` 里取齐后沿调用链传下）。
 */
export interface BreadthDeps {
  /** Agent 分析唤起服务（「AI 分析」按钮用；服务缺席时按钮隐藏） */
  agentAsk: AgentAskService | null;
  /** A 股盘中判定（轮询窗口用；服务缺席时降级为「始终轮询」） */
  isIntraday: () => boolean;
  /** 宿主 UI Kit（卡片 / 弹窗 / 按钮 / 空态 / Tabs） */
  ui: UiKitService;
}

/**
 * 插件取数运行时（页面与 Agent 工具共用）
 */
export interface BreadthRuntime {
  /**
   * 拉取全市场 A 股快照（东财源，小并发分页：并发 3 / 每页 500）
   * @returns 全市场完整报价列表
   */
  fetchAllQuotes: () => Promise<FullQuote[]>;
}

/** 当日市场宽度统计（ARMS 为成交量口径，与通达信主流一致；自宿主复制） */
export interface MarketBreadth {
  /** 上涨家数 */
  upCount: number;
  /** 下跌家数 */
  downCount: number;
  /** 平盘家数 */
  flatCount: number;
  /** 上涨股成交量合计（手） */
  upVol: number;
  /** 下跌股成交量合计（手） */
  downVol: number;
  /** 涨跌比 A/D = 上涨家数 ÷ 下跌家数（下跌为 0 时 null） */
  ad: number | null;
  /**
   * 阿姆氏指标 ARMS = (上涨家数 ÷ 下跌家数) ÷ (上涨成交量 ÷ 下跌成交量)
   * （分母为 0 或家数为 0 时 null，展示「--」）
   */
  arms: number | null;
  /** 活跃股家数（日换手率 > 阈值，阈值见 constants 的 BREADTH_ACTIVE_TURNOVER_THRESHOLD） */
  activeCount: number;
  /** 换手率有效（正常交易）家数（活跃占比的分母） */
  activeTotal: number;
  /** 活跃占比（%，活跃家数 ÷ 有效家数 ×100；无有效样本为 null） */
  activeRatio: number | null;
}

/** 市场宽度分钟点（分时曲线的数据点；time 已取整到分钟） */
export interface BreadthPoint {
  /** 分钟时间戳（毫秒，已向下取整到分钟） */
  time: number;
  /** 上涨家数 */
  upCount: number;
  /** 下跌家数 */
  downCount: number;
  /** 平盘家数 */
  flatCount: number;
  /** 上涨股成交量合计（手） */
  upVol: number;
  /** 下跌股成交量合计（手） */
  downVol: number;
  /** ARMS 值（无法计算时 null） */
  arms: number | null;
  /** 活跃股家数（换手率 > 阈值；缺失字段按旧点兜底） */
  activeCount?: number;
  /** 换手率有效（正常交易）家数（缺失字段按旧点兜底） */
  activeTotal?: number;
}

/** 市场宽度日 bar（每交易日 15:00 后由当日最后一个分钟点聚合落库） */
export interface BreadthDayBar {
  /** 交易日（本地日键 YYYY-MM-DD） */
  date: string;
  /** 收盘上涨家数 */
  upCount: number;
  /** 收盘下跌家数 */
  downCount: number;
  /** 收盘上涨股成交量合计（手） */
  upVol: number;
  /** 收盘下跌股成交量合计（手） */
  downVol: number;
  /** 收盘 ARMS 值（无法计算时 null） */
  arms: number | null;
  /** 收盘活跃股家数（换手率 > 阈值；旧 bar 可能缺失） */
  activeCount?: number;
  /** 收盘换手率有效（正常交易）家数（旧 bar 可能缺失） */
  activeTotal?: number;
}

/** 五大市场广度指标序列 + 活跃占比（逐日对齐；自宿主复制） */
export interface BreadthIndicatorSeries {
  /** 交易日键序列（YYYY-MM-DD 升序，其余数组按此下标对齐） */
  dates: string[];
  /** ADL 腾落线（Σ(上涨-下跌家数)，自本地首条 bar 累加，仅相对意义） */
  adl: Array<number | null>;
  /** ADL 的 MA 均线 */
  adlMa: Array<number | null>;
  /** ADR 涨跌比率（N 日上涨家数总和 ÷ N 日下跌家数总和；下跌总和为 0 时 null） */
  adr: Array<number | null>;
  /** OBOS 超买超卖（N 日上涨家数总和 − N 日下跌家数总和） */
  obos: Array<number | null>;
  /** OBOS 的 MA 均线 */
  obosMa: Array<number | null>;
  /** ARMS 平滑均线（日 bar ARMS 的 MA；窗口内无有效 ARMS 时 null） */
  armsMa: Array<number | null>;
  /** MCO 麦克莱伦震荡指标（EMA(DIF,19) − EMA(DIF,39)，DIF = 上涨 − 下跌家数） */
  mco: Array<number | null>;
  /** MCO 信号线（MCO 的 MA） */
  mcoSignal: Array<number | null>;
  /** 活跃占比（%，换手率 > 阈值家数 ÷ 换手率有效家数 ×100；旧 bar 无字段为 null） */
  activeRatio: Array<number | null>;
}

/** 副图卡配置（声明顺序 = 默认展示顺序） */
export interface BreadthIndicatorCard {
  /** 指标 kind（同时也是副图 key） */
  key: BreadthIndicatorKind;
  /** 卡标题 */
  label: string;
  /** 标题行右侧口径说明 */
  subtitle: string;
  /** 最新值小数位 */
  digits: number;
}

/** ARMS 状态判定结果 */
export interface ArmsStateResult {
  /** 状态 key（ARMS_STATE 之一） */
  key: ArmsStateKey;
  /** 中文状态文案 */
  label: string;
  /** 语义色调：up 红（强）/ down 绿（弱）/ flat 灰（平衡），供 UI 类名映射 */
  tone: 'up' | 'down' | 'flat';
}

/** 解读行语义色档位（跟随涨跌配色主题消费） */
export type BreadthInterpretTone = 'up' | 'down' | 'flat';

/** 解读结果：一句白话 + 语义色档位 */
export interface BreadthInterpretation {
  /** 白话解读文案 */
  text: string;
  /** 语义色档位 */
  tone: BreadthInterpretTone;
}

/** 「总结」弹窗的一个条目：指标名 / 展示值 / 白话解读 */
export interface BreadthSummaryItem {
  /** 指标 kind */
  kind: BreadthIndicatorKind;
  /** 指标名 */
  label: string;
  /** 展示文案（数值或「--」） */
  display: string;
  /** 白话解读（无数据为 null） */
  interpret: BreadthInterpretation | null;
}

/** 视图档位选项（页签 value 复用 BreadthIndicatorViewKey） */
export interface BreadthViewOption {
  /** 页签文案 */
  label: string;
  /** 页签值 */
  value: BreadthIndicatorViewKey;
}
