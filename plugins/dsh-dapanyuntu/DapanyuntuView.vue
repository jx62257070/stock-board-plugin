<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DAPANYUNTU_EMBED_URL,
  DAPANYUNTU_IFRAME_TITLE,
  DAPANYUNTU_NOTICE_TEXT,
  DAPANYUNTU_OPEN_SITE_LABEL,
  DAPANYUNTU_SITE_URL,
  HEATMAP_THEME_MESSAGE_SOURCE,
} from './constants';
import type { DapanyuntuDeps } from './types';

/**
 * 大盘云图页（自宿主内置页 HeatmapView.vue 迁移，2026-10-29 转插件分发）
 *
 * iframe 直嵌 dapanyuntu.com：第三方 Next.js 站点（Cloudflare 托管），
 * 响应头无 X-Frame-Options / CSP frame-ancestors，可被安全嵌入（2026-10-13 实测）；
 * 数据与交互全部由对方页面自管，本页不取数、不代理。
 * 顶部提示条声明内容来源并提供原站跳转入口（宿主 app:open-url 服务）。
 * 若对方日后加嵌入限制或 DNS 不可达，此处表现为空白/错误框——停用本插件即可。
 *
 * 主题跟随（2026-10-13 起）：跨域 iframe 无法由父页面直接注入脚本，依赖 Tauri 侧
 * initialization_script_for_all_frames 在第三方页面每个 document 创建时注入桥
 * （见宿主 src-tauri/src/lib.rs HEATMAP_THEME_INIT_SCRIPT，纯浏览器 dev / 移动端无此
 * 机制，postMessage 静默失效）。本页职责：
 * - 收到 iframe 的 ready 消息即回发当前主题（早于 load 完成首次同步）；
 * - iframe load 兜底重发一次（防 ready 消息早于本组件监听注册而丢失）；
 * - 宿主明暗切换时实时推送（经 deps.isDark 快照驱动）。
 * 协议消息两端约定 source = HEATMAP_THEME_MESSAGE_SOURCE，缺省直接丢弃。
 */

const props = defineProps<{
  /** 宿主能力依赖（主题快照 + 外链打开，见 types.ts） */
  deps: DapanyuntuDeps;
}>();

/** 当前是否暗色（宿主主题快照经 computed 转响应式，随宿主切换实时更新） */
const isDark = computed(() => props.deps.isDark());

const iframeRef = ref<HTMLIFrameElement | null>(null);

/** 把当前宿主主题推送给 iframe（contentWindow 未就绪时静默跳过） */
const syncIframeTheme = (): void => {
  const contentWindow = iframeRef.value?.contentWindow;
  if (!contentWindow) return;
  contentWindow.postMessage(
    { source: HEATMAP_THEME_MESSAGE_SOURCE, type: 'heatmap-theme', dark: isDark.value },
    '*',
  );
};

/**
 * iframe 注入脚本就绪信号：回发当前主题完成首次同步
 * @param event 宿主窗口收到的 postMessage 事件
 */
const onHostMessage = (event: MessageEvent): void => {
  const data = event.data as { source?: unknown; type?: unknown } | null;
  if (
    !data ||
    data.source !== HEATMAP_THEME_MESSAGE_SOURCE ||
    data.type !== 'heatmap-theme-ready' ||
    event.source !== iframeRef.value?.contentWindow
  ) {
    return;
  }
  syncIframeTheme();
};

/** 系统默认浏览器打开原站（宿主 app:open-url；服务缺席时按钮不渲染） */
const openSite = (): void => {
  props.deps.openExternal?.(DAPANYUNTU_SITE_URL);
};

window.addEventListener('message', onHostMessage);
watch(isDark, syncIframeTheme);
onBeforeUnmount(() => {
  window.removeEventListener('message', onHostMessage);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <!-- 来源提示条：声明第三方嵌入 + 原站跳转入口（对齐宿主 NoticeBar 视觉） -->
    <div
      class="flex shrink-0 items-start gap-2 rounded-lg bg-primary-weak px-3 py-2.5 text-xs leading-5 text-text-secondary"
      role="note"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
      <p class="min-w-0 flex-1">{{ DAPANYUNTU_NOTICE_TEXT }}</p>
      <button
        v-if="deps.openExternal"
        type="button"
        class="flex shrink-0 items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
        @click="openSite"
      >
        {{ DAPANYUNTU_OPEN_SITE_LABEL }}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3 w-3"
          aria-hidden="true"
        >
          <path d="m7 17 10-10" />
          <path d="M8 7h9v9" />
        </svg>
      </button>
    </div>

    <!-- 云图 iframe：撑满剩余高度；load 兜底重发主题（防 ready 消息早于监听注册丢失） -->
    <div class="min-h-0 flex-1 overflow-hidden rounded-xl border border-flat-weak bg-surface">
      <iframe
        ref="iframeRef"
        :src="DAPANYUNTU_EMBED_URL"
        :title="DAPANYUNTU_IFRAME_TITLE"
        class="h-full w-full border-0"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        allow="fullscreen"
        @load="syncIframeTheme"
      ></iframe>
    </div>
  </div>
</template>
