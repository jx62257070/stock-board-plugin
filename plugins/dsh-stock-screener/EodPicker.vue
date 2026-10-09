<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue';
import type { TableColumn } from '../../host/types/table.types';
import { analyzeEodStocks } from './analysis';
import {
  COLUMN_LABEL_CHANGE,
  COLUMN_LABEL_MARKET_CAP,
  COLUMN_LABEL_NAME,
  COLUMN_LABEL_PRICE,
  COLUMN_LABEL_TIMELINE_STRENGTH,
  COLUMN_LABEL_TURNOVER,
  COLUMN_LABEL_VOLUME_RATIO,
  EOD_ANALYZE_BUTTON,
  EOD_ANALYZE_BUTTON_BUSY,
  EOD_CANCEL_BUTTON,
  EOD_CONCURRENCY_HINT,
  EOD_EMPTY_RESULT,
  EOD_FAILED,
  EOD_FILTER_CARD_TITLE,
  EOD_FILTERS_DEFAULT,
  EOD_PROGRESS_STAGE_READY,
  EOD_RESULT_CARD_TITLE,
  EOD_RESULT_EMPTY,
  EOD_RESULT_IDLE,
  EOD_ST_LABEL,
  EOD_TIMELINE_CONCURRENCY,
  EOD_TIMELINE_HINT,
  HIT_COUNT_TEXT,
  NUMBER_PLACEHOLDER,
} from './constants';
import { isAnalysisAborted } from './concurrency';
import type { AnalysisProgress, EodFilters, EodStock, ScreenerDeps, ScreenerRuntime } from './types';

/**
 * 尾盘选股工具：全市场快照按流通市值 / 量比 / 涨幅 / 换手率 / ST 基础过滤，
 * 再按分时强度（分时价位于均价上方的时间占比）精筛强势股
 *
 * 全市场快照与分时均为重接口，全部由用户点击触发，不做轮询
 */
const props = defineProps<{
  /** 宿主能力（由插件在 apply 里从 ctx 取齐后随页面 props 下发） */
  deps: ScreenerDeps;
  /** 插件取数运行时（SDK 单例 + 日 K 会话缓存） */
  runtime: ScreenerRuntime;
}>();

const format = props.deps.format;

/** 过滤条件（默认值参考尾盘选股法常用参数） */
const filters = reactive<EodFilters>({ ...EOD_FILTERS_DEFAULT });

const isAnalyzing = ref(false);
const progress = ref<AnalysisProgress>({ stage: EOD_PROGRESS_STAGE_READY, completed: 0, total: 0 });
const results = ref<EodStock[]>([]);
const hasRun = ref(false);
const notice = ref<string | null>(null);
const abortController = ref<AbortController | null>(null);

/** 数字输入双向绑定（空串按 0 处理由用户自行权衡；null 上限以空串表示） */
const filterForm = reactive({
  marketCapMin: String(EOD_FILTERS_DEFAULT.marketCapMin),
  marketCapMax: String(EOD_FILTERS_DEFAULT.marketCapMax ?? ''),
  volumeRatioMin: String(EOD_FILTERS_DEFAULT.volumeRatioMin),
  changePercentMin: String(EOD_FILTERS_DEFAULT.changePercentMin),
  changePercentMax: String(EOD_FILTERS_DEFAULT.changePercentMax ?? ''),
  turnoverRateMin: String(EOD_FILTERS_DEFAULT.turnoverRateMin),
  turnoverRateMax: String(EOD_FILTERS_DEFAULT.turnoverRateMax ?? ''),
  timelineAboveAvgRatioMin: String(EOD_FILTERS_DEFAULT.timelineAboveAvgRatioMin),
});

/**
 * 表单收集为过滤条件（非法输入回退默认值）
 * @returns 过滤条件对象
 */
