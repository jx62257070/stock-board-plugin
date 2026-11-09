<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import EChartBox from './EChartBox.vue';
import { chartPalette, readCssVar, useChartThemeSignal } from './echarts-theme';
import {
  INDEX_KLINE_CHART_HEIGHT_PX,
  INDEX_KLINE_MA_COLORS,
  INDEX_KLINE_MA_PERIODS,
  INDEX_KLINE_VIEW,
} from './constants';
import { toDayKey } from './compute-breadth';
import type { IndexDayBar, IndexMinutePoint } from './types';
import type { IndexKlineItem, IndexKlineViewKey } from './constants';
import type { BreadthRuntime } from './types';

/**
 * 大盘指数卡（自宿主宽基 ETF 卡片形态移植，插件自包含版）
 *
 * - 分时：当日 1 分钟线（新浪源），主图分时线（涨跌色 + 面积）+ 均价线（量加权累计）
 *   + 昨收基准虚线（y=0 百分比域），副图分钟成交量；
 * - 日K：腾讯源蜡烛图 + MA5/10/20，副图成交量（按阴阳着色）；
 * - 卡头：指数名 / 代码 + 最新点位与涨跌幅胶囊（分时取分钟末点，日K取最后一根收盘）；
 * - 数据在模式切换 / 盘中刷新 tick 变化时按需拉取；失败保留上一次成功数据。
 */
const props = defineProps<{
  /** 指数条目（symbol + 展示名） */
  item: IndexKlineItem;
  /** 图表模式（分时 / 日K，全页统一切换） */
  mode: IndexKlineViewKey;
  /** 盘中刷新 tick（父级自增，分时 / 日K 均跟随重拉：日K最后一根盘中未定稿） */
  tick: number;
  /** 取数运行时（指数 K 线 fetcher） */
  runtime: BreadthRuntime;
}>();

/** 主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 涨跌语义色（渲染时读宿主 CSS 变量，读不到回落红绿） */
const upColor = computed(() => readCssVar('--color-up-strong') || '#e0524d');
const downColor = computed(() => readCssVar('--color-down-strong') || '#2aa46c');

/** 日 K 序列（时间升序；分时模式也拉取 —— 供昨收基准与卡头报价兜底） */
const dayBars = ref<IndexDayBar[]>([]);

/** 当日分钟点序列（时间升序；仅分时模式消费） */
const minutes = ref<IndexMinutePoint[]>([]);

/** 昨收点位（分时百分比域的基准；无数据为 null） */
const prevClose = ref<number | null>(null);

/** 首次加载中（已有数据时静默刷新，不闪加载态） */
const loading = ref(true);

/** 加载失败且无历史数据（展示错误占位） */
const failed = ref(false);

/**
 * 从日 K 序列推导昨收：最后一根为今日（盘中未定稿）取倒数第二根，否则取最后一根
 * @param bars 日 K 序列
 * @returns 昨收点位；序列为空（或只有今日一根）时 null
 */
const derivePrevClose = (bars: IndexDayBar[]): number | null => {
  const today = toDayKey(Date.now());
  const last = bars.at(-1);
  if (!last) return null;
  if (last.date === today) return bars.at(-2)?.close ?? null;
  return last.close;
};

/**
 * 拉取当前模式所需数据：日K 两个模式共用（昨收 / 蜡烛），分时另拉 1 分钟线
 */
const load = async (): Promise<void> => {
  loading.value = dayBars.value.length === 0;
  failed.value = false;
  try {
    const bars = await props.runtime.fetchIndexDayKline(props.item.symbol);
    dayBars.value = bars;
    prevClose.value = derivePrevClose(bars);
    if (props.mode === INDEX_KLINE_VIEW.MINUTE) {
      minutes.value = await props.runtime.fetchIndexMinuteLine(props.item.symbol);
    }
  } catch (error) {
    // 失败保留上一次成功数据；首次失败才展示错误态
    failed.value = dayBars.value.length === 0;
    console.warn('[dsh-market-breadth] index kline load failed', props.item.symbol, error);
  } finally {
    loading.value = false;
  }
};

// 模式切换 / 标的变化 / 刷新 tick 重拉（切模式时图表结构不同，EChartBox 以 key 重建）
watch(
  () => [props.item.symbol, props.mode, props.tick] as const,
  () => {
    void load();
  },
  { immediate: true },
);

