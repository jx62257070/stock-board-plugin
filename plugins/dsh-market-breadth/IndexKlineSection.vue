<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import IndexKlineCard from './IndexKlineCard.vue';
import {
  INDEX_KLINE_ITEMS,
  INDEX_KLINE_POLL_MS,
  INDEX_KLINE_VIEW,
  INDEX_KLINE_VIEW_OPTIONS,
} from './constants';
import type { IndexKlineViewKey } from './constants';
import type { BreadthDeps, BreadthRuntime } from './types';

/**
 * 「大盘指数」区块（市场宽度页顶部）：上证 / 深证成指 / 创业板指 / 科创50
 * 四张 K 线卡（2×2 网格，窄屏降 1 列），形态对齐宿主宽基 ETF 股票模块。
 *
 * - 全页统一 分时 / 日K 切换（右上角 Tabs，卡片随模式重建）；
 * - 盘中 60s 自增刷新 tick（isIntraday 门控，交易窗口外暂停），卡片按需重拉；
 * - 数据为上游轻量单标的请求，不落本地库。
 */
const props = defineProps<{
  /** 取数运行时（指数 K 线 fetcher） */
  runtime: BreadthRuntime;
  /** 宿主能力（盘中判定 / UI Kit） */
  deps: BreadthDeps;
}>();

/** 图表模式（分时 / 日K，全页统一；默认分时） */
const viewMode = ref<IndexKlineViewKey>(INDEX_KLINE_VIEW.MINUTE);

/** 盘中刷新 tick（自增驱动各卡重拉） */
const tick = ref(0);

/** 刷新定时器句柄（卸载时清理） */
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  pollTimer = setInterval(() => {
    if (props.deps.isIntraday()) tick.value += 1;
  }, INDEX_KLINE_POLL_MS);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<template>
  <component :is="deps.ui.Card" title="大盘指数">
    <template #extra>
      <component
        :is="deps.ui.Tabs"
        v-model="viewMode"
        :options="INDEX_KLINE_VIEW_OPTIONS"
        aria-label="指数图表模式"
      />
    </template>

    <div class="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
      <IndexKlineCard
        v-for="item in INDEX_KLINE_ITEMS"
        :key="item.symbol"
        :item="item"
        :mode="viewMode"
        :tick="tick"
        :runtime="runtime"
      />
    </div>
  </component>
</template>
