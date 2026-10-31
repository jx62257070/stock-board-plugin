<script setup lang="ts">
import { computed, ref } from 'vue';
import SentimentDetailChart from './SentimentDetailChart.vue';
import {
  COLUMN_LABEL,
  DETAIL_CARD_TITLE,
  DETAIL_LABEL,
  EMPTY_SCAN_BUTTON,
  EMPTY_TEXT,
  EMPTY_TITLE,
  FAILURE_CARD_TITLE,
  FAILURE_FOOTER_NOTICE,
  INDEX_PILL_CLASS,
  KIND_CHIPS,
  MAX_HISTORY_DAYS,
  MOBILE_BACK_LABEL,
  MOBILE_ROW_OPEN_LABEL,
  MOOD_LABEL,
  PROGRESS_CARD_TITLE,
  RANGE_DAYS,
  RANGE_OPTIONS,
  RANK_CARD_TITLE,
  RETRY_BUTTON_TEXT,
  SCAN_BUTTON_RUNNING,
  SCAN_BUTTON_TEXT,
  SCAN_DONE_BODY,
  SCAN_DONE_TITLE,
  SCAN_FAILED_TEXT,
  SCAN_STEP_LABEL,
  SCAN_STEP_ORDER,
  SCAN_STEP_WEIGHT,
  SENTIMENT_MENU_ICON,
  SENTIMENT_PAGE_SUBTITLE,
  SENTIMENT_PLUGIN_ID,
  SMALL_ORDER_NOTICE,
  SOURCE_BADGE_TEXT,
  STALE_NO_DATA_BADGE,
  TABLE_FOOTER_NOTICE,
  TRIAL_BADGE_TEXT,
  WATCHLIST_CAP,
  WATCH_COUNT_TEXT,
  WATCH_EMPTY_NOTICE,
  WATCH_FULL_NOTICE,
  WATCH_MODAL_FOOTER_NOTICE,
  WATCH_MODAL_TITLE,
  WATCH_SEARCH_PLACEHOLDER,
  indexPillKey,
  intradayNotice,
  staleBadgeText,
} from './constants';
import {
  buildMarketMap,
  computeIndexSeries,
  detectDivergences,
  marketAmountChangePct,
  resolveStaleDays,
} from './judge';
import { runScan } from './scan';
import type { SentimentRepo } from './storage';
import type {
  ChartMode,
  DivergenceMark,
  IndexPoint,
  RankRow,
  RankSortKey,
  ScanFailure,
  ScanProgress,
  SentimentDeps,
} from './types';
import type { KindFilter, RangeKey } from './constants';
import type { TableColumn } from '../../host/types/table.types';

/**
 * 散户情绪指数看板（插件 dsh-sentiment-index 的页面）
 *
 * 三区结构（上下布局；容器 ≥1024px 时左右分栏，<640px 时列表 / 详情整页切换）：
 * ① 全市场情绪条（两市成交额 / 涨跌家数 / 涨停 / 炸板 / 跌停，全部本地数据）；
 * ② 题材指数排行（kind 筛选 + 双指数排序；行点击 → 详情联动）；
 * ③ 单题材详情（价格-情绪-量能三栏联动图 + 背离标记 + 时间档切换）。
 *
 * 打开页面不联网：全部数据读 `repo.snapshot()`；「采集更新」是唯一联网入口
 * （用户点击触发，可离开本页 —— 采集在插件层继续，完成走 app:notify 浮窗）。
 */
const props = defineProps<{
  /** 散户情绪指数仓储（由插件注入，已建表并水合） */
  repo: SentimentRepo;
  /** 宿主能力（UI Kit / 格式化 / 网络 / 市场数据 / 浮窗），由插件在 apply 里取好传入 */
  deps: SentimentDeps;
}>();

/** 宿主格式化服务（模板里写 `format.percent(...)` 比 `deps.format.percent(...)` 好读） */
const format = props.deps.format;

// ---------- 页面状态 ----------

/** 是否正在采集 */
const scanning = ref(false);
/** 采集进度（null = 未进行中） */
const progress = ref<ScanProgress | null>(null);
/** 页内提示文案（空串 = 无） */
const scanNotice = ref('');
/** kind 筛选（关注默认） */
const kindFilter = ref<KindFilter>('watch');
/** 详情默认选中是否处于「跟随模式」（切 chips 重置回跟随，点行后固定跟随用户） */
const followMode = ref(true);
/** 用户手动选中的板块代码（followMode 为 false 时生效） */
const selectedCode = ref('');
/** 时间档（交易日数） */
const rangeKey = ref<RangeKey>('60');
/** 主图形态 */
const chartMode = ref<ChartMode>('kline');
/** 资金副图开关（横屏 pad / 宽容器默认收起由模板类控制初始态，见 onFundToggleInit） */
const showFund = ref(true);
/** 关注管理弹层 */
const watchModalOpen = ref(false);
/** 关注搜索关键词 */
const watchSearch = ref('');
/** 关注草稿（弹层内增删，保存才生效） */
const watchDraft = ref<string[]>([]);
/** 手机档视图（list 排行 / detail 详情；仅 <640px 容器生效） */
const mobileView = ref<'list' | 'detail'>('list');

// ---------- 快照与指标重算（纯本地，不联网） ----------

/** 本地快照（repo 内部是响应式 ref，采集落库后这里自动重算） */
const snapshot = computed(() => props.repo.snapshot());

/** 交易日 → 沪深总成交额（同源分母映射） */
const marketMap = computed(() => buildMarketMap(snapshot.value.market));

