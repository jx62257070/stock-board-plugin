<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { FullQuote } from 'stock-sdk';
import type { TableColumn } from '../../host/types/table.types';
import { runMaCrossBacktest, runScreener } from './backtest';
import EquityCurveSvg from './EquityCurveSvg.vue';
import {
  BACKTEST_BUTTON,
  BACKTEST_BUTTON_BUSY,
  BACKTEST_CARD_TITLE,
  BACKTEST_DISCLAIMER,
  BACKTEST_DISCLAIMER_TAG,
  BACKTEST_ERROR,
  BACKTEST_HINT,
  BACKTEST_IDLE,
  BACKTEST_INPUT_LABEL,
  BACKTEST_INPUT_PLACEHOLDER,
  BACKTEST_METRIC_LABELS,
  BASIC_FILTER_BUTTON,
  BASIC_FILTER_BUTTON_BUSY,
  BASIC_FILTER_CARD_TITLE,
  BASIC_FILTER_ERROR,
  BASIC_RESULT_CARD_TITLE,
  BASIC_RESULT_EMPTY,
  BASIC_RESULT_IDLE,
  COLUMN_LABEL_AMOUNT,
  COLUMN_LABEL_BACKTEST,
  COLUMN_LABEL_CHANGE,
  COLUMN_LABEL_NAME,
  COLUMN_LABEL_PRICE,
  COLUMN_LABEL_TURNOVER,
  COLUMN_LABEL_VOLUME_RATIO,
  HIT_COUNT_TEXT,
  SCREENER_TOP_N,
  SCREENER_TOP_N_OPTIONS,
} from './constants';
import { formatAmount } from './format-amount';
import type { BacktestResult, ScreenerDeps, ScreenerRuntime } from './types';

/**
 * 基础筛选工具：条件筛选（涨幅/换手/量比/PE）+ 简单回测（MA 金叉死叉 vs 买入持有基准）
 *
 * 全市场快照与 K 线均为重接口，全部由用户点击触发，不做轮询
 */
const props = defineProps<{
  /** 宿主能力（由插件在 apply 里从 ctx 取齐后随页面 props 下发） */
  deps: ScreenerDeps;
  /** 插件取数运行时（SDK 单例 + 日 K 会话缓存） */
  runtime: ScreenerRuntime;
}>();

const format = props.deps.format;

// ---------- 筛选条件 ----------
const filters = reactive({
  changeMin: '',
  changeMax: '',
  turnoverMin: '',
  turnoverMax: '',
  volumeRatioMin: '',
  peMax: '',
});

/** 结果条数（字符串绑定 select，数值化使用） */
const topN = ref<string>(String(SCREENER_TOP_N));

const results = ref<FullQuote[]>([]);
const isScreening = ref(false);
const screenError = ref(false);
const hasScreened = ref(false);

/**
 * 解析数字输入：空串返回 undefined（不过滤）
 * @param value 输入框原值
 * @returns 数值或 undefined
 */
const parseNumber = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : undefined;
};

/** 执行选股 */
const onScreen = async (): Promise<void> => {
  isScreening.value = true;
  screenError.value = false;
  try {
    results.value = await runScreener(
      props.runtime,
      {
        changeMin: parseNumber(filters.changeMin),
        changeMax: parseNumber(filters.changeMax),
        turnoverMin: parseNumber(filters.turnoverMin),
        turnoverMax: parseNumber(filters.turnoverMax),
        volumeRatioMin: parseNumber(filters.volumeRatioMin),
        peMax: parseNumber(filters.peMax),
      },
      Number(topN.value),
    );
    hasScreened.value = true;
  } catch (error) {
    results.value = [];
    screenError.value = true;
    console.error('[screener]', error);
  } finally {
    isScreening.value = false;
  }
};

/**
 * 结果行跳详情（右侧停靠面板）
 * @param quote 筛选结果项
 */
const openDetail = (quote: FullQuote): void => {
  props.deps.stockOpen.openSidebar(quote.code);
};

/**
 * 结果行双击进详情整页（携带来源列表，详情页可一键切换）
 * @param row 行数据
 */
const openDetailPage = (row: FullQuote): void => {
  props.deps.stockOpen.openPage(
    row.code,
    results.value.map((item) => ({
      symbol: item.code,
      name: item.name,
      price: item.price,
      changePercent: item.changePercent,
    })),
  );
};

// ---------- 简单回测 ----------
const backtestSymbol = ref('');
const backtestResult = ref<BacktestResult | null>(null);
const isBacktesting = ref(false);
const backtestError = ref(false);

