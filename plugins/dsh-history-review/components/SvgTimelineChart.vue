<script setup lang="ts">
import { computed } from 'vue';
import {
  BEAR_STAGE_CSS_VAR,
  BULL_CHART_HEIGHT_PX,
  BULL_STAGE_CSS_VAR,
} from '../constants';
import { buildBearStats, buildRoundStats } from '../judge';
import type { MonthlyBar, ReviewRoundMeta } from '../types';

/**
 * 行情四阶段图（SVG 手绘，替代宿主内置时代的 ECharts 版）
 *
 * 轮次窗口内的指数月 K 收盘折线，底层铺阶段色带（色带色与标注色全部运行时读
 * CSS 变量，随宿主主题 / 涨跌配色 / 明暗自动跟随，无需 JS 监听）；标注起点 /
 * 顶点 / 低点（熊市 = 顶部 / 低点），牛熊使用各自色板（`mode` 区分）。
 * 图为只读展示，无坐标轴交互——复盘读的是阶段结构，不是单点数值。
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

/** 视口宽（viewBox 逻辑宽，容器内等比缩放） */
const VIEW_WIDTH = 960;

/** 画布内边距（左留 y 轴刻度、右留标注空间） */
const PAD = { left: 70, right: 34, top: 34, bottom: 30 } as const;

/** 窗口内月 K（升序；不足两根时父组件显示占位文案，本组件不渲染） */
const windowBars = computed(() =>
  props.bars.filter((bar) => bar.month >= props.round.window.start && bar.month <= props.round.window.end),
);

/**
 * 收盘价展示文案（指数点位取整，低价指数保留两位）
 * @param close 收盘价
 * @returns 展示文案
 */
const formatClose = (close: number): string => (close >= 100 ? close.toFixed(0) : close.toFixed(2));

/** y 值域（上下各留 4% 空隙） */
const yRange = computed(() => {
  const closes = windowBars.value.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || max || 1;
  return { min: min - span * 0.04, max: max + span * 0.04 };
});

/**
 * 月份 → x 坐标（按窗口内序号均分）
 * @param month 月份（YYYY-MM）
 * @returns x 像素（窗口外月份钳位到边界）
 */
const xOf = (month: string): number => {
  const bars = windowBars.value;
  let index = bars.findIndex((bar) => bar.month >= month);
  if (index === -1) index = bars.length - 1;
  const inner = VIEW_WIDTH - PAD.left - PAD.right;
  return PAD.left + (bars.length <= 1 ? inner / 2 : (index / (bars.length - 1)) * inner);
};

/**
 * 收盘价 → y 坐标
 * @param close 收盘价
 * @returns y 像素
 */
const yOf = (close: number): number => {
  const { min, max } = yRange.value;
  const inner = BULL_CHART_HEIGHT_PX - PAD.top - PAD.bottom;
  return PAD.top + inner - ((close - min) / (max - min)) * inner;
};

/** 收盘折线的点集（x,y 空格分隔） */
const linePoints = computed(() =>
  windowBars.value.map((bar) => `${xOf(bar.month).toFixed(1)},${yOf(bar.close).toFixed(1)}`).join(' '),
);

/** 阶段色带矩形（色值 = 阶段色调映射的 CSS 变量，随主题切换） */
const stageBands = computed(() => {
  const vars = props.mode === 'bear' ? BEAR_STAGE_CSS_VAR : BULL_STAGE_CSS_VAR;
  return props.round.stages.map((stage) => ({
    key: stage.name,
    x: xOf(stage.start),
    x2: xOf(stage.end),
    fill: `var(${vars[stage.tone] ?? '--color-flat-weak'})`,
    label: stage.name,
  }));
});

/** y 轴刻度（4 条网格线 + 数值文案） */
const yTicks = computed(() => {
  const { min, max } = yRange.value;
  return [0, 1 / 3, 2 / 3, 1].map((ratio) => {
    const value = max - (max - min) * ratio;
    return { y: yOf(value), text: formatClose(value) };
  });
});

/** x 轴月份刻度（首 / 中 / 末 + 中间均分点，最多 6 个避免拥挤） */
const xTicks = computed(() => {
  const bars = windowBars.value;
  if (bars.length < 2) return [];
  const step = Math.max(1, Math.ceil((bars.length - 1) / 5));
  const ticks: { x: number; text: string }[] = [];
  for (let index = 0; index < bars.length; index += step) {
    ticks.push({ x: xOf(bars[index]!.month), text: bars[index]!.month.slice(2) });
  }
  const last = bars[bars.length - 1]!;
  if (ticks[ticks.length - 1]?.text !== last.month.slice(2)) {
    ticks.push({ x: xOf(last.month), text: last.month.slice(2) });
  }
  return ticks;
});

