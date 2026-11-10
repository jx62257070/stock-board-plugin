<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReviewDeps } from '../deps';
import CollapseReviewCard from './CollapseReviewCard.vue';
import ModeLibraryView from './ModeLibraryView.vue';
import RoundArchiveCard from './RoundArchiveCard.vue';
import RoundEventTimeline from './RoundEventTimeline.vue';
import RoundTimelinePlaceholder from './RoundTimelinePlaceholder.vue';
import StageDetailGrid from './StageDetailGrid.vue';
import SvgTimelineChart from './SvgTimelineChart.vue';
import { buildBearStats, buildRoundStats } from '../judge';
import { BULL_ROUNDS } from '../rounds';
import { BEAR_ROUNDS } from '../bears';
import { WEEKLY_SERIES } from '../weekly-data';
import {
  BULL_VIEW_TABS,
  BULL_VIEW_TAB_DEFAULT,
  BULL_VIEW_TAB_LIBRARY,
} from '../constants';
import type { ReviewRoundMeta, ReviewStageTone } from '../types';

/**
 * 历史牛熊复盘 · 根视图（历史牛市 / 历史熊市 / 模式库）
 *
 * - 行情数据为随插件打包的静态周 K（weekly-data.ts，零请求零存储）；
 * - 全部数字由 `judge.ts` 从周 K 回算，文案为定性复盘观点；
 * - 卡片 / 页签 / 按钮消费宿主 `app:ui`（deps.ui），行情图为 ECharts（SvgTimelineChart）。
 */
defineProps<{
  /** 宿主能力依赖（app:ui） */
  deps: ReviewDeps;
}>();

/** 牛市默认展示的轮次（本轮科技 AI 抱团：最新一轮，复盘参考价值最高） */
const BULL_DEFAULT_ROUND_ID = 'ai-tech';

/** 熊市默认展示的轮次（国有股减持大熊市：第一轮制度熊） */
const BEAR_DEFAULT_ROUND_ID = 'state-share-bear';

/** 阶段色调 → 图例色点（按行情方向取用；完整类名静态写死，Tailwind 可扫描） */
const TONE_DOT_CLASS: Record<'bull' | 'bear', Record<ReviewStageTone, string>> = {
  bull: {
    s1: 'bg-primary-weak',
    s2: 'bg-up-weak',
    s3: 'bg-up-pale',
    s4: 'bg-down-weak',
  },
  bear: {
    s1: 'bg-down-weak',
    s2: 'bg-flat-weak',
    s3: 'bg-down-pale',
    s4: 'bg-primary-weak',
  },
};

/** 顶层页签：牛市 / 熊市 / 模式库 */
const marketTab = ref<string>(BULL_VIEW_TAB_DEFAULT);

/** 牛市轮次页签 */
const activeBullRoundId = ref<string>(BULL_DEFAULT_ROUND_ID);

/** 熊市轮次页签 */
const activeBearRoundId = ref<string>(BEAR_DEFAULT_ROUND_ID);

/** 当前行情方向（模式库页签沿用上次方向，仅用于图例与口径） */
const mode = computed<'bull' | 'bear'>(() => (marketTab.value === 'bear' ? 'bear' : 'bull'));

/** 当前行情的轮次清单 */
const activeRounds = computed<readonly ReviewRoundMeta[]>(() =>
  mode.value === 'bear' ? BEAR_ROUNDS : BULL_ROUNDS,
);

/** 轮次页签选项（牛市 / 熊市各自的轮次列表） */
const roundTabOptions = computed(() =>
  activeRounds.value.map((round) => ({ label: round.name, value: round.id })),
);

/** 当前轮次档案 */
const activeRound = computed(() => {
  const id = mode.value === 'bear' ? activeBearRoundId.value : activeBullRoundId.value;
  return activeRounds.value.find((round) => round.id === id);
});

/** 轮次页签的双向绑定（按行情方向写入各自的轮次 id，互不串扰） */
const activeRoundId = computed<string>({
  get: () => (mode.value === 'bear' ? activeBearRoundId.value : activeBullRoundId.value),
  set: (value) => {
    if (mode.value === 'bear') activeBearRoundId.value = value;
    else activeBullRoundId.value = value;
  },
});