/** 交易日历（升序，滞后天数用它数） */
const marketDates = computed(() => snapshot.value.market.map((point) => point.date));

/** 关注集合 */
const watchSet = computed(() => new Set(snapshot.value.watchlist));

/**
 * 全板块逐日指数（全量重算：30~120 板块 × ≤420 日，毫秒级；
 * 采集落库 / 首屏水合才触发，不随交互重算）
 */
const indexByCode = computed(() => {
  const map = new Map<string, IndexPoint[]>();
  for (const board of snapshot.value.boards) {
    map.set(board.code, computeIndexSeries(board.days, marketMap.value));
  }
  return map;
});

/** 全板块背离标记 */
const marksByCode = computed(() => {
  const map = new Map<string, DivergenceMark[]>();
  for (const board of snapshot.value.boards) {
    map.set(board.code, detectDivergences(indexByCode.value.get(board.code) ?? [], board.days));
  }
  return map;
});

/** 采集元信息 */
const meta = computed(() => snapshot.value.meta);

/** 板块代码 → 板块事实 */
const boardByCode = computed(() => new Map(snapshot.value.boards.map((board) => [board.code, board])));

// ---------- 排行行（视图模型） ----------

/**
 * 组装单板块的排行行
 * @param code 板块代码
 * @returns 排行行
 */
const buildRow = (code: string): RankRow | null => {
  const board = boardByCode.value.get(code);
  if (!board) return null;
  const series = indexByCode.value.get(code) ?? [];
  const lastPoint = series[series.length - 1] ?? null;
  const lastDay = board.days[board.days.length - 1] ?? null;
  const asOfDate = lastDay?.date ?? '';
  return {
    code,
    name: board.name,
    kind: board.kind,
    watched: watchSet.value.has(code),
    retailIndex: lastPoint?.retailIndex ?? null,
    heatIndex: lastPoint?.heatIndex ?? null,
    amountShare: lastPoint?.factors.amountShare ?? null,
    smallRatio: lastDay?.smallRatio ?? null,
    pctChg: lastDay?.pctChg ?? null,
    amount: lastDay?.amount ?? null,
    asOf: asOfDate,
    staleDays:
      asOfDate && meta.value?.asOf
        ? resolveStaleDays(marketDates.value, asOfDate, meta.value.asOf)
        : null,
    noData: board.days.length === 0,
  };
};

/** 当前筛选集内的排行行（先筛后排；null 值恒沉底） */
const rows = computed(() => {
  const kind = kindFilter.value;
  const filtered: RankRow[] = [];
  const codePool =
    kind === 'concept' ? snapshot.value.watchlist : snapshot.value.boards.map((board) => board.code);
  for (const code of codePool) {
    const row = buildRow(code);
    if (!row) continue;
    if (kind === 'watch' && !row.watched) continue;
    if (kind === 'industry' && row.kind !== 'industry') continue;
    if (kind === 'concept' && !row.watched) continue;
    filtered.push(row);
  }
  const factor = (row: RankRow): number => row[sortKey.value] ?? Number.NEGATIVE_INFINITY;
  return filtered.sort((a, b) => (sortDesc.value ? factor(b) - factor(a) : factor(a) - factor(b)));
});

/** 排序键（排行表列头与手机列表共用；默认散户情绪指数降序） */
const sortKey = ref<RankSortKey>('retailIndex');
const sortDesc = ref(true);

// ---------- 详情默认选中（跟随模式：筛选集内散户情绪指数最高者） ----------

/** 当前详情选中的行 */
const selectedRow = computed<RankRow | null>(() => {
  if (!followMode.value) {
    return rows.value.find((row) => row.code === selectedCode.value) ?? rows.value[0] ?? null;
  }
  let top: RankRow | null = null;
  for (const row of rows.value) {
    if (row.retailIndex !== null && (top === null || top.retailIndex === null || row.retailIndex > top.retailIndex)) {
      top = row;
    }
  }
  return top ?? rows.value[0] ?? null;
});

/**
 * 行点击：固定跟随用户选择，手机档整页切详情
 * @param row 排行行
 */
const onSelectRow = (row: RankRow): void => {
  followMode.value = false;
  selectedCode.value = row.code;
  mobileView.value = 'detail';
};

/**
 * 切换 kind chips：重置回「当前筛选集内散户情绪指数最高」的跟随模式
 * @param kind 筛选值
 */
const onKindChip = (kind: KindFilter): void => {
  kindFilter.value = kind;
  followMode.value = true;
  selectedCode.value = '';
  mobileView.value = 'list';
};

// ---------- 详情数据（时间档窗口 + 背离） ----------

/** 详情数据包（窗口切片；无数据板块为 null） */
const detail = computed(() => {
  const row = selectedRow.value;
  if (!row) return null;
  const board = boardByCode.value.get(row.code);
  if (!board || board.days.length === 0) return null;
  const series = indexByCode.value.get(row.code) ?? [];
  const count = RANGE_DAYS[rangeKey.value];
  const start = Math.max(0, board.days.length - count);
  return {
    board,
    days: board.days.slice(start),
    series: series.slice(start),
    marks: marksByCode.value.get(row.code) ?? [],
  };
});

// ---------- 全市场情绪条 ----------

