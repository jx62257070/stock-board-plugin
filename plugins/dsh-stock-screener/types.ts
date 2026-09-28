/**
 * 插件 dsh-stock-screener（选股器）· 类型定义
 *
 * 数据流：全市场快照 / 板块 / 股池 → 股票池（`ScannerPoolItem`）→
 * 逐票新浪日 K（`KlineBar`，会话内缓存）→ 信号判定（`ScanSignalResult`）；
 * 尾盘选股走「快照基础过滤 + 分时强度精筛」（`EodStock`）；
 * 基础筛选走 SDK 链式筛选（`ScreenerFilters`）与 MA 回测（`BacktestResult`）。
 */
import type {
  FormatService,
  StockOpenService,
  UiKitService,
  WatchlistService,
} from '../../host/types/plugin.types';
import type { BacktestReport, StockSDK } from 'stock-sdk';

/**
 * 插件运行所需的宿主能力（依赖注入容器）
 *
 * 为什么不直接在模块里 import：本插件最终以**单文件产物**形态分发，
 * 运行时拿不到宿主模块，只能由 `plugin.ts` 在 `apply(ctx)` 里把服务取好、
 * 沿调用链传下来。同时也让依赖显式化 —— 看这一个对象就知道插件用了宿主什么。
 */
export interface ScreenerDeps {
  /** 格式化与涨跌语义（百分比 / 涨跌色 / 限速节拍 / 符号归一化） */
  format: FormatService;
  /** 宿主 UI Kit（卡片 / 表格 / 按钮 / 标签 / 空态 / 开关 / Tabs） */
  ui: UiKitService;
  /** 全站统一的个股打开交互（右侧详情侧栏 / 详情整页） */
  stockOpen: StockOpenService;
  /** 自选股只读视图（「自选股」股票池来源） */
  watchlist: WatchlistService;
}

/**
 * 插件取数运行时（由 `createRuntime` 构造，页面与 Agent 工具共用）
 *
 * SDK 实例级缓存（代码表 / 交易日历）按实例隔离，整个插件共用一份；
 * K 线会话缓存同理 —— 同一只票在一次会话里反复回测不会重复打上游。
 */
export interface ScreenerRuntime {
  /** stock-sdk 实例（fetchImpl 走宿主 `app:http` 通道 + 东财镜像域改道） */
  sdk: StockSDK;
  /**
   * 拉取日 K（会话内缓存：首次取满，之后只补尾部缺口）
   * @param symbol 完整符号（sh600519 形态）
   * @param options 缓存策略（是否写入缓存 / 单次请求根数上限）
   * @returns 日 K 序列（时间升序）
   */
  fetchDailyKline: (
    symbol: string,
    options?: KlineCacheOptions,
  ) => Promise<KlineBar[]>;
}

/**
 * 日 K 数据项（自定义最小结构，替代 klinecharts 的 KLineData ——
 * 插件只需要 OHLC / 成交量 / 成交额与时间戳，不引入整个图表库）
 */
export interface KlineBar {
  /** 交易日 0 点时间戳（毫秒，本地时区） */
  timestamp: number;
  /** 开盘价 */
  open: number;
  /** 最高价 */
  high: number;
  /** 最低价 */
  low: number;
  /** 收盘价 */
  close: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元；新浪分钟级才返回，日 K 恒为 0） */
  turnover: number;
}

/** K 线缓存水位（会话内缓存的一条元信息） */
export interface KlineCacheMeta {
  /** 完整符号 */
  symbol: string;
  /** 缓存口径（数据源 + 复权方式，如 `sina-none`） */
  source: string;
  /** 库内最早 bar 的交易日（YYYY-MM-DD） */
  firstDate: string;
  /** 库内最新 bar 的交易日（YYYY-MM-DD） */
  lastDate: string;
  /** 库内 bar 总数 */
  barCount: number;
  /** 最近一次回源时间戳（毫秒） */
  fetchedAt: number;
}

/** 日 K 取数缓存策略 */
export interface KlineCacheOptions {
  /**
   * 是否把取回的数据写进会话缓存
   *
   * 单票回测（用户真的在看这只票）传 true；整池扫描传 false ——
   * 不然点一次扫描就会把整个股票池的日 K 灌进缓存。
   */
  store?: boolean;
  /** 首次请求（无缓存）时的根数上限（收窄批量场景的请求体量） */
  barLimit?: number;
}

