<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { TableColumn } from '../../host/types/table.types';
import { scanSignalPool } from './analysis';
import {
  fetchConceptBoards,
  fetchConceptConstituents,
  fetchIndustryBoards,
  fetchIndustryConstituents,
} from './boards';
import {
  BOARD_LIMIT_LABEL,
  BOARD_SELECT_PLACEHOLDER,
  BOARD_TYPE_OPTIONS,
  COLUMN_LABEL_MATCHED,
  COLUMN_LABEL_NAME,
  HIT_COUNT_TEXT,
  MARKET_SNAPSHOT_BATCH_SIZE,
  MARKET_SNAPSHOT_CONCURRENCY,
  POOL_SOURCE_HINTS,
  POOL_SOURCE_TABS,
  RANKING_FIELD_OPTIONS,
  SCAN_BOARD_LIMIT_OPTIONS,
  SCAN_CONCURRENCY,
  SCAN_STOCK_CHANGE_OPTIONS,
  SCAN_TOP_N_OPTIONS,
  SCAN_ZT_POOL_OPTIONS,
  SCANNER_CANCEL_BUTTON,
  SCANNER_CONCURRENCY_HINT,
  SCANNER_EMPTY_POOL,
  SCANNER_FAILED,
  SCANNER_NO_MATCH,
  SCANNER_NO_SIGNAL,
  SCANNER_POOL_CARD_TITLE,
  SCANNER_PROGRESS_STAGE_READY,
  SCANNER_RESULT_CARD_TITLE,
  SCANNER_RESULT_IDLE,
  SCANNER_SCAN_BUTTON,
  SCANNER_SCAN_BUTTON_BUSY,
  SCANNER_SIGNAL_CARD_TITLE,
  SIGNAL_TEMPLATES,
  TOP_N_LABEL,
} from './constants';
import { isAnalysisAborted } from './concurrency';
import type {
  AnalysisProgress,
  ScanSignalResult,
  ScannerPoolItem,
  ScreenerDeps,
  ScreenerRuntime,
  SignalKey,
} from './types';

/**
 * 信号扫描工具：股票池来源（自选 / 板块 / 榜单 / 涨停强势池 / 盘口异动池）
 * + 信号模板多选 + 并发扫描（支持取消、进度、边扫边出结果）
 *
 * 与宿主内置版的差异：宿主 `app:watchlist` 服务是**只读**视图，
 * 扫描结果不带「加自选」按钮 —— 加自选请打开个股后在自选股页操作。
 */
const props = defineProps<{
  /** 宿主能力（由插件在 apply 里从 ctx 取齐后随页面 props 下发） */
  deps: ScreenerDeps;
  /** 插件取数运行时（SDK 单例 + 日 K 会话缓存） */
  runtime: ScreenerRuntime;
}>();

/** 扫描并发（常量透出展示用） */
const CONCURRENCY_LABEL = SCAN_CONCURRENCY;

/** 当前股票池来源 */
const poolSource = ref<string>('watchlist');

// ---------- 板块来源状态 ----------
const boardType = ref<string>('industry');
const boards = ref<{ code: string; name: string }[]>([]);
const selectedBoardCode = ref('');
const boardLimit = ref<number>(50);

/** 当前板块类型下的板块选项 */
const boardOptions = computed(() => boards.value);

// ---------- 榜单 / 股池状态 ----------
const rankingField = ref<string>('amount');
const topN = ref<number>(20);
const ztPoolType = ref<string>('strong');
const stockChangeType = ref<string>('rocket_launch');

// ---------- 信号多选 ----------
const selectedSignals = ref<SignalKey[]>(['ma_golden']);

/**
 * 切换信号模板选中态
 * @param key 信号 key
 */
const toggleSignal = (key: SignalKey): void => {
  const index = selectedSignals.value.indexOf(key);
  if (index >= 0) {
    selectedSignals.value.splice(index, 1);
  } else {
    selectedSignals.value = [...selectedSignals.value, key];
  }
};

// ---------- 股票池解析 ----------
/** 是否正在解析股票池 / 扫描 */
const isScanning = ref(false);
const progress = ref<AnalysisProgress>({ stage: SCANNER_PROGRESS_STAGE_READY, completed: 0, total: 0 });
const results = ref<ScanSignalResult[]>([]);
const notice = ref<string | null>(null);
const abortController = ref<AbortController | null>(null);