/** 情绪条摘要（全部本地数据；池子类数值来自上次采集的 meta） */
const mood = computed(() => {
  const asOf = meta.value?.asOf ?? '';
  let rise: number | null = null;
  let fall: number | null = null;
  if (asOf) {
    let riseSum = 0;
    let fallSum = 0;
    let sawAny = false;
    for (const board of snapshot.value.boards) {
      if (board.kind !== 'industry') continue;
      const day = board.days.find((item) => item.date === asOf);
      if (!day) continue;
      if (day.upCount !== null) {
        riseSum += day.upCount;
        sawAny = true;
      }
      if (day.downCount !== null) {
        fallSum += day.downCount;
        sawAny = true;
      }
    }
    if (sawAny) {
      rise = riseSum;
      fall = fallSum;
    }
  }
  return {
    asOf,
    totalAmount: snapshot.value.market[snapshot.value.market.length - 1]?.totalAmount ?? null,
    amountChangePct: marketAmountChangePct(snapshot.value.market),
    riseCount: rise,
    fallCount: fall,
    limitUpCount: meta.value?.limitUpTotal ?? null,
    streak2Count: meta.value?.streak2Count ?? null,
    zhaBanCount: meta.value?.zhaBanCount ?? null,
    limitDownCount: meta.value?.limitDownCount ?? null,
  };
});

// ---------- 采集 ----------

/**
 * 触发一次采集（点击触发，不轮询；可在采集中离开本页 —— 完成走浮窗提醒）
 */
const onScan = async (): Promise<void> => {
  if (scanning.value) return;
  scanning.value = true;
  scanNotice.value = '';
  progress.value = { step: 'snapshot', done: 0, total: 0 };
  try {
    const result = await runScan(props.repo, props.deps, {
      onProgress: (next) => {
        progress.value = next;
      },
    });
    const parts: string[] = [];
    if (result.excludedDate) parts.push(intradayNotice(result.excludedDate));
    if (result.fflowMissNotice) parts.push(result.fflowMissNotice);
    if (result.failures.length > 0) parts.push(`${result.failures.length} 个板块本轮失败（见下方失败清单）`);
    scanNotice.value = parts.join(' ');
    props.deps.notify?.notify({
      title: SCAN_DONE_TITLE(result.asOf),
      body: SCAN_DONE_BODY(result.addedRows, result.failures.length),
      source: SENTIMENT_PLUGIN_ID,
    });
  } catch (error) {
    scanNotice.value = `${SCAN_FAILED_TEXT}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    scanning.value = false;
    progress.value = null;
  }
};

/** 失败清单（上次采集遗留） */
const failures = computed<readonly ScanFailure[]>(() => meta.value?.failures ?? []);

/**
 * 重试单个失败板块（只重跑失败板块，不整轮重扫）
 * @param failure 失败记录
 */
const onRetryFailure = async (failure: ScanFailure): Promise<void> => {
  if (scanning.value) return;
  scanning.value = true;
  scanNotice.value = '';
  progress.value = { step: 'history', done: 0, total: 1 };
  try {
    await runScan(props.repo, props.deps, { onlyCodes: [failure.code] });
    scanNotice.value = `${failure.name} 补采完成`;
  } catch (error) {
    scanNotice.value = `${SCAN_FAILED_TEXT}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    scanning.value = false;
    progress.value = null;
  }
};

// ---------- 关注管理 ----------

/** 关注是否已满 */
const watchFull = computed(() => watchDraft.value.length >= WATCHLIST_CAP);

/** 搜索命中的板块清单（板块清单缓存；无缓存时为空） */
const watchCandidates = computed(() => {
  const keyword = watchSearch.value.trim().toLowerCase();
  const refs = snapshot.value.refs;
  const rowsLocal = keyword
    ? refs.filter(
        (ref) => ref.name.toLowerCase().includes(keyword) || ref.code.toLowerCase().includes(keyword),
      )
    : refs;
  return rowsLocal.slice(0, 200);
});

/**
 * 打开关注管理弹层（草稿 = 当前清单副本）
 */
const openWatchModal = (): void => {
  watchDraft.value = [...snapshot.value.watchlist];
  watchSearch.value = '';
  watchModalOpen.value = true;
};

/**
 * 草稿内加入一个板块（满额置灰）
 * @param code 板块代码
 */
const addWatchDraft = (code: string): void => {
  if (watchFull.value || watchDraft.value.includes(code)) return;
  watchDraft.value = [...watchDraft.value, code];
};

/**
 * 草稿内移除一个板块
 * @param code 板块代码
 */
const removeWatchDraft = (code: string): void => {
  watchDraft.value = watchDraft.value.filter((item) => item !== code);
};

/** 本轮新增的板块（保存后要补拉历史） */
const addedWatchCodes = computed(
  () => watchDraft.value.filter((code) => !snapshot.value.watchlist.includes(code)),
);

/**
 * 保存关注清单（新增板块自动补拉一次历史，走并发红线；移除不删除已落库历史）
 */
const saveWatchlist = async (): Promise<void> => {
  const added = addedWatchCodes.value;
  await props.repo.setWatchlist(watchDraft.value);
  followMode.value = true;
  selectedCode.value = '';
  watchModalOpen.value = false;
  if (added.length === 0 || scanning.value) return;
  // 增量补拉新增板块（后台执行，不阻塞页面；完成走浮窗）
  void runScan(props.repo, props.deps, { onlyCodes: added })
    .then((result) => {
      props.deps.notify?.notify({
        title: SCAN_DONE_TITLE(result.asOf),
        body: SCAN_DONE_BODY(result.addedRows, result.failures.length),
        source: SENTIMENT_PLUGIN_ID,
      });
    })
    .catch((error: unknown) => {
      scanNotice.value = `新增板块补拉失败：${error instanceof Error ? error.message : String(error)}`;
    });
};

