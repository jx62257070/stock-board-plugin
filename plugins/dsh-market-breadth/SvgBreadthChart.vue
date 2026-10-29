<script setup lang="ts">
import { computed } from 'vue';

/**
 * 市场宽度副图（纯 SVG 折线图，替代宿主 ECharts 版 BreadthIndicatorChart）
 *
 * - 主线为主题色实线；可选均线为灰色虚线；可选基准线（ARMS y=1 / MCO y=0）为浅色点线；
 * - 无坐标轴刻度，仅保留首尾日期与区间极值标注，满足「形状与位置对比」的副图诉求；
 * - 主题跟随：颜色全部走 CSS 变量，明暗 / 主题色切换即时生效。
 */

/** SVG 视窗宽（像素，等比缩放） */
const VIEW_WIDTH = 600;
/** SVG 视窗高（像素，等比缩放） */
const VIEW_HEIGHT = 180;
/** 视窗内边距 */
const PADDING = 10;

const props = defineProps<{
  /** 日期序列（与 values 按下标对齐） */
  dates: string[];
  /** 主指标序列（null 为缺口，断线） */
  values: ReadonlyArray<number | null>;
  /** 均线序列（可选，虚线） */
  ma?: ReadonlyArray<number | null>;
  /** 基准线值（可选，如 ARMS 的 1 / MCO 的 0） */
  baseline?: number;
  /** 数值格式化（极值标注用；缺省两位小数） */
  format?: (value: number) => string;
}>();

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

/**
 * 值 → y 坐标
 * @param value 数值
 * @returns SVG y 坐标
 */
const toY = (value: number): number => {
  const { min, max } = valueRange.value;
  const ratio = (value - min) / (max - min || 1);
  return PADDING + (1 - ratio) * (VIEW_HEIGHT - PADDING * 2);
};

/**
 * 下标 → x 坐标（均分视窗宽）
 * @param index 序列下标
 * @returns SVG x 坐标
 */
const toX = (index: number): number =>
  props.values.length <= 1
    ? VIEW_WIDTH / 2
    : PADDING + (index / (props.values.length - 1)) * (VIEW_WIDTH - PADDING * 2);

/**
 * 序列 → polyline points 串（null 断段：每段一条 polyline）
 * @param values 序列
 * @returns 段列表（每段一条 points 串）
 */
const toSegments = (values: ReadonlyArray<number | null>): string[] => {
  const segments: string[] = [];
  let current: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${toX(index).toFixed(1)},${toY(value).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));
  return segments;
};

/** 主线分段 */
const mainSegments = computed(() => toSegments(props.values));
/** 均线分段 */
const maSegments = computed(() => (props.ma ? toSegments(props.ma) : []));

/** 基准线 y 坐标（未配置为 null） */
const baselineY = computed(() =>
  props.baseline === undefined ? null : toY(props.baseline),
);

/** 区间最大值标注（右上） */
const maxLabel = computed(() => {
  if (mainValues.value.length === 0) return '';
  const value = Math.max(...mainValues.value);
  return (props.format ?? ((v: number) => v.toFixed(2)))(value);
});

/** 区间最小值标注（右下） */
const minLabel = computed(() => {
  if (mainValues.value.length === 0) return '';
  const value = Math.min(...mainValues.value);
  return (props.format ?? ((v: number) => v.toFixed(2)))(value);
});

/** 首个日期标注（左下） */
const firstDate = computed(() => props.dates[0]?.slice(5) ?? '');
/** 末个日期标注（右下） */
const lastDate = computed(() => props.dates.at(-1)?.slice(5) ?? '');
</script>

<template>
  <div class="w-full">
    <svg
      :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
      class="block w-full"
      role="img"
      aria-label="市场宽度指标副图"
    >
      <!-- 基准线（如 ARMS 的 1 / MCO 的 0） -->
      <line
        v-if="baselineY !== null"
        :x1="PADDING"
        :x2="VIEW_WIDTH - PADDING"
        :y1="baselineY"
        :y2="baselineY"
        stroke="var(--color-border)"
        stroke-dasharray="2 4"
        stroke-width="1"
      />
      <!-- 单点：序列只有 1 个值时 polyline 画不出来，落一个圆点占位 -->
      <circle
        v-if="mainSegments.length === 0 && mainValues.length === 1"
        :cx="toX(props.values.indexOf(mainValues[0]!))"
        :cy="toY(mainValues[0]!)"
        r="3"
        fill="var(--color-primary)"
      />
      <!-- 均线（灰色虚线） -->
      <polyline
        v-for="(segment, index) in maSegments"
        :key="`ma-${index}`"
        :points="segment"
        fill="none"
        stroke="var(--color-text-tertiary)"
        stroke-dasharray="5 4"
        stroke-width="1.2"
      />
      <!-- 主线（主题色实线） -->
      <polyline
        v-for="(segment, index) in mainSegments"
        :key="`main-${index}`"
        :points="segment"
        fill="none"
        stroke="var(--color-primary)"
        stroke-linejoin="round"
        stroke-width="1.6"
      />
    </svg>
    <div class="flex items-center justify-between text-[10px] text-text-tertiary tabular-nums">
      <span>{{ firstDate }}</span>
      <span>高 {{ maxLabel }}</span>
      <span>低 {{ minLabel }}</span>
      <span>{{ lastDate }}</span>
    </div>
  </div>
</template>
