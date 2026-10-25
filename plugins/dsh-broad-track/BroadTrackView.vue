<script setup lang="ts">
import { computed, ref } from 'vue';
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
  buildShareSignalTimeline,
  buildShareSignalWaves,
  recentNetFlow,
  runShareBacktest,
} from './share-signal';
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
  NATIONAL_TEAM_OF_INST_RATIO,
  SHARE_SIGNAL_BADGE_CLASS,
  SHARE_SIGNAL_LABEL,
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

/** 逐日份额信号（图表标注用） */
const shareTimeline = computed<ShareSignalDay[]>(() =>
  buildShareSignalTimeline(comboSeries.value),
);

/** 信号波段（统计与回测用；一次战役算一个） */
const shareWaves = computed(() => buildShareSignalWaves(comboSeries.value));

/** 近 120 日的逐日信号（时间线条展示用） */
const recentShareTimeline = computed<ShareSignalDay[]>(() =>
  shareTimeline.value.slice(-120),
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

/** 份额曲线 SVG 路径（组合总份额） */
const sharePath = computed(() => {
  const list = comboSeries.value;
  if (list.length < 2) return '';
  const values = list.map((point) => point.totalSharesYi);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 1000;
  const height = 100;
  return list
    .map((point, index) => {
      const x = (index / (list.length - 1)) * width;
      const y = height - ((point.totalSharesYi - min) / span) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

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

/** 每日净申赎柱（近 N 日；正红负绿） */
const flowBars = computed(() => {
  const list = comboSeries.value.slice(-120);
  const values = list.map((point) => point.netFlowYi ?? 0);
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  return list.map((point) => ({
    date: point.date,
    value: point.netFlowYi,
    height: (Math.abs(point.netFlowYi ?? 0) / max) * 100,
  }));
});

/** 信号在曲线上的标记位置（X 轴百分比） */
const waveMarkers = computed(() => {
  const list = comboSeries.value;
  if (list.length === 0) return [];
  const indexByDate = new Map(list.map((point, index) => [point.date, index]));
  const marks: { date: string; level: 'enter' | 'exit'; left: number }[] = [];
  for (const wave of shareWaves.value) {
    if (wave.level === 'none') continue;
    const index = indexByDate.get(wave.date);
    if (index === undefined) continue;
    marks.push({
      date: wave.date,
      level: wave.level,
      left: (index / (list.length - 1)) * 100,
    });
  }
  return marks;
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
      <component :is="deps.ui.Card" :title="BROAD_SHARE_TITLE">
        <template #extra>
          <component
            :is="deps.ui.Button"
            variant="ghost"
            :disabled="shareSyncing || refreshing || syncing"
            @click="onSyncShares"
          >
            {{ BROAD_SHARE_SYNC_BUTTON }}
          </component>
        </template>

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

        <!-- 份额曲线（SVG 折线） -->
        <div class="mt-4">
          <div class="relative h-24 w-full">
            <svg
              class="h-full w-full"
              :viewBox="`0 0 1000 100`"
              preserveAspectRatio="none"
              role="img"
              aria-label="组合总份额走势"
            >
              <polyline
                :points="sharePath"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
                class="text-primary"
              />
            </svg>
            <!-- 信号标记 -->
            <span
              v-for="mark in waveMarkers"
              :key="`${mark.date}-${mark.level}`"
              class="absolute top-0 h-full w-0.5 -translate-x-1/2"
              :class="mark.level === 'enter' ? 'bg-up' : 'bg-down'"
              :style="{ left: `${mark.left}%` }"
              :title="`${mark.date} ${SHARE_SIGNAL_LABEL[mark.level]}`"
            />
          </div>
          <div class="mt-1 flex justify-between text-[10px] tabular-nums text-text-tertiary">
            <span>{{ shareAxis.first }}</span>
            <span>{{ shareAxis.middle }}</span>
            <span>{{ shareAxis.last }}</span>
          </div>
        </div>

        <!-- 每日净申赎柱（近 120 日） -->
        <div class="mt-3">
          <p class="mb-1 text-xs font-medium text-text-secondary">
            {{ BROAD_SHARE_CHART_TITLE }}
          </p>
          <div class="flex h-16 items-end gap-px">
            <div
              v-for="bar in flowBars"
              :key="bar.date"
              class="group relative flex-1"
              :style="{ height: `${Math.max(bar.height, 1)}%` }"
            >
              <div
                class="h-full w-full rounded-t-[1px]"
                :class="(bar.value ?? 0) >= 0 ? 'bg-up-weak' : 'bg-down-weak'"
              />
              <span
                class="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-text shadow-sm group-hover:block"
              >
                {{ bar.date.slice(5) }} · {{ bar.value === null ? '—' : `${bar.value.toFixed(0)} 亿` }}
              </span>
            </div>
          </div>
        </div>

        <!-- 逐日信号时间线条（近 120 日） -->
        <div class="mt-3">
          <p class="mb-1 text-xs font-medium text-text-secondary">近 120 日信号状态</p>
          <div class="flex items-end gap-px">
            <div
              v-for="day in recentShareTimeline"
              :key="day.date"
              class="h-4 flex-1 rounded-[1px]"
              :class="
                day.level === 'enter'
                  ? 'bg-up'
                  : day.level === 'exit'
                    ? 'bg-down'
                    : 'bg-flat-weak'
              "
              :title="`${day.date} ${SHARE_SIGNAL_LABEL[day.level]}`"
            />
          </div>
          <div class="mt-1 flex justify-between text-[10px] tabular-nums text-text-tertiary">
            <span>{{ recentShareTimeline.length > 0 ? shortDate(recentShareTimeline[0].date) : '' }}</span>
            <span>
              {{ recentShareTimeline.length > 0 ? shortDate(recentShareTimeline[recentShareTimeline.length - 1].date) : '' }}
            </span>
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

      <!-- 进场 / 退场信号波段 -->
      <component :is="deps.ui.Card" :title="BROAD_WAVE_TITLE">
        <div v-if="shareWaves.length > 0" class="space-y-2">
          <div
            v-for="wave in [...shareWaves].reverse()"
            :key="`${wave.date}-${wave.level}`"
            class="flex items-start gap-3 rounded-lg border border-flat-weak px-3 py-2"
          >
            <span
              class="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
              :class="SHARE_SIGNAL_BADGE_CLASS[wave.level]"
            >
              {{ SHARE_SIGNAL_LABEL[wave.level] }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span class="text-xs font-medium tabular-nums text-text">{{ wave.date }}</span>
                <span class="text-[11px] text-text-tertiary">
                  持续 {{ wave.days }} 日（连续 {{ wave.streak }} 日同向）
                </span>
                <span class="text-[11px] tabular-nums" :class="trendClass(wave.deltaSharesYi)">
                  份额 {{ wave.deltaSharesYi >= 0 ? '+' : '' }}{{ wave.deltaSharesYi.toFixed(0) }} 亿份
                </span>
                <span class="text-[11px] tabular-nums" :class="trendClass(wave.netFlowYi)">
                  净申赎 {{ wave.netFlowYi === null ? '—' : `${wave.netFlowYi >= 0 ? '+' : ''}${wave.netFlowYi.toFixed(0)}` }} 亿元
                </span>
                <span v-if="wave.indexReturn !== null" class="text-[11px] tabular-nums text-text-tertiary">
                  区间指数 {{ wave.indexReturn >= 0 ? '+' : '' }}{{ wave.indexReturn.toFixed(1) }}%
                </span>
              </div>
              <ul class="mt-1 space-y-0.5">
                <li
                  v-for="(evidence, index) in wave.evidences"
                  :key="index"
                  class="flex items-start gap-1.5 text-[11px] leading-relaxed text-text-secondary"
                >
                  <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                  {{ evidence }}
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p v-else class="text-xs text-text-tertiary">
          暂无满足条件的信号（需要连续同向变动 + 累计金额达标 + 指数位置匹配）。
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
                <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
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
      <div class="mt-3 max-h-80 overflow-y-auto">
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
  </div>
</template>