/** 执行 MA 金叉死叉回测 */
const onBacktest = async (): Promise<void> => {
  const input = backtestSymbol.value.trim();
  if (!input) {
    return;
  }
  isBacktesting.value = true;
  backtestError.value = false;
  try {
    // 任意形态代码归一化成完整符号（600519 / SH600519 → sh600519）
    const result = await runMaCrossBacktest(props.runtime, format.toFullSymbol(input));
    backtestResult.value = result;
    applyStrategyClass(result);
  } catch (error) {
    backtestResult.value = null;
    backtestError.value = true;
    console.error('[backtest]', error);
  } finally {
    isBacktesting.value = false;
  }
};

/**
 * 从筛选结果回填回测标的并执行
 * @param quote 筛选结果项
 */
const backtestFromResult = (quote: FullQuote): void => {
  backtestSymbol.value = format.normalizeCode(quote.code);
  void onBacktest();
};

/** 策略线涨跌语义类名（跟随最终收益，红涨绿跌） */
const strategyClass = ref('text-up');

/**
 * 计算策略线的涨跌类名
 * @param result 回测结果
 */
const applyStrategyClass = (result: BacktestResult): void => {
  const curve = result.equityCurve;
  const first = curve[0] ?? 0;
  const last = curve.at(-1) ?? first;
  strategyClass.value = format.trendClass(format.trend(first > 0 ? ((last - first) / first) * 100 : 0));
};

/** 筛选结果列配置（涨跌幅默认开启排序） */
const resultColumns: TableColumn<FullQuote>[] = [
  { key: 'name', label: COLUMN_LABEL_NAME },
  { key: 'price', label: COLUMN_LABEL_PRICE, align: 'right' },
  {
    key: 'changePercent',
    label: COLUMN_LABEL_CHANGE,
    align: 'right',
    sortable: true,
    sortValue: (quote) => quote.changePercent,
  },
  { key: 'turnoverRate', label: COLUMN_LABEL_TURNOVER, align: 'right' },
  { key: 'volumeRatio', label: COLUMN_LABEL_VOLUME_RATIO, align: 'right' },
  { key: 'amount', label: COLUMN_LABEL_AMOUNT, align: 'right' },
  { key: 'actions', label: COLUMN_LABEL_BACKTEST, align: 'right' },
];
</script>