/** 卡头报价：分时取分钟末点，日K取最后一根收盘（对昨收 / 前一根的涨跌幅） */
const quote = computed<{ price: number; pct: number } | null>(() => {
  if (props.mode === INDEX_KLINE_VIEW.MINUTE) {
    const last = minutes.value.at(-1);
    if (!last || prevClose.value === null || prevClose.value <= 0) return null;
    return { price: last.close, pct: (last.close / prevClose.value - 1) * 100 };
  }
  const bars = dayBars.value;
  const last = bars.at(-1);
  const prev = bars.at(-2);
  if (!last || !prev || prev.close <= 0) return null;
  return { price: last.close, pct: (last.close / prev.close - 1) * 100 };
});

/** 卡头涨跌色类（up 红 / down 绿；无报价不显示卡头行） */
const trendClass = computed(() =>
  (quote.value?.pct ?? 0) >= 0 ? 'text-up' : 'text-down',
);

/**
 * 成交量 → 紧凑文案（万 / 亿；不带单位 —— 日K为手、分钟线为股，量纲随源不同）
 * @param volume 成交量（上游原值）
 * @returns 文案
 */
const fmtVolume = (volume: number): string =>
  volume >= 1e8
    ? `${(volume / 1e8).toFixed(2)}亿`
    : volume >= 1e4
      ? `${(volume / 1e4).toFixed(1)}万`
      : String(Math.round(volume));

/**
 * 简单移动平均（窗口不足为 null 断点）
 * @param values 收盘序列
 * @param period 均线周期
 * @returns MA 序列（与入参按下标对齐）
 */
const maOf = (values: readonly number[], period: number): Array<number | null> =>
  values.map((_, i) => {
    if (i + 1 < period) return null;
    let sum = 0;
    for (let j = i + 1 - period; j <= i; j += 1) sum += values[j] ?? 0;
    return sum / period;
  });

/** ECharts tooltip 参数的最小结构（axis 触发时为数组） */
interface TooltipParam {
  /** 类目名（时间 / 日期） */
  name?: string;
  /** 序列名（MA 行用） */
  seriesName?: string;
  /** 序列类型 */
  seriesType?: string;
  /** 系列主色（MA 行着色） */
  color?: string;
  /** 数据下标 */
  dataIndex?: number;
  /** 数据值（蜡烛为 [开, 收, 低, 高]） */
  value?: number | number[];
}

/**
 * 双网格矩形（分时 / 日K共用）：左右留白完全一致，保证主图与成交量副图绘图区
 * 逐列对齐。**不用 containLabel** —— 主图右侧有 y 轴刻度文字、副图没有，
 * containLabel 会把两区宽度挤成不一样，蜡烛与量柱随之错位；改为固定预留
 * 右侧刻度带宽（right = GRID_RIGHT），两区同宽。
 */
const GRID_LEFT = 8;
const GRID_RIGHT = 46;

/**
 * 生成一个双网格矩形
 * @param top 距容器顶距离（px）
 * @param height 网格高度（px）
 * @returns grid 矩形配置
 */
const gridRect = (top: number, height: number): { left: number; right: number; top: number; height: number } => ({
  left: GRID_LEFT,
  right: GRID_RIGHT,
  top,
  height,
});

