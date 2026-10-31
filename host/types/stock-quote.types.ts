/**
 * 行情相关类型统一出口：re-export stock-sdk 的报价模型
 *
 * 业务代码从本文件导入，避免直接依赖 SDK 内部路径；
 * 若 SDK 字段与展示需求有出入，在本目录补充映射类型
 */
export type { FullQuote, SimpleQuote, SearchResult, HKQuote } from 'stock-sdk';
import type { FullQuote } from 'stock-sdk';

/**
 * 港股标的经映射层生成的全量报价
 *
 * SDK 的 FullQuote.market 判别值只覆盖 A 股（'CN'，该类型为 A 股行情设计），
 * 本类型把 market 放宽为 'HK' 以携带真实市场、assetType 收敛为 'stock'
 * （映射层只服务港股个股）。合并回 fetchFullQuotes 的 FullQuote[] 时在
 * 一处受控断言收窄回去——全站消费方均不判别 market 字段，符号（hk 前缀）
 * 才是市场判别依据（is-hk-symbol）
 */
export type HkMappedQuote = Omit<FullQuote, 'market' | 'assetType'> & {
  /** 市场（真实值 'HK'） */
  market: 'HK';
  /** 资产类型（港股个股） */
  assetType: 'stock';
};

/**
 * 报价卡片最小展示字段：完整报价（FullQuote）与轻量报价（如全球指数）通用
 *
 * StockQuoteCard 只消费这四个字段；结构化子类型无需拼凑完整 FullQuote
 */
export interface QuoteCardLike {
  /** 名称 */
  name: string;
  /** 最新价（无数据为 null） */
  price: number | null;
  /** 涨跌幅%（无数据为 null） */
  changePercent: number | null;
  /** 行情时间戳（缺失时卡片闪烁动画退化为按价格触发） */
  timestamp?: number | null;
}
