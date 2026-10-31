<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CHART_FOOTER_NOTICE,
  DETAIL_LABEL,
  divergenceBluntTip,
  divergenceFadeTip,
  YI_UNIT,
  YUAN_PER_YI,
} from './constants';
import type { BoardDay, ChartMode, DivergenceMark, IndexPoint } from './types';

/**
 * 单题材详情三栏联动图（纯 SVG 手绘，插件不带 ECharts 依赖）
 *
 * - 主图：板块日 K 蜡烛（可切收盘价线）+ 散户情绪指数（右轴 0~100 恒定域）+
 *   背离 ⚠ 标记 —— 价格创新低而情绪高位钝化的背离直接可读；
 * - 量能副图：成交量柱按当日涨跌红/绿；
 * - 资金副图：小单净占比折线（红正绿负）+ 零轴虚线，可整体收起；
 * - 三栏共用 x 轴：拖动平移、滚轮缩放在组件内部维护视窗，三栏同步；
 * - 主题跟随：颜色全部走 CSS 变量，明暗 / 主题色 / 涨跌配色切换即时生效。
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

/** SVG 视窗宽 */
const VIEW_W = 640;
/** 主图窗高 */
const MAIN_H = 212;
/** 量能窗高 */
const VOL_H = 66;
/** 资金窗高 */
const FUND_H = 60;
/** 窗间距 */
const GAP = 30;
/** 左右边距（右侧留右轴刻度） */
const PAD_L = 8;
const PAD_R = 46;

/** 视窗总高（资金副图收起时缩短） */
const viewH = computed(() => (props.showFund ? 8 + MAIN_H + GAP + VOL_H + GAP + FUND_H + 18 : 8 + MAIN_H + GAP + VOL_H + 18));
/** 主图 y 顶 */
const mainTop = 8;
/** 量能 y 顶 */
const volTop = computed(() => mainTop + MAIN_H + GAP);
/** 资金 y 顶 */
const fundTop = computed(() => volTop.value + VOL_H + GAP);

/** 视窗起点（0~1，含） */
const viewLo = ref(0);
/** 视窗终点（0~1，含） */
const viewHi = ref(1);

// 数据换档 / 换板块时重置视窗（prop 引用变化即重置，保守但可预期）
watch(
  () => props.days,
  () => {
    viewLo.value = 0;
    viewHi.value = 1;
  },
);

/** 可见窗口（下标区间，含首尾） */
const visibleRange = computed(() => {
  const total = props.days.length;
  if (total === 0) return { start: 0, end: -1 };
  const start = Math.floor(viewLo.value * total);
  const end = Math.max(start, Math.ceil(viewHi.value * total) - 1);
  return { start, end: Math.min(end, total - 1) };
});

/** 可见的板块日线 */
const visibleDays = computed(() => props.days.slice(visibleRange.value.start, visibleRange.value.end + 1));
/** 可见的指数序列 */
const visibleSeries = computed(() => props.series.slice(visibleRange.value.start, visibleRange.value.end + 1));

/** 可见收盘价域（含影线，上下留 3% 余量） */
const priceRange = computed(() => {
  const values: number[] = [];
  for (const day of visibleDays.value) {
    if (day.close !== null) values.push(day.close);
    if (props.mode === 'kline') {
      if (day.high !== null) values.push(day.high);
      if (day.low !== null) values.push(day.low);
    }
  }
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.03 || Math.abs(max) * 0.01 || 1;
  return { min: min - pad, max: max + pad };
});

/** 可见成交量最大值 */
const maxVolume = computed(() => {
  const values = visibleDays.value.map((day) => day.volume ?? 0).filter((value) => value > 0);
  return values.length > 0 ? Math.max(...values) : 0;
});

/** 可见小单净占比域（对称域：绝对值最大者，零轴居中） */
const fundRange = computed(() => {
  const values = visibleSeries.value
    .map((point) => point.factors.smallNetRatio)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const bound = Math.max(1, ...values.map((value) => Math.abs(value)));
  return { min: -bound, max: bound };
});

/** 单元槽宽（可见单元均分绘图区） */
const slotWidth = computed(() => (VIEW_W - PAD_L - PAD_R) / Math.max(1, visibleDays.value.length));

/**
 * 下标 → x 中心
 * @param index 可见窗口内下标
 * @returns SVG x
 */
const toX = (index: number): number => PAD_L + slotWidth.value * (index + 0.5);

/**
 * 价格 → 主图 y
 * @param value 价格
 * @returns SVG y
 */
const toPriceY = (value: number): number => {
  const { min, max } = priceRange.value;
  const ratio = (value - min) / (max - min || 1);
  return mainTop + (1 - ratio) * MAIN_H;
};