/** 分时 option（percent 域：分时线 + 均价线 + 昨收虚线，副图分钟成交量） */
const minuteOption = computed<EChartsCoreOption | null>(() => {
  const points = minutes.value;
  const base = prevClose.value;
  if (points.length === 0 || base === null || base <= 0) return null;
  const palette = chartPalette(themeSignal.value);

  const times = points.map((point) => point.time);
  const closes = points.map((point) => point.close);
  const vols = points.map((point) => point.volume);
  const pcts = closes.map((close) => (close / base - 1) * 100);

  // 均价线：量加权累计均价（无量的分钟不累计），再换算到百分比域
  let cumPV = 0;
  let cumV = 0;
  const avgCloses = points.map((point) => {
    if (point.volume > 0) {
      cumPV += point.close * point.volume;
      cumV += point.volume;
    }
    return cumV > 0 ? cumPV / cumV : point.close;
  });
  const avgPcts = avgCloses.map((avg) => (avg / base - 1) * 100);

  const rising = (closes.at(-1) ?? base) >= base;
  const lineColor = rising ? upColor.value : downColor.value;

  /**
   * tooltip：时间 + 点位（涨跌幅）+ 均价 + 分钟量
   * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
   * @returns HTML 文本
   */
  const tooltipFormatter = (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
    const index = params[0]?.dataIndex ?? -1;
    if (index < 0 || index >= closes.length) return '';
    const pct = pcts[index] ?? 0;
    const tone = pct >= 0 ? upColor.value : downColor.value;
    const lines = [
      times[index] ?? '',
      `点位 ${closes[index]?.toFixed(2)}（<span style="color:${tone}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>）`,
      `均价 ${(avgCloses[index] ?? 0).toFixed(2)}`,
    ];
    if ((vols[index] ?? 0) > 0) lines.push(`量 ${fmtVolume(vols[index] ?? 0)}`);
    return lines.join('<br/>');
  };

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.text, fontSize: 11 },
      formatter: tooltipFormatter,
    },
    grid: [gridRect(10, 96), gridRect(122, 40)],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: times,
        axisLine: { show: true, lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: times,
        axisLine: { show: true, lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: {
          show: true,
          color: palette.text,
          fontSize: 10,
          // 每小时一个刻度（1 分钟线：60 点 ≈ 1 小时）
          interval: (index: number): boolean => index % 60 === 0,
        },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          show: true,
          color: palette.text,
          fontSize: 10,
          formatter: (value: number): string => `${value.toFixed(1)}%`,
        },
        splitLine: { show: true, lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        gridIndex: 1,
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        type: 'line',
        data: pcts,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.4, color: lineColor },
        itemStyle: { color: lineColor },
        areaStyle: { color: lineColor, opacity: 0.08 },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: palette.axisLine, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
      {
        type: 'line',
        data: avgPcts,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1, color: '#e8b339' },
        itemStyle: { color: '#e8b339' },
      },
      {
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: vols.map((volume, index) => ({
          value: volume,
          itemStyle: { color: (closes[index] ?? base) >= base ? upColor.value : downColor.value },
        })),
        barWidth: '60%',
      },
    ],
  };
});

/** 日K option：蜡烛 + MA5/10/20（百分比涨跌着色的成交量副图） */
const dayOption = computed<EChartsCoreOption | null>(() => {
  const bars = dayBars.value;
  if (bars.length === 0) return null;
  const palette = chartPalette(themeSignal.value);

  const dates = bars.map((bar) => bar.date.slice(5));
  const candles = bars.map((bar) => [bar.open, bar.close, bar.low, bar.high]);
  const closes = bars.map((bar) => bar.close);
  const vols = bars.map((bar) => bar.volume);

  const maSeries = INDEX_KLINE_MA_PERIODS.map((period, index) => ({
    type: 'line',
    name: `MA${period}`,
    data: maOf(closes, period),
    xAxisIndex: 0,
    yAxisIndex: 0,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 1, color: INDEX_KLINE_MA_COLORS[index] },
    itemStyle: { color: INDEX_KLINE_MA_COLORS[index] },
  }));

  /**
   * tooltip：日期 + 开收高低 + 涨跌幅 + 量 + MA 行
   * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
   * @returns HTML 文本
   */
  const tooltipFormatter = (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
    const index = params[0]?.dataIndex ?? -1;
    if (index < 0 || index >= bars.length) return '';
    const lines = [dates[index] ?? ''];
    for (const param of params) {
      if (param.seriesType === 'candlestick') {
        const candle = candles[index] ?? [];
        const close = closes[index] ?? 0;
        const prev = index > 0 ? closes[index - 1] ?? close : close;
        const pct = prev > 0 ? (close / prev - 1) * 100 : 0;
        const tone = pct >= 0 ? upColor.value : downColor.value;
        lines.push(
          `开 ${(candle[0] ?? 0).toFixed(2)}　收 <span style="color:${tone}">${close.toFixed(2)}</span>`,
          `高 ${(candle[3] ?? 0).toFixed(2)}　低 ${(candle[2] ?? 0).toFixed(2)}`,
          `涨跌 <span style="color:${tone}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`,
          `量 ${fmtVolume(vols[index] ?? 0)}`,
        );
      } else if (param.seriesType === 'line') {
        const value = param.value;
        if (typeof value === 'number' && Number.isFinite(value)) {
          lines.push(
            `<span style="color:${param.color ?? palette.text}">${param.seriesName}</span> ${value.toFixed(2)}`,
          );
        }
      }
    }
    return lines.join('<br/>');
  };

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.text, fontSize: 11 },
      formatter: tooltipFormatter,
    },
    grid: [gridRect(10, 96), gridRect(122, 40)],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: dates,
        axisLine: { show: true, lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLine: { show: true, lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: {
          show: true,
          color: palette.text,
          fontSize: 10,
          formatter: (value: string): string => value,
        },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          show: true,
          color: palette.text,
          fontSize: 10,
        },
        splitLine: { show: true, lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        gridIndex: 1,
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      {
        type: 'candlestick',
        data: candles,
        xAxisIndex: 0,
        yAxisIndex: 0,
        itemStyle: {
          color: upColor.value,
          color0: downColor.value,
          borderColor: upColor.value,
          borderColor0: downColor.value,
        },
      },
      ...maSeries,
      {
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: vols.map((volume, index) => ({
          value: volume,
          itemStyle: {
            color: (closes[index] ?? 0) >= (index > 0 ? closes[index - 1] ?? 0 : 0)
              ? upColor.value
              : downColor.value,
          },
        })),
        barWidth: '60%',
      },
    ],
  };
});

