<script setup lang="ts">
import { BULL_CHART_HEIGHT_PX } from '../constants';

/**
 * 行情阶段图占位（静态数据缺失 / 窗口数据不足两根周 K 时）
 */
defineProps<{
  /** 叠加指数名（文案用） */
  roundName: string;
}>();
</script>

<template>
  <div
    class="flex items-center justify-center rounded-lg bg-flat-weak text-xs text-text-secondary"
    :style="{ height: `${BULL_CHART_HEIGHT_PX}px` }"
  >
    静态数据加载后渲染（{{ roundName }} 周K…）
  </div>
</template>
