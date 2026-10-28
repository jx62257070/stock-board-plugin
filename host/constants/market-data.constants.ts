/**
 * `app:market-data` 服务的取数选项常量
 *
 * 盯盘小组件三个内容视图（成交额 / 热点新闻 / 今天炒什么）的「源切换」可选项：
 * key 归取数实现层分发，label 给气泡里的源切换下拉直接展示。
 * 与热点新闻页 / 今天炒什么页的源全集保持一致，页面侧各自另有更全的常量，
 * 这里只收窄到小组件需要的最小集。
 */
import type { MarketBoardSource, MarketNewsSource } from '../types/market-data.types.ts';

/** 新闻源可选项（数组顺序 = 气泡下拉顺序；财联社优先与热点新闻页默认一致） */
export const MARKET_NEWS_SOURCES: readonly { value: MarketNewsSource; label: string }[] = [
  { value: 'cls', label: '财联社' },
  { value: 'sina', label: '新浪财经' },
  { value: 'eastmoney', label: '东方财富' },
  { value: 'ths', label: '同花顺' },
  { value: 'thepaper', label: '澎湃新闻' },
  { value: 'tdx', label: '通达信资讯' },
];

/** 默认新闻源 */
export const MARKET_NEWS_SOURCE_DEFAULT: MarketNewsSource = 'cls';

/** 热榜平台可选项（数组顺序 = 气泡下拉顺序；与今天炒什么页默认平台顺序一致） */
export const MARKET_BOARD_SOURCES: readonly { value: MarketBoardSource; label: string }[] = [
  { value: 'ths', label: '同花顺热榜' },
  { value: 'em', label: '东方财富热榜' },
  { value: 'cls', label: '财联社热榜' },
  { value: 'tdx', label: '通达信热榜' },
  { value: 'xq', label: '雪球热股' },
];

/** 默认热榜平台 */
export const MARKET_BOARD_SOURCE_DEFAULT: MarketBoardSource = 'ths';

/** 各平台取数的默认分组（取 BOARD_GROUPS 每平台首项，气泡不暴露分组切换） */
export const MARKET_BOARD_SOURCE_GROUP: Record<MarketBoardSource, string> = {
  ths: 'normal',
  em: 'popularity',
  cls: 'hot',
  tdx: 'popularity',
  xq: 'search',
};
