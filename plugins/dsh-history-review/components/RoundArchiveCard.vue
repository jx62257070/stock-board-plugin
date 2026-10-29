<script setup lang="ts">
import { computed } from 'vue';
import type { ReviewBearStats, ReviewRoundMeta, ReviewRoundStats } from '../types';

/**
 * 轮次档案卡：统计条（数字由 judge.ts 回算）+ 轮次标签 + 档案字段；
 * 牛市 / 熊市按 `mode` 切换统计口径与字段文案
 */
const props = withDefaults(
  defineProps<{
    /** 轮次档案 */
    round: ReviewRoundMeta;
    /** 该轮回算统计（数据未同步时为 null；牛市 / 熊市形态不同） */
    stats: ReviewRoundStats | ReviewBearStats | null;
    /** 行情方向（决定统计口径与文案） */
    mode?: 'bull' | 'bear';
  }>(),
  { mode: 'bull' },
);

/** 待同步占位文案 */
const PENDING_TEXT = '待同步';

/** 牛市统计条：区间 / 最大涨幅 / 最大回撤 / 至顶时长 / 叠加指数 */
const bullStatItems = computed(() => {
  const stats = props.stats as ReviewRoundStats | null;
  return [
    { label: '统计区间', value: props.round.span, class: 'text-text' },
    {
      label: '区间最大涨幅',
      value: stats ? `+${stats.gainPercent.toFixed(1)}%` : PENDING_TEXT,
      class: stats ? 'text-up' : 'text-text-secondary',
    },
    {
      label: '退潮最大回撤',
      value: stats ? `${stats.drawdownPercent.toFixed(1)}%` : PENDING_TEXT,
      class: stats ? 'text-down' : 'text-text-secondary',
    },
    {
      label: '至顶时长',
      value: stats ? `${stats.monthsToPeak} 个月` : PENDING_TEXT,
      class: 'text-text',
    },
    { label: '叠加指数', value: props.round.indexName, class: 'text-text' },
  ];
});

/** 熊市统计条：区间 / 最大跌幅 / 见底后最大反弹 / 下跌时长 / 叠加指数 */
const bearStatItems = computed(() => {
  const stats = props.stats as ReviewBearStats | null;
  return [
    { label: '统计区间', value: props.round.span, class: 'text-text' },
    {
      label: '区间最大跌幅',
      value: stats ? `${stats.drawdownPercent.toFixed(1)}%` : PENDING_TEXT,
      class: stats ? 'text-down' : 'text-text-secondary',
    },
    {
      label: '见底后最大反弹',
      value: stats ? `+${stats.bouncePercent.toFixed(1)}%` : PENDING_TEXT,
      class: stats ? 'text-up' : 'text-text-secondary',
    },
    {
      label: '下跌时长',
      value: stats ? `${stats.monthsToTrough} 个月` : PENDING_TEXT,
      class: 'text-text',
    },
    { label: '叠加指数', value: props.round.indexName, class: 'text-text' },
  ];
});

/** 统计条展示项（label + 值文案 + 值色类） */
const statItems = computed(() => (props.mode === 'bear' ? bearStatItems.value : bullStatItems.value));

/** 轮次类型之外的标签（形态 / 状态） */
const extraTags = computed(() => [
  {
    text: `${props.mode === 'bear' ? '触发方式' : '瓦解形态'}：${props.round.collapseLabel}`,
    class: 'bg-up-weak text-up',
  },
  { text: props.round.status, class: 'bg-flat-weak text-text-secondary' },
]);

/** 档案字段（label + 值） */
const metaItems = computed(() => [
  { label: props.mode === 'bear' ? '下跌主线' : '抱团主线', value: props.round.mainline },
  {
    label: props.mode === 'bear' ? '杀跌代表（固定成分池）' : '中军 / 二线（固定成分池）',
    value: props.round.midCaps,
  },
  { label: '市场大环境', value: props.round.macro },
  {
    label: props.mode === 'bear' ? '逆势结构行情' : '同期竞争主线',
    value: props.round.rival,
  },
]);
</script>

<template>
  <div>
    <!-- 统计条：全部数字来自月 K 回算 -->
    <div class="mb-3 grid grid-cols-2 gap-2 @xl:grid-cols-5">
      <div
        v-for="item in statItems"
        :key="item.label"
        class="rounded-lg bg-flat-weak px-3 py-2"
      >
        <div class="text-xs text-text-secondary">{{ item.label }}</div>
        <div class="text-base font-semibold" :class="item.class">{{ item.value }}</div>
      </div>
    </div>

    <div class="mb-3 flex flex-wrap gap-1.5">
      <span class="rounded-full bg-primary-weak px-2 py-0.5 text-xs font-medium text-primary">
        {{ round.roundType }}
      </span>
      <span
        v-for="tag in extraTags"
        :key="tag.text"
        class="rounded-full px-2 py-0.5 text-xs font-medium"
        :class="tag.class"
      >
        {{ tag.text }}
      </span>
    </div>

    <div class="grid gap-x-5 gap-y-2.5 @3xl:grid-cols-2">
      <div v-for="item in metaItems" :key="item.label">
        <div class="text-xs text-text-subtle">{{ item.label }}</div>
        <div class="text-sm text-text">{{ item.value }}</div>
      </div>
    </div>
  </div>
</template>
