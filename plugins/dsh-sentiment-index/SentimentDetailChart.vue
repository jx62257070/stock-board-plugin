<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import {
  CHART_FOOTER_NOTICE,
  DETAIL_LABEL,
  divergenceBluntTip,
  divergenceFadeTip,
  YI_UNIT,
  YUAN_PER_YI,
} from './constants';
import type { BoardDay, ChartMode, DivergenceMark, IndexPoint } from './types';
import EChartBox from './EChartBox.vue';
import { chartPalette, readCssVar, semanticColor, useChartThemeSignal } from './echarts-theme';

/**
 * 单题材详情三栏联动图（ECharts 多 grid 渲染，替代早期 SVG 手绘版）
 *
 * - 主图：板块日 K 蜡烛（可切收盘价线）+ 散户情绪指数（右轴 0~100 恒定域）+
 *   背离 ⚠ 散点标记 —— 价格创新低而情绪高位钝化的背离直接可读；
 * - 量能副图：成交量柱按当日涨跌红/绿；
 * - 资金副图：小单净占比折线（红正绿负）+ 零轴虚线，可整体收起；
 * - 三栏共用 dataZoom（inside：拖动平移 + 滚轮缩放，ECharts 原生联动）；
 * - hover 出 axis tooltip（日期 + 价格 + 情绪 + 小单 + 背离提示）；
 * - 主题跟随：颜色运行时读 CSS 变量，明暗 / 主题色 / 涨跌配色切换重算 option。
 */

const props = defineProps<{
  /** 板块逐日数据（与 series 同长度同顺序） */
  days: BoardDay[];
  /** 逐日指数序列（与 days 对齐） */
  series: IndexPoint[];
  /** 背离标记（date 定位） */
  marks: DivergenceMark[];
  /** 主图形态 */
  mode: ChartMode;
  /** 是否显示资金副图 */
  showFund: boolean;
}>();

/** 图表主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 主图窗高（px） */
const MAIN_H = 300;
/** 量能窗高（px） */
const VOL_H = 110;
/** 资金窗高（px） */
const FUND_H = 100;
/** 窗间距（px） */
const GAP = 14;
/** 主图 y 顶 */
const MAIN_TOP = 16;

/** 量能 y 顶 */
const volTop = MAIN_TOP + MAIN_H + GAP;
/** 资金 y 顶 */
const fundTop = volTop + VOL_H + GAP;

/** 视窗总高（资金副图收起时缩短） */
const viewH = computed(() =>
  props.showFund ? fundTop + FUND_H + 26 : volTop + VOL_H + 26,
);

/** 可见成交量最大值 */
const maxVolume = computed(() => {
  const values = props.days.map((day) => day.volume ?? 0).filter((value) => value > 0);
  return values.length > 0 ? Math.max(...values) : 0;
});

/** 可见小单净占比域（对称域：绝对值最大者，零轴居中） */
const fundBound = computed(() => {
  const values = props.series
    .map((point) => point.factors.smallNetRatio)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return Math.max(1, ...values.map((value) => Math.abs(value)));
});

/**
 * 某日的涨跌语义色（优先涨跌幅字段，缺失退回收盘 vs 前收）
 * @param index days 下标
 * @returns hex 颜色值
 */
const trendColorAt = (index: number): string => {
  const day = props.days[index];
  const up = semanticColor('--color-up', '#dc2626');
  const down = semanticColor('--color-down', '#16a34a');
  if (!day) return up;
  if (day.pctChg !== null) return day.pctChg >= 0 ? up : down;
  const prev = props.days[index - 1];
  if (prev?.close !== null && prev !== undefined && day.close !== null) {
    return day.close >= prev.close ? up : down;
  }
  return up;
};

/** 背离标记的 tooltip 文案（日期 → 类型文案） */
const markTipByDate = computed(() => {
  const map = new Map<string, string>();
  for (const mark of props.marks) {
    const point = props.series.find((item) => item.date === mark.date);
    const retail = point?.retailIndex ?? 50;
    map.set(mark.date, mark.kind === 'blunt' ? divergenceBluntTip(retail) : divergenceFadeTip());
  }
  return map;
});

