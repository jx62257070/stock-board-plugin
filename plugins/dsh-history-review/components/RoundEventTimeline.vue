<script setup lang="ts">
import type { ReviewEventCategory, ReviewEventKind, ReviewRoundEvent } from '../types';

/**
 * 事件时间线：催化 / 政策 / 冲击按时间排列，按五类标注（龙头动向 / 国内政策 /
 * 海外环境 / 资金情绪 / 产业业绩），并区分「预期（叙事启动）」与「落地（已兑现）」；
 * 重点看中军领涨与见顶、多杀多踩踏、政策与流动性拐点的先后次序。
 * 列表整体平铺不滚动，高度交给页面容器统一收管。
 */
defineProps<{
  /** 轮次事件列表（按时间先后） */
  events: readonly ReviewRoundEvent[];
}>();

/** 事件类别标签（完整类名静态写死，Tailwind 可扫描） */
const CATEGORY_TAG: Record<ReviewEventCategory, { text: string; class: string }> = {
  leader: { text: '龙头动向', class: 'bg-primary-weak text-primary' },
  policy: { text: '国内政策', class: 'bg-flat-weak text-text-secondary' },
  overseas: { text: '海外环境', class: 'bg-flat-weak text-text-secondary' },
  funds: { text: '资金情绪', class: 'bg-up-weak text-up' },
  sector: { text: '产业业绩', class: 'bg-down-weak text-down-strong' },
};

/** 事件口径标签（预期 / 落地） */
const KIND_TAG: Record<ReviewEventKind, { text: string; class: string }> = {
  expected: { text: '预期', class: 'bg-primary-weak text-primary' },
  landed: { text: '落地', class: 'bg-flat-weak text-text-secondary' },
};
</script>

<template>
  <ol class="list-none">
    <li
      v-for="event in events"
      :key="`${event.date}-${event.title}`"
      class="relative pb-3.5 pl-5 last:pb-0"
    >
      <span class="absolute left-1 top-2 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
      <span
        class="absolute bottom-0 left-[7px] top-4 w-px bg-flat-weak"
        aria-hidden="true"
      />
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-xs font-medium text-text-subtle">{{ event.date }}</span>
        <span
          class="rounded-full px-1.5 py-px text-[11px] font-medium"
          :class="CATEGORY_TAG[event.category].class"
        >
          {{ CATEGORY_TAG[event.category].text }}
        </span>
        <span class="text-sm text-text">{{ event.title }}</span>
      </div>
      <div class="mt-0.5 flex items-baseline gap-x-2 text-xs text-text-secondary">
        <span
          class="shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium"
          :class="KIND_TAG[event.kind].class"
        >
          {{ KIND_TAG[event.kind].text }}
        </span>
        <span>{{ event.detail }}</span>
      </div>
    </li>
  </ol>
</template>
