/**
 * 「盯盘小组件」三个内容视图的市场数据契约（`app:market-data` 服务的返回载荷）
 *
 * 只声明**气泡渲染所需的最小字段集**，上游类型（ThsTurnoverMinute / HotNewsItem /
 * HotBoardItem）的字段名与口径随版本变化，服务实现层做显式映射 ——
 * 插件与渲染端拿到的结构因此长期稳定。
 */

/** 实时成交额快照（市场总览「实时成交额」模块同源：同花顺 dq 域） */
export interface MarketTurnoverSnapshot {
  /** 今日实时累计成交额（元；null = 上游未返回） */
  turnover: number | null;
  /** 较上一日同时刻变动（元，后端直出环比） */
  turnoverChange: number | null;
  /** 预测全天成交额（元） */
  predictTurnover: number | null;
  /** 近 60 日平均成交额（元；5 日均由实现层按日 K 本地平均后一并给出） */
  averageTurnover: number | null;
  /** 近 5 日平均成交额（元；实现层按日 K 近 5 条本地计算） */
  averageTurnover5: number | null;
  /** 分时点列（升序；当日累计与昨日同时刻，供气泡迷你双线） */
  points: MarketTurnoverPoint[];
}

/** 实时成交额分时点 */
export interface MarketTurnoverPoint {
  /** 当日累计成交额（元） */
  turnover: number | null;
  /** 昨日同时刻累计成交额（元） */
  pre: number | null;
}

/** 新闻源键（与热点新闻页 HotNewsView 的源全集一致） */
export type MarketNewsSource = 'sina' | 'eastmoney' | 'ths' | 'thepaper' | 'cls' | 'tdx';

/** 新闻标题行（气泡只显示标题，不带摘要 / 图片 / 正文） */
export interface MarketNewsHeadline {
  /** 原文链接（点击经 OPEN_URL 事件交给主窗口打开） */
  url: string;
  /** 标题 */
  title: string;
  /** 发布时间（秒级 Unix 时间戳字符串；空串 = 上游未提供） */
  ctime: string;
}

/** 热榜平台键（与「今天炒什么」页 BOARD_SOURCE 全集一致） */
export type MarketBoardSource = 'ths' | 'em' | 'cls' | 'tdx' | 'xq';

/** 热榜行（名称 / 现价 / 涨跌幅 / 热度文案；个股行可跳详情） */
export interface MarketBoardRow {
  /** 完整符号（sh600519 形态；跳详情用） */
  symbol: string;
  /** 股票名称 */
  name: string;
  /** 现价（源未提供为 null） */
  price: number | null;
  /** 涨跌幅 %（源未提供为 null） */
  changePct: number | null;
  /** 热度展示文案（如「64.2万热度」；空串 = 该源无热度口径） */
  heatLabel: string;
}