const collectFilters = (): EodFilters => {
  const num = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const nullableNum = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    marketCapMin: num(filterForm.marketCapMin, EOD_FILTERS_DEFAULT.marketCapMin),
    marketCapMax: nullableNum(filterForm.marketCapMax),
    volumeRatioMin: num(filterForm.volumeRatioMin, EOD_FILTERS_DEFAULT.volumeRatioMin),
    changePercentMin: num(filterForm.changePercentMin, EOD_FILTERS_DEFAULT.changePercentMin),
    changePercentMax: nullableNum(filterForm.changePercentMax),
    turnoverRateMin: num(filterForm.turnoverRateMin, EOD_FILTERS_DEFAULT.turnoverRateMin),
    turnoverRateMax: nullableNum(filterForm.turnoverRateMax),
    excludeST: filters.excludeST,
    timelineAboveAvgRatioMin: num(
      filterForm.timelineAboveAvgRatioMin,
      EOD_FILTERS_DEFAULT.timelineAboveAvgRatioMin,
    ),
  };
};

/** 执行尾盘分析（可取消） */
const onAnalyze = async (): Promise<void> => {
  isAnalyzing.value = true;
  results.value = [];
  notice.value = null;
  progress.value = { stage: EOD_PROGRESS_STAGE_READY, completed: 0, total: 0 };
  const controller = new AbortController();
  abortController.value = controller;
  try {
    const stocks = await analyzeEodStocks(props.runtime, collectFilters(), {
      signal: controller.signal,
      onProgress: (value) => {
        progress.value = value;
      },
    });
    results.value = stocks;
    hasRun.value = true;
    if (stocks.length === 0) {
      notice.value = EOD_EMPTY_RESULT;
    }
  } catch (error) {
    if (!isAnalysisAborted(error)) {
      console.error('[eod-picker]', error);
      notice.value = EOD_FAILED;
    }
  } finally {
    abortController.value = null;
    isAnalyzing.value = false;
  }
};

/** 取消分析 */
const onCancel = (): void => {
  abortController.value?.abort();
};

onBeforeUnmount(() => {
  abortController.value?.abort();
});

/**
 * 结果行打开个股详情（右侧停靠面板）
 * @param stock 结果行
 */
const openDetail = (stock: EodStock): void => {
  props.deps.stockOpen.openSidebar(stock.symbol);
};

/**
 * 结果行双击进详情整页（携带来源列表）
 * @param row 结果行
 */
const openDetailPage = (row: EodStock): void => {
  props.deps.stockOpen.openPage(
    row.symbol,
    results.value.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      price: item.price,
      changePercent: item.changePercent,
    })),
  );
};

/** 结果列配置（涨跌幅 / 分时强度默认开启排序） */
const resultColumns: TableColumn<EodStock>[] = [
  { key: 'name', label: COLUMN_LABEL_NAME },
  { key: 'price', label: COLUMN_LABEL_PRICE, align: 'right' },
  {
    key: 'changePercent',
    label: COLUMN_LABEL_CHANGE,
    align: 'right',
    sortable: true,
    sortValue: (stock) => stock.changePercent,
  },
  { key: 'turnoverRate', label: COLUMN_LABEL_TURNOVER, align: 'right' },
  { key: 'volumeRatio', label: COLUMN_LABEL_VOLUME_RATIO, align: 'right' },
  { key: 'circulatingMarketCap', label: COLUMN_LABEL_MARKET_CAP, align: 'right' },
  {
    key: 'timelineAboveAvgRatio',
    label: COLUMN_LABEL_TIMELINE_STRENGTH,
    align: 'right',
    sortable: true,
    sortValue: (stock) => stock.timelineAboveAvgRatio,
  },
];
</script>