/**
 * 解析自选股池（符号来自宿主只读视图，名称批量回填）
 * @returns 股票池条目列表
 */
const resolveWatchlistPool = async (): Promise<ScannerPoolItem[]> => {
  const symbols = props.deps.watchlist.symbols();
  if (symbols.length === 0) {
    return [];
  }
  const pool: ScannerPoolItem[] = symbols.map((symbol) => ({
    code: symbol.replace(/^(sh|sz|bj)/, ''),
    symbol,
    name: symbol,
  }));
  try {
    const quotes = await props.runtime.sdk.quotes.cn([...symbols]);
    for (const item of pool) {
      const hit = quotes.find((quote) => quote.code === item.symbol);
      if (hit) {
        item.name = hit.name;
      }
    }
  } catch (error) {
    console.error('[signal-scanner] 回填自选名称失败', error);
  }
  return pool;
};

/**
 * 拉取板块列表（切换板块类型时）
 */
const loadBoards = async (): Promise<void> => {
  boards.value = [];
  selectedBoardCode.value = '';
  const list =
    boardType.value === 'industry'
      ? await fetchIndustryBoards(props.runtime)
      : await fetchConceptBoards(props.runtime);
  boards.value = list.map((item) => ({ code: item.code, name: item.name }));
};

// 切换来源 / 板块类型时按需拉列表
const onPoolSourceChange = (): void => {
  notice.value = null;
  if (poolSource.value === 'board' && boards.value.length === 0) {
    void loadBoards().catch((error) => console.error('[signal-scanner]', error));
  }
};
const onBoardTypeChange = (): void => {
  void loadBoards().catch((error) => console.error('[signal-scanner]', error));
};

/**
 * 解析板块股池（成分股截取前 N）
 * @returns 股票池条目列表
 */
const resolveBoardPool = async (): Promise<ScannerPoolItem[]> => {
  if (!selectedBoardCode.value) {
    return [];
  }
  const constituents =
    boardType.value === 'industry'
      ? await fetchIndustryConstituents(props.runtime, selectedBoardCode.value)
      : await fetchConceptConstituents(props.runtime, selectedBoardCode.value);
  return constituents.slice(0, boardLimit.value).map((item) => ({
    code: item.code,
    // A 股 6 位纯代码 → 完整符号（宿主口径归一化）
    symbol: props.deps.format.normalizeCode(item.code),
    name: item.name,
  }));
};

/**
 * 解析榜单 TopN 股池（全市场快照按字段排序）
 * @returns 股票池条目列表
 */
const resolveRankingPool = async (): Promise<ScannerPoolItem[]> => {
  const quotes = await props.runtime.sdk.batch.cn({
    batchSize: MARKET_SNAPSHOT_BATCH_SIZE,
    concurrency: MARKET_SNAPSHOT_CONCURRENCY,
  });
  const field = rankingField.value as 'amount' | 'changePercent' | 'turnoverRate';
  return [...quotes]
    .sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0))
    .slice(0, topN.value)
    .map((quote) => ({
      code: quote.code.replace(/^(sh|sz|bj)/, ''),
      symbol: quote.code,
      name: quote.name,
    }));
};

/**
 * 解析涨停 / 强势股池
 * @returns 股票池条目列表
 */
const resolveZtPool = async (): Promise<ScannerPoolItem[]> => {
  const items = await props.runtime.sdk.marketEvent.ztPool(ztPoolType.value as never);
  return items.slice(0, topN.value).map((item) => ({
    code: item.code,
    symbol: props.deps.format.normalizeCode(item.code),
    name: item.name,
  }));
};

/**
 * 解析盘口异动池（按类型去重）
 * @returns 股票池条目列表
 */
const resolveStockChangePool = async (): Promise<ScannerPoolItem[]> => {
  const items = await props.runtime.sdk.marketEvent.stockChanges(stockChangeType.value as never);
  const deduped = new Map<string, ScannerPoolItem>();
  for (const item of items) {
    const symbol = props.deps.format.normalizeCode(item.code);
    if (!deduped.has(symbol)) {
      deduped.set(symbol, {
        code: item.code,
        symbol,
        name: item.name,
      });
    }
  }
  return [...deduped.values()].slice(0, topN.value);
};

/**
 * 按来源解析股票池
 * @returns 股票池条目列表
 */
