<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
// 宿主 UiKit / 涨跌语义等能力一律经 `deps` 注入：本插件最终以单文件产物分发，
// 运行时没有 import 可用（详见 types.ts 的 `BroadDeps`）
import {
  refreshDaily,
  syncQuarter,
} from './scan';
import {
  buildSignalTimeline,
  estimateEtf,
  recentMainInflow,
  recentSignalDays,
  sumEstimates,
} from './estimate';
import {
  buildComboSeries,
  buildNationalSeries,
  buildShareCampaigns,
  buildShareSignalTimeline,
  recentNetFlow,
  runShareBacktest,
} from './share-signal';
import type { NationalSeriesPoint } from './share-signal';
import { syncShareSeries } from './share-sync';
import {
  ANCHOR_DEFAULT_PERIOD,
  BROAD_ANCHOR_AUTO,
  BROAD_ANCHOR_COLUMN_LABEL,
  BROAD_ANCHOR_NOTE,
  BROAD_ANCHOR_SAVE,
  BROAD_ANCHOR_SAVE_FAILED,
  BROAD_ANCHOR_TITLE,
  BROAD_COLUMN_LABEL,
  BROAD_DISCLAIMER,
  BROAD_EMPTY_TEXT,
  BROAD_HEADER_LABEL,
  BROAD_INDEX_TITLE,
  BROAD_MENU_ICON,
  BROAD_MODEL_NOTE,
  BROAD_PAGE_SUBTITLE,
  BROAD_PAGE_TITLE,
  BROAD_PLACEHOLDER,
  BROAD_QUARTER_COLUMN_LABEL,
  BROAD_QUARTER_TABLE_TITLE,
  BROAD_REFRESH_BUTTON,
  BROAD_REFRESH_FAILED,
  BROAD_RUNNING,
  BROAD_SHARE_CHART_NOTE,
  BROAD_SHARE_CHART_TITLE,
  BROAD_SHARE_COLUMN_LABEL,
  BROAD_SHARE_HELP_BUTTON,
  BROAD_SHARE_HELP_LAYERS,
  BROAD_SHARE_HELP_METRICS,
  BROAD_SHARE_HELP_TITLE,
  BROAD_SHARE_NOTE,
  BROAD_SHARE_RANGE_LABEL,
  BROAD_SHARE_SOURCE_LABEL,
  BROAD_SHARE_SUMMARY_LABEL,
  BROAD_SHARE_SYNC_BUTTON,
  BROAD_SHARE_SYNC_FAILED,
  BROAD_SHARE_SYNCING,
  BROAD_SHARE_TABLE_TITLE,
  BROAD_SHARE_TITLE,
  BROAD_SIGNAL_EVIDENCE_TITLE,
  BROAD_SIGNAL_NOTE,
  BROAD_SIGNAL_TIMELINE_TITLE,
  BROAD_SIGNAL_TITLE,
  BROAD_SUMMARY_LABEL,
  BROAD_SUMMARY_TITLE,
  BROAD_SYNC_BUTTON,
  BROAD_SYNC_FAILED,
  BROAD_TABLE_TITLE,
  BROAD_WAVE_NOTE,
  BROAD_WAVE_TITLE,
  BROAD_BACKTEST_LABEL,
  BROAD_BACKTEST_NOTE,
  BROAD_BACKTEST_TITLE,
  CAMPAIGN_CARD_MAX,
  NATIONAL_TEAM_OF_INST_RATIO,
  SHARE_EXIT_COMPLETION_LABEL,
  SHARE_LIFECYCLE_BADGE_CLASS,
  SHARE_LIFECYCLE_LABEL,
  SHARE_SIGNAL_BADGE_CLASS,
  SHARE_SIGNAL_LABEL,
  SIGNAL_ENTER_MIN_AMOUNT,
  SIGNAL_EXIT_MIN_AMOUNT,
  SIGNAL_LEVEL_BADGE_CLASS,
  SIGNAL_LEVEL_BLOCK_CLASS,
  SIGNAL_LEVEL_LABEL,
  TRACKED_ETFS,
  YUAN_PER_YI,
} from './constants';
import type { PluginSettingsStore } from '../../host/types/plugin.types';
import type { TableColumn } from '../../host/types/table.types';
import type { BroadRepo } from './storage';
import type {
  AnchorHolding,
  BroadDeps,
  BroadScanProgress,
  ComboSharePoint,
  EtfEstimate,
  EtfQuarterRow,
  QuoteRow,
  ShareBacktestStat,
  ShareCampaignWave,
  ShareSignalDay,
  SignalDayResult,
} from './types';

/**
 * 宽基跟踪看板（插件 dsh-broad-track 的页面）
 *
 * 页面只读插件库快照渲染（零联网）；「刷新日频 / 同步季度」才发起上游请求
 * （行情批量 + 逐 ETF 资金流与日 K ≈ 29 次 / 份额申赎与持有人结构 28 次，全部串行错峰）。
 * 持仓预估与操作信号都是纯客户端的现算（estimate.ts），改设置即时重算、不触发网络请求。
 */
const props = defineProps<{
  /** 宽基跟踪仓储（由插件注入，已建表并水合快照） */
  repo: BroadRepo;
  /** 宿主能力（由插件在 apply 里从 ctx 取齐后随页面 props 下发） */
  deps: BroadDeps;
  /** 插件设置存取句柄（国家队占比存在 settings 的 national_share 键下） */
  settings: PluginSettingsStore;
}>();

/** 宿主格式化服务的短名字（模板里写 `format.percent(...)` 比 `deps.format.percent(...)` 好读） */
const format = props.deps.format;

/** 是否正在刷新日频 */
const refreshing = ref(false);
/** 是否正在同步季度 */
const syncing = ref(false);
/** 进行中的进度（null = 未进行） */
const progress = ref<BroadScanProgress | null>(null);
/** 操作结果 / 失败提示（空串 = 无提示） */
const notice = ref('');
/** 锚点编辑弹窗是否打开 */
const anchorOpen = ref(false);

/** 份额卡「图解」帮助弹窗显隐 */
const shareHelpOpen = ref(false);
/** 「近 120 日信号状态」颜色图例浮层显隐（就地解释深浅，不跳大弹窗） */
const timelineHelpOpen = ref(false);
/** 「近 120 日信号状态」被点击钉住的交易日（空串 = 无钉住；hover 与点击都能看提示） */
const pinnedTimelineDate = ref('');
/** 时间轴悬停中的交易日（空串 = 光标不在图上；十字焦点线与共享读数用） */
const hoverTimelineDate = ref('');
/** 日期 → 序列下标（十字焦点线定位用） */
const timelineDateIndex = computed(() => {
  const map = new Map<string, number>();
  comboSeries.value.forEach((point, index) => map.set(point.date, index));
  return map;
});
/** 当前生效交易日：钉住优先，其次悬停 */
const activeTimelineDate = computed(() => pinnedTimelineDate.value || hoverTimelineDate.value);
/** 当前生效交易日的序列下标（-1 = 无） */
const activeTimelineIndex = computed(() => {
  const date = activeTimelineDate.value;
  return date === '' ? -1 : timelineDateIndex.value.get(date) ?? -1;
});
/** 十字焦点线的 x 坐标（内容像素坐标） */
const crosshairLeft = computed(() =>
  activeTimelineIndex.value < 0
    ? 0
    : activeTimelineIndex.value * timelineDayWidth.value + timelineDayWidth.value / 2,
);
/** 读数行日期：钉住 / 悬停优先，否则最新交易日（常驻读数行始终有内容） */
const readoutDate = computed(() => {
  const active = activeTimelineDate.value;
  if (active !== '') return active;
  const list = comboSeries.value;
  return list.length > 0 ? list[list.length - 1].date : '';
});
/** 读数行是否处于默认态（未悬停也未钉住，显示最新交易日） */
const readoutIsDefault = computed(() => activeTimelineDate.value === '');
/** 读数行的序列点 */
const activeTimelinePoint = computed(() => {
  const index = timelineDateIndex.value.get(readoutDate.value);
  return index === undefined ? null : comboSeries.value[index] ?? null;
});
/** 读数行的信号状态（按日期查，避免两序列错位） */
const activeTimelineSignal = computed(() => {
  const date = readoutDate.value;
  if (date === '') return null;
  return shareTimelineFull.value.find((day) => day.date === date) ?? null;
});
/** 锚点编辑草稿（打开弹窗时从仓储快照初始化） */
const anchorDraft = ref<AnchorHolding[]>([]);
/** 锚点保存是否进行中 */
const anchorSaving = ref(false);

/** 快照（响应式：刷新落库后自动刷新） */
const snapshot = computed(() => props.repo.snapshot());

/** 是否有任何日频数据（决定空态） */
const hasDaily = computed(() => snapshot.value.dailyDates.length > 0);

/** 国家队占机构持仓比例（0-1；坏值回退默认） */
const nationalShare = computed<number>(() => {
  const value = props.settings.get<number>('national_share', NATIONAL_TEAM_OF_INST_RATIO);
  return typeof value === 'number' && value >= 0 && value <= 1
    ? value
    : NATIONAL_TEAM_OF_INST_RATIO;
});

/** 逐只 ETF 的持仓预估（响应式：刷新 / 改锚点 / 改设置后自动重算） */
const estimates = computed<EtfEstimate[]>(() => {
  const snap = snapshot.value;
  const anchorByCode = new Map(snap.anchors.map((item) => [item.code, item]));
  return TRACKED_ETFS.map((etf) =>
    estimateEtf({
      etf,
      dailyRows: snap.dailyByCode.get(etf.code) ?? [],
      quarters: snap.quartersByCode.get(etf.code) ?? [],
      holders: snap.holdersByCode.get(etf.code) ?? [],
      anchor: anchorByCode.get(etf.code) ?? null,
      nationalOfInst: nationalShare.value,
    }),
  );
});