<template>
  <div class="space-y-4">
    <!-- 筛选条件 -->
    <component :is="deps.ui.Card" :title="BASIC_FILTER_CARD_TITLE">
      <div class="grid grid-cols-6 gap-3 max-md:grid-cols-3">
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">涨幅 ≥ (%)</span>
          <component :is="deps.ui.Input" v-model="filters.changeMin" placeholder="-100" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">涨幅 ≤ (%)</span>
          <component :is="deps.ui.Input" v-model="filters.changeMax" placeholder="100" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">换手率 ≥ (%)</span>
          <component :is="deps.ui.Input" v-model="filters.turnoverMin" placeholder="0" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">换手率 ≤ (%)</span>
          <component :is="deps.ui.Input" v-model="filters.turnoverMax" placeholder="100" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">量比 ≥</span>
          <component :is="deps.ui.Input" v-model="filters.volumeRatioMin" placeholder="0" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">PE(TTM) ≤</span>
          <component :is="deps.ui.Input" v-model="filters.peMax" placeholder="不限" />
        </label>
      </div>
      <div class="mt-4 flex items-center gap-3">
        <component :is="deps.ui.Button" :disabled="isScreening" @click="onScreen">
          {{ isScreening ? BASIC_FILTER_BUTTON_BUSY : BASIC_FILTER_BUTTON }}
        </component>
        <label class="flex items-center gap-1.5 text-xs text-text-tertiary">
          结果条数
          <select
            v-model="topN"
            class="rounded-lg bg-flat-weak px-2 py-1 text-xs text-text outline-none"
          >
            <option v-for="n in SCREENER_TOP_N_OPTIONS" :key="n" :value="String(n)">Top{{ n }}</option>
          </select>
        </label>
        <span v-if="hasScreened && !isScreening" class="text-xs text-text-tertiary">
          {{ HIT_COUNT_TEXT(results.length) }}
        </span>
      </div>
    </component>

    <!-- 筛选结果 -->
    <component :is="deps.ui.Card" :title="BASIC_RESULT_CARD_TITLE">
      <div v-if="screenError" class="py-10">
        <component :is="deps.ui.Empty" :text="BASIC_FILTER_ERROR" />
      </div>
      <component :is="deps.ui.Skeleton" v-else-if="isScreening" />
      <component
        :is="deps.ui.Table"
        v-else-if="results.length > 0"
        :columns="resultColumns"
        :rows="results"
        :row-key="(quote: FullQuote) => quote.code"
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
        <template #amount="{ row }">
          <span class="text-text-secondary">{{ formatAmount(row.amount) }}</span>
        </template>
        <template #actions="{ row }">
          <button
            type="button"
            class="pressable rounded bg-primary-weak px-2 py-0.5 text-xs text-primary active:scale-90"
            @click.stop="backtestFromResult(row)"
          >
            回测
          </button>
        </template>
      </component>
      <component :is="deps.ui.Empty" v-else-if="hasScreened" :text="BASIC_RESULT_EMPTY" />
      <component :is="deps.ui.Empty" v-else :text="BASIC_RESULT_IDLE" />
    </component>

    <!-- 简单回测 -->
    <component :is="deps.ui.Card" :title="BACKTEST_CARD_TITLE">
      <div class="flex flex-wrap items-end gap-3">
        <label class="space-y-1">
          <span class="text-xs text-text-tertiary">{{ BACKTEST_INPUT_LABEL }}</span>
          <component
            :is="deps.ui.Input"
            v-model="backtestSymbol"
            :placeholder="BACKTEST_INPUT_PLACEHOLDER"
            class="w-48"
          />
        </label>
        <component
          :is="deps.ui.Button"
          variant="ghost"
          :disabled="isBacktesting || !backtestSymbol.trim()"
          @click="onBacktest"
        >
          {{ isBacktesting ? BACKTEST_BUTTON_BUSY : BACKTEST_BUTTON }}
        </component>
        <span class="text-xs text-text-tertiary">{{ BACKTEST_HINT }}</span>
      </div>

      <div v-if="backtestError" class="mt-4 py-8">
        <component :is="deps.ui.Empty" :text="BACKTEST_ERROR" />
      </div>
      <template v-else-if="backtestResult">
        <div class="mt-4 grid grid-cols-5 gap-3 max-md:grid-cols-2">
          <div class="rounded-card bg-flat-weak p-3">
            <p class="text-xs text-text-tertiary">{{ BACKTEST_METRIC_LABELS.totalReturn }}</p>
            <p
              class="mt-1 text-lg font-semibold tabular-nums"
              :class="format.trendClass(format.trend(backtestResult.report.totalReturn))"
            >
              {{ format.percent(backtestResult.report.totalReturn) }}
            </p>
          </div>
          <div class="rounded-card bg-flat-weak p-3">
            <p class="text-xs text-text-tertiary">{{ BACKTEST_METRIC_LABELS.buyHoldReturn }}</p>
            <p
              class="mt-1 text-lg font-semibold tabular-nums"
              :class="format.trendClass(format.trend(backtestResult.report.buyHoldReturn))"
            >
              {{ format.percent(backtestResult.report.buyHoldReturn) }}
            </p>
          </div>
          <div class="rounded-card bg-flat-weak p-3">
            <p class="text-xs text-text-tertiary">{{ BACKTEST_METRIC_LABELS.winRate }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-text">
              {{ format.percentUnsigned(backtestResult.report.winRate) }}
            </p>
          </div>
          <div class="rounded-card bg-flat-weak p-3">
            <p class="text-xs text-text-tertiary">{{ BACKTEST_METRIC_LABELS.maxDrawdown }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-down">
              {{ format.percentUnsigned(backtestResult.report.maxDrawdown) }}
            </p>
          </div>
          <div class="rounded-card bg-flat-weak p-3">
            <p class="text-xs text-text-tertiary">{{ BACKTEST_METRIC_LABELS.tradeCount }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-text">
              {{ backtestResult.report.tradeCount }}
            </p>
          </div>
        </div>
        <div class="mt-4">
          <EquityCurveSvg
            :dates="backtestResult.dates"
            :equity-curve="backtestResult.equityCurve"
            :buy-hold-curve="backtestResult.buyHoldCurve"
            :strategy-class="strategyClass"
          />
        </div>
        <p class="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
          <component :is="deps.ui.Tag" tone="flat">{{ BACKTEST_DISCLAIMER_TAG }}</component>
          {{ BACKTEST_DISCLAIMER }}
        </p>
      </template>
      <div v-else-if="isBacktesting" class="mt-4"><component :is="deps.ui.Skeleton" /></div>
      <component :is="deps.ui.Empty" v-else :text="BACKTEST_IDLE" />
    </component>
  </div>
</template>