const resolvePool = async (): Promise<ScannerPoolItem[]> => {
  if (poolSource.value === 'watchlist') {
    return resolveWatchlistPool();
  }
  if (poolSource.value === 'board') {
    return resolveBoardPool();
  }
  if (poolSource.value === 'zt_pool') {
    return resolveZtPool();
  }
  if (poolSource.value === 'stock_changes') {
    return resolveStockChangePool();
  }
  return resolveRankingPool();
};

/** 执行扫描（可取消） */
const onScan = async (): Promise<void> => {
  if (selectedSignals.value.length === 0) {
    notice.value = SCANNER_NO_SIGNAL;
    return;
  }
  isScanning.value = true;
  results.value = [];
  notice.value = null;
  progress.value = { stage: SCANNER_PROGRESS_STAGE_READY, completed: 0, total: 0 };
  const controller = new AbortController();
  abortController.value = controller;
  try {
    const pool = await resolvePool();
    if (pool.length === 0) {
      notice.value = SCANNER_EMPTY_POOL;
      return;
    }
    const scanned = await scanSignalPool(props.runtime, pool, selectedSignals.value, {
      signal: controller.signal,
      onProgress: (value) => {
        progress.value = value;
      },
      onResult: (result) => {
        results.value = [...results.value, result];
      },
    });
    results.value = scanned;
    if (scanned.length === 0) {
      notice.value = SCANNER_NO_MATCH;
    }
  } catch (error) {
    if (!isAnalysisAborted(error)) {
      console.error('[signal-scanner]', error);
      notice.value = SCANNER_FAILED;
    }
  } finally {
    abortController.value = null;
    isScanning.value = false;
  }
};

/** 取消扫描 */
const onCancel = (): void => {
  abortController.value?.abort();
};

onBeforeUnmount(() => {
  // 离开页面即中止扫描（池可达上百个请求，不中止会在后台跑完）
  abortController.value?.abort();
});

/**
 * 结果行打开个股详情（右侧停靠面板）
 * @param row 结果行
 */
const openDetail = (row: ScanSignalResult): void => {
  props.deps.stockOpen.openSidebar(row.symbol);
};

/**
 * 结果行双击进详情整页（携带来源列表）
 * @param row 结果行
 */
const openDetailPage = (row: ScanSignalResult): void => {
  props.deps.stockOpen.openPage(
    row.symbol,
    results.value.map((item) => ({ symbol: item.symbol, name: item.name })),
  );
};

/** 来源说明文案 */
const poolHint = computed(() => POOL_SOURCE_HINTS[poolSource.value] ?? '');

/** 结果列配置 */
const resultColumns: TableColumn<ScanSignalResult>[] = [
  { key: 'name', label: COLUMN_LABEL_NAME },
  { key: 'matchedLabels', label: COLUMN_LABEL_MATCHED },
];
</script>