/**
 * 详情头部的关注开关（加关注立即补拉该板块历史；移除保留数据）
 * @param code 板块代码
 */
const toggleWatch = async (code: string): Promise<void> => {
  const next = watchSet.value.has(code)
    ? snapshot.value.watchlist.filter((item) => item !== code)
    : watchFull.value
      ? snapshot.value.watchlist
      : [...snapshot.value.watchlist, code];
  if (next === snapshot.value.watchlist) {
    scanNotice.value = WATCH_FULL_NOTICE;
    return;
  }
  await props.repo.setWatchlist(next);
  if (!watchSet.value.has(code) || scanning.value) return;
  void runScan(props.repo, props.deps, { onlyCodes: [code] }).catch((error: unknown) => {
    scanNotice.value = `补拉历史失败：${error instanceof Error ? error.message : String(error)}`;
  });
};

// ---------- 展示格式化 ----------

/**
 * 涨跌幅文本色（跟全站涨跌色）
 * @param value 涨跌幅（%）
 * @returns 色类名
 */
const changeClass = (value: number | null): string =>
  value === null ? 'text-text-tertiary' : format.trendClass(format.trend(value));

/** 五步进度的分段视图（进度条与步骤 chips 共用；当前步按 done/total 填充） */
const progressSegments = computed(() => {
  const step = progress.value?.step;
  const stepDone = progress.value?.done ?? 0;
  const stepTotal = progress.value?.total ?? 0;
  const currentIndex = step ? SCAN_STEP_ORDER.indexOf(step) : -1;
  return SCAN_STEP_ORDER.map((name, index) => {
    const isPast = currentIndex >= 0 && index < currentIndex;
    const isCurrent = index === currentIndex;
    const ratio = isCurrent && stepTotal > 0 ? Math.min(1, stepDone / stepTotal) : 0;
    return {
      step: name,
      label: SCAN_STEP_LABEL[name],
      icon: isPast ? '✓' : isCurrent ? '›' : '·',
      fill: isPast ? 100 : isCurrent ? Math.round(ratio * 100) : 0,
      fillClass: isPast ? 'bg-primary' : isCurrent ? 'bg-primary/70' : 'bg-transparent',
      labelClass: isPast ? 'text-primary' : isCurrent ? 'font-semibold text-text' : 'text-text-tertiary',
    };
  });
});

/** 总进度百分比（按步权重折算的体感值；钳在 2~99 避免两端假满 / 假零） */
const scanPercent = computed(() => {
  const sum = progressSegments.value.reduce(
    (total, seg) => total + (seg.fill * SCAN_STEP_WEIGHT[seg.step]) / 100,
    0,
  );
  return Math.max(2, Math.min(99, Math.round(sum)));
});

/** 采集提示条的语气（失败 / 限流中止用警示色，其余用主色提示） */
const scanNoticeIsError = computed(
  () => scanNotice.value.includes('失败') || scanNotice.value.includes('限流'),
);

/**
 * 净占比文本色（红正绿负）
 * @param value 净占比（%）
 * @returns 色类名
 */
const ratioClass = (value: number | null): string =>
  value === null || value === 0
    ? 'text-text-secondary'
    : format.trendClass(format.trend(value));

/**
 * 数值占位（缺数据给 —，不显示 0）
 * @param value 数值
 * @param digits 小数位
 * @returns 文案
 */
const fixed = (value: number | null, digits = 2): string =>
  value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

/**
 * 两市成交额 → 万亿 / 亿文案
 * @param value 成交额（元）
 * @returns 文案
 */
const toTrillion = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  return value >= 1e12 ? `${(value / 1e12).toFixed(2)} 万亿` : `${(value / 1e8).toFixed(0)} 亿`;
};

/**
 * 采集时间文案
 * @param value 毫秒时间戳
 * @returns 本地时间文案
 */
const formatScannedAt = (value: number): string => new Date(value).toLocaleString('zh-CN');

/**
 * 滞后徽标文案（无数据板块给「无数据」）
 * @param row 排行行
 * @returns 徽标文案；正常返回空串
 */
const staleBadge = (row: RankRow): string => {
  if (row.noData) return STALE_NO_DATA_BADGE;
  if (row.staleDays === null || row.staleDays <= 0) return '';
  return staleBadgeText(row.staleDays);
};

/**
 * 指数胶囊配色（≥70 红 / 40~69 橙 / <40 灰；null 恒灰）
 * @param value 指数值
 * @returns 色类名
 */
const pillClass = (value: number | null): string =>
  value === null ? 'bg-flat-weak/60 text-text-tertiary' : INDEX_PILL_CLASS[indexPillKey(value)];

// ---------- 表格列 ----------

/** 排行表列配置（排序走宿主 Table 内部排序；null 值沉底由宿主处理） */
const columns: TableColumn<RankRow>[] = [
  { key: 'name', label: COLUMN_LABEL.name },
  {
    key: 'heatIndex',
    label: COLUMN_LABEL.heat,
    align: 'right',
    sortable: true,
    sortValue: (row) => row.heatIndex,
  },
  {
    key: 'retailIndex',
    label: COLUMN_LABEL.retail,
    align: 'right',
    sortable: true,
    sortValue: (row) => row.retailIndex,
  },
  {
    key: 'amountShare',
    label: COLUMN_LABEL.share,
    align: 'right',
    sortable: true,
    sortValue: (row) => row.amountShare,
  },
  {
    key: 'smallRatio',
    label: COLUMN_LABEL.smallRatio,
    align: 'right',
    sortable: true,
    sortValue: (row) => row.smallRatio,
  },
  {
    key: 'pctChg',
    label: COLUMN_LABEL.change,
    align: 'right',
    sortable: true,
    sortValue: (row) => row.pctChg,
  },
];