/** 宽基口径合计预估（亿元） */
const totals = computed(() => sumEstimates(estimates.value));

/** 信号时间线（升序；由落库日频现算） */
const timeline = computed<SignalDayResult[]>(() =>
  buildSignalTimeline(snapshot.value.dailyByCode),
);

/** 最近 N 日信号（时间线展示用） */
const recentSignals = computed<SignalDayResult[]>(() => recentSignalDays(timeline.value));

/** 最新一个交易日的信号（null = 无数据） */
const todaySignal = computed<SignalDayResult | null>(() => {
  const list = timeline.value;
  return list.length > 0 ? list[list.length - 1] : null;
});

/** 近 5 日主力净流入合计（元） */
const mainRecent = computed(() => recentMainInflow(timeline.value));

/** 当日主力净流入合计（元；无数据为 null） */
const mainToday = computed(() => todaySignal.value?.mainInflowTotal ?? null);

/** 指数快照（页头展示；未刷新为空数组） */
const indexQuotes = computed<QuoteRow[]>(() => snapshot.value.meta.indexQuotes);

// ---------- 明细表行 ----------

/** 明细表的一行（预估 + 最新日频 + 近 5 日主力） */
interface EtfRowView extends EtfEstimate {
  /** 当日涨跌幅（%） */
  changePercent: number | null;
  /** 当日成交额（元） */
  amount: number | null;
  /** 当日主力净流入（元） */
  mainInflow: number | null;
  /** 当日超大单净流入（元） */
  superInflow: number | null;
  /** 近 5 日主力净流入合计（元） */
  mainRecent: number | null;
}

/** 明细表行（预估 join 最新日频与近 5 日主力） */
const tableRows = computed<EtfRowView[]>(() => {
  const snap = snapshot.value;
  return estimates.value.map((item) => {
    const daily = snap.dailyByCode.get(item.code) ?? [];
    const latest = daily.length > 0 ? daily[daily.length - 1] : null;
    const recent = daily.slice(-5);
    const mainRecentSum = recent.reduce(
      (sum, row) => sum + (row.mainInflow ?? 0),
      0,
    );
    return {
      ...item,
      changePercent: latest?.changePercent ?? null,
      amount: latest?.amount ?? null,
      mainInflow: latest?.mainInflow ?? null,
      superInflow: latest?.superInflow ?? null,
      mainRecent: recent.length > 0 ? mainRecentSum : null,
    };
  });
});

/** 明细表列定义 */
const tableColumns: TableColumn<EtfRowView>[] = [
  { key: 'name', label: BROAD_COLUMN_LABEL.name },
  { key: 'price', label: BROAD_COLUMN_LABEL.price, align: 'right' },
  { key: 'changePercent', label: BROAD_COLUMN_LABEL.changePercent, align: 'right' },
  { key: 'amount', label: BROAD_COLUMN_LABEL.amount, align: 'right' },
  { key: 'mainInflow', label: BROAD_COLUMN_LABEL.mainInflow, align: 'right' },
  { key: 'mainRecent', label: BROAD_COLUMN_LABEL.mainRecent, align: 'right' },
  { key: 'superInflow', label: BROAD_COLUMN_LABEL.superInflow, align: 'right' },
  { key: 'sharesEnd', label: BROAD_COLUMN_LABEL.sharesEnd, align: 'right' },
  { key: 'netSubscribe', label: BROAD_COLUMN_LABEL.netSubscribe, align: 'right' },
  { key: 'netAsset', label: BROAD_COLUMN_LABEL.netAsset, align: 'right' },
  { key: 'estHolding', label: BROAD_COLUMN_LABEL.estHolding, align: 'right' },
];

/** 明细表最小宽度（11 列，窄容器下横向滚动） */
const tableMinWidth = 1080;

// ---------- 季度申赎表 ----------

/** 季度表的一行（join ETF 名） */
interface QuarterRowView extends EtfQuarterRow {
  /** ETF 展示名 */
  etfName: string;
}

/** 季度申赎表行（每只 ETF 取最近两期，按报告期降序） */
const quarterRows = computed<QuarterRowView[]>(() => {
  const snap = snapshot.value;
  const rows: QuarterRowView[] = [];
  for (const etf of TRACKED_ETFS) {
    const list = (snap.quartersByCode.get(etf.code) ?? [])
      .slice()
      .sort((left, right) => (left.periodEnd < right.periodEnd ? 1 : -1))
      .slice(0, 2);
    for (const row of list) rows.push({ ...row, etfName: etf.name });
  }
  return rows;
});

/** 季度申赎表列定义 */
const quarterColumns: TableColumn<QuarterRowView>[] = [
  { key: 'etfName', label: BROAD_QUARTER_COLUMN_LABEL.name },
  { key: 'periodEnd', label: BROAD_QUARTER_COLUMN_LABEL.periodEnd },
  { key: 'subscribe', label: BROAD_QUARTER_COLUMN_LABEL.subscribe, align: 'right' },
  { key: 'redeem', label: BROAD_QUARTER_COLUMN_LABEL.redeem, align: 'right' },
  { key: 'netSubscribe', label: BROAD_QUARTER_COLUMN_LABEL.netSubscribe, align: 'right' },
  { key: 'sharesEnd', label: BROAD_QUARTER_COLUMN_LABEL.sharesEnd, align: 'right' },
  { key: 'netAsset', label: BROAD_QUARTER_COLUMN_LABEL.netAsset, align: 'right' },
  { key: 'changeRate', label: BROAD_QUARTER_COLUMN_LABEL.changeRate, align: 'right' },
];

/** 季度表最小宽度 */
const quarterMinWidth = 760;

// ---------- 锚点编辑 ----------

/**
 * 打开锚点编辑弹窗（草稿从仓储快照初始化；无锚点的 ETF 给空条目）
 */
const openAnchor = (): void => {
  const snap = snapshot.value;
  const byCode = new Map(snap.anchors.map((item) => [item.code, item]));
  anchorDraft.value = TRACKED_ETFS.map((etf) => {
    const existing = byCode.get(etf.code);
    if (existing) return { ...existing };
    return { code: etf.code, periodEnd: ANCHOR_DEFAULT_PERIOD, sharesYi: 0, source: '' };
  });
  anchorOpen.value = true;
};

/**
 * 按持有人结构一键推算锚点（期末总份额 × 机构持有比例 × 国家队占比）
 */
const autoFillAnchors = (): void => {
  const snap = snapshot.value;
  anchorDraft.value = anchorDraft.value.map((draft) => {
    const holders = snap.holdersByCode.get(draft.code) ?? [];
    const latest = holders.length > 0 ? holders[0] : null;
    if (!latest || latest.totalSharesYi === null || latest.instRatio === null) return draft;
    const shares = latest.totalSharesYi * (latest.instRatio / 100) * nationalShare.value;
    return {
      ...draft,
      sharesYi: Number(shares.toFixed(2)),
      periodEnd: latest.periodEnd,
      source: `按持有人结构推算（${latest.periodEnd}）`,
    };
  });
};

/**
 * 保存锚点（全量替换）
 */
const saveAnchors = async (): Promise<void> => {
  anchorSaving.value = true;
  try {
    const cleaned = anchorDraft.value
      .filter((draft) => draft.code !== '' && Number.isFinite(draft.sharesYi))
      .map((draft) => ({
        code: draft.code,
        periodEnd: draft.periodEnd,
        sharesYi: draft.sharesYi,
        source: draft.source,
      }));
    await props.repo.saveAnchors(cleaned);
    anchorOpen.value = false;
    notice.value = `锚点已保存（${cleaned.length} 只 ETF）`;
  } catch (error) {
    notice.value = `${BROAD_ANCHOR_SAVE_FAILED}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    anchorSaving.value = false;
  }
};

/**
 * 草稿行的折合金额（亿元；用该 ETF 最新价）
 * @param code ETF 代码
 * @returns 折合金额文本；无草稿或无价格为占位符
 */
const draftAmountYi = (code: string): string => {
  const draft = anchorDraft.value.find((item) => item.code === code);
  const latest = snapshot.value.dailyByCode.get(code) ?? [];
  const price = latest.length > 0 ? latest[latest.length - 1].price : null;
  if (!draft || price === null) return BROAD_PLACEHOLDER;
  return ((draft.sharesYi * price) / YUAN_PER_YI).toFixed(1);
};

// ---------- 份额口径（国家队主口径） ----------

/** 是否正在同步份额序列 */
const shareSyncing = ref(false);

/** 组合逐日份额序列（由落库份额行现算） */
const comboSeries = computed<ComboSharePoint[]>(() =>
  buildComboSeries(snapshot.value.sharesByCode),
);

/** 是否有份额数据 */
const hasShares = computed(() => comboSeries.value.length > 0);

/**
 * 国家队持仓估算序列（日频；锚点 + 确认操作日按占比参与申赎）
 *
 * 纯前端现算：输入全来自仓储快照与信号时间线（改锚点 / 调设置 / 刷新后自动重算）。
 * 依赖 shareTimeline 的生命周期判定（低频操作假设，见 buildNationalSeries）。
 */
const nationalSeries = computed<NationalSeriesPoint[]>(() =>
  buildNationalSeries(
    snapshot.value.sharesByCode,
    snapshot.value.holdersByCode,
    snapshot.value.anchors,
    nationalShare.value,
    new Map(shareTimeline.value.map((day) => [day.date, day.lifecycle])),
  ),
);

/** 国家队估算序列按日期索引（读数行查值用） */
const nationalByDate = computed(() => {
  const map = new Map<string, NationalSeriesPoint>();
  for (const point of nationalSeries.value) map.set(point.date, point);
  return map;
});

/** 读数行 / 悬停日可见的国家队估算点（null = 该日无估算，如锚点前） */
const activeNationalPoint = computed<NationalSeriesPoint | null>(() => {
  const date = readoutDate.value;
  if (date === '') return null;
  return nationalByDate.value.get(date) ?? null;
});

/**
 * 国家队估算曲线路径（份额折线行内叠加的虚线）
 *
 * ⚠️ **独立归一**：国家队持仓是组合总份额的子集，量级只有两三成，
 * 沿用组合折线的 min/max 归一会整条压在底部失去形状；这里用估算序列
 * 自身的 min/max 铺满行高（与 sharePath 同一 viewBox 0..100），
 * 图例与读数行明示「量纲独立，看趋势不看刻度」。
 */
const nationalPath = computed(() => {
  const national = nationalSeries.value;
  const list = comboSeries.value;
  if (national.length < 2 || list.length < 2) return '';
  // 估算点 → 组合序列索引（x 坐标必须与折线同一时间刻度）
  const indexByDate = new Map<string, number>();
  list.forEach((point, index) => indexByDate.set(point.date, index));
  const values = national.map((point) => point.nationalSharesYi);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const height = 100;
  const segments: string[] = [];
  let open = false;
  for (const point of national) {
    const index = indexByDate.get(point.date);
    if (index === undefined) {
      open = false; // 该日在组合序列之外（理论上不会发生），断线防御
      continue;
    }
    const w = timelineDayWidth.value;
    const x = index * w + w / 2;
    const y = height - ((point.nationalSharesYi - min) / span) * height;
    segments.push(`${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
    open = true;
  }
  return segments.join(' ');
});

