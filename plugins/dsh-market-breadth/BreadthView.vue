<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SvgBreadthChart from './SvgBreadthChart.vue';
import { buildBreadthAnalysisPrompt } from './prompt';
import {
  ADR_READY_DAYS,
  ARMS_NEUTRAL_LINE,
  BREADTH_ACTIVE_TURNOVER_THRESHOLD,
  BREADTH_AI_BUTTON_TEXT,
  BREADTH_AI_EMPTY_BODY,
  BREADTH_AI_EMPTY_TITLE,
  BREADTH_AI_RUNNING_TEXT,
  BREADTH_ADL_MA_PERIOD,
  BREADTH_ARMS_MA_PERIOD,
  BREADTH_INDICATOR_INFO,
  BREADTH_INDICATOR_KIND,
  BREADTH_INDICATOR_VIEW,
  BREADTH_INDICATOR_VIEW_DAYS,
  BREADTH_INDICATOR_VIEW_OPTIONS,
  BREADTH_INTERPRET_EMPTY,
  BREADTH_POLL_INTERVAL_MS,
  BREADTH_REFRESHING_TEXT,
  BREADTH_REFRESH_BUTTON_TEXT,
  BREADTH_SUMMARY_BUTTON_TEXT,
  BREADTH_SUMMARY_MODAL_TITLE,
  BREADTH_SUMMARY_DATE_ARIA_LABEL,
  BREADTH_SUMMARY_SUBTITLE,
  MCO_READY_DAYS,
} from './constants';
import { classifyArms, interpretBreadthValue } from './interpret';
import { computeBreadthIndicatorSeries } from './indicators';
import { toDayKey } from './compute-breadth';
import type { BreadthRepo } from './storage';
import type {
  BreadthDeps,
  BreadthIndicatorCard,
  BreadthPoint,
  BreadthRuntime,
  BreadthSummaryItem,
} from './types';
import type {
  BreadthIndicatorKind,
  BreadthIndicatorViewKey,
} from './constants';

/**
 * 市场宽度页（PC，自宿主内置页移植）
 *
 * 六大市场广度指标副图组（ADL / ADR / OBOS / ARMS / MCO / 活跃占比），基于本地
 * 积累的日 bar（ctx.db）经 computeBreadthIndicatorSeries 离线计算。
 * 数据生产：页面挂载期间自带一路全市场快照轮询（盘中 30s 一轮，挂载必跑一次），
 * 每轮 ingest 产出分钟点；收盘后（≥15:00）快照定稿聚合为当日日 bar。
 * 「总结」可选已采集日期（默认最新），「刷新」重取当前选中日期的数据。
 */
const props = defineProps<{
  /** 本地积累仓储（读库即渲染；ingest / rebuildBar 供刷新用） */
  repo: BreadthRepo;
  /** 取数运行时（全市场快照） */
  runtime: BreadthRuntime;
  /** 宿主能力（Agent 唤起 / 盘中判定 / UI Kit） */
  deps: BreadthDeps;
}>();

/** 快照响应式读口（bars 日期升序 + 分钟点按日映射） */
const snap = computed(() => props.repo.snapshot());

/** 日 bar 序列 */
const bars = computed(() => snap.value.bars);

/** 当日分钟点序列（取最后一点作当日概览） */
const todaySeries = computed<BreadthPoint[]>(() => {
  const today = toDayKey(Date.now());
  return snap.value.minutes.get(today) ?? [];
});

/** 六指标序列（随 bars 全量重算，250 bar 量级毫秒级完成） */
const series = computed(() => computeBreadthIndicatorSeries(bars.value));

/** 已积累交易日数 */
const accumDays = computed(() => bars.value.length);

/** 当日概览（当日最后一个分钟点；无采样为 null） */
const todayPoint = computed<BreadthPoint | null>(() => todaySeries.value.at(-1) ?? null);

/** 当日活跃占比（%，当日末点活跃家数 ÷ 有效家数；旧点无字段或分母为 0 为 null） */
const todayActiveRatio = computed<number | null>(() => {
  const point = todayPoint.value;
  if (point?.activeCount === undefined || !point.activeTotal) return null;
  return (point.activeCount / point.activeTotal) * 100;
});

/** ARMS 现值五档状态（null 显「--」） */
const armsState = computed(() => classifyArms(todayPoint.value?.arms ?? null));

/* ------------------------------ 视图档位与副图 ------------------------------ */

