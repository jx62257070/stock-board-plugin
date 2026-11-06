<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { init } from 'echarts/core';

/**
 * ECharts 容器封装（宿主 BaseChart 的插件自包含版）
 *
 * - options 深度 watch 后 setOption 增量合并；数据整体更换的图传 notMerge 全量替换；
 * - ResizeObserver 自适应容器尺寸，卸载前 dispose 防泄漏；
 * - 明暗 / 主题色切换由消费方经 useChartThemeSignal 重算 options，这里只负责渲染；
 * - 旧宿主（< v1.16.0）运行时桥上没有 echarts：降级为占位文案。
 */
const props = defineProps<{
  /** ECharts 配置项（echarts/core 的精简类型） */
  options: EChartsCoreOption;
  /** 是否全量替换更新（setOption notMerge），默认增量合并 */
  notMerge?: boolean;
  /** ECharts 不可用时的占位文案 */
  fallbackText?: string;
}>();

/** 宿主桥上的 echarts/core（旧宿主解构兜底为空对象 → init 非函数 → 走降级） */
const echartsAvailable = typeof init === 'function';

/** 图表容器引用 */
const containerRef = ref<HTMLDivElement | null>(null);

/** ECharts 实例（挂载后创建，卸载前销毁） */
let chart: EChartsType | null = null;

/** 用当前 options 渲染（默认增量合并，notMerge 时全量替换） */
const render = (): void => {
  chart?.setOption(props.options, { notMerge: props.notMerge ?? false });
};

/** 容器尺寸变化时自适应 */
const resizeObserver = new ResizeObserver(() => {
  chart?.resize();
});

onMounted(() => {
  if (!echartsAvailable || !containerRef.value) {
    return;
  }
  chart = init(containerRef.value, undefined, { renderer: 'svg' });
  render();
  resizeObserver.observe(containerRef.value);
});

watch(
  () => props.options,
  () => render(),
  { deep: true },
);

onBeforeUnmount(() => {
  resizeObserver.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div v-if="echartsAvailable" ref="containerRef" class="h-full w-full" />
  <div
    v-else
    class="flex h-full w-full items-center justify-center text-xs text-text-tertiary"
  >
    {{ fallbackText ?? '图表需要升级宿主到 v1.16.0 及以上' }}
  </div>
</template>