/** 当前模式对应的 option（无数据显示 null → 模板空态） */
const option = computed<EChartsCoreOption | null>(() =>
  props.mode === INDEX_KLINE_VIEW.MINUTE ? minuteOption.value : dayOption.value,
);

/** 卡头涨跌幅文案（+ / - 号保留两位） */
const pctText = computed(() => {
  const pct = quote.value?.pct;
  if (pct === undefined) return '--';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
});

/** 卡头涨跌胶囊的行内配色（跟随涨跌主题色变量） */
const pillStyle = computed(() => {
  const up = (quote.value?.pct ?? 0) >= 0;
  return up
    ? { color: 'var(--color-up-strong)', background: 'var(--color-up-weak)' }
    : { color: 'var(--color-down-strong)', background: 'var(--color-down-weak)' };
});

/** 图表 aria 标签（模式名随切换） */
const modeLabel = computed(() =>
  props.mode === INDEX_KLINE_VIEW.MINUTE ? '分时' : '日K',
);
</script>

<template>
  <!-- bg/border 用 -weak 档：--color-flat 在宿主暗色主题未做变量覆盖（仍为亮色 #8a94a6），
       bg-flat / border-flat 会在暗色下渲染成浅底（仓库其他插件清一色只走 -weak 档） -->
  <div class="rounded-lg border border-flat-weak bg-flat-weak p-2">
    <div class="flex items-center justify-between gap-2 px-1 pb-1">
      <div class="flex min-w-0 items-baseline gap-2">
        <h3 class="text-sm font-semibold text-text">{{ item.name }}</h3>
        <span class="text-xs tabular-nums text-text-tertiary">{{ item.symbol.toUpperCase() }}</span>
      </div>
      <div v-if="quote" class="flex items-center gap-2">
        <span class="text-sm font-bold tabular-nums" :class="trendClass">
          {{ quote.price.toFixed(2) }}
        </span>
        <span
          class="rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums"
          :style="pillStyle"
        >
          {{ pctText }}
        </span>
      </div>
    </div>
    <div
      v-if="loading"
      class="flex items-center justify-center text-xs text-text-tertiary"
      :style="{ height: `${INDEX_KLINE_CHART_HEIGHT_PX}px` }"
    >
      加载中…
    </div>
    <div
      v-else-if="failed"
      class="flex items-center justify-center text-xs text-text-tertiary"
      :style="{ height: `${INDEX_KLINE_CHART_HEIGHT_PX}px` }"
    >
      K 线加载失败（上游可能限频，下一轮自动重试）
    </div>
    <div
      v-else-if="option"
      class="w-full"
      role="img"
      :aria-label="`${item.name} ${modeLabel}图`"
      :style="{ height: `${INDEX_KLINE_CHART_HEIGHT_PX}px` }"
    >
      <EChartBox :key="mode" :options="option" not-merge />
    </div>
    <div
      v-else
      class="flex items-center justify-center text-xs text-text-tertiary"
      :style="{ height: `${INDEX_KLINE_CHART_HEIGHT_PX}px` }"
    >
      {{ mode === INDEX_KLINE_VIEW.MINUTE ? '暂无分时数据（非交易时段）' : '暂无数据' }}
    </div>
  </div>
</template>
