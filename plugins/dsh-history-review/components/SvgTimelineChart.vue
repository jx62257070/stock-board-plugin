<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import {
  BEAR_STAGE_CSS_VAR,
  BULL_CHART_HEIGHT_PX,
  BULL_STAGE_CSS_VAR,
} from '../constants';
import { buildBearStats, buildRoundStats } from '../judge';
import type { MonthlyBar, ReviewRoundMeta } from '../types';
import EChartBox from './EChartBox.vue';
import { chartPalette, readCssVar, semanticColor, useChartThemeSignal } from './echarts-theme';

/**
 * 行情四阶段图（ECharts 渲染，替代早期 SVG 手绘版）
 *
 * 轮次窗口内的指数月 K 收盘折线，底层铺阶段色带（markArea，色值运行时读
 * CSS 变量，随宿主主题 / 涨跌配色 / 明暗自动跟随）；标注起点 / 顶点 / 低点
 * （熊市 = 顶部 / 低点）用 markPoint，牛熊使用各自色板（`mode` 区分）。
 * hover 出 tooltip（月份 + 收盘 + 所处阶段）。
 */
const props = withDefaults(
  defineProps<{
    /** 轮次档案（提供窗口与阶段区间） */
    round: ReviewRoundMeta;
    /** 该轮叠加指数的全量月 K（升序；可为空，空时不渲染） */
    bars: readonly MonthlyBar[];
    /** 行情方向（决定阶段色板与统计口径） */
    mode?: 'bull' | 'bear';
  }>(),
  { mode: 'bull' },
);

/** 图表主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 窗口内月 K（升序；end 为 null（进行中轮次）时延伸到最新一根；不足两根时父组件显示占位文案，本组件不渲染） */
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
 * 关键位标注点（牛市 = 起点 / 顶点 / 低点；熊市 = 顶部 / 低点；由月 K 回算）
 */
const annotations = computed(() => {
  const bars = windowBars.value;
  if (bars.length < 2) return [];
  const isBear = props.mode === 'bear';
  const bearStats = isBear ? buildBearStats(props.bars, props.round) : null;
  const bullStats = isBear ? null : buildRoundStats(props.bars, props.round);
  const list: { month: string; close: number; text: string; colorVar: string }[] = [];
  const first = bars[0]!;
  list.push({
    month: first.month,
    close: first.close,
    text: `${isBear ? '顶部' : '起点'} ${formatClose(first.close)}`,
    colorVar: '--color-up-strong',
  });
  if (bullStats) {
    list.push({
      month: bullStats.peakMonth,
      close: bullStats.peakClose,
      text: `顶点 ${formatClose(bullStats.peakClose)}`,
      colorVar: '--color-up-strong',
    });
  }
  const troughMonth = bullStats?.troughMonth ?? bearStats?.troughMonth;
  const troughClose = bullStats?.troughClose ?? bearStats?.troughClose;
  if (troughMonth !== undefined && troughClose !== undefined) {
    list.push({
      month: troughMonth,
      close: troughClose,
      text: `低点 ${formatClose(troughClose)}`,
      colorVar: '--color-down-strong',
    });
  }
  return list;
});

/**
 * tooltip 文本组装（月份 + 收盘 + 所处阶段）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const tooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    value?: number | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const value = params[0]?.value;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return params[0]?.axisValue ?? '';
  }
  const stage = stageNameOf(params[0]?.axisValue ?? '');
  const lines = [`${params[0]?.axisValue ?? ''} 收盘 ${formatClose(value)}`];
  if (stage) lines.push(stage);
  return lines.join('<br/>');
};

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
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: tooltipFormatter,
    },
    grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: bars.map((bar) => bar.month),
      boundaryGap: false,
      axisLabel: { color: palette.text, fontSize: 10, formatter: (value: string) => value.slice(2) },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: palette.text, fontSize: 10, formatter: (value: number) => formatClose(value) },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        name: props.round.name,
        type: 'line',
        data: bars.map((bar) => bar.close),
        showSymbol: false,
        lineStyle: { width: 1.6, color: lineColor },
        itemStyle: { color: lineColor },
        // 阶段色带（底层；色值运行时读宿主 CSS 变量）
        markArea: {
          silent: true,
          data: props.round.stages.map((stage) => [
            {
              xAxis: stage.start,
              itemStyle: { color: readCssVar(stageVars.value[stage.tone] ?? '--color-flat-weak') || 'rgba(127,127,127,0.12)' },
              label: {
                show: true,
                position: 'insideTop',
                formatter: stage.name,
                color: isDark ? '#dfe6ee' : '#3a4453',
                fontSize: 11,
                fontWeight: 600,
              },
            },
            { xAxis: stage.end },
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
            coord: [item.month, item.close],
            itemStyle: { color: semanticColor(item.colorVar, '#dc2626') },
          })),
        },
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
    :aria-label="`${round.name} 行情四阶段图`"
  >
    <EChartBox v-if="option" :options="option" not-merge />
  </div>
</template>
