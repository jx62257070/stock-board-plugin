<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { EQUITY_LEGEND_BUY_HOLD, EQUITY_LEGEND_STRATEGY } from './constants';
import EChartBox from './EChartBox.vue';
import { chartPalette, semanticColor, useChartThemeSignal } from './echarts-theme';

/**
 * 回测权益曲线（ECharts 双线图，替代早期 SVG 手绘版）
 *
 * - 策略线颜色随涨跌语义（父组件算好 trend 类名传入，运行时映射语义 CSS 变量取色）；
 * - 买入持有基准为灰色虚线；带坐标轴与 hover tooltip（日期 + 策略 / 基准权益）。
 */

const props = defineProps<{
  /** 日期序列 */
  dates: string[];
  /** 策略权益曲线（元） */
  equityCurve: number[];
  /** 买入持有基准曲线（元） */
  buyHoldCurve: number[];
  /** 策略线的涨跌语义类名（text-up / text-down，由父组件按最终收益算好传入） */
  strategyClass: string;
}>();

/** 图表主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 策略线颜色（text-up / text-down 类名 → 语义 CSS 变量取色） */
const strategyColor = computed(() =>
  props.strategyClass.includes('text-down')
    ? semanticColor('--color-down', '#16a34a')
    : semanticColor('--color-up', '#dc2626'),
);

/**
 * tooltip 文本组装（日期 + 策略权益 + 基准权益，万元折算可读化）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const tooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    seriesName?: string;
    value?: number | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const lines: string[] = [params[0]?.axisValue ?? ''];
  for (const param of params) {
    if (param.seriesName) {
      lines.push(`${param.seriesName} ${(param.value ?? 0).toLocaleString('en-US')} 元`);
    }
  }
  return lines.join('<br/>');
};

/** ECharts 配置（主题 / 数据变化时整体重算） */
const option = computed<EChartsCoreOption | null>(() => {
  if (props.equityCurve.length === 0) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: tooltipFormatter,
    },
    legend: {
      data: [EQUITY_LEGEND_STRATEGY, EQUITY_LEGEND_BUY_HOLD],
      textStyle: { color: palette.text, fontSize: 11 },
      top: 0,
    },
    grid: { left: 8, right: 16, top: 28, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: props.dates,
      axisLabel: { color: palette.text, fontSize: 10 },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        color: palette.text,
        fontSize: 10,
        formatter: (value: number) => value.toLocaleString('en-US'),
      },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        name: EQUITY_LEGEND_STRATEGY,
        type: 'line',
        data: props.equityCurve,
        showSymbol: false,
        lineStyle: { width: 1.5, color: strategyColor.value },
        itemStyle: { color: strategyColor.value },
        areaStyle: { opacity: 0.06, color: strategyColor.value },
      },
      {
        name: EQUITY_LEGEND_BUY_HOLD,
        type: 'line',
        data: props.buyHoldCurve,
        showSymbol: false,
        lineStyle: { width: 1, type: 'dashed', color: palette.text },
        itemStyle: { color: palette.text },
      },
    ],
  };
});
</script>

<template>
  <div class="space-y-2">
    <div class="h-[220px] w-full" role="img" aria-label="回测权益曲线">
      <EChartBox v-if="option" :options="option" />
    </div>
  </div>
</template>
