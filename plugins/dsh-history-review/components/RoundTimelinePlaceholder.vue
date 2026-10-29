<script setup lang="ts">
import { BULL_CHART_HEIGHT_PX } from '../constants';

/**
 * 行情阶段图占位（首次同步未完成 / 窗口数据不足两根月 K 时）
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
    首次同步完成后渲染（正在拉取 {{ roundName }} 月K…）
  </div>
</template>
