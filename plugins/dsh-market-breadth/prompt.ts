/**
 * 插件 dsh-market-breadth · AI 分析提示词组装（自包含 prompt）
 *
 * 口径自宿主 `src/common/utils/build-breadth-analysis-prompt.ts` 与
 * `src/common/utils/build-rank-analysis-prompt.ts` 移植：数据段（最新截面 +
 * 近 10 / 30 日趋势）由本函数从指标序列直接组装 → 段落拼接 → 超长截断 →
 * 填入模板。全部数据段都无行时返回空串，由调用方提示「暂无可分析的数据」。
 */
import { BREADTH_ANALYSIS_MAX_CHARS, BREADTH_ANALYSIS_PROMPT_TEMPLATE } from './constants';
import type { BreadthDayBar, BreadthIndicatorSeries } from './types';

/** 提示词的一个数据段（标题 + 行文本列表） */
interface PromptDataset {
  /** 段标题 */
  title: string;
  /** 段内行文本 */
  lines: string[];
}

/**
 * 序列末 N 日的「日期 | 涨/跌/平家数 | ARMS | 活跃占比」趋势行
 * @param bars 日 bar 序列（任意顺序）
 * @param days 取末尾多少个交易日
 * @returns 行文本列表（倒序，最近在前）
 */
const recentTrendLines = (
  bars: readonly BreadthDayBar[],
  days: number,
): string[] => {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const start = Math.max(0, sorted.length - days);
  const lines: string[] = [];
  for (let index = sorted.length - 1; index >= start; index -= 1) {
    const bar = sorted[index];
    if (!bar) continue;
    const active =
      bar.activeCount !== undefined && bar.activeTotal
        ? `${((bar.activeCount / bar.activeTotal) * 100).toFixed(1)}%`
        : '--';
    lines.push(
      `${bar.date.slice(5)} | 涨${bar.upCount} 跌${bar.downCount} | ARMS ${bar.arms === null ? '--' : bar.arms.toFixed(2)} | 活跃占比 ${active}`,
    );
  }
  return lines;
};

/**
 * 组装提示词数据段：最新交易日截面 + 近 10 / 30 日趋势
 * @param bars 日 bar 序列
 * @param series 六指标序列（与 bars 同源计算）
 * @returns 数据段列表（无有效数据为空数组）
 */
const collectDatasets = (
  bars: readonly BreadthDayBar[],
  series: BreadthIndicatorSeries,
): PromptDataset[] => {
  const last = series.dates.length - 1;
  if (last < 0) return [];
  /**
   * 取序列末位的值
   * @param values 指标序列
   * @returns 末位值；全空为 null
   */
  const at = (values: ReadonlyArray<number | null>): number | null => values[last] ?? null;
  const snapshotLines = [
    `数据截至 | ${series.dates[last] ?? '--'}`,
    `ADL 腾落线 | ${at(series.adl) ?? '--'}`,
    `ADR 涨跌比率 | ${at(series.adr) ?? '--'}`,
    `OBOS 超买超卖 | ${at(series.obos) ?? '--'}`,
    `ARMS 平滑均线 | ${at(series.armsMa) ?? '--'}`,
    `MCO 麦克莱伦震荡 | ${at(series.mco) ?? '--'}`,
    `活跃占比（%） | ${at(series.activeRatio) ?? '--'}`,
  ];
  const trend = (days: number, label: string): PromptDataset => ({
    title: `${label}（日期 | 涨/跌 | ARMS | 活跃占比）`,
    lines: recentTrendLines(bars, days),
  });
  return [
    { title: '最新交易日截面（指标 | 数值）', lines: snapshotLines },
    trend(10, '近 10 日趋势'),
    trend(30, '近 30 日趋势'),
  ];
};

/**
 * 组装市场宽度 AI 分析提示词
 * @param bars 日 bar 序列
 * @param series 六指标序列
 * @returns 提示词；无有效数据返回空串
 */
export const buildBreadthAnalysisPrompt = (
  bars: readonly BreadthDayBar[],
  series: BreadthIndicatorSeries,
): string => {
  const datasets = collectDatasets(bars, series);
  const sections = datasets
    .filter((dataset) => dataset.lines.length > 0)
    .map((dataset) => `【${dataset.title}】\n${dataset.lines.join('\n')}`);
  const data = sections.join('\n\n');
  if (data === '') return '';
  const capped =
    data.length > BREADTH_ANALYSIS_MAX_CHARS
      ? data.slice(0, BREADTH_ANALYSIS_MAX_CHARS) + '\n…（已截断）'
      : data;
  return BREADTH_ANALYSIS_PROMPT_TEMPLATE.replace('{days}', String(bars.length)).replace(
    '{data}',
    capped,
  );
};
