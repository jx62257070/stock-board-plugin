/**
 * 插件 dsh-stock-screener · 基础筛选 + MA 回测层
 *
 * 自宿主 `api/screener.api.ts` 移植：
 * - runScreener：全市场快照（小并发分页）+ SDK 链式筛选，按成交额降序取前 N；
 * - runMaCrossBacktest：会话缓存日 K + calcMA(5,20) + SDK backtest 引擎。
 */
import dayjs from 'dayjs';
import { backtest, calcMA, screen } from 'stock-sdk';
import type { FullQuote } from 'stock-sdk';
import {
  BACKTEST_FEE,
  BACKTEST_INITIAL_CAPITAL,
  BACKTEST_MIN_BARS,
  BACKTEST_RANGE_DAYS,
  MARKET_SNAPSHOT_BATCH_SIZE,
  MARKET_SNAPSHOT_CONCURRENCY,
} from './constants';
import type { ScreenerRuntime } from './types';
import type { BacktestBar, BacktestResult, ScreenerFilters } from './types';

/**
 * 运行选股：全市场快照（小并发分页）+ SDK 链式筛选，按成交额降序取前 N
 *
 * ⚠️ 重接口（全市场快照）：由用户点击触发，不做轮询
 * @param runtime 插件取数运行时
 * @param filters 筛选条件
 * @param topN 结果条数
 * @returns 筛选结果（FullQuote 列表）
 */
export const runScreener = async (
  runtime: ScreenerRuntime,
  filters: ScreenerFilters,
  topN: number,
): Promise<FullQuote[]> => {
  const quotes = await runtime.sdk.batch.cn({
    batchSize: MARKET_SNAPSHOT_BATCH_SIZE,
    concurrency: MARKET_SNAPSHOT_CONCURRENCY,
  });
  return screen(quotes)
    .where((quote) => filters.changeMin === undefined || quote.changePercent >= filters.changeMin)
    .where((quote) => filters.changeMax === undefined || quote.changePercent <= filters.changeMax)
    .where(
      (quote) =>
        filters.turnoverMin === undefined ||
        (quote.turnoverRate !== null && quote.turnoverRate >= filters.turnoverMin),
    )
    .where(
      (quote) =>
        filters.turnoverMax === undefined ||
        (quote.turnoverRate !== null && quote.turnoverRate <= filters.turnoverMax),
    )
    .where(
      (quote) =>
        filters.volumeRatioMin === undefined ||
        (quote.volumeRatio !== null && quote.volumeRatio >= filters.volumeRatioMin),
    )
    .where(
      (quote) => filters.peMax === undefined || (quote.pe !== null && quote.pe <= filters.peMax),
    )
    .sortBy((quote) => quote.amount)
    .top(topN);
};

/**
 * MA 金叉死叉策略：快线上穿慢线买入、下穿卖出（读预计算指标，不引入前视）
 * @param bar 当前 K 线（含 ma 指标）
 * @param index 当前下标
 * @param series 完整 K 线序列
 * @returns 买卖信号
 */
const maCrossStrategy = (
  bar: BacktestBar,
  index: number,
  series: readonly BacktestBar[],
): 'buy' | 'sell' | 'hold' => {
  const prev = series[index - 1];
  const fastNow = bar.ma?.ma5 ?? null;
  const slowNow = bar.ma?.ma20 ?? null;
  const fastPrev = prev?.ma?.ma5 ?? null;
  const slowPrev = prev?.ma?.ma20 ?? null;
  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return 'hold';
  }
  if (fastPrev <= slowPrev && fastNow > slowNow) {
    return 'buy';
  }
  if (fastPrev >= slowPrev && fastNow < slowNow) {
    return 'sell';
  }
  return 'hold';
};

/**
 * 运行 MA 金叉死叉回测（近一年日 K）
 *
 * ⚠️ 东财行情域（push2his）不可用时段 `sdk.kline.withIndicators` 不可靠，
 * 与宿主一致改走新浪日 K。
 * ⚠️ 新浪日 K 为不复权：除权日附近会产生虚假跳空，回测结果为近似口径。
 * @param runtime 插件取数运行时
 * @param fullSymbol 用户输入符号（600519 / sh600519 均可，**须已归一化为完整符号**）
 * @returns 回测报告与权益曲线
 */
export const runMaCrossBacktest = async (
  runtime: ScreenerRuntime,
  fullSymbol: string,
): Promise<BacktestResult> => {
  // 单票回测（用户指定标的）⇒ 写入会话缓存：首次取满、之后只补缺口，本地截取近一年窗口
  const allBars = await runtime.fetchDailyKline(fullSymbol, { store: true });
  const startTs = dayjs().subtract(BACKTEST_RANGE_DAYS, 'day').startOf('day').valueOf();
  const bars = allBars.filter((bar) => bar.timestamp >= startTs);
  if (bars.length < BACKTEST_MIN_BARS) {
    throw new Error(`日 K 数据不足（仅 ${bars.length} 根），无法回测`);
  }

  const maRows = calcMA(
    bars.map((bar) => bar.close),
    { periods: [5, 20] },
  );
  const backtestBars: BacktestBar[] = bars.map((bar, index) => ({
    date: dayjs(bar.timestamp).format('YYYY-MM-DD'),
    close: bar.close,
    ma: maRows[index] ?? {},
  }));

  const report = backtest<BacktestBar>({
    klines: backtestBars,
    strategy: maCrossStrategy,
    initialCapital: BACKTEST_INITIAL_CAPITAL,
    fee: { ...BACKTEST_FEE },
    getDate: (bar) => bar.date,
  });

  // 买入持有基准曲线：initial * close[i] / close[0]（首个有效收盘）
  const firstClose = backtestBars.find((bar) => bar.close > 0)?.close ?? 1;
  const dates = backtestBars.map((bar) => bar.date);
  const equityCurve = report.equityCurve;
  const buyHoldCurve = backtestBars.map((bar) => (bar.close / firstClose) * BACKTEST_INITIAL_CAPITAL);

  return { report, dates, equityCurve, buyHoldCurve };
};
