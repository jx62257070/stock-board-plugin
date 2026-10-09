<script setup lang="ts">
import { ref } from 'vue';
import BasicScreener from './BasicScreener.vue';
import EodPicker from './EodPicker.vue';
import SignalScanner from './SignalScanner.vue';
import {
  SCREENER_TAB_BASIC,
  SCREENER_TAB_SCANNER,
  SCREENER_TOOL_TABS,
} from './constants';
import type { ScreenerDeps, ScreenerRuntime } from './types';

/**
 * 选股器：三种选股工具 tab 切换
 *
 * - 基础筛选：条件筛选（涨幅/换手/量比/PE）+ 简单回测
 * - 信号扫描：股票池（自选/板块/榜单/股池/异动）× 技术信号模板（MA/MACD/RSI/BOLL）
 * - 尾盘选股：全市场按市值/量比/涨幅/换手过滤后按分时强度精筛
 *
 * 全部为重接口，均由用户点击触发，不做轮询。
 * 与宿主内置版的差异：tab 显隐 / 顺序不再走宿主的页签配置
 * （那是宿主 store 的能力，插件不写宿主状态），固定三页平铺。
 */
defineProps<{
  /** 宿主能力（由插件在 apply 里从 ctx 取齐后随页面 props 下发） */
  deps: ScreenerDeps;
  /** 插件取数运行时（SDK 单例 + 日 K 会话缓存） */
  runtime: ScreenerRuntime;
}>();

/** 当前工具 tab */
const activeTool = ref<string>(SCREENER_TAB_BASIC);
</script>

<template>
  <div class="space-y-4">
    <component
      :is="deps.ui.Tabs"
      v-model="activeTool"
      :options="[...SCREENER_TOOL_TABS]"
      variant="underline"
    />

    <BasicScreener v-if="activeTool === SCREENER_TAB_BASIC" :deps="deps" :runtime="runtime" />
    <SignalScanner v-else-if="activeTool === SCREENER_TAB_SCANNER" :deps="deps" :runtime="runtime" />
    <EodPicker v-else :deps="deps" :runtime="runtime" />
  </div>
</template>
