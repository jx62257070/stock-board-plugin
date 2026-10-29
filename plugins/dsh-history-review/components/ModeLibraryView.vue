<script setup lang="ts">
import { computed } from 'vue';
import type { TableColumn } from '../../../host/types/table.types';
import type { ReviewDeps } from '../deps';
import { BULL_BOARD_CAPABILITY, BULL_PATTERNS } from '../rounds';
import { BEAR_PATTERNS } from '../bears';
import { buildBearStats, buildRoundStats } from '../judge';
import { BULL_TABLE_MIN_WIDTH } from '../constants';
import type {
  MonthlyBar,
  ReviewBearStats,
  ReviewRoundMeta,
  ReviewRoundStats,
} from '../types';

/**
 * 全景模式库：牛 / 熊七轮横向对比表 + 可复用规律卡 + 四轮看板预警能力对比。
 * 涨幅 / 回撤由月 K 回算；定性结论来自 rounds.ts / bears.ts 的复盘框架沉淀。
 * 卡片与表格消费宿主 `app:ui`（deps.ui），与原生页面同风格。
 */
const props = defineProps<{
  /** 宿主能力依赖（app:ui） */
  deps: ReviewDeps;
  /** 牛市轮次档案 */
  bullRounds: readonly ReviewRoundMeta[];
  /** 熊市轮次档案 */
  bearRounds: readonly ReviewRoundMeta[];
  /** symbol → 月 K 序列（未同步的指数缺失时该行统计显示待同步） */
  series: Record<string, MonthlyBar[]>;
}>();

/** 牛市对比表行：轮次档案 + 回算统计 */
interface BullCompareRow extends ReviewRoundMeta {
  /** 回算统计（未同步为 null） */
  stats: ReviewRoundStats | null;
}

/** 熊市对比表行：轮次档案 + 回算统计 */
interface BearCompareRow extends ReviewRoundMeta {
  /** 回算统计（未同步为 null） */
  stats: ReviewBearStats | null;
}

/** 待同步占位文案 */
const PENDING_TEXT = '待同步';

/** 牛市对比表行数据（每轮的统计即时回算） */
const bullRows = computed<BullCompareRow[]>(() =>
  props.bullRounds.map((round) => ({
    ...round,
    stats: buildRoundStats(props.series[round.indexSymbol] ?? [], round),
  })),
);

/** 熊市对比表行数据（每轮的统计即时回算） */
const bearRows = computed<BearCompareRow[]>(() =>
  props.bearRounds.map((round) => ({
    ...round,
    stats: buildBearStats(props.series[round.indexSymbol] ?? [], round),
  })),
);

/** 牛市对比表列配置 */
const bullColumns: TableColumn<BullCompareRow>[] = [
  { key: 'short', label: '轮次', sortable: true, sortValue: (row) => row.window.start },
  { key: 'span', label: '统计区间' },
  { key: 'mainline', label: '抱团主线' },
  {
    key: 'gain',
    label: '区间最大涨幅',
    align: 'right',
    sortable: true,
    sortValue: (row) => row.stats?.gainPercent ?? null,
  },
  {
    key: 'drawdown',
    label: '退潮最大回撤',
    align: 'right',
    sortable: true,
    sortValue: (row) => row.stats?.drawdownPercent ?? null,
  },
  { key: 'collapseLabel', label: '形态' },
  { key: 'trigger', label: '瓦解触发' },
];

/** 熊市对比表列配置 */
const bearColumns: TableColumn<BearCompareRow>[] = [
  { key: 'short', label: '轮次', sortable: true, sortValue: (row) => row.window.start },
  { key: 'span', label: '统计区间' },
  { key: 'mainline', label: '下跌主线' },
  {
    key: 'drawdown',
    label: '区间最大跌幅',
    align: 'right',
    sortable: true,
    sortValue: (row) => row.stats?.drawdownPercent ?? null,
  },
  {
    key: 'bounce',
    label: '见底后最大反弹',
    align: 'right',
    sortable: true,
    sortValue: (row) => row.stats?.bouncePercent ?? null,
  },
  { key: 'collapseLabel', label: '杀法' },
  { key: 'trigger', label: '触发与出清' },
];

/** 能力对比表的行（直接复用档案结构） */
const capabilityRows = BULL_BOARD_CAPABILITY;

/** 能力对比行类型（模板插槽签名用；模板里写 typeof 下标会卡解析） */
type CapabilityRow = (typeof BULL_BOARD_CAPABILITY)[number];

/** 能力对比表列配置 */
const capabilityColumns: TableColumn<CapabilityRow>[] = [
  { key: 'round', label: '抱团行情' },
  { key: 'ability', label: '看板预警能力' },
  { key: 'weakness', label: '核心短板' },
  { key: 'leadingSignal', label: '真正领先信号' },
];

/**
 * 牛市涨幅文案（带正号）
 * @param row 对比行
 * @returns 文案
 */
const gainText = (row: BullCompareRow): string =>
  row.stats ? `+${row.stats.gainPercent.toFixed(1)}%` : PENDING_TEXT;