/**
 * tooltip 文本组装（日期 + 价格 + 情绪 + 小单 + 成交额 + 背离提示）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const tooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const date = params[0]?.axisValue ?? '';
  const day = props.days.find((item) => item.date === date);
  const point = props.series.find((item) => item.date === date);
  const lines = [date];
  if (day) {
    if (day.close !== null) lines.push(`收 ${day.close.toFixed(0)}`);
    if (day.pctChg !== null) lines.push(`${day.pctChg >= 0 ? '+' : ''}${day.pctChg.toFixed(2)}%`);
  }
  if (point?.retailIndex != null) lines.push(`情绪 ${point.retailIndex.toFixed(0)}`);
  if (day?.smallRatio !== null && day) {
    lines.push(`小单 ${day.smallRatio >= 0 ? '+' : ''}${day.smallRatio.toFixed(2)}%`);
  }
  if (day?.amount !== null && day) {
    lines.push(`额 ${(day.amount / YUAN_PER_YI).toFixed(0)}${YI_UNIT}`);
  }
  const markTip = markTipByDate.value.get(date);
  if (markTip) lines.push(markTip);
  return lines.join('<br/>');
};

/** ECharts 配置（主题 / 数据 / 形态切换时重建） */
const option = computed<EChartsCoreOption | null>(() => {
  if (props.days.length === 0) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const up = semanticColor('--color-up', '#dc2626');
  const down = semanticColor('--color-down', '#16a34a');
  const dates = props.days.map((day) => day.date);
  const axisLabel = { color: palette.text, fontSize: 10 } as const;
  // 资金副图收起时量能轴成为最底轴，承担 x 刻度展示
  const bottomGridIndex = props.showFund ? 2 : 1;

  // 主图价格序列：kline 蜡烛（缺开收的日置 null 跳过）/ line 收盘线（null 断线）
  const priceSeries =
    props.mode === 'kline'
      ? [
          {
            name: '板块日K',
            type: 'candlestick',
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: props.days.map((day) =>
              day.open !== null && day.close !== null && day.low !== null && day.high !== null
                ? [day.open, day.close, day.low, day.high]
                : null,
            ),
            itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
            barMaxWidth: 14,
          },
        ]
      : [
          {
            name: '收盘价',
            type: 'line',
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: props.days.map((day) => day.close),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { width: 1.4, color: isDark ? '#dfe6ee' : '#3a4453' },
            itemStyle: { color: isDark ? '#dfe6ee' : '#3a4453' },
          },
        ];

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: tooltipFormatter,
    },
    grid: [
      { left: 8, right: 52, top: MAIN_TOP, height: MAIN_H },
      { left: 8, right: 52, top: volTop, height: VOL_H },
      ...(props.showFund ? [{ left: 8, right: 52, top: fundTop, height: FUND_H }] : []),
    ],
    xAxis: dates.map((_, gridIndex) => ({
      type: 'category',
      gridIndex,
      data: dates,
      axisLabel: { ...axisLabel, show: gridIndex === bottomGridIndex, formatter: (value: string) => value.slice(5) },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    })),
    yAxis: [
      {
        type: 'value',
        scale: true,
        axisLabel: { ...axisLabel, formatter: (value: number) => value.toFixed(0) },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        gridIndex: 0,
        position: 'right',
        min: 0,
        max: 100,
        interval: 25,
        axisLabel: { ...axisLabel, formatter: (value: number) => value.toFixed(0) },
        splitLine: { show: false },
      },
      {
        type: 'value',
        gridIndex: 1,
        max: Math.max(1, maxVolume.value) * 1.05,
        axisLabel: {
          ...axisLabel,
          formatter: (value: number) => `${(value / 10000).toFixed(0)}万`,
        },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      ...(props.showFund
        ? [
            {
              type: 'value',
              gridIndex: 2,
              min: -fundBound.value,
              max: fundBound.value,
              axisLabel: { ...axisLabel, formatter: (value: number) => `${value.toFixed(0)}%` },
              splitLine: { lineStyle: { color: palette.splitLine } },
            },
          ]
        : []),
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], throttle: 50 }],
    series: [
      ...priceSeries,
      {
        name: '散户情绪指数',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 1,
        data: props.series.map((point) => point.retailIndex),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2, color: readCssVar('--color-primary') || '#3b82f6' },
        itemStyle: { color: readCssVar('--color-primary') || '#3b82f6' },
      },
      {
        name: '背离',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 1,
        data: props.marks
          .map((mark) => {
            const point = props.series.find((item) => item.date === mark.date);
            if (!point) return null;
            return {
              value: [mark.date, point.retailIndex ?? 50],
              name: mark.kind,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null),
        symbol: 'circle',
        symbolSize: 18,
        itemStyle: {
          color: semanticColor('--color-up-weak', '#fee2e2'),
          borderColor: up,
          borderWidth: 1.2,
        },
        label: {
          show: true,
          position: 'inside',
          formatter: '⚠',
          fontSize: 11,
          fontWeight: 700,
          color: up,
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 2,
        data: props.days.map((day, index) => ({
          value: day.volume ?? 0,
          itemStyle: { color: trendColorAt(index) },
        })),
        barMaxWidth: 12,
      },
      ...(props.showFund
        ? [
            {
              name: '小单净占比（正）',
              type: 'line',
              xAxisIndex: 2,
              yAxisIndex: 3,
              data: props.series.map((point) => {
                const value = point.factors.smallNetRatio;
                return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
              }),
              showSymbol: false,
              connectNulls: false,
              lineStyle: { width: 1.5, color: up },
              itemStyle: { color: up },
              markLine: {
                silent: true,
                symbol: 'none',
                label: { show: false },
                lineStyle: { color: palette.axisLine, type: 'dashed', width: 1 },
                data: [{ yAxis: 0 }],
              },
            },
            {
              name: '小单净占比（负）',
              type: 'line',
              xAxisIndex: 2,
              yAxisIndex: 3,
              data: props.series.map((point) => {
                const value = point.factors.smallNetRatio;
                return value !== null && Number.isFinite(value) && value < 0 ? value : null;
              }),
              showSymbol: false,
              connectNulls: false,
              lineStyle: { width: 1.5, color: down },
              itemStyle: { color: down },
            },
          ]
        : []),
    ],
  };
});
</script>

<template>
  <div class="w-full">
    <div
      class="w-full"
      :style="{ height: `${viewH}px` }"
      role="img"
      aria-label="单题材价格-情绪-量能联动图"
    >
      <EChartBox v-if="option" :options="option" not-merge />
    </div>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-tertiary">
      <span class="inline-flex items-center gap-1">
        <i class="inline-block h-0.5 w-4 rounded-full bg-[var(--color-text)]" />{{ DETAIL_LABEL.legendBoard }}
      </span>
      <span class="inline-flex items-center gap-1">
        <i class="inline-block h-0.5 w-4 rounded-full bg-primary" />{{ DETAIL_LABEL.legendRetail }}
      </span>
      <span class="inline-flex items-center gap-1">
        <span class="text-up">⚠</span>{{ DETAIL_LABEL.legendDivergence }}
      </span>
      <span class="ml-auto">{{ CHART_FOOTER_NOTICE }}</span>
    </div>
  </div>
</template>