/** 逐日份额信号（图表标注用） */
const shareTimeline = computed<ShareSignalDay[]>(() =>
  buildShareSignalTimeline(comboSeries.value),
);

/** 战役生命周期列表（含疑似未确认的战役；界面主展示） */
const shareCampaigns = computed<ShareCampaignWave[]>(() =>
  buildShareCampaigns(comboSeries.value),
);

/**
 * 战役卡展示的「有意义」战役：已确认的，或疑似但金额达到确认门槛一半的，
 * 最多展示最近 15 场 —— 方向段状态机会把 1 日的小抖动也开成战役
 * （真实序列 679 日有 233 场，全量渲染会淹没重点）。
 */
const notableCampaigns = computed<ShareCampaignWave[]>(() => {
  const minFlow =
    Math.min(SIGNAL_ENTER_MIN_AMOUNT, SIGNAL_EXIT_MIN_AMOUNT) / 2;
  const list = shareCampaigns.value.filter(
    (campaign) =>
      campaign.confirmDate !== null ||
      Math.abs(campaign.netFlowYi) >= minFlow,
  );
  return list.slice(-CAMPAIGN_CARD_MAX);
});

/** 当前所处生命周期状态（最新交易日的状态） */
const currentLifecycle = computed<ShareSignalDay['lifecycle'] | null>(
  () => shareTimeline.value[shareTimeline.value.length - 1]?.lifecycle ?? null,
);

/**
 * 生命周期色块类名（近 20 日时间条用）
 * @param lifecycle 生命周期状态
 * @returns 色块类名（只用宿主白名单已有的类）
 */
const lifecycleBarClass = (lifecycle: ShareSignalDay['lifecycle']): string => {
  if (lifecycle === 'entry_confirmed') return 'bg-up';
  if (lifecycle === 'entry_suspected') return 'bg-up-weak';
  if (lifecycle === 'exit_confirmed') return 'bg-down';
  if (lifecycle === 'exit_suspected') return 'bg-down-weak';
  return 'bg-flat-weak';
};

/** 时间轴每天占的像素（默认档位；柱宽 + 1px 间隙），全历史按此铺开、视口拖动 */
const TIMELINE_DAY_WIDTH = 6;
/** 滚轮缩放档位（每天像素，从「压缩全景」到「逐日放大」） */
const TIMELINE_DAY_WIDTH_STEPS = [3, 4, 6, 9, 14, 20, 28];
/** 当前档位（滚轮调整） */
const timelineDayWidth = ref(TIMELINE_DAY_WIDTH);
/** 净申赎行高随缩放档位同步放大（放大后图不至于又宽又扁） */
const TIMELINE_ROW_HEIGHTS: Record<number, number> = { 3: 48, 4: 56, 6: 64, 9: 88, 14: 116, 20: 144, 28: 168 };
/** 当前行高（px） */
const flowRowHeight = computed(() => TIMELINE_ROW_HEIGHTS[timelineDayWidth.value] ?? 64);
/** 色带行高（约为柱行的 1/4，同样随档位走） */
const bandRowHeight = computed(() => Math.min(32, Math.max(12, Math.round(flowRowHeight.value / 4))));

/** 逐日份额信号（全历史；与净申赎柱同刻度铺开） */
const shareTimelineFull = computed<ShareSignalDay[]>(() => shareTimeline.value);

/** 全历史每日净申赎柱（高度开方压缩：按全历史最大值归一后取平方根，小流量日也可见） */
const flowBars = computed(() => {
  const list = comboSeries.value;
  const max = Math.max(...list.map((point) => Math.abs(point.netFlowYi ?? 0)), 1);
  return list.map((point) => ({
    date: point.date,
    value: point.netFlowYi,
    height: Math.sqrt(Math.abs(point.netFlowYi ?? 0) / max) * 100,
  }));
});