/** 当前轮次的指数周 K（静态数据直读） */
const activeBars = computed(() =>
  activeRound.value ? (WEEKLY_SERIES[activeRound.value.indexSymbol] ?? []) : [],
);

/** 当前轮次的回算统计（牛 / 熊各自口径） */
const activeStats = computed(() => {
  if (!activeRound.value) return null;
  return mode.value === 'bear'
    ? buildBearStats(activeBars.value, activeRound.value)
    : buildRoundStats(activeBars.value, activeRound.value);
});

/** 当前阶段图例（取自轮次的阶段拆解，色点按方向映射） */
const stageLegend = computed(() =>
  (activeRound.value?.stages ?? []).map((stage) => ({
    name: stage.name,
    dot: TONE_DOT_CLASS[mode.value][stage.tone],
  })),
);
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <component :is="deps.ui.Tabs" v-model="marketTab" :options="BULL_VIEW_TABS" />
      <component
        :is="deps.ui.Tabs"
        v-if="marketTab !== BULL_VIEW_TAB_LIBRARY"
        v-model="activeRoundId"
        :options="roundTabOptions"
      />
    </div>

    <ModeLibraryView
      v-if="marketTab === BULL_VIEW_TAB_LIBRARY"
      :deps="deps"
      :bull-rounds="BULL_ROUNDS"
      :bear-rounds="BEAR_ROUNDS"
      :series="WEEKLY_SERIES"
    />

    <template v-else-if="activeRound">
      <component :is="deps.ui.Card">
        <RoundArchiveCard :round="activeRound" :stats="activeStats" :mode="mode" />
      </component>

      <component :is="deps.ui.Card" :title="`行情阶段 · ${activeRound.indexName}周K`">
        <template #extra>
          <div class="flex items-center gap-3 text-xs text-text-secondary">
            <span v-for="legend in stageLegend" :key="legend.name" class="flex items-center gap-1">
              <i class="inline-block h-2.5 w-2.5 rounded-sm" :class="legend.dot" aria-hidden="true" />
              {{ legend.name }}
            </span>
          </div>
        </template>
        <SvgTimelineChart v-if="activeBars.length >= 2" :round="activeRound" :bars="activeBars" :mode="mode" />
        <RoundTimelinePlaceholder v-else :round-name="activeRound.indexName" />
        <p class="mt-2 text-xs text-text-subtle">
          色带为复盘档案声明的阶段区间；顶 / 底与涨跌幅度由 judge.ts 从周K回算（静态数据，随插件版本更新）。
        </p>
      </component>

      <component :is="deps.ui.Card" title="阶段明细">
        <template #extra>
          <span class="text-xs text-text-subtle">重点看各阶段的「演变」，而非单日读数</span>
        </template>
        <StageDetailGrid :stages="activeRound.stages" :mode="mode" />
      </component>

      <div class="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        <component :is="deps.ui.Card" title="消息面 · 事件时间线">
          <template #extra>
            <span class="text-xs text-text-subtle">五类标注 · 区分「预期 / 落地」</span>
          </template>
          <RoundEventTimeline :events="activeRound.events" />
        </component>
        <component :is="deps.ui.Card" :title="mode === 'bear' ? '见底 & 出清复盘' : '见顶 & 瓦解复盘'">
          <template #extra>
            <span class="text-xs text-text-subtle">{{ mode === 'bear' ? '出清信号画像' : '多因子错配画像' }}</span>
          </template>
          <CollapseReviewCard
            :mismatch="activeRound.mismatch"
            :review="activeRound.review"
            :collapse-label="activeRound.collapseLabel"
          />
        </component>
      </div>
    </template>

    <p class="rounded-lg bg-flat-weak px-3 py-2 text-xs leading-relaxed text-text-secondary">
      复盘观点仅供参考，不构成投资建议。本页定位是沉淀历史模式用于对标：能识别「已确认的退潮 / 见底」，
      不能预测崩盘或见底的具体时点；周K为随插件打包的静态数据（腾讯源），不联网、进行中轮次随插件版本更新。
    </p>
  </div>
</template>
