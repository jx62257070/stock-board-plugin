<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  QUICK_NOTE_MAX_LENGTH,
  type NoteStockRef,
  type QuickNote,
  type QuickNoteRepo,
} from './service';
import type { QuickNoteDeps } from './types';
import {
  QUICK_NOTE_BAR_ARCHIVE_LINK,
  QUICK_NOTE_BAR_PLACEHOLDER,
  QUICK_NOTE_REMOVE_ARIA,
  QUICK_NOTE_SECTION_EMPTY,
  QUICK_NOTE_SECTION_SAVE,
} from './constants';

/**
 * 个股详情扩展区 · 该股的速记（插件 dsh-quick-note 贡献）
 *
 * 经内核的「个股详情扩展区」贡献点挂到右侧个股详情面板底部，
 * 宿主只传当前股票符号；本组件消费插件自己的 note:repo，
 * 展示关联了这只股票的速记，并支持就地追加（自动带上关联）。
 *
 * v1.2.0：就地追加的输入区改为**悬浮速记条** —— 它经 `position: fixed`
 * 贴住个股详情面板（`aside.dock-panel`）的底缘，打开详情即可见，
 * 不用再滚到面板最底部才能记一笔；下方的归档列表保持原位，
 * 悬浮条上的「查看」按钮一键滚过去。
 *
 * 定位不走 Teleport / 不碰宿主 DOM 结构：组件就挂在面板内容里，
 * 从根元素 `closest('.dock-panel')` 拿到面板矩形，`fixed` 对齐即可
 * （dock 拖宽 / 窗口缩放经 ResizeObserver + resize 监听实时跟随）。
 * 布局关键属性全部走内联样式 —— 第三方产物形态下写不了宿主没有的
 * Tailwind 类，内联是唯一稳妥的承载。
 *
 * 宿主依赖全部来自 `deps`（见 `types.ts`）：本插件以单文件产物分发，
 * 运行时没有 import 可用 —— UI 组件、格式化、自选股查名、行情兜底一律走注入。
 */
const props = defineProps<{
  /** 当前股票符号（宿主已归一化为完整形态，如 sh600519） */
  symbol: string;
  /** 速记仓储（插件在注册扩展区时经 props 注入自己的服务实现） */
  repo: QuickNoteRepo;
  /** 宿主能力容器（插件在 apply 里从 ctx 取齐后注入） */
  deps: QuickNoteDeps;
}>();

/** 悬浮条与面板边缘的内边距（与面板内容的 p-3 同口径） */
const BAR_INSET_PX = 12;

/** 悬浮条层级（盖过面板内的卡片，但低于宿主弹窗层） */
const BAR_Z_INDEX = 30;

/** 输入框自适应高度上限（超出后内部滚动） */
const BAR_INPUT_MAX_HEIGHT_PX = 120;

/** 就地输入的草稿 */
const draft = ref('');

/** 悬浮条的输入框（自适应高度用） */
const draftEl = ref<HTMLTextAreaElement | null>(null);

/** 组件根元素（向上找宿主面板的起点） */
const rootEl = ref<HTMLElement | null>(null);

/** 归档列表容器（悬浮条「查看」按钮的滚动目标） */
const archiveEl = ref<HTMLElement | null>(null);

/** 悬浮条定位样式（挂载测量后填充；未就绪前先隐藏避免闪跳） */
const barStyle = ref<Record<string, string>>({ position: 'fixed', visibility: 'hidden' });

/** 关联了当前股票的速记（新的在前，响应式） */
const notes = computed<readonly QuickNote[]>(() => props.repo.listBySymbol(props.symbol));

/** 悬浮条上的归档入口文案（条数随增删实时变） */
const archiveLinkText = computed(() =>
  QUICK_NOTE_BAR_ARCHIVE_LINK.replace('{n}', String(notes.value.length)),
);

/**
 * 解析当前股票的名称（落库用，速记面板的关联标签读它展示）
 *
 * 自选股里有就直接取（零请求）；不在自选里才向行情源取一次快照兜底 ——
 * 名称只在这一次保存时用得上，取不到就退回符号，绝不因为改名失败而丢笔记。
 * @returns 股票名称（兜底为完整符号）
 */
const resolveStockName = async (): Promise<string> => {
  const fromWatchlist = props.deps.watchlist.nameOf(props.symbol);
  if (fromWatchlist) return fromWatchlist;
  try {
    const [quote] = await props.deps.quotes.fetchFullQuotes([props.symbol]);
    if (quote?.name) return quote.name;
  } catch {
    // 名称是展示信息，取不到就用符号，不打断保存
  }
  return props.symbol;
};

/**
 * 保存草稿：自动关联当前股票
 *
 * 先清空草稿（手感即时），名称异步补齐 —— 用户不会感知到那一次查名请求；
 * 保存后焦点留在输入框，方便连着记几笔。
 */
const onSave = async (): Promise<void> => {
  const text = draft.value;
  if (!text.trim()) return;
  draft.value = '';
  const name = await resolveStockName();
  const stock: NoteStockRef = { symbol: props.symbol, name };
  props.repo.create(text, stock);
  draftEl.value?.focus();
};

