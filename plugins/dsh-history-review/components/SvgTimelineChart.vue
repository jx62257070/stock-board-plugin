<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import {
  BEAR_STAGE_CSS_VAR,
  BULL_CHART_HEIGHT_PX,
  BULL_STAGE_CSS_VAR,
} from '../constants';
import { buildBearStats, buildRoundStats } from '../judge';
import type { KlineBar, ReviewRoundMeta } from '../types';
import EChartBox from './EChartBox.vue';
import { chartPalette, readCssVar, semanticColor, useChartThemeSignal } from './echarts-theme';

/**
 * 行情四阶段图（ECharts 双 grid：主图折线 + 成交量副图）
 *
 * 轮次窗口内的指数周 K：主图为收盘折线，底层铺阶段色带（markArea，色值运行时读
 * CSS 变量，随宿主主题 / 涨跌配色 / 明暗自动跟随）；标注起点 / 顶点 / 低点
 * （熊市 = 顶部 / 低点）用 markPoint，牛熊使用各自色板（`mode` 区分）；
 * 副图为周成交量柱（按当周涨跌取红 / 绿），与主图共享十字准线。
 * crosshair（axisPointer cross）+ tooltip：周截止日 + 收盘 + 所处阶段 +
 * 成交量与「相对窗口首周」的倍数（看放量 / 缩量节奏）。
 */
const props = withDefaults(
  defineProps<{
    /** 轮次档案（提供窗口与阶段区间） */
    round: ReviewRoundMeta;
    /** 该轮叠加指数的全量周 K（升序；静态数据，可为空，空时不渲染） */
    bars: readonly KlineBar[];
    /** 行情方向（决定阶段色板与统计口径） */
    mode?: 'bull' | 'bear';
  }>(),
  { mode: 'bull' },
);

/** 图表主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 窗口内周 K（升序；end 为 null（进行中轮次）时延伸到最新一根；不足两根时父组件显示占位文案，本组件不渲染） */
const windowBars = computed(() =>
  props.bars.filter(
    (bar) => bar.month >= props.round.window.start && bar.month <= (props.round.window.end ?? '9999-12'),
  ),
);

/**
 * 收盘价展示文案（指数点位取整，低价指数保留两位）
 * @param close 收盘价
 * @returns 展示文案
 */
const formatClose = (close: number): string => (close >= 100 ? close.toFixed(0) : close.toFixed(2));

/**
 * 成交量展示文案（手 → 亿手 / 万手缩写）
 * @param volume 周成交量（手）
 * @returns 展示文案
 */
const formatVolume = (volume: number): string =>
  volume >= 1e8 ? `${(volume / 1e8).toFixed(2)}亿手` : volume >= 1e4 ? `${(volume / 1e4).toFixed(1)}万手` : `${volume}手`;

/** 窗口首周成交量（tooltip「相对首周倍数」的基准） */
const baseVolume = computed(() => windowBars.value[0]?.volume ?? 0);

/** 阶段色带的取色映射（牛 / 熊各自色板） */
const stageVars = computed(() => (props.mode === 'bear' ? BEAR_STAGE_CSS_VAR : BULL_STAGE_CSS_VAR));

/**
 * 月份所处阶段的名称（tooltip 用；窗口外为空串）
 * @param month 月份（YYYY-MM）
 * @returns 阶段名
 */
const stageNameOf = (month: string): string =>
  props.round.stages.find((stage) => month >= stage.start && month <= stage.end)?.name ?? '';

/**
 * 月份区间 → 窗口内首 / 末周 K 的日期（markArea 色带端点；阶段区间按月比对）
 * @param start 起始月（YYYY-MM，含）
 * @param end 结束月（YYYY-MM，含）
 * @returns 色带端点日期；窗口内无对应周 K 为 null
 */
const stageBand = (
  start: string,
  end: string,
): { from: string; to: string } | null => {
  const bars = windowBars.value;
  const from = bars.find((bar) => bar.month >= start)?.date;
  let to: string | undefined;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    if (bar && bar.month <= end) {
      to = bar.date;
      break;
    }
  }
  if (from === undefined || to === undefined || from > to) return null;
  return { from, to };
};