/**
 * 情绪指数 → 主图 y（右轴恒定 0~100）
 * @param value 指数值
 * @returns SVG y
 */
const toRetailY = (value: number): number => mainTop + (1 - value / 100) * MAIN_H;

/**
 * 成交量 → 量能 y
 * @param value 成交量
 * @returns SVG y
 */
const toVolY = (value: number): number => {
  const top = volTop.value;
  if (maxVolume.value <= 0 || value <= 0) return top + VOL_H;
  return top + (1 - value / maxVolume.value) * VOL_H;
};

/**
 * 小单净占比 → 资金 y
 * @param value 净占比（%）
 * @returns SVG y
 */
const toFundY = (value: number): number => {
  const { min, max } = fundRange.value;
  const ratio = (value - min) / (max - min || 1);
  return fundTop.value + (1 - ratio) * FUND_H;
};

/** 主图右轴刻度（0/25/50/75/100） */
const retailTicks = computed(() => [0, 25, 50, 75, 100].map((value) => ({ value, y: toRetailY(value) })));

/** 当日蜡烛颜色类（涨红跌绿，跟 data-trend） */
type TrendColor = 'var(--color-up)' | 'var(--color-down)';

/**
 * 某日的涨跌色（优先涨跌幅字段，缺失退回收盘 vs 前收）
 * @param index 可见窗口内下标
 * @returns 颜色值
 */
const trendColorAt = (index: number): TrendColor => {
  const day = visibleDays.value[index];
  if (!day) return 'var(--color-up)';
  if (day.pctChg !== null) return day.pctChg >= 0 ? 'var(--color-up)' : 'var(--color-down)';
  const prev = visibleDays.value[index - 1];
  if (prev?.close !== null && prev !== undefined && day.close !== null) {
    return day.close >= prev.close ? 'var(--color-up)' : 'var(--color-down)';
  }
  return 'var(--color-up)';
};

/** 蜡烛实体宽（槽宽的 62%，至少 1px） */
const bodyWidth = computed(() => Math.max(1, slotWidth.value * 0.62));