/** 视图档位（近 60 / 120 日 / 全部积累） */
const view = ref<BreadthIndicatorViewKey>(BREADTH_INDICATOR_VIEW.ALL);

/** 窗口内下标起点（ALL 全量；D60 / D120 取末尾 N 日） */
const windowStart = computed(() => {
  const days = BREADTH_INDICATOR_VIEW_DAYS[view.value];
  if (days === undefined) return 0;
  return Math.max(0, series.value.dates.length - days);
});

/**
 * 截取当前视图窗口的序列
 * @param values 完整指标序列
 * @returns 窗口内切片
 */
const sliceWindow = (values: ReadonlyArray<number | null>): Array<number | null> =>
  values.slice(windowStart.value);

/** 窗口内日期序列 */
const windowDates = computed(() => series.value.dates.slice(windowStart.value));

/**
 * 序列内最后一个非 null 值（副图标题行的「最新值」）
 * @param values 指标序列
 * @returns 最新值；全空为 null
 */
const lastValue = (values: ReadonlyArray<number | null>): number | null => {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value !== null) return value;
  }
  return null;
};

/** 各副图最新值文案（null 显「--」） */
const latest = computed(() => ({
  adl: lastValue(series.value.adl),
  adr: lastValue(series.value.adr),
  obos: lastValue(series.value.obos),
  armsMa: lastValue(series.value.armsMa),
  mco: lastValue(series.value.mco),
  active: lastValue(series.value.activeRatio),
}));

/**
 * 数值 → 展示文案（千分位或指定小数位；null 显「--」）
 * @param value 数值
 * @param digits 小数位
 * @returns 文案
 */
const fmt = (value: number | null, digits = 2): string =>
  value === null
    ? '--'
    : Math.abs(value) >= 1000
      ? value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
      : value.toFixed(digits);

/**
 * 副图取值组（kind → 主序列 / 均线 / 基准线 / 最新值）
 * @param kind 指标 kind
 * @returns 副图渲染参数
 */
const cardSeries = (
  kind: BreadthIndicatorKind,
): { values: Array<number | null>; ma?: Array<number | null>; baseline?: number; value: number | null } => {
  const s = series.value;
  switch (kind) {
    case 'adl':
      return { values: sliceWindow(s.adl), ma: sliceWindow(s.adlMa), value: latest.value.adl };
    case 'adr':
      return { values: sliceWindow(s.adr), value: latest.value.adr };
    case 'obos':
      return { values: sliceWindow(s.obos), ma: sliceWindow(s.obosMa), value: latest.value.obos };
    case 'arms':
      return { values: sliceWindow(s.armsMa), baseline: ARMS_NEUTRAL_LINE, value: latest.value.armsMa };
    case 'mco':
      return { values: sliceWindow(s.mco), ma: sliceWindow(s.mcoSignal), baseline: 0, value: latest.value.mco };
    case 'active':
      return { values: sliceWindow(s.activeRatio), value: latest.value.active };
  }
};

/** ADR/OBOS 是否达标准口径周期 */
const adrReady = computed(() => accumDays.value >= ADR_READY_DAYS);

/** ARMS 平滑均线是否达惯例周期 */
const armsMaReady = computed(() => accumDays.value >= BREADTH_ARMS_MA_PERIOD);

/** MCO 是否过预热期（约 50 日，参考值） */
const mcoReady = computed(() => accumDays.value >= MCO_READY_DAYS);

/** 页头就绪徽标 */
const readinessBadges = computed(() => [
  { label: `ADR/OBOS N=10 ${adrReady.value ? '已就绪' : `积累中 ${accumDays.value}/${ADR_READY_DAYS}`}`, ok: adrReady.value },
  { label: `ARMS MA${BREADTH_ARMS_MA_PERIOD} ${armsMaReady.value ? '已就绪' : `积累中 ${accumDays.value}/${BREADTH_ARMS_MA_PERIOD}`}`, ok: armsMaReady.value },
  { label: `MCO ${mcoReady.value ? '已趋稳' : `预热中 ${accumDays.value}/${MCO_READY_DAYS}`}`, ok: mcoReady.value },
]);

/**
 * 指标说明气泡文本（公式 + 空行 + 意义）
 * @param kind 指标 kind
 * @returns 气泡完整文本
 */
const infoText = (kind: BreadthIndicatorKind): string => {
  const info = BREADTH_INDICATOR_INFO[kind];
  return `${info.formula}\n\n${info.meaning}`;
};