/** 选股条件（区间为闭区间；字段缺省表示不过滤） */
export interface ScreenerFilters {
  /** 涨跌幅下限（%） */
  changeMin?: number;
  /** 涨跌幅上限（%） */
  changeMax?: number;
  /** 换手率下限（%） */
  turnoverMin?: number;
  /** 换手率上限（%） */
  turnoverMax?: number;
  /** 量比下限 */
  volumeRatioMin?: number;
  /** 市盈率 TTM 上限 */
  peMax?: number;
}

/** 回测 K 线项（日 K 截取近一年窗口 + MA 指标） */
export interface BacktestBar {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 收盘价（不复权） */
  close: number;
  /** MA 指标（ma5 / ma20） */
  ma: Record<string, number | null>;
}

/** 回测结果：报告 + 权益曲线数据（供图表渲染） */
export interface BacktestResult {
  /** SDK 回测报告（含买入持有基准） */
  report: BacktestReport;
  /** 日期序列（与权益曲线对齐） */
  dates: string[];
  /** 策略权益曲线（元） */
  equityCurve: number[];
  /** 买入持有基准权益曲线（元，不含费） */
  buyHoldCurve: number[];
}

/** 信号扫描 K 线数据项（含按需启用的指标） */
export interface ScanKlineBar {
  close: number | null;
  ma?: Record<string, number | null>;
  macd?: { dif?: number | null; dea?: number | null; macd?: number | null };
  rsi?: Record<string, number | null>;
  boll?: { upper?: number | null; mid?: number | null; lower?: number | null };
}

/** 分析进度（阶段 + 已完成 / 总数） */
export interface AnalysisProgress {
  /** 阶段文案（如「技术信号扫描」） */
  stage: string;
  /** 已完成数 */
  completed: number;
  /** 总数 */
  total: number;
}

/**
 * 技术信号 key（MA / MACD / RSI / BOLL 四族八种）
 */
export type SignalKey =
  | 'ma_golden'
  | 'ma_death'
  | 'macd_golden'
  | 'macd_death'
  | 'rsi_oversold'
  | 'rsi_overbought'
  | 'boll_upper'
  | 'boll_lower';

/** 扫描股票池条目 */
export interface ScannerPoolItem {
  /** 展示代码（6 位纯代码） */
  code: string;
  /** 完整符号（sh600519 形态，拉取 K 线 / 跳详情用） */
  symbol: string;
  /** 股票名称 */
  name: string;
}

/** 信号扫描结果行 */
export interface ScanSignalResult {
  /** 展示代码 */
  code: string;
  /** 完整符号 */
  symbol: string;
  /** 股票名称 */
  name: string;
  /** 命中的信号标签列表（如 ['MA金叉']） */
  matchedLabels: string[];
}

/** 尾盘选股过滤条件（参考同花顺尾盘选股法默认值） */
export interface EodFilters {
  /** 流通市值下限（亿） */
  marketCapMin: number;
  /** 流通市值上限（亿；null 表示不设上限） */
  marketCapMax: number | null;
  /** 量比下限 */
  volumeRatioMin: number;
  /** 当日涨幅下限（%） */
  changePercentMin: number;
  /** 当日涨幅上限（%；null 表示不设上限） */
  changePercentMax: number | null;
  /** 换手率下限（%） */
  turnoverRateMin: number;
  /** 换手率上限（%；null 表示不设上限） */
  turnoverRateMax: number | null;
  /** 是否过滤 ST 股票 */
  excludeST: boolean;
  /** 分时强度下限（分时价位于均价上方的时间占比，%） */
  timelineAboveAvgRatioMin: number;
}

/** 尾盘选股结果行（基础过滤 + 分时结构筛选后） */
export interface EodStock {
  /** 展示代码（6 位纯代码） */
  code: string;
  /** 完整符号 */
  symbol: string;
  /** 股票名称 */
  name: string;
  /** 现价（元） */
  price: number;
  /** 涨跌幅（%） */
  changePercent: number;
  /** 换手率（%） */
  turnoverRate: number | null;
  /** 量比 */
  volumeRatio: number | null;
  /** 流通市值（亿） */
  circulatingMarketCap: number | null;
  /** 分时强度（分时价位于均价上方的时间占比，%） */
  timelineAboveAvgRatio: number;
}