/** 蜡烛几何（kline 模式） */
const candles = computed(() => {
  if (props.mode !== 'kline') return [];
  return visibleDays.value
    .map((day, index) => {
      if (day.open === null || day.close === null) return null;
      const top = toPriceY(Math.max(day.open, day.close));
      const bottom = toPriceY(Math.min(day.open, day.close));
      const color = trendColorAt(index);
      const wickTop = day.high !== null ? toPriceY(day.high) : top;
      const wickBottom = day.low !== null ? toPriceY(day.low) : bottom;
      return {
        key: day.date,
        x: toX(index),
        bodyTop: top,
        bodyHeight: Math.max(1, bottom - top),
        wickTop,
        wickBottom,
        color,
        title: candleTitle(day),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
});

/** 收盘价线（line 模式） */
const closeLine = computed(() => {
  if (props.mode !== 'line') return { segments: [] as string[], color: 'var(--color-text)' };
  const segments: string[] = [];
  let current: string[] = [];
  visibleDays.value.forEach((day, index) => {
    if (day.close === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${toX(index).toFixed(1)},${toPriceY(day.close).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));
  return { segments, color: 'var(--color-text)' };
});

/** 情绪指数折线（null 断段） */
const retailSegments = computed(() => {
  const segments: string[] = [];
  let current: string[] = [];
  visibleSeries.value.forEach((point, index) => {
    const value = point.retailIndex;
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${toX(index).toFixed(1)},${toRetailY(value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));
  return segments;
});

/** 量能柱 */
const volumeBars = computed(() =>
  visibleDays.value.map((day, index) => {
    const volume = day.volume ?? 0;
    return {
      key: day.date,
      x: toX(index),
      y: toVolY(volume),
      height: Math.max(volume > 0 ? 1 : 0, volTop.value + VOL_H - toVolY(volume)),
      width: Math.max(1, slotWidth.value * 0.62),
      color: trendColorAt(index),
      title: candleTitle(day),
    };
  }),
);

/** 小单净占比折线段（红正绿负：按符号切段） */
const fundSegments = computed(() => {
  const positive: string[] = [];
  const negative: string[] = [];
  const positiveRuns: string[] = [];
  const negativeRuns: string[] = [];
  visibleSeries.value.forEach((point, index) => {
    const value = point.factors.smallNetRatio;
    if (value === null || !Number.isFinite(value)) {
      if (positive.length > 1) positiveRuns.push(positive.join(' '));
      if (negative.length > 1) negativeRuns.push(negative.join(' '));
      positive.length = 0;
      negative.length = 0;
      return;
    }
    const pointText = `${toX(index).toFixed(1)},${toFundY(value).toFixed(1)}`;
    (value >= 0 ? positive : negative).push(pointText);
  });
  if (positive.length > 1) positiveRuns.push(positive.join(' '));
  if (negative.length > 1) negativeRuns.push(negative.join(' '));
  return { positiveRuns, negativeRuns, zeroY: toFundY(0) };
});

/** 背离标记（可见窗口内；打在情绪线对应点位上方） */
const visibleMarks = computed(() => {
  const indexed = visibleSeries.value
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => props.marks.some((mark) => mark.date === point.date));
  const markByDate = new Map(props.marks.map((mark) => [mark.date, mark]));
  return indexed
    .map(({ point, index }) => {
      const mark = markByDate.get(point.date);
      if (!mark) return null;
      const retail = point.retailIndex ?? 50;
      return {
        key: `${mark.date}-${mark.kind}`,
        x: toX(index),
        y: toRetailY(retail) - 16,
        title: mark.kind === 'blunt' ? divergenceBluntTip(retail) : divergenceFadeTip(),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
});

/** 首尾可见日期标注 */
const firstDateLabel = computed(() => visibleDays.value[0]?.date.slice(5) ?? '');
const lastDateLabel = computed(() => visibleDays.value.at(-1)?.date.slice(5) ?? '');

/**
 * 蜡烛 / 量能柱的原生 tooltip 文案（日期 + 价格 + 情绪 + 小单四元组）
 * @param day 板块日线
 * @returns tooltip 文案
 */
const candleTitle = (day: BoardDay): string => {
  const parts = [day.date];
  if (day.close !== null) parts.push(`收 ${day.close.toFixed(0)}`);
  if (day.pctChg !== null) parts.push(`${day.pctChg >= 0 ? '+' : ''}${day.pctChg.toFixed(2)}%`);
  const point = props.series.find((item) => item.date === day.date);
  if (point?.retailIndex != null) parts.push(`情绪 ${point.retailIndex.toFixed(0)}`);
  if (day.smallRatio !== null) parts.push(`小单 ${day.smallRatio >= 0 ? '+' : ''}${day.smallRatio.toFixed(2)}%`);
  if (day.amount !== null) parts.push(`额 ${(day.amount / YUAN_PER_YI).toFixed(0)}${YI_UNIT}`);
  return parts.join(' · ');
};

// ---------- 视窗交互：拖动平移 + 滚轮缩放 ----------

/** svg 根元素引用（坐标换算用） */
const svgRef = ref<SVGSVGElement | null>(null);
/** 拖动起点状态 */
let dragState: { pointerId: number; startX: number; lo: number; hi: number } | null = null;

/**
 * 把 client x 换算为绘图区占比（0~1，越界夹取）
 * @param clientX 指针 x
 * @returns 占比
 */
const fractionAt = (clientX: number): number => {
  const rect = svgRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0) return 0;
  const plotX = ((clientX - rect.left) / rect.width) * VIEW_W;
  return Math.min(1, Math.max(0, (plotX - PAD_L) / (VIEW_W - PAD_L - PAD_R)));
};

/**
 * 指针按下：记录拖动起点
 * @param event 指针事件
 * @returns void
 */
const onPointerDown = (event: PointerEvent): void => {
  if (visibleDays.value.length === 0) return;
  dragState = { pointerId: event.pointerId, startX: event.clientX, lo: viewLo.value, hi: viewHi.value };
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
};

/**
 * 指针拖动：平移视窗（三栏共享同一视窗状态，天然联动）
 * @param event 指针事件
 * @returns void
 */
const onPointerMove = (event: PointerEvent): void => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const rect = svgRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0) return;
  const span = dragState.hi - dragState.lo;
  const shift = ((event.clientX - dragState.startX) / rect.width) * -span;
  let lo = dragState.lo + shift;
  let hi = dragState.hi + shift;
  if (lo < 0) {
    lo = 0;
    hi = span;
  }
  if (hi > 1) {
    hi = 1;
    lo = 1 - span;
  }
  viewLo.value = lo;
  viewHi.value = hi;
};

/**
 * 指针抬起：结束拖动
 * @returns void
 */
const endDrag = (): void => {
  dragState = null;
};

/**
 * 滚轮：以指针为中心缩放视窗（最小 5 个单元）
 * @param event 滚轮事件
 * @returns void
 */
const onWheel = (event: WheelEvent): void => {
  if (visibleDays.value.length === 0) return;
  event.preventDefault();
  const anchor = fractionAt(event.clientX);
  const factor = event.deltaY > 0 ? 1.25 : 0.8;
  const span = Math.min(1, Math.max(5 / Math.max(1, props.days.length), (viewHi.value - viewLo.value) * factor));
  const center = viewLo.value + (viewHi.value - viewLo.value) * anchor;
  let lo = center - span * anchor;
  let hi = lo + span;
  if (lo < 0) {
    lo = 0;
    hi = span;
  }
  if (hi > 1) {
    hi = 1;
    lo = 1 - span;
  }
  viewLo.value = lo;
  viewHi.value = hi;
};
</script>

<template>
  <div class="w-full">
    <svg
      ref="svgRef"
      :viewBox="`0 0 ${VIEW_W} ${viewH}`"
      class="block w-full cursor-grab touch-none select-none active:cursor-grabbing"
      role="img"
      aria-label="单题材价格-情绪-量能联动图"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @wheel="onWheel"
    >
      <!-- 主图右轴刻度与网格 -->
      <g v-for="tick in retailTicks" :key="`tick-${tick.value}`">
        <line
          :x1="PAD_L"
          :x2="VIEW_W - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          stroke="var(--color-flat)"
          stroke-width="1"
          stroke-dasharray="2 4"
        />
        <text :x="VIEW_W - PAD_R + 6" :y="tick.y + 3" font-size="10" fill="var(--color-text-tertiary)">
          {{ tick.value }}
        </text>
      </g>

      <!-- 主图：K 线蜡烛 -->
      <g v-if="mode === 'kline'">
        <g v-for="candle in candles" :key="`c-${candle.key}`">
          <title>{{ candle.title }}</title>
          <line
            :x1="candle.x"
            :x2="candle.x"
            :y1="candle.wickTop"
            :y2="candle.wickBottom"
            :stroke="candle.color"
            stroke-width="1"
          />
          <rect
            :x="candle.x - bodyWidth / 2"
            :y="candle.bodyTop"
            :width="bodyWidth"
            :height="candle.bodyHeight"
            :fill="candle.color"
          />
        </g>
      </g>
      <!-- 主图：收盘价线 -->
      <template v-else>
        <polyline
          v-for="(segment, index) in closeLine.segments"
          :key="`line-${index}`"
          :points="segment"
          fill="none"
          :stroke="closeLine.color"
          stroke-width="1.4"
        />
      </template>

      <!-- 情绪指数折线（湖青实线，右轴 0~100） -->
      <polyline
        v-for="(segment, index) in retailSegments"
        :key="`retail-${index}`"
        :points="segment"
        fill="none"
        stroke="var(--color-primary)"
        stroke-width="2"
        stroke-linejoin="round"
      />

      <!-- 背离标记（⚠，悬停看两侧数值） -->
      <g v-for="mark in visibleMarks" :key="`mark-${mark.key}`">
        <title>{{ mark.title }}</title>
        <circle :cx="mark.x" :cy="mark.y" r="9" fill="var(--color-up-weak)" stroke="var(--color-up)" stroke-width="1.2" />
        <text
          :x="mark.x"
          :y="mark.y + 4"
          text-anchor="middle"
          font-size="11"
          font-weight="700"
          fill="var(--color-up)"
        >
          ⚠
        </text>
      </g>

      <!-- 量能副图（涨红跌绿） -->
      <g v-for="bar in volumeBars" :key="`v-${bar.key}`">
        <title>{{ bar.title }}</title>
        <rect :x="bar.x - bar.width / 2" :y="bar.y" :width="bar.width" :height="bar.height" :fill="bar.color" />
      </g>
      <text
        :x="VIEW_W - PAD_R + 6"
        :y="volTop + 10"
        font-size="10"
        fill="var(--color-text-tertiary)"
      >
        {{ (maxVolume / 10000).toFixed(1) }}万手
      </text>

      <!-- 资金副图（小单净占比：红正绿负 + 零轴） -->
      <template v-if="showFund">
        <line
          :x1="PAD_L"
          :x2="VIEW_W - PAD_R"
          :y1="fundSegments.zeroY"
          :y2="fundSegments.zeroY"
          stroke="var(--color-flat)"
          stroke-dasharray="2 4"
          stroke-width="1"
        />
        <polyline
          v-for="(segment, index) in fundSegments.positiveRuns"
          :key="`fp-${index}`"
          :points="segment"
          fill="none"
          stroke="var(--color-up)"
          stroke-width="1.5"
        />
        <polyline
          v-for="(segment, index) in fundSegments.negativeRuns"
          :key="`fn-${index}`"
          :points="segment"
          fill="none"
          stroke="var(--color-down)"
          stroke-width="1.5"
        />
      </template>

      <!-- 首尾日期 -->
      <text :x="PAD_L" :y="viewH - 4" font-size="10" fill="var(--color-text-tertiary)">{{ firstDateLabel }}</text>
      <text
        :x="VIEW_W - PAD_R"
        :y="viewH - 4"
        text-anchor="end"
        font-size="10"
        fill="var(--color-text-tertiary)"
      >
        {{ lastDateLabel }}
      </text>
    </svg>

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