/**
 * 月份 + 收盘 → 窗口内对应周 K（judge 回算的关键位月份 / 收盘定位到具体周）
 * @param month 月份（YYYY-MM）
 * @param close 收盘价
 * @returns 匹配的周 K；无匹配为 undefined
 */
const barOfMonth = (month: string, close: number): KlineBar | undefined =>
  windowBars.value.find((bar) => bar.month === month && bar.close === close);

/**
 * 关键位标注点（牛市 = 起点 / 顶点 / 低点；熊市 = 顶部 / 低点；由周 K 回算）
 */
const annotations = computed(() => {
  const bars = windowBars.value;
  if (bars.length < 2) return [];
  const isBear = props.mode === 'bear';
  const bearStats = isBear ? buildBearStats(props.bars, props.round) : null;
  const bullStats = isBear ? null : buildRoundStats(props.bars, props.round);
  const list: { date: string; close: number; text: string; colorVar: string }[] = [];
  const first = bars[0]!;
  list.push({
    date: first.date,
    close: first.close,
    text: `${isBear ? '顶部' : '起点'} ${formatClose(first.close)}`,
    colorVar: '--color-up-strong',
  });
  const peakBar =
    bullStats !== null ? barOfMonth(bullStats.peakMonth, bullStats.peakClose) : undefined;
  if (peakBar) {
    list.push({
      date: peakBar.date,
      close: peakBar.close,
      text: `顶点 ${formatClose(peakBar.close)}`,
      colorVar: '--color-up-strong',
    });
  }
  const troughMonth = bullStats?.troughMonth ?? bearStats?.troughMonth;
  const troughClose = bullStats?.troughClose ?? bearStats?.troughClose;
  const troughBar =
    troughMonth !== undefined && troughClose !== undefined
      ? barOfMonth(troughMonth, troughClose)
      : undefined;
  if (troughBar) {
    list.push({
      date: troughBar.date,
      close: troughBar.close,
      text: `低点 ${formatClose(troughBar.close)}`,
      colorVar: '--color-down-strong',
    });
  }
  return list;
});

/** tooltip 参数的最小结构（axis 触发时为数组，按 series 顺序排列） */
interface TooltipParam {
  /** 类目名（周截止日） */
  axisValue?: string;
  /** 数据值（主图 = 收盘，副图 = 成交量） */
  value?: number | null;
}

/**
 * tooltip 文本组装（周截止日 + 收盘 + 所处阶段 + 成交量与相对首周倍数）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const tooltipFormatter = (raw: unknown): string => {
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const [main, vol] = params;
  const lines = [`<b>${main?.axisValue ?? ''}（周）</b>`];
  const close = main?.value;
  if (close !== null && close !== undefined && Number.isFinite(close)) {
    lines.push(`收盘 ${formatClose(close)}`);
    const stage = stageNameOf((main?.axisValue ?? '').slice(0, 7));
    if (stage) {
      lines.push(
        `<span style="color:${readCssVar('--color-primary') || '#3b82f6'}">${stage}</span>`,
      );
    }
  }
  const volume = vol?.value;
  if (volume !== null && volume !== undefined && Number.isFinite(volume) && volume > 0) {
    const multiple = baseVolume.value > 0 ? volume / baseVolume.value : null;
    lines.push(
      `成交量 ${formatVolume(volume)}${multiple !== null ? `（首周 ${multiple.toFixed(2)} 倍）` : ''}`,
    );
  }
  return lines.join('<br/>');
};

/** 周成交量柱色（当周收涨红 / 收跌绿，跟随宿主涨跌配色） */
const volumeUpColor = computed(() => semanticColor('--color-up-weak', 'rgba(220,38,38,0.55)'));
const volumeDownColor = computed(() => semanticColor('--color-down-weak', 'rgba(22,163,74,0.55)'));