/**
 * 输入框自适应高度：内容一行时贴成细条，多行时向上生长到上限
 */
const autoGrow = (): void => {
  const el = draftEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, BAR_INPUT_MAX_HEIGHT_PX)}px`;
};

watch(draft, () => void nextTick(autoGrow));

/**
 * 编辑区快捷键：Enter 保存，Shift + Enter 换行
 * @param event 键盘事件
 */
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void onSave();
};

/**
 * 删除一条速记
 * @param id 速记 id
 */
const onRemove = (id: string): void => {
  props.repo.remove(id);
};

/**
 * 相对时间（`3分钟前` / `昨天` / `9-18`）
 * @param timestamp 毫秒时间戳
 * @returns 相对时间文案
 */
const relativeTime = (timestamp: number): string => props.deps.format.relativeTime(timestamp);

// ---------- 悬浮定位：贴住个股详情面板（aside.dock-panel）的底缘 ----------

/** 找到的宿主面板元素（mounted 时解析，找不到则放弃悬浮降级为流内布局） */
let panelEl: HTMLElement | null = null;

/** 面板尺寸监听（dock 拖宽时跟随重排） */
let resizeObserver: ResizeObserver | null = null;

/**
 * 按面板当前矩形重算悬浮条的 fixed 定位
 */
const syncBarStyle = (): void => {
  if (!panelEl) return;
  const rect = panelEl.getBoundingClientRect();
  barStyle.value = {
    position: 'fixed',
    visibility: 'visible',
    right: `${Math.max(window.innerWidth - rect.right, 0) + BAR_INSET_PX}px`,
    bottom: `${Math.max(window.innerHeight - rect.bottom, 0) + BAR_INSET_PX}px`,
    width: `${Math.max(rect.width - BAR_INSET_PX * 2, 0)}px`,
    zIndex: String(BAR_Z_INDEX),
  };
};

/**
 * 窗口缩放与面板拖宽共用的重算入口
 * @returns 无返回值
 */
const onViewportChange = (): void => syncBarStyle();

onMounted(() => {
  panelEl = rootEl.value?.closest('.dock-panel') ?? rootEl.value?.closest('aside') ?? null;
  if (!panelEl) {
    // 理论上不会发生（宿主面板永远在）：放弃悬浮，回落为扩展区原位的流内输入条
    barStyle.value = {};
    return;
  }
  syncBarStyle();
  resizeObserver = new ResizeObserver(onViewportChange);
  resizeObserver.observe(panelEl);
  window.addEventListener('resize', onViewportChange);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', onViewportChange);
});

/**
 * 滚到下方的归档列表（悬浮条上的「查看」入口）
 */
const scrollToArchive = (): void => {
  archiveEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
</script>

<template>
  <div ref="rootEl" class="space-y-3">
    <!-- 悬浮速记条：fixed 贴住详情面板底部，打开详情即可随手记 -->
    <div
      class="rounded-card border border-flat-weak bg-surface px-2.5 py-2"
      :style="{ ...barStyle, boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)' }"
    >
      <div class="flex items-end gap-2">
        <textarea
          ref="draftEl"
          v-model="draft"
          :maxlength="QUICK_NOTE_MAX_LENGTH"
          rows="1"
          :placeholder="QUICK_NOTE_BAR_PLACEHOLDER"
          :style="{ resize: 'none' }"
          class="w-full rounded-card border border-flat-weak bg-surface px-2.5 py-2 text-sm text-text placeholder:text-text-tertiary focus:border-primary focus:outline-none"
          @keydown="onKeydown"
        />
        <component
          :is="deps.ui.Button"
          variant="primary"
          :disabled="draft.trim().length === 0"
          @click="onSave"
        >
          {{ QUICK_NOTE_SECTION_SAVE }}
        </component>
      </div>
      <button
        v-if="notes.length > 0"
        type="button"
        class="pressable mt-1 rounded p-0.5 text-xs text-text-tertiary hover:text-text"
        @click="scrollToArchive"
      >
        {{ archiveLinkText }}
      </button>
    </div>

    <!-- 归档列表：该股全部速记（浏览 / 删除；输入在上方悬浮条完成） -->
    <div ref="archiveEl" class="space-y-2">
      <component :is="deps.ui.Empty" v-if="notes.length === 0" :text="QUICK_NOTE_SECTION_EMPTY" />
      <ul v-else class="space-y-2">
        <li
          v-for="note in notes"
          :key="note.id"
          class="group rounded-card border border-flat-weak px-3 py-2"
        >
          <p class="whitespace-pre-wrap break-words text-sm text-text">{{ note.text }}</p>
          <div class="mt-1 flex items-center justify-between gap-2">
            <span class="text-xs text-text-tertiary">
              {{ relativeTime(note.createdAt) }}
            </span>
            <button
              type="button"
              class="pressable rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-flat-weak hover:text-text group-hover:opacity-100 active:scale-90"
              :aria-label="QUICK_NOTE_REMOVE_ARIA"
              @click="onRemove(note.id)"
            >
              <component :is="deps.ui.Icon" name="trash" :size="12" />
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
