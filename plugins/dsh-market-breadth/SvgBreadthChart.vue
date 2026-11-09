<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import EChartBox from './EChartBox.vue';
import { chartPalette, readCssVar, useChartThemeSignal } from './echarts-theme';

/**
 * 市场宽度副图（ECharts 渲染，替代早期纯 SVG 手绘版）
 *
 * - 主线为主题色实线；可选均线为灰色虚线；可选基准线（ARMS y=1 / MCO y=0）为浅色虚线；
 * - 坐标轴可见：x 轴为日期（MM-DD，自动抽稀防重叠），y 轴为数值刻度 + 浅色分隔线；
 *   下方标注行只留区间高/低值；hover 出 axis tooltip；
 * - 主题跟随：颜色经 useChartThemeSignal 响应明暗 / 主题色切换后重算 option。
 */

const props = defineProps<{
  /** 日期序列（与 values 按下标对齐） */
  dates: string[];
  /** 主指标序列（null 为缺口，断线） */
  values: ReadonlyArray<number | null>;
  /** 均线序列（可选，虚线） */
  ma?: ReadonlyArray<number | null>;
  /** 基准线值（可选，如 ARMS 的 1 / MCO 的 0） */
  baseline?: number;
  /** 数值格式化（极值标注与 tooltip 用；缺省两位小数） */
  format?: (value: number) => string;
}>();

/** 主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 主线可见值集合（极值域计算用） */
const mainValues = computed(() =>
  props.values.filter((value): value is number => value !== null && Number.isFinite(value)),
);

/** 全部曲线的取值范围（加 5% 余量，避免线贴边） */
const valueRange = computed(() => {
  const all = [...mainValues.value];
  if (props.ma) all.push(...props.ma.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (props.baseline !== undefined) all.push(props.baseline);
  if (all.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min) * 0.05 || Math.abs(max) * 0.01 || 1;
  return { min: min - pad, max: max + pad };
});

/** 数值格式化函数（props 缺省两位小数） */
const fmt = computed(() => props.format ?? ((value: number) => value.toFixed(2)));

/** 主线主题色（渲染时读宿主 CSS 变量，读不到回落蓝色） */
const primaryColor = computed(() => readCssVar('--color-primary') || '#3b82f6');

/** 序列是否只有单点（单点时 showSymbol 才能画出占位圆点） */
const isSinglePoint = computed(() => mainValues.value.length === 1);

/** tooltip 参数的最小结构（axis 触发时为数组） */
interface TooltipParam {
  /** 类目名（日期） */
  name?: string;
  /** 数据值（null 为缺口） */
  data?: number | null;
}

/**
 * tooltip 文本组装（日期 + 主值 + 均值）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const tooltipFormatter = (raw: unknown): string => {
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const [main, ma] = params;
  if (!main) return '';
  const lines = [`${main.name ?? ''}`];
  if (main.data !== null && main.data !== undefined && Number.isFinite(main.data)) {
    lines.push(`值 ${fmt.value(main.data)}`);
  }
  if (ma?.data !== null && ma.data !== undefined && Number.isFinite(ma.data)) {
    lines.push(`MA ${fmt.value(ma.data)}`);
  }
  return lines.join('<br/>');
};

/** ECharts 配置（主题 / 数据变化时整体重算） */
const option = computed<EChartsCoreOption>(() => {
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const { min, max } = valueRange.value;
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: tooltipFormatter,
    },
    grid: { left: 4, right: 8, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: [...props.dates],
      axisLine: { show: true, lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: palette.text,
        fontSize: 10,
        formatter: (value: string): string => value.slice(5),
      },
    },
    yAxis: {
      type: 'value',
      show: true,
      min,
      max,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: palette.text,
        fontSize: 10,
        formatter: (value: number): string => fmt.value(value),
      },
      splitLine: { show: true, lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        type: 'line',
        data: [...props.values],
        showSymbol: isSinglePoint.value,
        symbol: 'circle',
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: 1.6, color: primaryColor.value },
        itemStyle: { color: primaryColor.value },
        ...(props.baseline !== undefined
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                label: { show: false },
                lineStyle: { color: palette.axisLine, type: 'dashed', width: 1 },
                data: [{ yAxis: props.baseline }],
              },
            }
          : {}),
      },
      ...(props.ma
        ? [
            {
              type: 'line',
              data: [...props.ma],
              showSymbol: false,
              connectNulls: false,
              lineStyle: { width: 1.2, type: 'dashed', color: palette.text },
              itemStyle: { color: palette.text },
            },
          ]
        : []),
    ],
  };
});

/** 区间最大值标注（下方标注行） */
const maxLabel = computed(() => {
  if (mainValues.value.length === 0) return '';
  return fmt.value(Math.max(...mainValues.value));
});

/** 区间最小值标注（下方标注行） */
const minLabel = computed(() => {
  if (mainValues.value.length === 0) return '';
  return fmt.value(Math.min(...mainValues.value));
});
</script>

<template>
  <div class="w-full">
    <div class="h-[150px] w-full" role="img" aria-label="市场宽度指标副图">
      <EChartBox :options="option" />
    </div>
    <div class="flex items-center justify-center gap-6 text-[10px] text-text-tertiary tabular-nums">
      <span>高 {{ maxLabel }}</span>
      <span>低 {{ minLabel }}</span>
    </div>
  </div>
</template>