/** 份额折线路径（x = 逐日固定像素，与柱、色带同一时间刻度） */
const sharePath = computed(() => {
  const list = comboSeries.value;
  if (list.length < 2) return '';
  const values = list.map((point) => point.totalSharesYi);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const height = 100;
  return list
    .map((point, index) => {
      const w = timelineDayWidth.value;
      const x = index * w + w / 2;
      const y = height - ((point.totalSharesYi - min) / span) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

/** 时间轴内容总宽（px） */
const timelineWidth = computed(() => comboSeries.value.length * timelineDayWidth.value);

/** 季度刻度（每季首月的位置，像素定位与内容同宽） */
const timelineQuarterMarks = computed(() => {
  const list = comboSeries.value;
  const marks: { label: string; left: number }[] = [];
  let prevMonth = '';
  list.forEach((point, index) => {
    const ym = point.date.slice(0, 7);
    if (ym === prevMonth) return;
    prevMonth = ym;
    const month = Number(point.date.slice(5, 7));
    if (month !== 1 && month !== 4 && month !== 7 && month !== 10) return;
    marks.push({ label: ym, left: index * timelineDayWidth.value });
  });
  return marks;
});

/** 时间轴视口引用（拖动滚动容器） */
const timelineViewport = ref<HTMLElement | null>(null);
/** 拖动中的起点（null = 未拖动） */
let timelineDragStart: { x: number; left: number } | null = null;
/** 是否处于拖动中（光标样式用） */
const timelineDragging = ref(false);
/** 本次按下后是否发生了拖动（用于抑制拖动结束后的误点击钉住） */
const timelineDidDrag = ref(false);
/** 数据首次就绪后自动对齐到最新日期（右端） */
const timelineAligned = ref(false);

/**
 * 按下：记录起点并捕获指针
 * @param event 指针按下事件
 */
const onTimelinePointerDown = (event: PointerEvent) => {
  const el = timelineViewport.value;
  if (!el) return;
  timelineDragStart = { x: event.clientX, left: el.scrollLeft };
  timelineDragging.value = true;
  timelineDidDrag.value = false;
  el.setPointerCapture(event.pointerId);
};

/**
 * 移动：按位移反向滚动视口（左拖右移）
 * @param event 指针移动事件
 */
const onTimelinePointerMove = (event: PointerEvent) => {
  const el = timelineViewport.value;
  if (!el) return;
  // 悬停跟踪：光标下的交易日驱动十字焦点线与共享读数（拖动中也跟随）
  const rect = el.getBoundingClientRect();
  const index = Math.floor((event.clientX - rect.left + el.scrollLeft) / timelineDayWidth.value);
  const list = comboSeries.value;
  hoverTimelineDate.value = index >= 0 && index < list.length ? list[index].date : '';
  if (!timelineDragStart) return;
  const dx = event.clientX - timelineDragStart.x;
  if (Math.abs(dx) > 4) timelineDidDrag.value = true;
  el.scrollLeft = timelineDragStart.left - dx;
};

/**
 * 抬起：结束拖动
 * @param event 指针抬起事件
 */
const onTimelinePointerUp = (event: PointerEvent) => {
  const el = timelineViewport.value;
  if (el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
  timelineDragStart = null;
  timelineDragging.value = false;
};

/**
 * 光标离开视口：清掉悬停日（钉住不受影响）
 */
const onTimelinePointerLeave = (): void => {
  hoverTimelineDate.value = '';
};

/**
 * 点击视口：拖动过后忽略；否则钉住 / 取消钉住悬停日（十字焦点线与读数随之固定）
 */
const onTimelineClick = () => {
  if (timelineDidDrag.value) {
    timelineDidDrag.value = false;
    return;
  }
  const date = hoverTimelineDate.value;
  if (date === '') return;
  pinnedTimelineDate.value = pinnedTimelineDate.value === date ? '' : date;
};

/**
 * 滚轮缩放时间轴（以光标下的日期为锚点，放大 / 缩小每天像素）
 * @param event 滚轮事件（上滚放大、下滚缩小）
 */
const onTimelineWheel = (event: WheelEvent) => {
  const el = timelineViewport.value;
  if (!el) return;
  const steps = TIMELINE_DAY_WIDTH_STEPS;
  const idx = steps.indexOf(timelineDayWidth.value);
  const next = event.deltaY < 0
    ? steps[Math.min(idx + 1, steps.length - 1)]
    : steps[Math.max(idx - 1, 0)];
  if (next === timelineDayWidth.value) return;
  event.preventDefault();
  // 记住光标位置对应的内容比例，缩放后让同一日期回到光标下方
  const cursorX = event.clientX - el.getBoundingClientRect().left;
  const anchor = (el.scrollLeft + cursorX) / Math.max(el.scrollWidth, 1);
  timelineDayWidth.value = next;
  void nextTick(() => {
    el.scrollLeft = anchor * el.scrollWidth - cursorX;
  });
};

/** 把视口滚到最右端（最新交易日） */
const alignTimelineRight = () => {
  const el = timelineViewport.value;
  if (el) el.scrollLeft = el.scrollWidth;
};

// 数据首次就绪（或从空变非空）后，把视口对齐到最右端（最新交易日）。
// 必须等 DOM 真正渲染完（flush: 'post' + 双 rAF），否则 scrollWidth 还是 0，滚不动。
watch(
  () => comboSeries.value.length,
  (length) => {
    if (length === 0 || timelineAligned.value) return;
    timelineAligned.value = true;
    requestAnimationFrame(() => requestAnimationFrame(alignTimelineRight));
  },
  { flush: 'post' },
);

/** 回测统计 */
const backtestStats = computed<ShareBacktestStat[]>(() =>
  runShareBacktest(comboSeries.value),
);

/** 最新交易日的组合快照（null = 无数据） */
const latestCombo = computed<ComboSharePoint | null>(() => {
  const list = comboSeries.value;
  return list.length > 0 ? list[list.length - 1] : null;
});

/** 近 5 日净申赎合计 */
const recentFlow = computed(() => recentNetFlow(comboSeries.value, 5));

/** 份额曲线的时间轴刻度（首 / 中 / 末） */
const shareAxis = computed(() => {
  const list = comboSeries.value;
  if (list.length === 0) return { first: '', middle: '', last: '' };
  const middle = list[Math.floor(list.length / 2)];
  return {
    first: list[0].date.slice(0, 7),
    middle: middle.date.slice(0, 7),
    last: list[list.length - 1].date.slice(0, 7),
  };
});

/** 份额明细表的一行 */
interface ShareRowView {
  /** ETF 代码 */
  code: string;
  /** ETF 展示名 */
  name: string;
  /** 跟踪指数 */
  indexName: string;
  /** 最新总份额（亿份） */
  sharesYi: number | null;
  /** 最新日份额变动（亿份） */
  deltaYi: number | null;
  /** 最新日估算净申赎（亿元） */
  amountYi: number | null;
  /** 最新收盘价 */
  price: number | null;
  /** 近 5 日份额变动合计（亿份） */
  recentDeltaYi: number | null;
  /** 数据源 */
  source: string;
}

/** 份额明细表行（每只 ETF 取最新一行 + 近 5 日变动） */
const shareRows = computed<ShareRowView[]>(() => {
  const snap = snapshot.value;
  return TRACKED_ETFS.map((etf) => {
    const list = snap.sharesByCode.get(etf.code) ?? [];
    const latest = list.length > 0 ? list[list.length - 1] : null;
    const recent = list.slice(-5);
    return {
      code: etf.code,
      name: etf.name,
      indexName: etf.indexName,
      sharesYi: latest?.sharesYi ?? null,
      deltaYi: latest?.deltaYi ?? null,
      amountYi: latest?.amountYi ?? null,
      price: latest?.price ?? null,
      recentDeltaYi:
        recent.length > 0 ? recent.reduce((sum, row) => sum + row.deltaYi, 0) : null,
      source: latest?.source ?? 'sse',
    };
  });
});

/** 份额明细表列定义 */
const shareColumns: TableColumn<ShareRowView>[] = [
  { key: 'name', label: BROAD_SHARE_COLUMN_LABEL.name },
  { key: 'index', label: BROAD_SHARE_COLUMN_LABEL.index },
  { key: 'shares', label: BROAD_SHARE_COLUMN_LABEL.shares, align: 'right' },
  { key: 'delta', label: BROAD_SHARE_COLUMN_LABEL.delta, align: 'right' },
  { key: 'flow', label: BROAD_SHARE_COLUMN_LABEL.flow, align: 'right' },
  { key: 'price', label: BROAD_SHARE_COLUMN_LABEL.price, align: 'right' },
  { key: 'recent', label: BROAD_SHARE_COLUMN_LABEL.recent, align: 'right' },
  { key: 'source', label: BROAD_SHARE_COLUMN_LABEL.source },
];

/** 份额明细表最小宽度 */
const shareMinWidth = 900;

/**
 * 同步份额序列（用户点击触发；增量入库，只补缺失日期）
 */
const onSyncShares = async (): Promise<void> => {
  shareSyncing.value = true;
  progress.value = null;
  notice.value = '';
  try {
    const result = await syncShareSeries(props.deps, props.repo, (next) => {
      progress.value = next;
    });
    const warnText = result.warnings.length > 0 ? `，${result.warnings.length} 条告警` : '';
    notice.value =
      `份额同步完成：新增 ${result.rowCount} 行（${result.requestCount} 次请求）`
      + `${result.earliestDate ? `，覆盖 ${result.earliestDate} ~ ${result.latestDate}` : ''}${warnText}`;
  } catch (error) {
    notice.value = `${BROAD_SHARE_SYNC_FAILED}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    shareSyncing.value = false;
    progress.value = null;
  }
};

// ---------- 刷新动作 ----------

/**
 * 刷新日频数据（用户点击触发）
 */
const onRefreshDaily = async (): Promise<void> => {
  refreshing.value = true;
  progress.value = null;
  notice.value = '';
  try {
    const result = await refreshDaily(props.deps, props.repo, (next) => {
      progress.value = next;
    });
    const warnText = result.warnings.length > 0 ? `，${result.warnings.length} 条告警` : '';
    notice.value = `日频刷新完成：${result.rowCount} 行${warnText}`;
  } catch (error) {
    notice.value = `${BROAD_REFRESH_FAILED}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    refreshing.value = false;
    progress.value = null;
  }
};

/**
 * 同步季度数据（用户点击触发）
 */
const onSyncQuarter = async (): Promise<void> => {
  syncing.value = true;
  progress.value = null;
  notice.value = '';
  try {
    const result = await syncQuarter(props.deps, props.repo, (next) => {
      progress.value = next;
    });
    const warnText = result.warnings.length > 0 ? `，${result.warnings.length} 条告警` : '';
    notice.value =
      `季度同步完成：份额 ${result.quarterCount} 行、持有人 ${result.holderCount} 行${warnText}`;
  } catch (error) {
    notice.value = `${BROAD_SYNC_FAILED}：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    syncing.value = false;
    progress.value = null;
  }
};

// ---------- 格式化助手 ----------

/**
 * 元 → 亿元文本（保留指定位数；null 占位）
 * @param value 金额（元）；null 返回占位符
 * @param digits 保留小数位数
 * @returns 亿元文本
 */
const fmtYi = (value: number | null, digits = 2): string =>
  value === null ? BROAD_PLACEHOLDER : (value / YUAN_PER_YI).toFixed(digits);

/**
 * ETF 价格三位小数（东财 decimal=3 口径）
 * @param value 价格；null 返回占位符
 * @returns 价格文本
 */
const fmtPrice = (value: number | null): string =>
  value === null ? BROAD_PLACEHOLDER : value.toFixed(3);

/**
 * 指数价格（点位，两位小数）
 * @param value 点位；null 返回占位符
 * @returns 点位文本
 */
const fmtIndexPrice = (value: number | null): string =>
  value === null ? BROAD_PLACEHOLDER : value.toFixed(2);

/**
 * 数值 → 涨跌语义类名（红涨绿跌；净流入为正 = 涨向）
 * @param value 数值；null 为中性色
 * @returns 语义类名
 */
const trendClass = (value: number | null): string => {
  if (value === null) return 'text-text-tertiary';
  return format.trendClass(format.trend(value));
};

/**
 * 时间戳 → 相对时间（null 占位）
 * @param timestamp 毫秒时间戳；null 返回占位符
 * @returns 相对时间文本
 */
const fmtRelative = (timestamp: number | null): string =>
  timestamp === null ? BROAD_PLACEHOLDER : format.relativeTime(timestamp);

/**
 * 信号档位徽标类名
 * @param level 信号档位
 * @returns 徽标类名
 */
const signalBadgeClass = (level: SignalDayResult['level']): string =>
  SIGNAL_LEVEL_BADGE_CLASS[level];

/**
 * 日期短展示（MM-DD）
 * @param date ISO 日期（YYYY-MM-DD）
 * @returns MM-DD 文本
 */
const shortDate = (date: string): string => date.slice(5);
</script>

<template>
  <div class="space-y-4">
    <!-- 页头：标题 + 口径 + 刷新入口 + 元信息 -->
    <component :is="deps.ui.Card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-1.5 text-base font-semibold text-text">
            <component :is="deps.ui.Icon" :name="BROAD_MENU_ICON" :size="16" />
            {{ BROAD_PAGE_TITLE }}
          </h1>
          <p class="mt-1 text-xs leading-relaxed text-text-secondary">{{ BROAD_PAGE_SUBTITLE }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span v-if="progress" class="text-xs tabular-nums text-text-tertiary">
            {{ BROAD_RUNNING }} {{ progress.done }}/{{ progress.total }}
          </span>
          <component
            :is="deps.ui.Button"
            :disabled="shareSyncing || refreshing || syncing"
            @click="onSyncShares"
          >
            <component :is="deps.ui.Icon" :name="BROAD_MENU_ICON" :size="14" />
            {{ shareSyncing ? BROAD_SHARE_SYNCING : BROAD_SHARE_SYNC_BUTTON }}
          </component>
          <component :is="deps.ui.Button" variant="ghost" :disabled="refreshing || syncing || shareSyncing" @click="onRefreshDaily">
            {{ BROAD_REFRESH_BUTTON }}
          </component>
          <component :is="deps.ui.Button" variant="ghost" :disabled="refreshing || syncing || shareSyncing" @click="onSyncQuarter">
            {{ BROAD_SYNC_BUTTON }}
          </component>
        </div>
      </div>

      <!-- 元信息：刷新时间 / 覆盖 / 告警数 -->
      <div
        v-if="hasDaily || hasShares"
        class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary"
      >
        <span v-if="hasShares">{{ BROAD_HEADER_LABEL.dailyAt }}：{{ fmtRelative(snapshot.meta.shareSyncedAt) }}</span>
        <span v-if="hasDaily">{{ BROAD_HEADER_LABEL.quarterAt }}：{{ fmtRelative(snapshot.meta.quarterRefreshedAt) }}</span>
        <span>{{ BROAD_HEADER_LABEL.etfCount }}：{{ TRACKED_ETFS.length }}</span>
        <span v-if="hasDaily">{{ BROAD_HEADER_LABEL.dayCount }}：{{ snapshot.dailyDates.length }}</span>
        <span v-if="hasShares">份额交易日：{{ snapshot.shareDates.length }}</span>
        <button
          type="button"
          class="pressable rounded px-1 py-0.5 text-primary active:scale-95"
          @click="openAnchor"
        >
          编辑锚点
        </button>
      </div>

      <p
        v-if="notice"
        class="mt-2 rounded-lg bg-primary-weak px-2 py-1.5 text-xs leading-relaxed text-primary"
      >
        {{ notice }}
      </p>
    </component>

    <!-- 空态：未同步过份额 -->
    <component :is="deps.ui.Card" v-if="!hasShares && !hasDaily">
      <component :is="deps.ui.Empty" :text="BROAD_EMPTY_TEXT" />
      <p class="mt-3 text-center text-xs leading-relaxed text-text-tertiary">
        「同步份额序列」会从交易所拉取 2024-01 至今的逐日份额（约 680 个交易日，数十秒完成），
        结果落本地插件库，之后读库即渲染、零联网。
      </p>
    </component>

    <template v-if="hasShares">
      <!-- 份额序列主口径：汇总 + 曲线 + 净申赎柱 -->
      <!-- 标题行：BaseCard 的 title 是纯文本插槽，图标要贴着标题文字只能自定义头部 -->
      <component :is="deps.ui.Card">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 class="flex items-center gap-1 text-sm font-semibold text-text">
            {{ BROAD_SHARE_TITLE }}
            <button
              type="button"
              class="pressable rounded text-text-tertiary hover:text-primary"
              :title="BROAD_SHARE_HELP_BUTTON"
              @click="shareHelpOpen = true"
            >
              <component :is="deps.ui.Icon" name="help" :size="13" />
            </button>
          </h2>
          <component
            :is="deps.ui.Button"
            variant="ghost"
            :disabled="shareSyncing || refreshing || syncing"
            @click="onSyncShares"
          >
            {{ BROAD_SHARE_SYNC_BUTTON }}
          </component>
        </div>

        <!-- 汇总指标 -->
        <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SHARE_SUMMARY_LABEL.totalShares }}</p>
            <p class="mt-0.5 text-2xl font-semibold tabular-nums text-text">
              {{ latestCombo ? latestCombo.totalSharesYi.toFixed(0) : BROAD_PLACEHOLDER }}
              <span class="text-sm font-normal text-text-tertiary">亿份</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SHARE_SUMMARY_LABEL.todayFlow }}</p>
            <p
              class="mt-0.5 text-lg font-medium tabular-nums"
              :class="trendClass(latestCombo?.netFlowYi ?? null)"
            >
              {{
                latestCombo?.netFlowYi === null || latestCombo?.netFlowYi === undefined
                  ? BROAD_PLACEHOLDER
                  : `${latestCombo.netFlowYi >= 0 ? '+' : ''}${latestCombo.netFlowYi.toFixed(0)}`
              }}
              <span class="text-xs font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SHARE_SUMMARY_LABEL.recentFlow }}</p>
            <p
              class="mt-0.5 text-lg font-medium tabular-nums"
              :class="trendClass(recentFlow.totalYi)"
            >
              {{ recentFlow.totalYi >= 0 ? '+' : '' }}{{ recentFlow.totalYi.toFixed(0) }}
              <span class="text-xs font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SHARE_SUMMARY_LABEL.indexLevel }}</p>
            <p class="mt-0.5 text-lg font-medium tabular-nums text-text">
              {{ latestCombo?.avgPrice === null || latestCombo?.avgPrice === undefined
                ? BROAD_PLACEHOLDER
                : latestCombo.avgPrice.toFixed(1) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SHARE_SUMMARY_LABEL.days }}</p>
            <p class="mt-0.5 text-lg font-medium tabular-nums text-text">
              {{ comboSeries.length }}
            </p>
          </div>
        </div>

        <!-- 份额走势 + 每日净申赎 + 信号色带：全历史同刻度铺开，左右拖动查看 -->
        <div class="mt-4">
          <p class="relative mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary">
            {{ BROAD_SHARE_CHART_TITLE }}
            <button
              type="button"
              class="pressable rounded text-text-tertiary hover:text-primary"
              title="点击查看颜色深浅图例"
              @click="timelineHelpOpen = !timelineHelpOpen"
            >
              <component :is="deps.ui.Icon" name="help" :size="12" />
            </button>
            <span class="text-[10px] font-normal text-text-tertiary">（左右拖动查看更早 · 悬停出十字线与读数 · 点击钉住）</span>
            <!-- 颜色深浅图例浮层（就地解释，点外部关闭） -->
            <template v-if="timelineHelpOpen">
              <span
                class="fixed"
                style="inset: 0; z-index: 20"
                @click="timelineHelpOpen = false"
              />
              <span
                class="absolute rounded-lg border border-flat-weak bg-surface shadow-md"
                style="top: 100%; left: 0; margin-top: 6px; z-index: 30; width: 320px; padding: 10px 12px"
              >
                <span class="block text-[11px] font-medium text-text">颜色深浅 = 判定进度</span>
                <span class="mt-1.5 block space-y-1 text-[11px] leading-relaxed text-text-secondary">
                  <span class="flex items-center gap-2">
                    <span class="inline-block shrink-0 rounded-[2px] bg-up" style="width: 12px; height: 12px" />
                    确认进场（连续同向 + 累计金额 + 回撤位置全齐）
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="inline-block shrink-0 rounded-[2px] bg-up" style="width: 12px; height: 12px; opacity: 0.4" />
                    疑似进场（净申购量级已达门槛，位置 / 连续性未全齐）
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="inline-block shrink-0 rounded-[2px] bg-down" style="width: 12px; height: 12px" />
                    确认退场（退场三条件全齐）
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="inline-block shrink-0 rounded-[2px] bg-down" style="width: 12px; height: 12px; opacity: 0.4" />
                    疑似退场（净赎回量级已达门槛，条件未全齐）
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="inline-block shrink-0 rounded-[2px] bg-flat-weak" style="width: 12px; height: 12px" />
                    观望 / 进场结束 / 退场结束 / 持仓观望
                  </span>
                </span>
                <span class="mt-1.5 block text-[11px] text-text-tertiary">
                  红 = 买（A 股习惯），绿 = 卖；三行共用十字焦点线，数据读数见标题下方常驻读数行（悬停 / 点击更新，点击可钉住）。
                </span>
              </span>
            </template>
          </p>
          <!-- 常驻读数行：钉住 / 悬停日优先，否则最新交易日 -->
          <div class="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span class="font-semibold tabular-nums text-text">
              {{ activeTimelinePoint ? activeTimelinePoint.date : '—' }}
            </span>
            <span
              class="tabular-nums"
              :class="trendClass(activeTimelinePoint?.netFlowYi ?? null)"
            >
              净申赎 {{
                activeTimelinePoint?.netFlowYi === null || activeTimelinePoint?.netFlowYi === undefined
                  ? '—'
                  : `${activeTimelinePoint.netFlowYi >= 0 ? '+' : ''}${activeTimelinePoint.netFlowYi.toFixed(0)} 亿`
              }}
            </span>
            <span class="tabular-nums text-text">
              总份额 {{ activeTimelinePoint ? activeTimelinePoint.totalSharesYi.toFixed(0) : '—' }} 亿份
            </span>
            <span class="tabular-nums text-text-tertiary">
              国家队估算 {{
                activeNationalPoint === null
                  ? '—'
                  : `${activeNationalPoint.nationalSharesYi.toFixed(0)} 亿份`
              }}<template v-if="activeNationalPoint?.nationalAmountYi !== null && activeNationalPoint?.nationalAmountYi !== undefined">
                ≈ {{ activeNationalPoint.nationalAmountYi.toFixed(0) }} 亿元
              </template>
            </span>
            <span
              v-if="activeTimelineSignal"
              class="rounded-full px-2 py-0.5 text-[11px] font-medium"
              :class="SHARE_LIFECYCLE_BADGE_CLASS[activeTimelineSignal.lifecycle]"
            >
              {{ SHARE_LIFECYCLE_LABEL[activeTimelineSignal.lifecycle] }}{{ activeTimelineSignal.level !== 'none' ? `（${SHARE_SIGNAL_LABEL[activeTimelineSignal.level]}）` : '' }}
            </span>
            <span v-if="readoutIsDefault" class="text-[10px] text-text-tertiary">
              最新交易日 · 悬停 / 点击查看其他日期
            </span>
          </div>
          <!-- 拖动视口：内容按每天固定宽度铺开，横向拖动平移 -->
          <div
            ref="timelineViewport"
            class="relative overflow-hidden"
            :style="{ cursor: timelineDragging ? 'grabbing' : 'grab', userSelect: 'none' }"
            @pointerdown="onTimelinePointerDown"
            @pointermove="onTimelinePointerMove"
            @pointerup="onTimelinePointerUp"
            @pointercancel="onTimelinePointerUp"
            @pointerleave="onTimelinePointerLeave"
            @wheel="onTimelineWheel"
            @click="onTimelineClick"
          >
            <div :style="{ width: `${timelineWidth}px`, paddingTop: '26px' }">
              <!-- 三行共用十字焦点线的容器 -->
              <div class="relative">
                <!-- 行1：组合总份额折线（独立一行，不被柱子遮挡） -->
                <p class="sticky left-0 text-xs font-medium text-text-secondary">
                  组合总份额<span v-if="nationalPath" class="font-normal text-text-tertiary">（虚线 = 国家队估算，量纲独立）</span>
                </p>
                <div class="relative mt-1" :style="{ height: `${flowRowHeight}px` }">
                  <svg
                    class="pointer-events-none absolute h-full w-full"
                    style="inset: 0"
                    :viewBox="`0 0 ${timelineWidth} 100`"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="组合总份额走势与国家队估算持仓"
                  >
                    <!-- sharePath 是路径语法（M/L），必须用 path 的 d 属性；polyline points 只认坐标对 -->
                    <path
                      :d="sharePath"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      vector-effect="non-scaling-stroke"
                      class="text-primary"
                    />
                    <!-- 国家队估算持仓：独立归一的虚线，只示意趋势（锚点前无数据自然断线）。
                         色彩用白名单内的中性灰（plugin-classes.txt 无 text-warning）。 -->
                    <path
                      v-if="nationalPath"
                      :d="nationalPath"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-dasharray="5 3"
                      vector-effect="non-scaling-stroke"
                      class="text-text-secondary"
                      style="opacity: 0.95"
                    />
                  </svg>
                </div>
                <!-- 行2：每日净申赎柱 -->
                <p class="sticky left-0 mt-2 text-xs font-medium text-text-secondary">每日净申赎</p>
                <div class="relative mt-1" :style="{ height: `${flowRowHeight}px` }">
                  <div class="flex h-full items-end" style="gap: 1px">
                    <div
                      v-for="bar in flowBars"
                      :key="bar.date"
                      class="group relative"
                      :style="{ width: `${timelineDayWidth - 1}px`, height: `${Math.max(bar.height, 1)}%` }"
                    >
                      <div
                        class="h-full w-full"
                        :class="(bar.value ?? 0) >= 0 ? 'bg-up' : 'bg-down'"
                        style="opacity: 0.8"
                      />
                    </div>
                  </div>
                </div>
                <!-- 行3：逐日生命周期色带（同一时间刻度） -->
                <p class="sticky left-0 mt-2 text-xs font-medium text-text-secondary">信号状态</p>
                <div class="mt-1 flex" style="gap: 1px">
                  <div
                    v-for="day in shareTimelineFull"
                    :key="day.date"
                    class="group relative"
                    :class="lifecycleBarClass(day.lifecycle)"
                    :style="{ width: `${timelineDayWidth - 1}px`, height: `${bandRowHeight}px` }"
                  />
                </div>
                <!-- 十字焦点线：贯穿三行，悬停 / 钉住的交易日 -->
                <div
                  v-if="activeTimelineIndex >= 0"
                  class="pointer-events-none absolute text-text-tertiary"
                  :style="{
                    left: `${crosshairLeft}px`,
                    top: 0,
                    bottom: 0,
                    width: '1px',
                    backgroundColor: 'currentColor',
                    opacity: 0.55,
                  }"
                />
              </div>
              <!-- 季度刻度 -->
              <div class="relative mt-1 h-4">
                <span
                  v-for="(mark, index) in timelineQuarterMarks"
                  :key="mark.label"
                  class="absolute top-0 text-[10px] tabular-nums text-text-tertiary"
                  :style="{
                    left: `${mark.left}px`,
                    transform: index === 0
                      ? 'none'
                      : index === timelineQuarterMarks.length - 1
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                  }"
                >{{ mark.label }}</span>
              </div>
            </div>
          </div>
        </div>

        <p class="mt-3 text-xs leading-relaxed text-text-tertiary">{{ BROAD_SHARE_NOTE }}</p>
        <p class="mt-1 text-xs leading-relaxed text-text-tertiary">{{ BROAD_SHARE_CHART_NOTE }}</p>
        <p class="mt-1 text-xs text-text-tertiary">
          {{ BROAD_SHARE_RANGE_LABEL }}：{{ snapshot.meta.shareEarliestDate || '—' }} ~
          {{ snapshot.meta.shareLatestDate || '—' }}
          （{{ fmtRelative(snapshot.meta.shareSyncedAt) }}同步）
        </p>
      </component>

      <!-- 国家队操作战役（生命周期） -->
      <component :is="deps.ui.Card" :title="BROAD_WAVE_TITLE">
        <template #extra>
          <span
            v-if="currentLifecycle"
            class="rounded-full px-2 py-0.5 text-xs font-medium"
            :class="SHARE_LIFECYCLE_BADGE_CLASS[currentLifecycle]"
          >
            {{ SHARE_LIFECYCLE_LABEL[currentLifecycle] }}
          </span>
        </template>
        <div v-if="notableCampaigns.length > 0" class="space-y-2">
          <div
            v-for="campaign in [...notableCampaigns].reverse()"
            :key="`${campaign.level}-${campaign.startDate}`"
            class="flex items-start gap-3 rounded-lg border border-flat-weak px-3 py-2"
          >
            <span
              class="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
              :class="
                campaign.confirmDate
                  ? SHARE_SIGNAL_BADGE_CLASS[campaign.level]
                  : SHARE_LIFECYCLE_BADGE_CLASS[campaign.level === 'enter' ? 'entry_suspected' : 'exit_suspected']
              "
            >
              {{ campaign.confirmDate ? SHARE_SIGNAL_LABEL[campaign.level] : SHARE_LIFECYCLE_LABEL[campaign.level === 'enter' ? 'entry_suspected' : 'exit_suspected'] }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span class="text-xs font-medium tabular-nums text-text">{{ campaign.startDate }}</span>
                <span v-if="campaign.suspectDate" class="text-[11px] tabular-nums text-text-tertiary">
                  疑似 {{ campaign.suspectDate.slice(5) }}
                </span>
                <span v-if="campaign.confirmDate" class="text-[11px] tabular-nums text-text-tertiary">
                  确认 {{ campaign.confirmDate.slice(5) }}
                </span>
                <span class="text-[11px] tabular-nums text-text-tertiary">
                  结束 {{ campaign.endDate.slice(5) }}（{{ campaign.days }} 日）
                </span>
                <span
                  class="text-[11px] tabular-nums"
                  :class="campaign.netFlowYi >= 0 ? 'text-up' : 'text-down'"
                >
                  {{ campaign.netFlowYi >= 0 ? '净申购' : '净赎回' }}
                  {{ Math.abs(campaign.netFlowYi).toFixed(0) }} 亿元
                </span>
                <span
                  v-if="campaign.exitCompletion"
                  class="rounded bg-flat-weak px-1 py-0.5 text-[10px] text-text-tertiary"
                >
                  退场{{ SHARE_EXIT_COMPLETION_LABEL[campaign.exitCompletion] }}
                </span>
              </div>
              <ul v-if="campaign.evidences.length > 0" class="mt-1 space-y-0.5">
                <li
                  v-for="(evidence, index) in campaign.evidences"
                  :key="index"
                  class="flex items-start gap-1.5 text-[11px] leading-relaxed text-text-secondary"
                >
                  <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full text-text-tertiary" style="background-color: currentColor" />
                  {{ evidence }}
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p v-else class="text-xs text-text-tertiary">
          暂无战役（份额平稳；触发疑似需连续 2 日同向变动或单日大额申赎，确认还需累计金额与指数位置）。
        </p>
        <p class="mt-3 text-xs leading-relaxed text-text-tertiary">{{ BROAD_WAVE_NOTE }}</p>
      </component>

      <!-- 信号回测 -->
      <component :is="deps.ui.Card" :title="BROAD_BACKTEST_TITLE">
        <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div v-for="stat in backtestStats" :key="stat.level">
            <p class="text-xs text-text-tertiary">
              {{ SHARE_SIGNAL_LABEL[stat.level] }} · {{ BROAD_BACKTEST_LABEL.count }}
            </p>
            <p class="mt-0.5 text-2xl font-semibold tabular-nums text-text">{{ stat.count }}</p>
            <p class="mt-0.5 text-xs tabular-nums text-text-secondary">
              {{ BROAD_BACKTEST_LABEL.returnHold }}：
              <span :class="trendClass(stat.avgReturnHold)">
                {{ stat.avgReturnHold === null ? '—' : `${stat.avgReturnHold >= 0 ? '+' : ''}${stat.avgReturnHold.toFixed(2)}%` }}
              </span>
              · {{ BROAD_BACKTEST_LABEL.winRate }}：
              <span class="tabular-nums text-text-secondary">
                {{ stat.winRate === null ? '—' : `${stat.winRate.toFixed(0)}%` }}
              </span>
            </p>
          </div>
        </div>
        <p class="mt-3 text-xs leading-relaxed text-text-tertiary">{{ BROAD_BACKTEST_NOTE }}</p>
      </component>

      <!-- 逐只 ETF 份额明细 -->
      <component :is="deps.ui.Card" :title="BROAD_SHARE_TABLE_TITLE">
        <component
          :is="deps.ui.Table"
          :columns="shareColumns"
          :rows="shareRows"
          row-key="code"
          :min-width="shareMinWidth"
        >
          <template #name="{ row }">
            <span class="flex items-center gap-1.5">
              <span class="text-text">{{ row.name }}</span>
              <span class="tabular-nums text-[11px] text-text-tertiary">{{ row.code }}</span>
            </span>
          </template>
          <template #index="{ row }">
            <span class="rounded bg-flat-weak px-1 py-0.5 text-[10px] text-text-tertiary">
              {{ row.indexName }}
            </span>
          </template>
          <template #shares="{ row }">
            <span class="tabular-nums text-text">
              {{ row.sharesYi === null ? BROAD_PLACEHOLDER : row.sharesYi.toFixed(2) }}
            </span>
          </template>
          <template #delta="{ row }">
            <span class="tabular-nums" :class="trendClass(row.deltaYi)">
              {{ row.deltaYi === null ? BROAD_PLACEHOLDER : `${row.deltaYi >= 0 ? '+' : ''}${row.deltaYi.toFixed(2)}` }}
            </span>
          </template>
          <template #flow="{ row }">
            <span class="tabular-nums" :class="trendClass(row.amountYi)">
              {{ row.amountYi === null ? BROAD_PLACEHOLDER : `${row.amountYi >= 0 ? '+' : ''}${row.amountYi.toFixed(0)}` }}
            </span>
          </template>
          <template #price="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.price === null ? BROAD_PLACEHOLDER : row.price.toFixed(3) }}
            </span>
          </template>
          <template #recent="{ row }">
            <span class="tabular-nums" :class="trendClass(row.recentDeltaYi)">
              {{ row.recentDeltaYi === null ? BROAD_PLACEHOLDER : `${row.recentDeltaYi >= 0 ? '+' : ''}${row.recentDeltaYi.toFixed(2)}` }}
            </span>
          </template>
          <template #source="{ row }">
            <span class="text-text-tertiary">{{ BROAD_SHARE_SOURCE_LABEL[row.source as 'sse' | 'szse'] }}</span>
          </template>
        </component>
        <p class="mt-2 text-xs text-text-tertiary">
          单位：亿份 / 亿元；份额来自交易所官方逐日披露（沪市单日全市场，深市按代码区间）。
        </p>
      </component>
    </template>

    <template v-if="hasDaily">
      <!-- 宽基指数行情 -->
      <component :is="deps.ui.Card" :title="BROAD_INDEX_TITLE">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div v-for="quote in indexQuotes" :key="quote.code" class="flex items-baseline gap-1.5">
            <span class="text-xs text-text-secondary">{{ quote.name }}</span>
            <span class="text-sm font-medium tabular-nums text-text">{{ fmtIndexPrice(quote.price) }}</span>
            <span class="text-xs font-medium tabular-nums" :class="trendClass(quote.changePercent)">
              {{ format.percent(quote.changePercent) }}
            </span>
          </div>
          <span v-if="indexQuotes.length === 0" class="text-xs text-text-tertiary">
            指数快照未采集（刷新日频时一并拉取）
          </span>
        </div>
      </component>

      <!-- 国家队持仓预估 -->
      <component :is="deps.ui.Card" :title="BROAD_SUMMARY_TITLE">
        <template #extra>
          <button
            type="button"
            class="pressable rounded px-1.5 py-0.5 text-xs text-primary active:scale-95"
            @click="openAnchor"
          >
            编辑锚点
          </button>
        </template>

        <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SUMMARY_LABEL.estTotal }}</p>
            <p class="mt-0.5 text-2xl font-semibold tabular-nums text-text">
              {{ totals.estTotalYi.toFixed(0) }}
              <span class="text-sm font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SUMMARY_LABEL.delta }}</p>
            <p class="mt-0.5 text-lg font-medium tabular-nums" :class="trendClass(totals.deltaTotalYi)">
              {{ totals.deltaTotalYi >= 0 ? '+' : '' }}{{ totals.deltaTotalYi.toFixed(0) }}
              <span class="text-xs font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SUMMARY_LABEL.mainToday }}</p>
            <p class="mt-0.5 text-lg font-medium tabular-nums" :class="trendClass(mainToday)">
              {{ mainToday === null ? BROAD_PLACEHOLDER : `${mainToday >= 0 ? '+' : ''}${fmtYi(mainToday)}` }}
              <span class="text-xs font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-text-tertiary">{{ BROAD_SUMMARY_LABEL.mainRecent }}</p>
            <p class="mt-0.5 text-lg font-medium tabular-nums" :class="trendClass(mainRecent)">
              {{ mainRecent >= 0 ? '+' : '' }}{{ fmtYi(mainRecent) }}
              <span class="text-xs font-normal text-text-tertiary">亿元</span>
            </p>
          </div>
        </div>

        <p class="mt-3 text-xs leading-relaxed text-text-tertiary">{{ BROAD_MODEL_NOTE }}</p>
      </component>

      <!-- 国家队操作信号 -->
      <component :is="deps.ui.Card" :title="BROAD_SIGNAL_TITLE">
        <template #extra>
          <span
            v-if="todaySignal"
            class="rounded-full px-2 py-0.5 text-xs font-medium"
            :class="signalBadgeClass(todaySignal.level)"
          >
            {{ SIGNAL_LEVEL_LABEL[todaySignal.level] }}
          </span>
        </template>

        <div v-if="todaySignal" class="space-y-3">
          <!-- 触发依据 -->
          <div>
            <p class="mb-1 text-xs font-medium text-text-secondary">{{ BROAD_SIGNAL_EVIDENCE_TITLE }}</p>
            <ul class="space-y-0.5">
              <li
                v-for="(evidence, index) in todaySignal.evidences"
                :key="index"
                class="flex items-start gap-1.5 text-xs leading-relaxed text-text-secondary"
              >
                <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full text-text-tertiary" style="background-color: currentColor" />
                {{ evidence }}
              </li>
            </ul>
          </div>

          <!-- 近 20 日信号时间线 -->
          <div>
            <p class="mb-1.5 text-xs font-medium text-text-secondary">
              {{ BROAD_SIGNAL_TIMELINE_TITLE }}
            </p>
            <div class="flex items-end gap-0.5">
              <div
                v-for="day in recentSignals"
                :key="day.date"
                class="h-6 flex-1 rounded-sm"
                :class="SIGNAL_LEVEL_BLOCK_CLASS[day.level]"
                :title="`${day.date} ${SIGNAL_LEVEL_LABEL[day.level]}`"
              />
            </div>
            <div class="mt-1 flex justify-between text-[10px] tabular-nums text-text-tertiary">
              <span>{{ recentSignals.length > 0 ? shortDate(recentSignals[0].date) : '' }}</span>
              <span>{{ recentSignals.length > 0 ? shortDate(recentSignals[recentSignals.length - 1].date) : '' }}</span>
            </div>
          </div>
        </div>
        <p v-else class="text-xs text-text-tertiary">暂无日频数据，先点「刷新日频」。</p>

        <p class="mt-3 text-xs leading-relaxed text-text-tertiary">{{ BROAD_SIGNAL_NOTE }}</p>
      </component>

      <!-- 宽基 ETF 明细 -->
      <component :is="deps.ui.Card" :title="BROAD_TABLE_TITLE">
        <component
          :is="deps.ui.Table"
          :columns="tableColumns"
          :rows="tableRows"
          row-key="code"
          :min-width="tableMinWidth"
        >
          <template #name="{ row }">
            <span class="flex items-center gap-1.5">
              <span class="text-text">{{ row.name }}</span>
              <span class="tabular-nums text-[11px] text-text-tertiary">{{ row.code }}</span>
              <span class="rounded bg-flat-weak px-1 py-0.5 text-[10px] text-text-tertiary">
                {{ row.indexName }}
              </span>
            </span>
          </template>
          <template #price="{ row }">
            <span class="tabular-nums text-text">{{ fmtPrice(row.price) }}</span>
          </template>
          <template #changePercent="{ row }">
            <span class="tabular-nums" :class="trendClass(row.changePercent)">
              {{ format.percent(row.changePercent) }}
            </span>
          </template>
          <template #amount="{ row }">
            <span class="tabular-nums text-text-secondary">{{ fmtYi(row.amount, 1) }}</span>
          </template>
          <template #mainInflow="{ row }">
            <span class="tabular-nums" :class="trendClass(row.mainInflow)">
              {{ row.mainInflow === null ? BROAD_PLACEHOLDER : `${row.mainInflow >= 0 ? '+' : ''}${fmtYi(row.mainInflow)}` }}
            </span>
          </template>
          <template #mainRecent="{ row }">
            <span class="tabular-nums" :class="trendClass(row.mainRecent)">
              {{ row.mainRecent === null ? BROAD_PLACEHOLDER : `${row.mainRecent >= 0 ? '+' : ''}${fmtYi(row.mainRecent)}` }}
            </span>
          </template>
          <template #superInflow="{ row }">
            <span class="tabular-nums" :class="trendClass(row.superInflow)">
              {{ row.superInflow === null ? BROAD_PLACEHOLDER : `${row.superInflow >= 0 ? '+' : ''}${fmtYi(row.superInflow)}` }}
            </span>
          </template>
          <template #sharesEnd="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.sharesEndYi === null ? BROAD_PLACEHOLDER : row.sharesEndYi.toFixed(2) }}
            </span>
          </template>
          <template #netSubscribe="{ row }">
            <span class="tabular-nums" :class="trendClass(row.lastNetSubscribeYi)">
              {{ row.lastNetSubscribeYi === null ? BROAD_PLACEHOLDER : `${row.lastNetSubscribeYi >= 0 ? '+' : ''}${row.lastNetSubscribeYi.toFixed(2)}` }}
            </span>
          </template>
          <template #netAsset="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.netAssetYi === null ? BROAD_PLACEHOLDER : row.netAssetYi.toFixed(0) }}
            </span>
          </template>
          <template #estHolding="{ row }">
            <span class="tabular-nums font-medium text-text">
              {{ row.estAmountYi === null ? BROAD_PLACEHOLDER : row.estAmountYi.toFixed(0) }}
            </span>
          </template>
        </component>
      </component>

      <!-- 季度份额申赎 -->
      <component :is="deps.ui.Card" :title="BROAD_QUARTER_TABLE_TITLE">
        <component
          :is="deps.ui.Table"
          :columns="quarterColumns"
          :rows="quarterRows"
          row-key="periodEnd"
          :min-width="quarterMinWidth"
        >
          <template #etfName="{ row }">
            <span class="text-text">{{ row.etfName }}</span>
          </template>
          <template #periodEnd="{ row }">
            <span class="tabular-nums text-text-secondary">{{ row.periodEnd }}</span>
          </template>
          <template #subscribe="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.subscribeYi === null ? BROAD_PLACEHOLDER : row.subscribeYi.toFixed(2) }}
            </span>
          </template>
          <template #redeem="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.redeemYi === null ? BROAD_PLACEHOLDER : row.redeemYi.toFixed(2) }}
            </span>
          </template>
          <template #netSubscribe="{ row }">
            <span
              class="tabular-nums"
              :class="trendClass(row.subscribeYi !== null && row.redeemYi !== null ? row.subscribeYi - row.redeemYi : null)"
            >
              {{
                row.subscribeYi !== null && row.redeemYi !== null
                  ? `${row.subscribeYi - row.redeemYi >= 0 ? '+' : ''}${(row.subscribeYi - row.redeemYi).toFixed(2)}`
                  : BROAD_PLACEHOLDER
              }}
            </span>
          </template>
          <template #sharesEnd="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.sharesEndYi === null ? BROAD_PLACEHOLDER : row.sharesEndYi.toFixed(2) }}
            </span>
          </template>
          <template #netAsset="{ row }">
            <span class="tabular-nums text-text-secondary">
              {{ row.netAssetYi === null ? BROAD_PLACEHOLDER : row.netAssetYi.toFixed(0) }}
            </span>
          </template>
          <template #changeRate="{ row }">
            <span class="tabular-nums" :class="trendClass(row.assetChangeRate)">
              {{ format.percent(row.assetChangeRate) }}
            </span>
          </template>
        </component>
        <p class="mt-2 text-xs text-text-tertiary">
          单位：亿份 / 亿元；数据来自天天基金 F10 定期报告，每只取最近两期。
        </p>
      </component>
    </template>

    <!-- 免责声明 -->
    <p class="px-1 text-xs leading-relaxed text-text-tertiary">{{ BROAD_DISCLAIMER }}</p>

    <!-- 锚点编辑弹窗 -->
    <component
      :is="deps.ui.Modal"
      v-model:open="anchorOpen"
      :title="BROAD_ANCHOR_TITLE"
    >
      <p class="text-xs leading-relaxed text-text-secondary">{{ BROAD_ANCHOR_NOTE }}</p>
      <div class="mt-3 flex items-center gap-2">
        <component :is="deps.ui.Button" variant="ghost" @click="autoFillAnchors">
          {{ BROAD_ANCHOR_AUTO }}
        </component>
        <span class="text-xs text-text-tertiary">
          当前国家队占比 {{ (nationalShare * 100).toFixed(0) }}%
        </span>
      </div>
      <div class="mt-3 overflow-y-auto" style="max-height: 20rem">
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-surface">
            <tr class="text-text-tertiary">
              <th class="py-1.5 text-left font-medium">{{ BROAD_ANCHOR_COLUMN_LABEL.name }}</th>
              <th class="py-1.5 text-left font-medium">{{ BROAD_ANCHOR_COLUMN_LABEL.periodEnd }}</th>
              <th class="py-1.5 text-right font-medium">{{ BROAD_ANCHOR_COLUMN_LABEL.sharesYi }}</th>
              <th class="py-1.5 text-right font-medium">{{ BROAD_ANCHOR_COLUMN_LABEL.estAmount }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="draft in anchorDraft" :key="draft.code" class="border-t border-flat-weak">
              <td class="py-1.5 text-text">{{ draft.code }}</td>
              <td class="py-1.5">
                <input
                  v-model="draft.periodEnd"
                  type="text"
                  class="w-24 rounded-md bg-flat-weak px-1.5 py-0.5 text-xs tabular-nums text-text outline-none focus:ring-1 focus:ring-primary"
                />
              </td>
              <td class="py-1.5 text-right">
                <input
                  v-model.number="draft.sharesYi"
                  type="number"
                  step="0.01"
                  class="w-24 rounded-md bg-flat-weak px-1.5 py-0.5 text-right text-xs tabular-nums text-text outline-none focus:ring-1 focus:ring-primary"
                />
              </td>
              <td class="py-1.5 text-right tabular-nums text-text-tertiary">
                {{ draftAmountYi(draft.code) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <component :is="deps.ui.Button" variant="ghost" @click="anchorOpen = false">
            取消
          </component>
          <component :is="deps.ui.Button" :disabled="anchorSaving" @click="saveAnchors">
            {{ BROAD_ANCHOR_SAVE }}
          </component>
        </div>
      </template>
    </component>

    <!-- 份额卡「图解」帮助弹窗 -->
    <component
      :is="deps.ui.Modal"
      v-model:open="shareHelpOpen"
      :title="BROAD_SHARE_HELP_TITLE"
      max-width-class="max-w-xl"
    >
      <div class="space-y-4 text-xs leading-relaxed text-text-secondary">
        <!-- 迷你示意：上行净申赎柱 + 下行信号状态色带 -->
        <div class="relative h-12 w-full overflow-hidden rounded-lg bg-flat-weak">
          <span class="absolute bg-up" style="width: 3px; left: 5%; bottom: 16px; height: 55%" />
          <span class="absolute bg-up" style="width: 3px; left: 9%; bottom: 16px; height: 30%" />
          <span class="absolute bg-up" style="width: 3px; left: 13%; bottom: 16px; height: 45%" />
          <span class="absolute bg-up" style="width: 3px; left: 17%; bottom: 16px; height: 20%" />
          <span class="absolute bg-down" style="width: 3px; left: 30%; bottom: 16px; height: 62%" />
          <span class="absolute bg-down" style="width: 3px; left: 34%; bottom: 16px; height: 38%" />
          <span class="absolute bg-down" style="width: 3px; left: 38%; bottom: 16px; height: 22%" />
          <span class="absolute bg-up" style="width: 3px; left: 50%; bottom: 16px; height: 48%" />
          <span class="absolute bg-up" style="width: 3px; left: 54%; bottom: 16px; height: 26%" />
          <span class="absolute bg-down" style="width: 3px; left: 66%; bottom: 16px; height: 34%" />
          <span class="absolute bg-up" style="width: 3px; left: 80%; bottom: 16px; height: 58%" />
          <span class="absolute bg-up" style="width: 3px; left: 84%; bottom: 16px; height: 36%" />
          <span class="absolute bg-up" style="width: 3px; left: 88%; bottom: 16px; height: 44%" />
          <span
            class="absolute flex"
            style="left: 4%; right: 4%; bottom: 7px; height: 4px; gap: 1px"
          >
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span class="bg-up-weak" style="width: 7%" />
            <span class="bg-up" style="width: 7%" />
            <span class="bg-up" style="width: 7%" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span class="bg-down-weak" style="width: 7%" />
            <span class="bg-down" style="width: 7%" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span style="width: 7%; background: currentColor; opacity: 0.25" />
            <span class="bg-up-weak" style="width: 7%" />
            <span class="bg-up" style="width: 7%" />
            <span style="width: 3%; background: currentColor; opacity: 0.25" />
          </span>
          <span
            class="absolute text-[10px] tabular-nums text-text-tertiary"
            style="bottom: -2px; left: 6px"
          >
            {{ shareAxis.first }}
          </span>
          <span
            class="absolute text-[10px] tabular-nums text-text-tertiary"
            style="bottom: -2px; right: 6px"
          >
            {{ shareAxis.last }}
          </span>
        </div>

        <!-- 三层结构：从上到下逐层解释 -->
        <div class="space-y-1.5">
          <div
            v-for="layer in BROAD_SHARE_HELP_LAYERS"
            :key="layer.title"
            class="rounded-lg border border-flat-weak px-3 py-2"
          >
            <p>
              <span class="font-medium text-text">{{ layer.title }}</span>
              <span class="ml-2 text-text-tertiary">{{ layer.scope }}</span>
            </p>
            <p class="mt-1">{{ layer.answer }}</p>
          </div>
        </div>

        <!-- 顶部汇总指标 -->
        <div class="space-y-1">
          <p v-for="metric in BROAD_SHARE_HELP_METRICS" :key="metric.label">
            <span class="font-medium text-text">{{ metric.label }}</span>
            <span class="ml-1">{{ metric.text }}</span>
          </p>
        </div>

        <p class="text-text-tertiary">{{ BROAD_SHARE_NOTE }}</p>
      </div>
    </component>
  </div>
</template>