<template>
  <div class="space-y-4">
    <!-- 股票池来源 -->
    <component :is="deps.ui.Card" :title="SCANNER_POOL_CARD_TITLE">
      <component
        :is="deps.ui.Tabs"
        v-model="poolSource"
        :options="[...POOL_SOURCE_TABS]"
        @update:model-value="onPoolSourceChange"
      />

      <!-- 板块来源子配置 -->
      <div v-if="poolSource === 'board'" class="mt-3 flex flex-wrap items-center gap-2">
        <component
          :is="deps.ui.Tabs"
          v-model="boardType"
          :options="[...BOARD_TYPE_OPTIONS]"
          @update:model-value="onBoardTypeChange"
        />
        <select
          v-model="selectedBoardCode"
          class="max-w-52 rounded-lg border border-flat-weak bg-surface px-2 py-1.5 text-xs text-text"
          aria-label="选择板块"
        >
          <option value="" disabled>{{ BOARD_SELECT_PLACEHOLDER }}</option>
          <option v-for="board in boardOptions" :key="board.code" :value="board.code">
            {{ board.name }}
          </option>
        </select>
        <label class="flex items-center gap-1.5 text-xs text-text-tertiary">
          {{ BOARD_LIMIT_LABEL }}
          <select
            v-model.number="boardLimit"
            class="rounded-lg bg-flat-weak px-2 py-1 text-xs text-text outline-none"
          >
            <option v-for="n in SCAN_BOARD_LIMIT_OPTIONS" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <component :is="deps.ui.Skeleton" v-if="boardOptions.length === 0" class="h-6 w-40" />
      </div>
      <p class="mt-2 text-xs text-text-tertiary">{{ poolHint }}</p>

      <!-- 榜单 / 股池通用子配置 -->
      <div
        v-if="poolSource === 'ranking' || poolSource === 'zt_pool' || poolSource === 'stock_changes'"
        class="mt-3 flex flex-wrap items-center gap-2"
      >
        <component
          :is="deps.ui.Tabs"
          v-if="poolSource === 'ranking'"
          v-model="rankingField"
          :options="[...RANKING_FIELD_OPTIONS]"
        />
        <component
          :is="deps.ui.Tabs"
          v-if="poolSource === 'zt_pool'"
          v-model="ztPoolType"
          :options="[...SCAN_ZT_POOL_OPTIONS]"
        />
        <component
          :is="deps.ui.Tabs"
          v-if="poolSource === 'stock_changes'"
          v-model="stockChangeType"
          :options="[...SCAN_STOCK_CHANGE_OPTIONS]"
        />
        <label class="flex items-center gap-1.5 text-xs text-text-tertiary">
          {{ TOP_N_LABEL }}
          <select
            v-model.number="topN"
            class="rounded-lg bg-flat-weak px-2 py-1 text-xs text-text outline-none"
          >
            <option v-for="n in SCAN_TOP_N_OPTIONS" :key="n" :value="n">Top{{ n }}</option>
          </select>
        </label>
      </div>
    </component>

    <!-- 信号模板 -->
    <component :is="deps.ui.Card" :title="SCANNER_SIGNAL_CARD_TITLE">
      <div class="grid grid-cols-4 gap-2 max-md:grid-cols-2">
        <button
          v-for="template in SIGNAL_TEMPLATES"
          :key="template.key"
          type="button"
          class="pressable rounded-card border p-3 text-left active:scale-[0.98]"
          :class="
            selectedSignals.includes(template.key)
              ? 'border-primary bg-primary-weak'
              : 'border-flat-weak bg-flat-weak/40 hover:border-primary/40'
          "
          :aria-pressed="selectedSignals.includes(template.key)"
          @click="toggleSignal(template.key)"
        >
          <p
            class="text-sm font-medium"
            :class="selectedSignals.includes(template.key) ? 'text-primary' : 'text-text'"
          >
            {{ template.label }}
          </p>
          <p class="mt-0.5 text-xs text-text-tertiary">{{ template.desc }}</p>
        </button>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <component :is="deps.ui.Button" :disabled="isScanning" @click="onScan">
          {{ isScanning ? SCANNER_SCAN_BUTTON_BUSY : SCANNER_SCAN_BUTTON }}
        </component>
        <component :is="deps.ui.Button" v-if="isScanning" variant="ghost" @click="onCancel">
          {{ SCANNER_CANCEL_BUTTON }}
        </component>
        <span v-if="isScanning" class="text-xs text-text-tertiary">
          {{ progress.stage }}（{{ progress.completed }}/{{ progress.total }}）{{ SCANNER_CONCURRENCY_HINT(CONCURRENCY_LABEL) }}
        </span>
        <span v-else-if="results.length > 0" class="text-xs text-text-tertiary">
          {{ HIT_COUNT_TEXT(results.length) }}
        </span>
      </div>
      <p v-if="notice" class="mt-2 text-xs text-down">{{ notice }}</p>
    </component>

    <!-- 扫描结果 -->
    <component :is="deps.ui.Card" :title="SCANNER_RESULT_CARD_TITLE">
      <component :is="deps.ui.Skeleton" v-if="isScanning && results.length === 0" />
      <component
        :is="deps.ui.Table"
        v-else-if="results.length > 0"
        :columns="resultColumns"
        :rows="results"
        :row-key="(row: ScanSignalResult) => row.symbol"
        :row-clickable="true"
        :enable-dblclick-nav="true"
        @row-click="openDetail"
        @row-dblclick="openDetailPage"
      >
        <template #name="{ row }">
          <span class="font-medium text-text">{{ row.name }}</span>
          <span class="ml-1 text-xs text-text-tertiary">{{ row.code }}</span>
        </template>
        <template #matchedLabels="{ row }">
          <component
            :is="deps.ui.Tag"
            v-for="label in row.matchedLabels"
            :key="label"
            tone="primary"
            class="mr-1"
          >
            {{ label }}
          </component>
        </template>
      </component>
      <component :is="deps.ui.Empty" v-else :text="SCANNER_RESULT_IDLE" />
    </component>
  </div>
</template>