/**
 * 行 key（板块代码，同一板块只出现一行）
 * @param row 排行行
 * @returns 行 key
 */
const rowKey = (row: RankRow): string => row.code;
</script>

<template>
  <div class="@container flex flex-col gap-3">
    <!-- ===== 页头 ===== -->
    <component :is="deps.ui.Card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-1.5 text-base font-semibold text-text">
            <component :is="deps.ui.Icon" :name="SENTIMENT_MENU_ICON" :size="16" />
            散户情绪指数
            <span class="rounded bg-flat-weak px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              {{ SOURCE_BADGE_TEXT }}
            </span>
            <span class="rounded bg-primary-weak px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {{ TRIAL_BADGE_TEXT }}
            </span>
          </h1>
          <p class="mt-1 text-xs leading-relaxed text-text-secondary">{{ SENTIMENT_PAGE_SUBTITLE }}</p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <component :is="deps.ui.Button" :disabled="scanning" @click="onScan">
            <component :is="deps.ui.Icon" name="refresh" :size="14" />
            {{ scanning ? SCAN_BUTTON_RUNNING : SCAN_BUTTON_TEXT }}
          </component>
          <span v-if="progress" class="text-[11px] tabular-nums text-text-tertiary">
            {{ SCAN_STEP_LABEL[progress.step] }} {{ progress.done }}/{{ progress.total }}
          </span>
        </div>
      </div>

      <!-- 口径信息行 -->
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary">
        <span>基准交易日：{{ meta?.asOf || '—' }}</span>
        <span>
          关注：{{ WATCH_COUNT_TEXT(snapshot.watchlist.length, WATCHLIST_CAP) }}
        </span>
        <span v-if="meta">上次采集：{{ formatScannedAt(meta.scannedAt) }}</span>
        <span>情绪历史深度：{{ MAX_HISTORY_DAYS }} 日内（fflow 上游约 121 日）</span>
      </div>

      <!-- 采集进度卡：五步分段 + 步内比例 + 当前单元（按 UI 稿 A3 形态） -->
      <div
        v-if="progress"
        class="mt-3 rounded-lg border border-primary/50 bg-primary-weak/40 px-3 py-2.5"
      >
        <div class="flex items-center gap-2 text-xs font-semibold text-primary">
          <component :is="deps.ui.Icon" name="refresh" :size="13" class="animate-spin" />
          {{ PROGRESS_CARD_TITLE }}
          <span class="ml-auto font-mono text-[11px] font-normal tabular-nums text-text-tertiary">
            总进度约 {{ scanPercent }}%
          </span>
        </div>
        <div class="mt-2 flex gap-1">
          <div
            v-for="seg in progressSegments"
            :key="`bar-${seg.step}`"
            class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface"
          >
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="seg.fillClass"
              :style="{ width: `${seg.fill}%` }"
            />
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span
            v-for="seg in progressSegments"
            :key="`chip-${seg.step}`"
            class="inline-flex items-center gap-1"
            :class="seg.labelClass"
          >
            <span class="w-3 text-center">{{ seg.icon }}</span>{{ seg.label }}
          </span>
        </div>
        <p v-if="progress.current" class="mt-1 truncate text-[11px] text-text-tertiary">
          {{ progress.current }}
        </p>
      </div>

      <p
        v-if="meta && meta.excludedDate"
        class="mt-2 rounded-lg bg-flat-weak px-2 py-1.5 text-xs leading-relaxed text-text-secondary"
      >
        {{ intradayNotice(meta.excludedDate) }}
      </p>
      <p
        v-if="scanNotice"
        class="mt-2 rounded-lg px-2 py-1.5 text-xs leading-relaxed"
        :class="scanNoticeIsError ? 'bg-up-weak text-up' : 'bg-primary-weak text-primary'"
      >
        {{ scanNotice }}
      </p>
    </component>

    <!-- ===== 主体：宽容器左右分栏（42/58），其余上下堆叠 ===== -->
    <div
      class="flex min-w-0 flex-col gap-3 @min-[1024px]:grid @min-[1024px]:grid-cols-[minmax(0,42fr)_minmax(0,58fr)] @min-[1024px]:items-start"
    >
      <!-- 左栏（宽容器）/ 上部（堆叠）：情绪条 + 排行；手机档 detail 视图下隐藏 -->
      <div
        class="flex min-w-0 flex-col gap-3"
        :class="mobileView === 'list' ? 'block' : '@max-[639px]:hidden @min-[640px]:block'"
      >
        <!-- 区① 全市场情绪条 -->
        <component :is="deps.ui.Card" v-if="meta" title="全市场情绪">
          <div class="grid grid-cols-2 gap-2 @min-[640px]:grid-cols-3 @min-[1024px]:grid-cols-2">
            <div class="rounded-lg border border-flat bg-bg px-3 py-2">
              <div class="text-[10.5px] font-semibold text-text-tertiary">{{ MOOD_LABEL.amount }}</div>
              <div class="mt-1 font-mono text-[15px] font-bold tabular-nums text-text">
                {{ toTrillion(mood.totalAmount) }}
              </div>
              <div class="font-mono text-[10.5px] tabular-nums" :class="changeClass(mood.amountChangePct)">
                {{ mood.amountChangePct === null ? '' : `较昨 ${format.percent(mood.amountChangePct)}` }}
              </div>
            </div>
            <div class="rounded-lg border border-flat bg-bg px-3 py-2 @min-[1024px]:hidden">
              <div class="text-[10.5px] font-semibold text-text-tertiary">{{ MOOD_LABEL.riseFall }}</div>
              <div class="mt-1 font-mono text-[15px] font-bold tabular-nums">
                <span class="text-up">{{ mood.riseCount ?? '—' }}</span>
                <span class="text-text-tertiary"> / </span>
                <span class="text-down">{{ mood.fallCount ?? '—' }}</span>
              </div>
              <div class="text-[10.5px] text-text-tertiary">行业口径合计</div>
            </div>
            <div class="rounded-lg border border-flat bg-bg px-3 py-2">
              <div class="text-[10.5px] font-semibold text-text-tertiary">{{ MOOD_LABEL.limitUp }}</div>
              <div class="mt-1 font-mono text-[15px] font-bold tabular-nums text-up">
                {{ mood.limitUpCount ?? '—' }}
              </div>
              <div class="text-[10.5px] text-text-tertiary">连板≥2：{{ mood.streak2Count ?? '—' }}</div>
            </div>
            <div class="rounded-lg border border-flat bg-bg px-3 py-2">
              <div class="text-[10.5px] font-semibold text-text-tertiary">{{ MOOD_LABEL.zhaBan }}</div>
              <div class="mt-1 font-mono text-[15px] font-bold tabular-nums text-text">
                {{ mood.zhaBanCount ?? '—' }}
              </div>
              <div class="text-[10.5px] text-text-tertiary">
                炸板率：{{
                  mood.zhaBanCount !== null && mood.limitUpCount
                    ? `${((mood.zhaBanCount / (mood.zhaBanCount + mood.limitUpCount)) * 100).toFixed(1)}%`
                    : '—'
                }}
              </div>
            </div>
            <div class="rounded-lg border border-flat bg-bg px-3 py-2 @min-[1024px]:hidden">
              <div class="text-[10.5px] font-semibold text-text-tertiary">{{ MOOD_LABEL.limitDown }}</div>
              <div class="mt-1 font-mono text-[15px] font-bold tabular-nums text-down">
                {{ mood.limitDownCount ?? '—' }}
              </div>
              <div class="text-[10.5px] text-text-tertiary">跌停池</div>
            </div>
          </div>
        </component>

        <!-- 区② 题材指数排行 -->
        <component :is="deps.ui.Card" :title="RANK_CARD_TITLE">
          <template #extra>
            <div class="flex items-center gap-1.5">
              <button
                v-for="chip in KIND_CHIPS"
                :key="chip.key"
                type="button"
                class="pressable rounded-full border px-3 py-1 text-[11px] font-semibold transition active:scale-95"
                :class="
                  kindFilter === chip.key
                    ? 'border-primary bg-primary text-white'
                    : 'border-flat bg-surface text-text-secondary'
                "
                @click="onKindChip(chip.key)"
              >
                {{ chip.label }}
                <template v-if="chip.key === 'watch'"> {{ snapshot.watchlist.length }}</template>
              </button>
              <button
                type="button"
                class="pressable rounded-full border border-dashed border-flat px-3 py-1 text-[11px] font-semibold text-text-tertiary transition active:scale-95"
                @click="openWatchModal"
              >
                + 管理
              </button>
            </div>
          </template>
          <template #title>
            <span class="text-sm font-semibold">{{ RANK_CARD_TITLE }}</span>
          </template>

          <!-- 空态：还没采集过 -->
          <div v-if="snapshot.boards.length === 0">
            <component :is="deps.ui.Empty" :text="EMPTY_TITLE" />
            <p class="mx-auto max-w-xs pb-4 text-center text-xs leading-relaxed text-text-tertiary">
              {{ EMPTY_TEXT }}
            </p>
            <p class="pb-4 text-center">
              <component :is="deps.ui.Button" :disabled="scanning" @click="onScan">
                <component :is="deps.ui.Icon" name="refresh" :size="14" />
                {{ EMPTY_SCAN_BUTTON }}
              </component>
            </p>
          </div>

          <template v-else>
            <!-- 手机档：列表行 -->
            <div class="@min-[640px]:hidden">
              <button
                v-for="row in rows"
                :key="row.code"
                type="button"
                class="flex w-full items-center gap-2 border-b border-flat/60 px-1 py-2.5 text-left last:border-b-0 active:bg-primary-weak"
                :aria-label="MOBILE_ROW_OPEN_LABEL"
                @click="onSelectRow(row)"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1 text-[13px] font-bold text-text">
                    <span class="truncate">{{ row.name }}</span>
                    <span v-if="row.watched" class="shrink-0 text-[11px] text-primary">★</span>
                    <span
                      v-if="staleBadge(row)"
                      class="shrink-0 rounded bg-flat-weak px-1 py-0.5 text-[10px] font-medium text-text-tertiary"
                    >
                      {{ staleBadge(row) }}
                    </span>
                  </div>
                  <div class="mt-0.5 text-[10px] text-text-tertiary">
                    {{ row.code }} · 占比 {{ fixed(row.amountShare, 1) }}% · 小单
                    <span :class="ratioClass(row.smallRatio)">{{ row.smallRatio === null ? '—' : format.percent(row.smallRatio) }}</span>
                  </div>
                </div>
                <div class="shrink-0 text-right">
                  <div class="text-[9px] font-semibold text-text-tertiary">情绪</div>
                  <div
                    class="font-mono text-base font-bold tabular-nums"
                    :class="row.retailIndex === null ? 'text-text-tertiary' : indexPillKey(row.retailIndex) === 'hot' ? 'text-up' : 'text-text'"
                  >
                    {{ row.retailIndex === null ? '—' : row.retailIndex.toFixed(0) }}
                  </div>
                </div>
                <div class="w-16 shrink-0 text-right font-mono text-[12.5px] font-bold tabular-nums" :class="changeClass(row.pctChg)">
                  {{ row.pctChg === null ? '—' : format.percent(row.pctChg) }}
                </div>
              </button>
              <p v-if="rows.length === 0" class="py-6 text-center text-xs text-text-tertiary">
                当前筛选下没有板块
              </p>
            </div>

            <!-- 平板 / 桌面档：表格 -->
            <component
              :is="deps.ui.Table"
              class="hidden @min-[640px]:block"
              :columns="columns"
              :rows="rows"
              :row-key="rowKey"
              :row-clickable="true"
              min-width="640px"
              @row-click="onSelectRow"
            >
              <template #name="{ row }">
                <span class="flex items-center gap-1.5">
                  <span class="font-semibold text-text">{{ row.name }}</span>
                  <span class="font-mono text-[10px] text-text-tertiary">{{ row.code }}</span>
                  <span v-if="row.kind === 'concept'" class="text-[10px] text-text-tertiary">概念</span>
                  <span v-if="row.watched" class="text-[11px] text-primary">★</span>
                  <span
                    v-if="staleBadge(row)"
                    class="rounded bg-flat-weak px-1 py-0.5 text-[10px] text-text-tertiary"
                  >
                    {{ staleBadge(row) }}
                  </span>
                </span>
              </template>
              <template #heatIndex="{ row }">
                <span class="inline-flex items-center justify-end gap-1.5">
                  <span class="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-flat-weak">
                    <span
                      class="block h-full rounded-full bg-primary"
                      :style="{ width: `${Math.min(100, row.heatIndex ?? 0)}%` }"
                    />
                  </span>
                  <span class="font-mono tabular-nums">{{ row.heatIndex === null ? '—' : row.heatIndex.toFixed(0) }}</span>
                </span>
              </template>
              <template #retailIndex="{ row }">
                <span
                  class="inline-block min-w-10 rounded-full px-2 py-0.5 text-center font-mono text-[11.5px] font-bold tabular-nums"
                  :class="pillClass(row.retailIndex)"
                >
                  {{ row.retailIndex === null ? '—' : row.retailIndex.toFixed(0) }}
                </span>
              </template>
              <template #amountShare="{ row }">{{ fixed(row.amountShare, 1) }}%</template>
              <template #smallRatio="{ row }">
                <span :class="ratioClass(row.smallRatio)">
                  {{ row.smallRatio === null ? '—' : format.percent(row.smallRatio) }}
                </span>
              </template>
              <template #pctChg="{ row }">
                <span :class="changeClass(row.pctChg)">
                  {{ row.pctChg === null ? '—' : format.percent(row.pctChg) }}
                </span>
              </template>
            </component>

            <p class="mt-2 text-[10.5px] leading-relaxed text-text-tertiary">
              {{ TABLE_FOOTER_NOTICE }}
            </p>
          </template>
        </component>
      </div>

      <!-- 右栏（宽容器）/ 下部（堆叠）：单题材详情；手机档 list 视图下隐藏 -->
      <div
        class="flex min-w-0 flex-col gap-3"
        :class="mobileView === 'detail' ? 'block' : '@max-[639px]:hidden @min-[640px]:block'"
      >
        <component :is="deps.ui.Card" :title="DETAIL_CARD_TITLE">
          <!-- 手机档返回键 -->
          <button
            type="button"
            class="pressable mb-2 rounded-md border border-flat px-2 py-1 text-[11px] text-text-secondary @min-[640px]:hidden"
            :aria-label="MOBILE_BACK_LABEL"
            @click="mobileView = 'list'"
          >
            ‹ 返回排行
          </button>

          <div v-if="!detail" class="py-6">
            <component :is="deps.ui.Empty" text="选择一个板块查看详情" />
          </div>

          <template v-else>
            <!-- 详情头 -->
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-base font-bold text-text">
                {{ detail.board.name }}
                <span class="font-mono text-[11px] font-normal text-text-tertiary">{{ detail.board.code }}</span>
              </span>
              <span
                class="rounded-full px-2 py-0.5 font-mono text-[11.5px] font-bold tabular-nums"
                :class="pillClass(selectedRow?.retailIndex ?? null)"
              >
                {{ DETAIL_LABEL.retailPill }} {{ selectedRow?.retailIndex?.toFixed(0) ?? '—' }}
              </span>
              <span class="rounded-full bg-flat-weak px-2 py-0.5 font-mono text-[11.5px] font-bold tabular-nums text-text-secondary">
                {{ DETAIL_LABEL.heatPill }} {{ selectedRow?.heatIndex?.toFixed(0) ?? '—' }}
              </span>
              <span class="font-mono text-sm font-bold tabular-nums" :class="changeClass(selectedRow?.pctChg ?? null)">
                {{ selectedRow?.pctChg == null ? '' : format.percent(selectedRow.pctChg) }}
              </span>
              <component
                :is="deps.ui.Button"
                variant="ghost"
                class="@max-[639px]:hidden"
                @click="toggleWatch(detail.board.code)"
              >
                {{ watchSet.has(detail.board.code) ? DETAIL_LABEL.watchRemove : DETAIL_LABEL.watchAdd }}
              </component>
            </div>

            <!-- 控制行：时间档 + 主图形态 + 资金副图开关 -->
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div class="flex items-center gap-1">
                <button
                  v-for="range in RANGE_OPTIONS"
                  :key="range.key"
                  type="button"
                  class="pressable rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition active:scale-95"
                  :class="
                    rangeKey === range.key
                      ? 'border-primary bg-primary text-white'
                      : 'border-flat bg-surface text-text-secondary'
                  "
                  @click="rangeKey = range.key"
                >
                  {{ range.label }}
                </button>
              </div>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="pressable rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition active:scale-95"
                  :class="
                    chartMode === 'kline'
                      ? 'border-primary bg-primary text-white'
                      : 'border-flat bg-surface text-text-secondary'
                  "
                  @click="chartMode = 'kline'"
                >
                  {{ DETAIL_LABEL.klineMode }}
                </button>
                <button
                  type="button"
                  class="pressable rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition active:scale-95"
                  :class="
                    chartMode === 'line'
                      ? 'border-primary bg-primary text-white'
                      : 'border-flat bg-surface text-text-secondary'
                  "
                  @click="chartMode = 'line'"
                >
                  {{ DETAIL_LABEL.lineMode }}
                </button>
              </div>
              <label class="flex items-center gap-1 text-[11px] text-text-tertiary">
                <input v-model="showFund" type="checkbox" class="accent-primary" />
                {{ DETAIL_LABEL.fundToggle }}
              </label>
            </div>

            <!-- 三栏联动图 -->
            <div class="mt-2">
              <SentimentDetailChart
                :days="detail.days"
                :series="detail.series"
                :marks="detail.marks"
                :mode="chartMode"
                :show-fund="showFund"
              />
            </div>

            <p class="mt-1 text-[10.5px] leading-relaxed text-text-tertiary">{{ SMALL_ORDER_NOTICE }}</p>
          </template>
        </component>
      </div>
    </div>

    <!-- ===== 失败清单 ===== -->
    <component :is="deps.ui.Card" v-if="failures.length > 0" :title="FAILURE_CARD_TITLE(failures.length)">
      <div class="flex flex-col gap-1.5">
        <div
          v-for="failure in failures"
          :key="failure.code"
          class="flex items-center gap-2 border-b border-dashed border-flat pb-1.5 text-xs text-text-secondary last:border-b-0"
        >
          <span class="rounded bg-up-weak px-1.5 py-0.5 text-[10px] font-bold text-up">失败</span>
          <span class="min-w-0 flex-1 truncate">{{ failure.name }} {{ failure.code }}</span>
          <span class="hidden max-w-40 truncate text-[10px] text-text-tertiary @min-[640px]:block">
            {{ failure.error }}
          </span>
          <component :is="deps.ui.Button" variant="ghost" :disabled="scanning" @click="onRetryFailure(failure)">
            {{ RETRY_BUTTON_TEXT }}
          </component>
        </div>
      </div>
      <p class="mt-2 text-[10.5px] leading-relaxed text-text-tertiary">{{ FAILURE_FOOTER_NOTICE }}</p>
    </component>

    <!-- ===== 关注题材管理弹层 ===== -->
    <component
      :is="deps.ui.Modal"
      :open="watchModalOpen"
      :title="`${WATCH_MODAL_TITLE} ${WATCH_COUNT_TEXT(watchDraft.length, WATCHLIST_CAP)}`"
      @update:open="watchModalOpen = $event"
    >
      <div class="flex min-h-0 flex-col gap-2">
        <component
          :is="deps.ui.Input"
          v-model="watchSearch"
          :placeholder="WATCH_SEARCH_PLACEHOLDER"
        />
        <p v-if="snapshot.refs.length === 0" class="py-4 text-center text-xs leading-relaxed text-text-tertiary">
          {{ WATCH_EMPTY_NOTICE }}
        </p>
        <div class="max-h-64 overflow-y-auto">
          <div
            v-for="item in watchCandidates"
            :key="item.code"
            class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-primary-weak"
          >
            <span class="text-primary">{{ watchDraft.includes(item.code) ? '✦' : '·' }}</span>
            <span class="min-w-0 flex-1 truncate font-semibold text-text">{{ item.name }}</span>
            <span class="font-mono text-[10px] text-text-tertiary">
              {{ item.code }} · {{ item.kind === 'industry' ? '行业' : '概念' }}
            </span>
            <button
              v-if="watchDraft.includes(item.code)"
              type="button"
              class="pressable rounded px-1.5 text-text-tertiary hover:text-up"
              @click="removeWatchDraft(item.code)"
            >
              ✕
            </button>
            <component
              :is="deps.ui.Button"
              v-else
              variant="ghost"
              :disabled="watchFull"
              @click="addWatchDraft(item.code)"
            >
              +
            </component>
          </div>
        </div>
        <p v-if="watchFull" class="text-[11px] text-up">{{ WATCH_FULL_NOTICE }}</p>
      </div>
      <template #footer>
        <div class="flex w-full items-center gap-2">
          <span class="mr-auto text-[10.5px] text-text-tertiary">{{ WATCH_MODAL_FOOTER_NOTICE }}</span>
          <component :is="deps.ui.Button" variant="ghost" @click="watchModalOpen = false">取消</component>
          <component :is="deps.ui.Button" @click="saveWatchlist">
            保存{{ addedWatchCodes.length > 0 ? `并增量采集 +${addedWatchCodes.length}` : '' }}
          </component>
        </div>
      </template>
    </component>
  </div>
</template>
