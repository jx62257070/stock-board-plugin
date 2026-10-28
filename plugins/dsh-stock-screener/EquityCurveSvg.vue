<script setup lang="ts">
import { computed } from 'vue';
import { EQUITY_LEGEND_BUY_HOLD, EQUITY_LEGEND_STRATEGY } from './constants';

/**
 * 回测权益曲线（纯 SVG 双线图，替代宿主 ECharts 版 EquityCurveChart）
 *
 * - 策略线颜色随涨跌语义（父组件算好 trend 类名传入，`currentColor` 跟随主题）；
 * - 买入持有基准为灰色虚线；无坐标轴刻度，仅保留首尾日期与图例，
 *   满足「形状对比」这一回测场景的核心诉求。
 */

/** SVG 视窗宽（像素，等比缩放） */
const VIEW_WIDTH = 600;
/** SVG 视窗高（像素，等比缩放） */
const VIEW_HEIGHT = 220;
/** 视窗内边距 */
const PADDING = 8;

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

/** 全部曲线的取值范围（加 5% 余量，避免线贴边） */
const valueRange = computed(() => {
  const all = [...props.equityCurve, ...props.buyHoldCurve].filter((v) => Number.isFinite(v));
  if (all.length === 0) {
    return { min: 0, max: 1 };
  }
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min) * 0.05 || Math.abs(max) * 0.01 || 1;
  return { min: min - pad, max: max + pad };
});

/**
 * 曲线 → SVG polyline 的 points 串
 * @param curve 权益曲线
 * @returns `x,y x,y …`（x 均分视窗宽，y 按值域映射）
 */
const toPoints = (curve: number[]): string => {
  if (curve.length === 0) {
    return '';
  }
  const { min, max } = valueRange.value;
  const span = max - min || 1;
  const innerW = VIEW_WIDTH - PADDING * 2;
  const innerH = VIEW_HEIGHT - PADDING * 2;
  const stepX = curve.length > 1 ? innerW / (curve.length - 1) : 0;
  return curve
    .map((value, index) => {
      const x = PADDING + stepX * index;
      const y = PADDING + innerH * (1 - (value - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
};

/** 策略线 points */
const strategyPoints = computed(() => toPoints(props.equityCurve));
/** 基准线 points */
const buyHoldPoints = computed(() => toPoints(props.buyHoldCurve));

/** 首个交易日（左下角标注） */
const firstDate = computed(() => props.dates[0] ?? '');
/** 最后交易日（右下角标注） */
const lastDate = computed(() => props.dates.at(-1) ?? '');
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-4 text-xs text-text-secondary">
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 rounded" :class="strategyClass" />
        {{ EQUITY_LEGEND_STRATEGY }}
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 rounded border-t border-dashed border-current text-text-tertiary" />
        {{ EQUITY_LEGEND_BUY_HOLD }}
      </span>
    </div>
    <svg
      :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
      class="w-full"
      role="img"
      aria-label="回测权益曲线"
    >
      <g :class="strategyClass">
        <polyline
          :points="strategyPoints"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      </g>
      <g class="text-text-tertiary">
        <polyline
          :points="buyHoldPoints"
          fill="none"
          stroke="currentColor"
          stroke-width="1"
          stroke-dasharray="4 3"
        />
      </g>
    </svg>
    <div class="flex items-center justify-between text-xs text-text-tertiary tabular-nums">
      <span>{{ firstDate }}</span>
      <span>{{ lastDate }}</span>
    </div>
  </div>
</template>