/**
 * 回撤文案（负值）
 * @param row 对比行（牛 / 熊通用的 drawdown 字段）
 * @returns 文案
 */
const drawdownText = (row: BullCompareRow | BearCompareRow): string =>
  row.stats ? `${row.stats.drawdownPercent.toFixed(1)}%` : PENDING_TEXT;

/**
 * 熊市见底后反弹文案（带正号）
 * @param row 熊市对比行
 * @returns 文案
 */
const bounceText = (row: BearCompareRow): string =>
  row.stats ? `+${row.stats.bouncePercent.toFixed(1)}%` : PENDING_TEXT;
</script>

<template>
  <div class="flex flex-col gap-3">
    <component :is="deps.ui.Card" title="七轮抱团牛市 · 横向对比">
      <template #extra>
        <span class="text-xs text-text-subtle">涨幅 / 回撤由月 K 回算</span>
      </template>
      <component
        :is="deps.ui.Table"
        :columns="bullColumns"
        :rows="bullRows"
        :row-key="(row: BullCompareRow) => row.id"
        :min-width="BULL_TABLE_MIN_WIDTH"
        scroll-class="table-scroll-sm"
      >
        <template #short="{ row }: { row: BullCompareRow }">
          <span class="font-medium text-text">{{ row.name }}</span>
        </template>
        <template #gain="{ row }: { row: BullCompareRow }">
          <span class="font-semibold" :class="row.stats ? 'text-up' : 'text-text-secondary'">
            {{ gainText(row) }}
          </span>
        </template>
        <template #drawdown="{ row }: { row: BullCompareRow }">
          <span class="font-semibold" :class="row.stats ? 'text-down' : 'text-text-secondary'">
            {{ drawdownText(row) }}
          </span>
        </template>
      </component>
    </component>

    <component :is="deps.ui.Card" title="七轮大级别熊市 · 横向对比">
      <template #extra>
        <span class="text-xs text-text-subtle">跌幅 / 反弹由月 K 回算</span>
      </template>
      <component
        :is="deps.ui.Table"
        :columns="bearColumns"
        :rows="bearRows"
        :row-key="(row: BearCompareRow) => row.id"
        :min-width="BULL_TABLE_MIN_WIDTH"
        scroll-class="table-scroll-sm"
      >
        <template #short="{ row }: { row: BearCompareRow }">
          <span class="font-medium text-text">{{ row.name }}</span>
        </template>
        <template #drawdown="{ row }: { row: BearCompareRow }">
          <span class="font-semibold" :class="row.stats ? 'text-down' : 'text-text-secondary'">
            {{ drawdownText(row) }}
          </span>
        </template>
        <template #bounce="{ row }: { row: BearCompareRow }">
          <span class="font-semibold" :class="row.stats ? 'text-up' : 'text-text-secondary'">
            {{ bounceText(row) }}
          </span>
        </template>
      </component>
    </component>

    <component :is="deps.ui.Card" title="可复用规律（模式库）">
      <div class="grid gap-2 @3xl:grid-cols-2">
        <div v-for="pattern in BULL_PATTERNS" :key="pattern.title" class="rounded-lg bg-flat-weak p-3">
          <b class="text-sm text-text">{{ pattern.title }}</b>
          <p class="mt-1 text-xs leading-relaxed text-text-secondary">{{ pattern.desc }}</p>
        </div>
      </div>
      <div class="mt-3 grid gap-2 @3xl:grid-cols-2">
        <div v-for="pattern in BEAR_PATTERNS" :key="pattern.title" class="rounded-lg bg-flat-weak p-3">
          <b class="text-sm text-text">{{ pattern.title }}</b>
          <p class="mt-1 text-xs leading-relaxed text-text-secondary">{{ pattern.desc }}</p>
        </div>
      </div>
    </component>

    <component :is="deps.ui.Card" title="四轮机构抱团 · 涨跌停看板预警能力对比">
      <template #extra>
        <span class="text-xs text-text-subtle">来源：豆包复盘框架</span>
      </template>
      <component
        :is="deps.ui.Table"
        :columns="capabilityColumns"
        :rows="capabilityRows"
        :row-key="(row: CapabilityRow) => row.round"
        :min-width="BULL_TABLE_MIN_WIDTH"
        scroll-class="table-scroll-sm"
      >
        <template #ability="{ row }: { row: CapabilityRow }">
          <span
            class="rounded-full px-2 py-0.5 text-xs font-medium"
            :class="
              row.abilityLevel === 'poor' ? 'bg-down-weak text-down-strong' : 'bg-primary-weak text-primary'
            "
          >
            {{ row.ability }}
          </span>
        </template>
      </component>
      <p class="mt-3 rounded-lg bg-flat-weak px-3 py-2 text-xs text-text-secondary">
        规律：板块中大盘中军占比越高，涨跌停指标的滞后性越强；小票占比越高，看板预警效果越好。
      </p>
    </component>
  </div>
</template>
