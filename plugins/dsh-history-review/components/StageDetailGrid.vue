<script setup lang="ts">
import { computed } from 'vue';
import type { ReviewStageTone } from '../types';

/**
 * 阶段明细网格：每个阶段一张色底卡（与时间轴色带同色系），
 * 强调「指标在各阶段的演变」而非高潮单日读数；牛熊使用各自色板
 */
const props = withDefaults(
  defineProps<{
    /** 轮次的阶段拆解 */
    stages: readonly { name: string; start: string; end: string; tone: ReviewStageTone; desc: string }[];
    /** 行情方向（决定阶段色板） */
    mode?: 'bull' | 'bear';
  }>(),
  { mode: 'bull' },
);

/** 牛市阶段色调 → 卡片底色 + 标题色（完整类名静态写死，Tailwind 才能扫到） */
const BULL_STAGE_CARD_CLASS: Record<ReviewStageTone, { card: string; title: string }> = {
  s1: { card: 'bg-primary-weak', title: 'text-primary' },
  s2: { card: 'bg-up-weak', title: 'text-up-strong' },
  s3: { card: 'bg-up-pale', title: 'text-up-strong' },
  s4: { card: 'bg-down-weak', title: 'text-down-strong' },
};

/** 熊市阶段色调 → 卡片底色 + 标题色（初跌 / 反弹中继 / 主跌磨底 / 见底反转） */
const BEAR_STAGE_CARD_CLASS: Record<ReviewStageTone, { card: string; title: string }> = {
  s1: { card: 'bg-down-weak', title: 'text-down-strong' },
  s2: { card: 'bg-flat-weak', title: 'text-text-secondary' },
  s3: { card: 'bg-down-pale', title: 'text-down-strong' },
  s4: { card: 'bg-primary-weak', title: 'text-primary' },
};

/** 当前生效的色板 */
const stageClass = computed(() =>
  props.mode === 'bear' ? BEAR_STAGE_CARD_CLASS : BULL_STAGE_CARD_CLASS,
);
</script>

<template>
  <div class="grid grid-cols-1 gap-2 @3xl:grid-cols-4">
    <div
      v-for="stage in stages"
      :key="stage.name"
      class="rounded-lg px-3 py-2.5"
      :class="stageClass[stage.tone].card"
    >
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-sm font-semibold" :class="stageClass[stage.tone].title">
          {{ stage.name }}
        </span>
        <span class="text-xs text-text-secondary">{{ stage.start }} – {{ stage.end }}</span>
      </div>
      <div class="mt-1 text-xs text-text-secondary">{{ stage.desc }}</div>
    </div>
  </div>
</template>