/** 六指标副图卡配置（声明顺序 = 默认展示顺序，口径同宿主；活跃占比卡 2026-10-29 王总指定移除） */
const INDICATOR_CARDS: readonly BreadthIndicatorCard[] = [
  { key: BREADTH_INDICATOR_KIND.ADL, label: 'ADL 腾落线', digits: 0, subtitle: `Σ(上涨−下跌家数)，起点为本地首条 bar（相对意义）；虚线为 MA${BREADTH_ADL_MA_PERIOD}` },
  { key: BREADTH_INDICATOR_KIND.ADR, label: 'ADR 涨跌比率', digits: 2, subtitle: 'N=10；＞1.5 超买，＜0.5 超卖' },
  { key: BREADTH_INDICATOR_KIND.OBOS, label: 'OBOS 超买超卖', digits: 0, subtitle: 'N=10 净差（家）；正值多头占优' },
  { key: BREADTH_INDICATOR_KIND.ARMS, label: 'TRIN 阿姆氏（ARMS）', digits: 2, subtitle: `MA${BREADTH_ARMS_MA_PERIOD}；＜1 多头强，＞1 空头强` },
  { key: BREADTH_INDICATOR_KIND.MCO, label: '麦克莱伦震荡（MCO）', digits: 1, subtitle: 'EMA19−EMA39；±25~35 为超买超卖区' },
];

/** 排序弹窗页签项（value = 指标 kind，口径同宿主 TabConfigButton） */
const INDICATOR_CARD_TABS = INDICATOR_CARDS.map((card) => ({
  label: card.label,
  value: card.key,
}));

/**
 * 指标卡显隐 + 顺序（宿主 useTabConfig 持久化，pageId 沿用原内置页的
 * 'market-breadth'，老配置无缝继承）
 */
const { visibleOptions: indicatorCardOptions } = props.deps.ui.useTabConfig<BreadthIndicatorKind>(
  'market-breadth',
  INDICATOR_CARD_TABS,
);

/** kind → 卡配置（渲染按 useTabConfig 归一化后的顺序查这张表） */
const cardMetaByKey = new Map(INDICATOR_CARDS.map((card) => [card.key, card]));

/** 窗口内是否无任何数据（整页空态判定） */
const isPageEmpty = computed(() => series.value.dates.length === 0);

/* ------------------------------ 数据生产（轮询 + 刷新） ------------------------------ */

/** 刷新 / 轮询进行中（防重入） */
const refreshing = ref(false);

/**
 * 拉一轮全市场快照并 ingest（生产分钟点 / 定稿日 bar）
 */
const fetchAndIngest = async (): Promise<void> => {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await props.repo.ingest(props.runtime);
  } catch (error) {
    console.warn('[dsh-market-breadth] snapshot ingest failed', error);
  } finally {
    refreshing.value = false;
  }
};

/** 轮询句柄（页面卸载时清理） */
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  // 挂载必跑一次：收盘后打开也能把当日序列定稿成日 bar
  void fetchAndIngest();
  pollTimer = setInterval(() => {
    if (props.deps.isIntraday()) void fetchAndIngest();
  }, BREADTH_POLL_INTERVAL_MS);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
});

/* ------------------------------ 总结（可选日期） ------------------------------ */

/** 总结弹窗开关 */
const summaryOpen = ref(false);

/** 已采集到数据的日期集合（bar 日期 ∪ 分钟点日期，降序 = 最新在前） */
const availableDates = computed<string[]>(() => {
  const set = new Set<string>([...bars.value.map((bar) => bar.date), ...snap.value.minutes.keys()]);
  return [...set].sort((a, b) => b.localeCompare(a));
});

/** 总结选中日期（默认最新采集日；列表变化时保持有效） */
const selectedDate = ref<string>('');

watch(
  availableDates,
  (dates) => {
    if (!dates.includes(selectedDate.value)) {
      selectedDate.value = dates[0] ?? '';
    }
  },
  { immediate: true },
);

/**
 * 解读行语义色类（跟随涨跌配色主题）
 * @param tone 语义档位
 * @returns Tailwind 文字色类
 */
const toneClass = (tone: 'up' | 'down' | 'flat'): string =>
  tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text';

/**
 * 指标序列在某日的下标（无该日为 -1）
 * @param date 本地日键
 * @returns 序列下标
 */
const seriesIndex = (date: string): number => series.value.dates.indexOf(date);

