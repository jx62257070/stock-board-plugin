/**
 * 插件 dsh-stock-screener · 板块取数层（东财源，经宿主上游通道）
 *
 * 自宿主 `api/board.api.ts` 移植：行业 / 概念板块列表与成分股。
 * 成分股是重接口，仅在用户选择板块时按需拉取，不参与轮询。
 */
import type {
  ConceptBoard,
  ConceptBoardConstituent,
  IndustryBoard,
  IndustryBoardConstituent,
} from 'stock-sdk';
import type { ScreenerRuntime } from './types';

/**
 * 拉取行业板块列表
 * @param runtime 插件取数运行时
 * @returns 全部行业板块（含涨跌幅 / 总市值 / 上涨下跌家数）
 */
export const fetchIndustryBoards = async (runtime: ScreenerRuntime): Promise<IndustryBoard[]> =>
  runtime.sdk.board.industry.list();

/**
 * 拉取概念板块列表（结构与行业板块一致）
 * @param runtime 插件取数运行时
 * @returns 全部概念板块
 */
export const fetchConceptBoards = async (runtime: ScreenerRuntime): Promise<ConceptBoard[]> =>
  runtime.sdk.board.concept.list();

/**
 * 拉取行业板块成分股
 * @param runtime 插件取数运行时
 * @param symbol 板块符号（BK1027 形态，来自 IndustryBoard.code）
 * @returns 成分股列表（code 为 6 位纯代码形态）
 */
export const fetchIndustryConstituents = async (
  runtime: ScreenerRuntime,
  symbol: string,
): Promise<IndustryBoardConstituent[]> => runtime.sdk.board.industry.constituents(symbol);

/**
 * 拉取概念板块成分股
 * @param runtime 插件取数运行时
 * @param symbol 板块符号（BKxxxx 形态，来自 ConceptBoard.code）
 * @returns 成分股列表（code 为 6 位纯代码形态）
 */
export const fetchConceptConstituents = async (
  runtime: ScreenerRuntime,
  symbol: string,
): Promise<ConceptBoardConstituent[]> => runtime.sdk.board.concept.constituents(symbol);