/** ECharts 配置（主题 / 数据 / 轮次切换时整体重算） */
const option = computed<EChartsCoreOption | null>(() => {
  const bars = windowBars.value;
  if (bars.length < 2) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const lineColor = readCssVar('--color-primary') || '#3b82f6';
  return {
    animation: false,
    // 主图 / 副图共享十字准线（x 轴联动）
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      // 十字准线：x / y 双轴跟随线 + 轴标签
      axisPointer: {
        type: 'cross',
        lineStyle: { color: palette.axisPointer },
        crossStyle: { color: palette.axisPointer },
        label: {
          fontSize: 10,
          color: isDark ? '#dfe6ee' : '#3a4453',
          backgroundColor: palette.tooltipBg,
          borderColor: palette.tooltipBorder,
          borderWidth: 1,
        },
      },
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: tooltipFormatter,
    },
    // grid 0 = 主图（收盘折线），grid 1 = 副图（成交量柱）
    grid: [
      { left: 8, right: 16, top: 30, height: '56%', containLabel: true },
      { left: 8, right: 16, top: '76%', height: '15%', containLabel: true },
    ],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: bars.map((bar) => bar.date),
        boundaryGap: false,
        // 日期标签只在副图下方展示，主图底部留给两图衔接
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisPointer: { label: { show: false } },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: bars.map((bar) => bar.date),
        axisLabel: {
          color: palette.text,
          fontSize: 10,
          formatter: (value: string) => value.slice(2),
        },
        axisLine: { lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        axisLabel: { color: palette.text, fontSize: 10, formatter: (value: number) => formatClose(value) },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        gridIndex: 1,
        axisLabel: {
          color: palette.text,
          fontSize: 10,
          formatter: (value: number) => (value >= 1e8 ? `${(value / 1e8).toFixed(0)}亿` : `${Math.round(value / 1e4)}万`),
        },
        splitLine: { show: false },
        splitNumber: 2,
        axisPointer: {
          label: {
            formatter: (param: { value: number }): string =>
              Number.isFinite(param?.value) ? formatVolume(param.value) : '',
          },
        },
      },
    ],
    series: [
      {
        name: props.round.name,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: bars.map((bar) => bar.close),
        showSymbol: false,
        lineStyle: { width: 1.6, color: lineColor },
        itemStyle: { color: lineColor },
        // 阶段色带（底层；端点按月区间定位到窗口内首 / 末周）
        markArea: {
          silent: true,
          data: props.round.stages
            .map((stage) => ({ stage, band: stageBand(stage.start, stage.end) }))
            .filter((item): item is { stage: (typeof item)['stage']; band: { from: string; to: string } } => item.band !== null)
            .map(({ stage, band }) => [
              {
                xAxis: band.from,
                itemStyle: {
                  color:
                    readCssVar(stageVars.value[stage.tone] ?? '--color-flat-weak') ||
                    'rgba(127,127,127,0.12)',
                },
                label: {
                  show: true,
                  position: 'insideTop',
                  formatter: stage.name,
                  color: isDark ? '#dfe6ee' : '#3a4453',
                  fontSize: 11,
                  fontWeight: 600,
                },
              },
              { xAxis: band.to },
            ]),
        },
        // 关键位标注（点 + 文案）
        markPoint: {
          silent: true,
          symbol: 'circle',
          symbolSize: 7,
          label: {
            show: true,
            position: 'top',
            fontSize: 10.5,
            fontWeight: 600,
            formatter: (param: { name?: string }) => param.name ?? '',
          },
          data: annotations.value.map((item) => ({
            name: item.text,
            coord: [item.date, item.close],
            itemStyle: { color: semanticColor(item.colorVar, '#dc2626') },
          })),
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: bars.map((bar) => ({
          value: bar.volume,
          // 当周收涨红 / 收跌绿（与 A 股涨跌配色一致）
          itemStyle: { color: bar.close >= bar.open ? volumeUpColor.value : volumeDownColor.value },
        })),
        barWidth: '60%',
      },
    ],
  };
});
</script>

<template>
  <div
    class="w-full"
    :style="{ height: `${BULL_CHART_HEIGHT_PX}px` }"
    role="img"
    :aria-label="`${round.name} 行情四阶段图（周K + 成交量）`"
  >
    <EChartBox v-if="option" :options="option" not-merge />
  </div>
</template>