/** 总结条目（按选中日期：有 bar 用六指标序列；只有分钟点给当日概览口径） */
const summaryItems = computed<BreadthSummaryItem[]>(() => {
  const date = selectedDate.value;
  if (date === '') return [];
  const index = seriesIndex(date);
  if (index >= 0) {
    /**
     * 取该日的指标值
     * @param values 指标序列
     * @returns 值；全空为 null
     */
    const at = (values: ReadonlyArray<number | null>): number | null => values[index] ?? null;
    /**
     * 组一条总结条目
     * @param kind 指标 kind
     * @param label 指标名
     * @param value 主值
     * @param digits 小数位
     * @param ma 均线值（仅 ADL）
     * @returns 条目
     */
    const build = (
      kind: BreadthIndicatorKind,
      label: string,
      value: number | null,
      digits: number,
      ma?: number | null,
    ): BreadthSummaryItem => ({
      kind,
      label,
      display: fmt(value, digits),
      interpret: interpretBreadthValue(kind, value, ma),
    });
    return [
      build('adl', 'ADL 腾落线', at(series.value.adl), 0, at(series.value.adlMa)),
      build('adr', 'ADR 涨跌比率', at(series.value.adr), 2),
      build('obos', 'OBOS 超买超卖', at(series.value.obos), 0),
      build('arms', 'TRIN 阿姆氏（ARMS）', at(series.value.armsMa), 2),
      build('mco', '麦克莱伦震荡（MCO）', at(series.value.mco), 1),
    ];
  }
  // 该日尚无 bar（如当日盘中）：给分钟点末点的当日概览口径
  const point = snap.value.minutes.get(date)?.at(-1) ?? null;
  const activeRatio =
    point?.activeCount !== undefined && point.activeTotal
      ? (point.activeCount / point.activeTotal) * 100
      : null;
  return [
    {
      kind: 'arms',
      label: `${date} 当日概览（盘中分钟点末点）`,
      display: point
        ? `涨 ${point.upCount.toLocaleString()} / 跌 ${point.downCount.toLocaleString()} / 平 ${point.flatCount.toLocaleString()}`
        : '--',
      interpret: null,
    },
    {
      kind: 'arms',
      label: 'ARMS 现值',
      display: fmt(point?.arms ?? null),
      interpret: interpretBreadthValue('arms', point?.arms ?? null),
    },
    {
      kind: 'active',
      label: `活跃占比（换手率＞${BREADTH_ACTIVE_TURNOVER_THRESHOLD}%）`,
      display: activeRatio === null ? '--' : `${activeRatio.toFixed(1)}%`,
      interpret: interpretBreadthValue('active', activeRatio),
    },
    {
      kind: 'adl',
      label: '六指标序列',
      display: bars.value.at(-1)?.date ?? '--',
      interpret: null,
    },
  ];
});

/** 总结弹窗副标题 */
const summarySubtitle = computed(() => {
  const latestBarDate = bars.value.at(-1)?.date;
  return latestBarDate ? BREADTH_SUMMARY_SUBTITLE.replace('{date}', latestBarDate.slice(5)) : '';
});

/* ------------------------------ 刷新按钮 ------------------------------ */

/**
 * 点击「刷新」：重取当前选中日期的数据
 *
 * - 选中日 = 今天（有分钟点）：重拉一轮全市场快照 ingest（同分钟覆盖 + 收盘定稿 upsert）；
 * - 选中日 = 历史日：上游无历史宽度数据可回源，改为从本地分钟点末点**重算该日 bar**
 *   并幂等覆盖落库（ctx.db 为单一事实源）。
 */
const runRefresh = async (): Promise<void> => {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const today = toDayKey(Date.now());
    if (selectedDate.value === today || selectedDate.value === '') {
      await props.repo.ingest(props.runtime);
    } else {
      await props.repo.rebuildBar(selectedDate.value);
    }
  } catch (error) {
    console.warn('[dsh-market-breadth] refresh failed', error);
  } finally {
    refreshing.value = false;
  }
};

/* ------------------------------ AI 分析 ------------------------------ */

/** AI 分析运行态（防重入） */
const aiRunning = ref(false);

/** 无数据提示（行内展示，数秒后消失） */
const aiHint = ref('');

/** 无数据提示自动清除句柄 */
let aiHintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 发起「AI 分析」：把广度指标摘要交给 Agent（服务缺席时按钮本就隐藏）
 */