<template>
  <div class="space-y-4">
    <!-- 筛选条件 -->
    <component :is="deps.ui.Card" :title="EOD_FILTER_CARD_TITLE">
      <div class="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">流通市值 ≥ (亿)</span>
          <component :is="deps.ui.Input" v-model="filterForm.marketCapMin" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">流通市值 ≤ (亿，空为不限)</span>
          <component :is="deps.ui.Input" v-model="filterForm.marketCapMax" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">量比 ≥</span>
          <component :is="deps.ui.Input" v-model="filterForm.volumeRatioMin" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">当日涨幅 ≥ (%)</span>
          <component :is="deps.ui.Input" v-model="filterForm.changePercentMin" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">当日涨幅 ≤ (%，空为不限)</span>
          <component :is="deps.ui.Input" v-model="filterForm.changePercentMax" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">换手率 ≥ (%)</span>
          <component :is="deps.ui.Input" v-model="filterForm.turnoverRateMin" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">换手率 ≤ (%，空为不限)</span>
          <component :is="deps.ui.Input" v-model="filterForm.turnoverRateMax" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">分时强度 ≥ (%)</span>
          <component :is="deps.ui.Input" v-model="filterForm.timelineAboveAvgRatioMin" />
        </label>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-2 text-xs text-text-secondary">
          {{ EOD_ST_LABEL }}
          <component :is="deps.ui.Switch" v-model="filters.excludeST" />
        </label>
        <component :is="deps.ui.Button" :disabled="isAnalyzing" @click="onAnalyze">
          {{ isAnalyzing ? EOD_ANALYZE_BUTTON_BUSY : EOD_ANALYZE_BUTTON }}
        </component>
        <component :is="deps.ui.Button" v-if="isAnalyzing" variant="ghost" @click="onCancel">
          {{ EOD_CANCEL_BUTTON }}
        </component>
        <span v-if="isAnalyzing" class="text-xs text-text-tertiary">
          {{ progress.stage }}（{{ progress.completed }}/{{ progress.total }}）{{ EOD_CONCURRENCY_HINT(EOD_TIMELINE_CONCURRENCY) }}
        </span>
        <span v-else-if="results.length > 0" class="text-xs text-text-tertiary">
          {{ HIT_COUNT_TEXT(results.length) }}
        </span>
      </div>
      <p class="mt-2 text-xs text-text-tertiary">{{ EOD_TIMELINE_HINT }}</p>
    </component>

    <!-- 分析结果 -->
    <component :is="deps.ui.Card" :title="EOD_RESULT_CARD_TITLE">
      <component :is="deps.ui.Skeleton" v-if="isAnalyzing && results.length === 0" />
      <component
        :is="deps.ui.Table"
        v-else-if="results.length > 0"
        :columns="resultColumns"
        :rows="results"
        :row-key="(stock: EodStock) => stock.symbol"
        :row-clickable="true"
        :enable-dblclick-nav="true"
        @row-click="openDetail"
        @row-dblclick="openDetailPage"
      >
        <template #name="{ row }">
          <span class="font-medium text-text">{{ row.name }}</span>
          <span class="ml-1 text-xs text-text-tertiary">{{ row.code }}</span>
        </template>
        <template #price="{ row }">
          <span :class="format.trendClass(format.trend(row.changePercent))">
            {{ format.price(row.price) }}
          </span>
        </template>
        <template #changePercent="{ row }">
          <span
            class="rounded-full px-2 py-0.5 text-xs font-semibold"
            :class="format.trendPillClass(format.trend(row.changePercent))"
          >
            {{ format.percent(row.changePercent) }}
          </span>
        </template>
        <template #turnoverRate="{ row }">
          <span class="text-text-secondary">{{ format.percentUnsigned(row.turnoverRate) }}</span>
        </template>
        <template #volumeRatio="{ row }">
          <span class="text-text-secondary">{{ format.price(row.volumeRatio) }}</span>
        </template>
        <template #circulatingMarketCap="{ row }">
          <span class="text-text-secondary">
            {{ row.circulatingMarketCap === null ? NUMBER_PLACEHOLDER : `${format.price(row.circulatingMarketCap)}亿` }}
          </span>
        </template>
        <template #timelineAboveAvgRatio="{ row }">
          <span
            class="font-medium"
            :class="row.timelineAboveAvgRatio >= 80 ? 'text-up' : 'text-text-secondary'"
          >
            {{ format.percentUnsigned(row.timelineAboveAvgRatio) }}
          </span>
        </template>
      </component>
      <component :is="deps.ui.Empty" v-else-if="hasRun" :text="EOD_RESULT_EMPTY" />
      <component :is="deps.ui.Empty" v-else :text="EOD_RESULT_IDLE" />
      <p v-if="notice" class="mt-2 text-xs text-down">{{ notice }}</p>
    </component>
  </div>
</template>
