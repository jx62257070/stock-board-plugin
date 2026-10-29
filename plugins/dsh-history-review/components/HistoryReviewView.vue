<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import type { ReviewDeps, ReviewRuntime } from '../deps';
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
import {
  BULL_VIEW_TABS,
  BULL_VIEW_TAB_DEFAULT,
  BULL_VIEW_TAB_LIBRARY,
} from '../constants';
import type { ReviewRoundMeta, ReviewStageTone } from '../types';

/**
 * 历史牛熊复盘 · 根视图（历史牛市 / 历史熊市 / 模式库）
 *
 * - 首次进入（存储为空）自动低频拉取各指数月 K（串行 + 500ms 错峰）写插件 storage，
 *   此后读快照渲染零联网；「更新到最新」手动增量刷新；
 * - 全部数字由 `judge.ts` 从月 K 回算，文案为定性复盘观点；
 * - 卡片 / 页签 / 按钮消费宿主 `app:ui`（deps.ui），行情图为 SVG 手绘（SvgTimelineChart）。
 */
const props = defineProps<{
  /** 宿主能力依赖（app:ui） */
  deps: ReviewDeps;
  /** 数据运行时（repo / 批量取数 / storage，plugin.ts 组装） */
  runtime: ReviewRuntime;
}>();

/** 牛市默认展示的轮次（核心资产·白酒抱团：C 类样本最完整） */
const BULL_DEFAULT_ROUND_ID = 'core-asset';

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

/** 正在同步 */
const syncing = ref(false);

/** 同步失败信息（空串 = 无错误） */
const syncError = ref('');

/** 同步进度文案（空串 = 不展示） */
const progressText = ref('');

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

/** 当前快照（响应式：同步落库后自动更新） */
const snapshot = computed(() => props.runtime.repo.snapshot());

/** 最近同步时间的展示文案 */
const syncedAtText = computed(() =>
  snapshot.value.syncedAt === null
    ? '未同步'
    : dayjs(snapshot.value.syncedAt).format('YYYY-MM-DD HH:mm'),
);

/** 当前轮次的指数月 K */
const activeBars = computed(() =>
  activeRound.value ? (snapshot.value.series[activeRound.value.indexSymbol] ?? []) : [],
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

/**
 * 执行一次全量同步（拉取全部指数月 K 并落库；串行错峰，失败不中断已完成的指数）
 */
const runSync = async (): Promise<void> => {
  if (syncing.value) return;
  syncing.value = true;
  syncError.value = '';
  try {
    const series = await props.runtime.fetchAllMonthlies((done, total, name) => {
      progressText.value = `拉取 ${name}（${done + 1}/${total}）`;
    });
    const bars: Record<string, number> = {};
    for (const [symbol, list] of Object.entries(series)) bars[symbol] = list.length;
    await props.runtime.repo.saveSync(series, { syncedAt: Date.now(), bars });
  } catch (error) {
    syncError.value = error instanceof Error ? error.message : String(error);
  } finally {
    syncing.value = false;
    progressText.value = '';
  }
};

onMounted(() => {
  // 库空才自动首拉；此后重进页面读库零联网
  if (props.runtime.repo.snapshot().syncedAt === null) void runSync();
});
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
      <div class="ml-auto flex items-center gap-2">
        <span v-if="syncing" class="text-xs text-text-secondary">{{ progressText || '同步中…' }}</span>
        <span v-else class="text-xs text-text-subtle">月K更新于 {{ syncedAtText }}</span>
        <component
          :is="deps.ui.Button"
          variant="ghost"
          :disabled="syncing"
          @click="runSync"
        >
          更新到最新
        </component>
      </div>
    </div>

    <p
      v-if="syncError"
      class="rounded-lg bg-up-weak px-3 py-2 text-xs text-up"
    >
      同步失败：{{ syncError }}（网络恢复后可再次点击「更新到最新」）
    </p>

    <ModeLibraryView
      v-if="marketTab === BULL_VIEW_TAB_LIBRARY"
      :deps="deps"
      :bull-rounds="BULL_ROUNDS"
      :bear-rounds="BEAR_ROUNDS"
      :series="snapshot.series"
    />

    <template v-else-if="activeRound">
      <component :is="deps.ui.Card">
        <RoundArchiveCard :round="activeRound" :stats="activeStats" :mode="mode" />
      </component>

      <component :is="deps.ui.Card" :title="`行情阶段 · ${activeRound.indexName}月K`">
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
          色带为复盘档案声明的阶段区间；顶 / 底与涨跌幅度由 judge.ts 从月K回算，关键位月份以数据为准。
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
      不能预测崩盘或见底的具体时点；月K来自新浪源，落插件本地存储，重进页面不联网。
    </p>
  </div>
</template>