const runAiAnalysis = async (): Promise<void> => {
  if (aiRunning.value || props.deps.agentAsk === null) return;
  const prompt = buildBreadthAnalysisPrompt(bars.value, series.value);
  if (prompt === '') {
    aiHint.value = `${BREADTH_AI_EMPTY_TITLE}：${BREADTH_AI_EMPTY_BODY}`;
    if (aiHintTimer !== null) clearTimeout(aiHintTimer);
    aiHintTimer = setTimeout(() => {
      aiHint.value = '';
    }, 4000);
    return;
  }
  aiRunning.value = true;
  try {
    await props.deps.agentAsk.ask(prompt, {
      pluginId: 'dsh-market-breadth',
      pluginName: '市场宽度',
    });
  } finally {
    aiRunning.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <component :is="deps.ui.Card" title="市场宽度 · 当日概览">
      <template #extra>
        <component :is="deps.ui.Tag" tone="primary">
          已积累 {{ accumDays }} 个交易日
        </component>
      </template>

      <div class="flex flex-wrap items-stretch gap-3">
        <div class="min-w-[180px] flex-1 rounded-lg bg-flat-weak px-3 py-2">
          <div class="text-xs text-text-secondary">上涨 / 平盘 / 下跌</div>
          <div class="mt-0.5 text-lg font-bold tabular-nums">
            <span class="text-up">{{ todayPoint ? todayPoint.upCount.toLocaleString() : '--' }}</span>
            <span class="text-text-secondary"> / </span>
            <span class="text-text">{{ todayPoint ? todayPoint.flatCount.toLocaleString() : '--' }}</span>
            <span class="text-text-secondary"> / </span>
            <span class="text-down">{{ todayPoint ? todayPoint.downCount.toLocaleString() : '--' }}</span>
          </div>
        </div>
        <div class="min-w-[180px] flex-1 rounded-lg bg-flat-weak px-3 py-2">
          <div class="text-xs text-text-secondary">上涨量 / 下跌量（手）</div>
          <div class="mt-0.5 text-lg font-bold tabular-nums">
            <span class="text-up">{{ todayPoint ? todayPoint.upVol.toLocaleString() : '--' }}</span>
            <span class="text-text-secondary"> / </span>
            <span class="text-down">{{ todayPoint ? todayPoint.downVol.toLocaleString() : '--' }}</span>
          </div>
        </div>
        <div class="min-w-[140px] flex-1 rounded-lg bg-flat-weak px-3 py-2">
          <div class="text-xs text-text-secondary">ARMS 现值</div>
          <div class="mt-0.5 flex items-baseline gap-2">
            <span class="text-lg font-bold tabular-nums">{{ fmt(todayPoint?.arms ?? null) }}</span>
            <span
              v-if="armsState"
              class="rounded-full px-2 py-0.5 text-xs font-bold"
              :style="{
                color: armsState.tone === 'up'
                  ? 'var(--color-up-strong)'
                  : armsState.tone === 'down'
                    ? 'var(--color-down-strong)'
                    : 'var(--color-flat)',
                background: armsState.tone === 'up'
                  ? 'var(--color-up-weak)'
                  : armsState.tone === 'down'
                    ? 'var(--color-down-weak)'
                    : 'var(--color-flat-weak)',
              }"
            >
              {{ armsState.label }}
            </span>
          </div>
        </div>
        <div class="min-w-[180px] flex-1 rounded-lg bg-flat-weak px-3 py-2">
          <div class="text-xs text-text-secondary">活跃股（换手率＞{{ BREADTH_ACTIVE_TURNOVER_THRESHOLD }}%）</div>
          <div class="mt-0.5 text-lg font-bold tabular-nums">
            {{ todayPoint?.activeCount !== undefined ? todayPoint.activeCount.toLocaleString() : '--' }}
            <span class="text-sm text-text-secondary">家 / {{ fmt(todayActiveRatio, 1) }}%</span>
          </div>
        </div>
      </div>
      <div v-if="todayPoint === null" class="mt-2 text-xs text-text-tertiary">
        今日暂无采样（交易日盘中本页自动拉取全市场快照积累，收盘后定稿为当日日 bar）
      </div>
    </component>

    <component
      :is="deps.ui.Empty"
      v-if="isPageEmpty"
      text="历史广度数据按本地逐日积累（收盘后落库，无法回填）；本页已自动拉取快照，收盘后首个交易日即出图"
    />

    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <component :is="deps.ui.Tabs" v-model="view" :options="BREADTH_INDICATOR_VIEW_OPTIONS" />
        <span
          v-for="badge in readinessBadges"
          :key="badge.label"
          class="rounded-full px-2.5 py-1 text-xs font-bold"
          :style="
            badge.ok
              ? 'color: var(--color-up-strong); background: var(--color-up-weak)'
              : 'color: var(--color-flat); background: var(--color-flat-weak)'
          "
        >
          {{ badge.label }}
        </span>
        <!-- 指标卡显隐 + 排序入口（口径同原内置页 TabConfigButton） -->
        <component
          :is="deps.ui.TabConfigButton"
          class="ml-auto"
          page-id="market-breadth"
          :options="INDICATOR_CARD_TABS"
        />
        <!-- 动作区（总结 / 刷新 / AI 分析；行尾随排序入口，宽度不够随行自动换行） -->
        <component :is="deps.ui.Button" variant="ghost" @click="summaryOpen = true">
          {{ BREADTH_SUMMARY_BUTTON_TEXT }}
        </component>
        <component
          :is="deps.ui.Button"
          variant="ghost"
          :disabled="refreshing"
          @click="runRefresh"
        >
          {{ refreshing ? BREADTH_REFRESHING_TEXT : BREADTH_REFRESH_BUTTON_TEXT }}
        </component>
        <component
          :is="deps.ui.Button"
          v-if="deps.agentAsk !== null"
          variant="ghost"
          :disabled="aiRunning"
          @click="runAiAnalysis"
        >
          {{ aiRunning ? BREADTH_AI_RUNNING_TEXT : BREADTH_AI_BUTTON_TEXT }}
        </component>
        <span v-if="aiHint !== ''" class="text-xs text-down">{{ aiHint }}</span>
      </div>

      <div class="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        <component :is="deps.ui.Card" v-for="option in indicatorCardOptions" :key="option.value">
          <div class="mb-2 flex items-center gap-1.5">
            <h2 class="text-sm font-semibold text-text">{{ cardMetaByKey.get(option.value)?.label }}</h2>
            <span
              class="cursor-help text-text-tertiary"
              :title="infoText(option.value)"
            >?</span>
            <span class="text-sm font-bold tabular-nums">
              {{ fmt(cardSeries(option.value).value, cardMetaByKey.get(option.value)?.digits ?? 2) }}
            </span>
            <span class="ml-auto truncate pl-3 text-xs text-text-tertiary">
              {{ cardMetaByKey.get(option.value)?.subtitle }}
            </span>
          </div>
          <SvgBreadthChart
            :dates="windowDates"
            :values="cardSeries(option.value).values"
            :ma="cardSeries(option.value).ma"
            :baseline="cardSeries(option.value).baseline"
            :format="(value: number) => fmt(value, cardMetaByKey.get(option.value)?.digits ?? 2)"
          />
        </component>
      </div>
    </template>

    <!-- 总结弹窗：日期选择器（限定已采集日期）+ 该日逐指标解读 -->
    <component
      :is="deps.ui.Modal"
      v-model:open="summaryOpen"
      :title="BREADTH_SUMMARY_MODAL_TITLE"
    >
      <div class="mb-3 flex items-center gap-2">
        <span class="text-xs text-text-secondary">日期</span>
        <select
          v-model="selectedDate"
          :aria-label="BREADTH_SUMMARY_DATE_ARIA_LABEL"
          class="rounded-lg bg-flat-weak px-3 py-1.5 text-sm text-text outline-none focus:ring-1 focus:ring-primary"
        >
          <option v-for="date in availableDates" :key="date" :value="date">{{ date }}</option>
        </select>
        <span class="text-xs text-text-tertiary">{{ summarySubtitle }}</span>
      </div>
      <ul class="space-y-2">
        <li
          v-for="(item, index) in summaryItems"
          :key="`${item.kind}-${index}`"
          class="rounded-lg bg-flat-weak px-3 py-2"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium text-text-secondary">{{ item.label }}</span>
            <b class="text-sm tabular-nums text-text">{{ item.display }}</b>
          </div>
          <p
            class="mt-0.5 text-xs"
            :class="item.interpret ? toneClass(item.interpret.tone) : 'text-text-tertiary'"
          >
            {{ item.interpret ? `▸ ${item.interpret.text}` : BREADTH_INTERPRET_EMPTY }}
          </p>
        </li>
      </ul>
    </component>
  </div>
</template>