/** 关键位标注（牛市 = 起点 / 顶点 / 低点；熊市 = 顶部 / 低点；由月 K 回算） */
const annotations = computed(() => {
  const bars = windowBars.value;
  if (bars.length < 2) return [];
  const list: { x: number; y: number; text: string; color: string }[] = [];
  const first = bars[0]!;
  const isBear = props.mode === 'bear';
  const bearStats = isBear ? buildBearStats(props.bars, props.round) : null;
  const bullStats = isBear ? null : buildRoundStats(props.bars, props.round);
  list.push({
    x: xOf(first.month),
    y: yOf(first.close),
    text: `${isBear ? '顶部' : '起点'} ${formatClose(first.close)}`,
    color: isBear ? 'var(--color-up-strong)' : 'var(--color-up-strong)',
  });
  if (bullStats) {
    list.push({
      x: xOf(bullStats.peakMonth),
      y: yOf(bullStats.peakClose),
      text: `顶点 ${formatClose(bullStats.peakClose)}`,
      color: 'var(--color-up-strong)',
    });
  }
  const troughMonth = bullStats?.troughMonth ?? bearStats?.troughMonth;
  const troughClose = bullStats?.troughClose ?? bearStats?.troughClose;
  if (troughMonth !== undefined && troughClose !== undefined) {
    list.push({
      x: xOf(troughMonth),
      y: yOf(troughClose),
      text: `${isBear ? '低点' : '低点'} ${formatClose(troughClose)}`,
      color: 'var(--color-down-strong)',
    });
  }
  return list;
});
</script>

<template>
  <svg
    :viewBox="`0 0 ${VIEW_WIDTH} ${BULL_CHART_HEIGHT_PX}`"
    class="w-full"
    :style="{ height: `${BULL_CHART_HEIGHT_PX}px` }"
    role="img"
    :aria-label="`${round.name} 行情四阶段图`"
  >
    <!-- 阶段色带（先铺底层） -->
    <rect
      v-for="band in stageBands"
      :key="band.key"
      :x="band.x"
      :y="PAD.top - 20"
      :width="Math.max(band.x2 - band.x, 1)"
      :height="BULL_CHART_HEIGHT_PX - PAD.top - PAD.bottom + 26"
      :fill="band.fill"
      rx="4"
    />
    <text
      v-for="band in stageBands"
      :key="`${band.key}-label`"
      :x="band.x + 6"
      :y="PAD.top - 6"
      class="fill-current text-text"
      font-size="11"
      font-weight="600"
    >
      {{ band.label }}
    </text>

    <!-- y 轴网格线与刻度 -->
    <g v-for="tick in yTicks" :key="tick.y">
      <line
        :x1="PAD.left"
        :x2="VIEW_WIDTH - PAD.right"
        :y1="tick.y"
        :y2="tick.y"
        stroke="var(--color-flat-weak)"
        stroke-width="1"
      />
      <text :x="PAD.left - 6" :y="tick.y + 3" text-anchor="end" font-size="10" class="fill-current text-text-tertiary">
        {{ tick.text }}
      </text>
    </g>

    <!-- x 轴月份刻度 -->
    <text
      v-for="tick in xTicks"
      :key="`${tick.text}-${tick.x}`"
      :x="tick.x"
      :y="BULL_CHART_HEIGHT_PX - 10"
      text-anchor="middle"
      font-size="10"
      class="fill-current text-text-tertiary"
    >
      {{ tick.text }}
    </text>

    <!-- 收盘折线 -->
    <polyline
      :points="linePoints"
      fill="none"
      stroke="var(--color-primary)"
      stroke-width="1.6"
      stroke-linejoin="round"
    />

    <!-- 关键位标注：点 + 文案 -->
    <g v-for="item in annotations" :key="`${item.x}-${item.text}`">
      <circle :cx="item.x" :cy="item.y" r="3.2" :fill="item.color" />
      <text
        :x="Math.min(item.x + 6, VIEW_WIDTH - PAD.right - 60)"
        :y="Math.max(item.y - 8, 12)"
        font-size="10.5"
        font-weight="600"
        :fill="item.color"
      >
        {{ item.text }}
      </text>
    </g>
  </svg>
</template>
