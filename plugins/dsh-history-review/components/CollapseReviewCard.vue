<script setup lang="ts">
import type { ReviewMismatch } from '../types';

/**
 * 见顶 & 瓦解复盘卡：多因子错配画像（背离 = 鱼尾信号）+ 定性解读
 *
 * 复盘框架的落点：各维度互相背离（资金已走、舆论仍多、散户狂热）即高风险鱼尾区，
 * 但**不能预测崩盘时点**——卡片内不做任何时点暗示。
 */
defineProps<{
  /** 错配画像（维度 × 是否背离） */
  mismatch: readonly ReviewMismatch[];
  /** 定性解读段落 */
  review: string;
  /** 瓦解形态标签（A / B / C 类） */
  collapseLabel: string;
}>();

/**
 * 维度状态标签（背离 = 鱼尾信号 / 平淡）
 * @param diverged 该维度是否与其他维度背离
 * @returns 标签文案与样式类
 */
const stateTag = (diverged: boolean): { text: string; class: string } =>
  diverged
    ? { text: '背离', class: 'bg-up-weak text-up' }
    : { text: '平淡', class: 'bg-flat-weak text-text-secondary' };
</script>

<template>
  <div>
    <ul class="flex list-none flex-col gap-2 p-0">
      <li v-for="item in mismatch" :key="item.dimension" class="flex items-center gap-2">
        <span
          class="rounded-full px-2 py-px text-xs font-medium"
          :class="stateTag(item.diverged).class"
        >
          {{ stateTag(item.diverged).text }}
        </span>
        <span class="text-sm text-text">{{ item.dimension }}</span>
      </li>
    </ul>
    <p class="mt-3 text-[13px] leading-relaxed text-text-secondary">
      {{ collapseLabel }} — {{ review }}
    </p>
  </div>
</template>
