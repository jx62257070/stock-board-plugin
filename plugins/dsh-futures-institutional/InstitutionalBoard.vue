<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import type { EChartsCoreOption } from 'echarts/core';
import EChartBox from './EChartBox.vue';
import { chartPalette, semanticColor, useChartThemeSignal } from './echarts-theme';
import {
  CCPM_EQUITY_PRODUCT_ORDER,
  CCPM_PRODUCTS,
  CCPM_SCOPE_LABELS,
  FUTURES_PAGE_TEXT,
  FUTURES_INSTITUTIONAL_PLUGIN_ID,
  HISTORY_COMBO_DAYS,
  HISTORY_COMBO_SYMBOL,
  HISTORY_KLINE_DAYS,
  HISTORY_VIEW_DEFAULT_DAYS,
  INDEX_COMBO_INDEXES,
} from './constants';
import type { CcpmProductCode } from './constants';
import {
  aggregateCcpmByMember,
  aggregateCcpmOthers,
  computeCcpmMemberStats,
  computeCcpmOthersStats,
  computeCcpmRollEntries,
  filterCcpmRowsByInstrument,
} from './compute';
import { buildCcpmAnalysisPrompt } from './prompt';
import { fetchIndexCandles, fetchIndexCloses, type IndexCandle } from './index-kline';
import { syncHistory } from './scan';
import type { HistoryComboSnapshot } from './storage';
import type { TableColumn } from '../../host/types/table.types';
import type {
  CcpmAggregateRow,
  CcpmAnalysisDataset,
  CcpmMemberDayPoint,
  CcpmMemberRow,
  CcpmMemberSeries,
  CcpmMemberStats,
  CcpmProductDayData,
  CcpmScopeMode,
  FuturesRuntime,
} from './types';

/**
 * 期货·机构行为看板（移植自宿主 FuturesInstitutionalView）
 *
 * 数据源：中金所 CCPM 成交持仓排名每日披露 CSV（GBK，仅 HTTP）。页面编排：
 * 筛选器（品种 / 三档合并口径 / 合约 / 交易日 / 席位搜索）→ 数据边界提示 →
 * 概览指标卡 → 上榜会员总表（分组视图：中信期货 + 其他机构汇总，整行 100% 宽，
 * 其他机构行点开详情弹窗，弹窗内含各家明细与跨合约展开）→ 席位画像（整行）→
 * 历史对照（中信净增减柱状 × 上证指数蜡烛，近 5 年可缩放，快照持久化秒开）→
 * 多空并排柱状（中信 vs 其他机构汇总两行）+ 净持仓时序 + 曲线对照 → 衍生榜单 → 移仓换月（折叠）→
 * 固定风险提示。历史回填由「同步历史」按钮触发（一次性任务，非轮询）。
 */

const props = defineProps<{
  /** 插件运行时（repo + deps） */
  runtime: FuturesRuntime;
}>();

/** 画像默认席位（宿主同款：短视频核验口径的主力席位） */
const DEFAULT_MEMBER = '中信期货(代客)';

/** 今天（yyyy-MM-dd，date input 初始值） */
const TODAY = dayjs().format('YYYY-MM-DD');

/** 品种选项（ui.Tabs 数据源，口径同原宿主筛选条：code + name） */
const productOptions = CCPM_PRODUCTS.map((item) => ({
  value: item.code,
  label: `${item.code} ${item.name}`,
}));

/** 合并口径选项（ui.Tabs 数据源，口径同原宿主筛选条） */
const scopeOptions: ReadonlyArray<{ label: string; value: CcpmScopeMode }> = [
  { label: '单合约', value: 'contract' },
  { label: '同品种合并', value: 'product' },
  { label: '全股指合并', value: 'all' },
];

/** 当前品种代码 */
const product = ref<string>('IF');

/** 当前合并口径（默认全股指——对应宿主的短视频核验口径） */
const scope = ref<CcpmScopeMode>('all');

/** 当前合约（单合约口径） */
const instrument = ref<string>('');

/** date input 交易日（yyyy-MM-dd） */
const dayInput = ref<string>(TODAY);

/** 实际披露交易日（yyyyMMdd，加载成功后回填，非披露日自动回退） */
const resolvedDay = ref<string>('');

/** 席位搜索关键词 */
const search = ref<string>('');

/** 选中席位（画像 / 时序目标；未显式点选时默认锚定中信期货） */
const selectedMember = ref<string | null>(null);

/** 用户是否显式点选过席位（点选后不再自动改选） */
const memberPicked = ref(false);

/** 已展开分解行的席位列表 */
const expandedMembers = ref<string[]>([]);

/** 首屏 / 切换加载中 */
const loading = ref(false);

/** 当日无披露数据（非交易日 / 上游异常） */
const noData = ref(false);

/** 单品种当日数据（contract / product 口径） */
const dayData = ref<CcpmProductDayData | null>(null);

/** 全股指口径各品种当日数据（key = 品种代码） */
const allData = ref<Record<string, CcpmProductDayData | null>>({});

/** 席位时序数据（选中席位的净持仓走势） */
const series = ref<CcpmMemberSeries | null>(null);

/** 时序加载中 */
const seriesLoading = ref(false);

/** 历史同步运行态（防重入） */
const syncing = ref(false);

/** 历史同步进度文案 */
const syncText = ref('');

/** 「AI 分析」运行态（防重入） */
const aiRunning = ref(false);

/** AI 入口是否可用（宿主 app:agent-ask 服务缺席时降级隐藏） */
const aiAvailable = computed(() => props.runtime.deps.agentAsk !== null);

/** 是否处于全股指口径 */
const isAllScope = computed(() => scope.value === 'all');

/** 当前口径下可用的品种当日数据集合 */
const activeDataList = computed<CcpmProductDayData[]>(() => {
  if (isAllScope.value) {
    // 用 != null 同时挡掉 null 与 undefined：allData 未填充时是 undefined
    return CCPM_EQUITY_PRODUCT_ORDER.map((code) => allData.value[code]).filter(
      (item): item is CcpmProductDayData => item != null,
    );
  }
  return dayData.value ? [dayData.value] : [];
});

/** 当前品种披露的合约列表 */
const instruments = computed<string[]>(() =>
  isAllScope.value ? [] : (dayData.value?.instruments ?? []),
);

/** 合约选项（ui.Tabs 数据源；单合约口径按当日披露动态生成） */
const instrumentOptions = computed(() =>
  instruments.value.map((id) => ({ value: id, label: id })),
);

/**
 * 加载某个自然日的数据（scope 决定单品种还是四股指）
 * @param day yyyy-MM-dd 或 yyyyMMdd
 * @param autoFallback 无数据时是否自动回退到最近披露日（首屏 true）
 */
const loadDay = async (day: string, autoFallback = false): Promise<void> => {
  const dayKey = day.replaceAll('-', '');
  if (!/^\d{8}$/.test(dayKey)) {
    return;
  }
  loading.value = true;
  noData.value = false;
  series.value = null;
  try {
    if (isAllScope.value) {
      const results = await Promise.all(
        CCPM_EQUITY_PRODUCT_ORDER.map((code) =>
          props.runtime.data.fetchProductDay(code, dayKey),
        ),
      );
      const next: Record<string, CcpmProductDayData | null> = {};
      CCPM_EQUITY_PRODUCT_ORDER.forEach((code, index) => {
        next[code] = results[index];
      });
      allData.value = next;
      const hit = results.find((item) => item !== null);
      if (hit) {
        resolvedDay.value = hit.tradingDay;
      } else if (autoFallback) {
        await fallbackToLatest();
        return;
      } else {
        noData.value = true;
      }
    } else {
      const data = await props.runtime.data.fetchProductDay(product.value, dayKey);
      if (data) {
        dayData.value = data;
        resolvedDay.value = data.tradingDay;
      } else if (autoFallback) {
        await fallbackToLatest();
        return;
      } else {
        dayData.value = null;
        noData.value = true;
      }
    }
  } finally {
    loading.value = false;
  }
};

/**
 * 回退到最近披露日（探测上游，同时刷新筛选器日期）
 */
const fallbackToLatest = async (): Promise<void> => {
  const anchorProduct = isAllScope.value ? 'IF' : product.value;
  const latest = await props.runtime.data.findLatestDay(
    anchorProduct,
    dayInput.value.replaceAll('-', ''),
  );
  if (latest) {
    resolvedDay.value = latest.data.tradingDay;
    dayInput.value = dayjs(latest.data.tradingDay, 'YYYYMMDD').format('YYYY-MM-DD');
    noData.value = false;
    if (isAllScope.value) {
      await loadDay(dayInput.value);
    } else {
      dayData.value = latest.data;
    }
  } else {
    noData.value = true;
    resolvedDay.value = '';
  }
};

/** 首屏加载：直接走自动回退 */
onMounted(() => {
  void loadDay(TODAY, true);
});

// 品种 / 口径 / 交易日变化 → 重新加载（合约与选中席位复位）
watch([product, scope, dayInput], () => {
  instrument.value = '';
  selectedMember.value = null;
  memberPicked.value = false;
  expandedMembers.value = [];
  void loadDay(dayInput.value);
});

// 合约列表就绪后默认选第一个合约
watch(instruments, (list) => {
  if (!instrument.value && list.length > 0) {
    instrument.value = list[0] ?? '';
  }
});

/**
 * 搜索过滤（席位名包含关键词，大小写不敏感）
 * @param memberName 席位名
 * @returns 是否命中搜索关键词（关键词为空时恒命中）
 */
const matchSearch = (memberName: string): boolean =>
  search.value.trim() === '' || memberName.toLowerCase().includes(search.value.trim().toLowerCase());

/** 单合约口径：指标计算后的行（当前合约） */
const stats = computed<CcpmMemberStats[]>(() => {
  const data = dayData.value;
  if (scope.value !== 'contract' || !data) {
    return [];
  }
  const target = instrument.value || data.instruments[0] || '';
  const rows = filterCcpmRowsByInstrument(data, target);
  const totals = data.totals[target];
  if (!totals) {
    return [];
  }
  return computeCcpmMemberStats(rows, totals);
});

/** 聚合口径：按会员聚合行（同品种 / 全股指共用） */
const aggregates = computed<CcpmAggregateRow[]>(() => {
  if (scope.value === 'contract' || activeDataList.value.length === 0) {
    return [];
  }
  return aggregateCcpmByMember(activeDataList.value);
});

// 数据就绪且用户未显式点选时，画像默认锚定中信期货（缺席则取榜首）
watch([stats, aggregates], ([s, a]) => {
  if (memberPicked.value) {
    return;
  }
  const list = s.length > 0 ? s : a;
  if (list.length === 0) {
    selectedMember.value = null;
    return;
  }
  selectedMember.value = list.some((row) => row.memberName === DEFAULT_MEMBER)
    ? DEFAULT_MEMBER
    : (list[0]?.memberName ?? null);
});

/** 「其他机构」汇总行的展示名（compute 层汇总行同名，主表行点击据此开详情弹窗） */
const OTHERS_ROW_NAME = '其他机构汇总';

/** 总表展示行（两种口径归一化后的形态，模板统一消费） */
interface DisplayRow {
  /** 席位名 */
  memberName: string;
  /** 多单（手） */
  buy: number | null;
  /** 多单增减 */
  buyChg: number | null;
  /** 空单（手） */
  sell: number | null;
  /** 空单增减 */
  sellChg: number | null;
  /** 净持仓 */
  net: number | null;
  /** 行为标签 */
  tag: 'hedge' | 'long' | 'short' | null;
  /** 标签判定依据 */
  tagReason: string | null;
}

/** 全部总表展示行（单合约与聚合口径归一化，未过滤；分组主表与详情弹窗共用数据源） */
const allDisplayRows = computed<readonly DisplayRow[]>(() => {
  if (scope.value === 'contract') {
    return stats.value.map((row) => ({
      memberName: row.memberName,
      buy: row.buyPos,
      buyChg: row.buyChg,
      sell: row.sellPos,
      sellChg: row.sellChg,
      net: row.netPos,
      tag: row.tag,
      tagReason: row.tagReason,
    }));
  }
  return aggregates.value.map((row) => ({
    memberName: row.memberName,
    buy: row.totalBuy,
    buyChg: row.totalBuyChg,
    sell: row.totalSell,
    sellChg: row.totalSellChg,
    net: row.totalNet,
    tag: row.tag,
    tagReason: row.tagReason,
  }));
});

/** 中信期货（代客）展示行（缺席 = 当日未上榜） */
const zxDisplayRow = computed<DisplayRow | null>(
  () => allDisplayRows.value.find((row) => row.memberName === DEFAULT_MEMBER) ?? null,
);

/** 其他机构汇总展示行（两口径归一化；除中信外无可计入行时为 null） */
const othersSummaryRow = computed<DisplayRow | null>(() => {
  if (scope.value !== 'contract' && othersAggregate.value) {
    return {
      memberName: OTHERS_ROW_NAME,
      buy: othersAggregate.value.totalBuy,
      buyChg: othersAggregate.value.totalBuyChg,
      sell: othersAggregate.value.totalSell,
      sellChg: othersAggregate.value.totalSellChg,
      net: othersAggregate.value.totalNet,
      tag: othersAggregate.value.tag,
      tagReason: othersAggregate.value.tagReason,
    };
  }
  if (scope.value === 'contract' && othersStats.value) {
    return {
      memberName: OTHERS_ROW_NAME,
      buy: othersStats.value.buyPos,
      buyChg: othersStats.value.buyChg,
      sell: othersStats.value.sellPos,
      sellChg: othersStats.value.sellChg,
      net: othersStats.value.netPos,
      tag: othersStats.value.tag,
      tagReason: othersStats.value.tagReason,
    };
  }
  return null;
});

/** 分组主表两行：中信期货 + 其他机构汇总 */
const groupRows = computed<readonly DisplayRow[]>(() =>
  [zxDisplayRow.value, othersSummaryRow.value].filter(
    (row): row is DisplayRow => row !== null,
  ),
);

/** 其他机构明细行（详情弹窗用：排除中信 + 席位搜索过滤） */
const otherDetailRows = computed<readonly DisplayRow[]>(() =>
  allDisplayRows.value
    .filter((row) => row.memberName !== DEFAULT_MEMBER)
    .filter((row) => matchSearch(row.memberName)),
);

/** 上榜会员总表列配置（app:ui Table 驱动；行 key = 席位名） */
const tableColumns: TableColumn<DisplayRow>[] = [
  { key: 'memberName', label: '席位' },
  { key: 'buy', label: '多单', align: 'right' },
  { key: 'buyChg', label: '多增减', align: 'right' },
  { key: 'sell', label: '空单', align: 'right' },
  { key: 'sellChg', label: '空增减', align: 'right' },
  { key: 'net', label: '净持仓', align: 'right' },
  { key: 'tag', label: '行为标注' },
];

/**
 * 行 key 提取（总表 expandable 受控模式用）
 * @param row 总表行
 * @returns 行 key（席位名）
 */
const rowKeyOf = (row: DisplayRow): string => row.memberName;

/** 行为标签 → Tag 色调（多头红 / 空头绿 / 对冲中性） */
const TAG_TONE = {
  hedge: 'flat',
  long: 'up',
  short: 'down',
} as const;

/**
 * 行为标签 → Tag 色调（插槽 row 无类型，经此收口）
 * @param tag 行为标签
 * @returns Tag 色调
 */
const tagTone = (tag: DisplayRow['tag']): 'flat' | 'up' | 'down' =>
  tag === null ? 'flat' : TAG_TONE[tag];

/** 选中席位的单合约画像 */
const selectedStats = computed<CcpmMemberStats | null>(
  () => stats.value.find((row) => row.memberName === selectedMember.value) ?? null,
);
/** 选中席位的聚合画像 */
const selectedAggregate = computed<CcpmAggregateRow | null>(
  () => aggregates.value.find((row) => row.memberName === selectedMember.value) ?? null,
);

/** 单合约口径：除中信期货外其余上榜会员的汇总行（分组视图与画像对照共用） */
const othersStats = computed<CcpmMemberStats | null>(() => {
  const data = dayData.value;
  if (scope.value !== 'contract' || !data) {
    return null;
  }
  const target = instrument.value || data.instruments[0] || '';
  const totals = data.totals[target];
  if (!totals || stats.value.length === 0) {
    return null;
  }
  return computeCcpmOthersStats(stats.value, totals, DEFAULT_MEMBER);
});

/** 聚合口径：除中信期货外其余全部上榜会员的汇总行 */
const othersAggregate = computed<CcpmAggregateRow | null>(() => {
  if (scope.value === 'contract' || activeDataList.value.length === 0) {
    return null;
  }
  return aggregateCcpmOthers(activeDataList.value, DEFAULT_MEMBER);
});

/** 席位画像统一视图模型（单合约 / 聚合两口径归一化，画像卡单一消费） */
interface ProfileView {
  /** 多单（手） */
  buy: number;
  /** 多单增减 */
  buyChg: number | null;
  /** 空单（手） */
  sell: number;
  /** 空单增减 */
  sellChg: number | null;
  /** 净持仓 */
  net: number;
  /** 净增减 */
  netChg: number | null;
  /** 单合约口径：多单占该合约上榜总多单比例（%）；聚合口径为 null */
  buyRatio: number | null;
  /** 单合约口径：空单占比（%）；聚合口径为 null */
  sellRatio: number | null;
  /** 聚合口径：上榜合约数；单合约口径为 null */
  coveredCount: number | null;
  /** 聚合口径：口径合约总数；单合约口径为 null */
  totalCount: number | null;
  /** 行为标签 */
  tag: DisplayRow['tag'];
  /** 标签判定依据 */
  tagReason: string | null;
}

/** 选中席位画像（当前口径归一化；未选中 / 无数据为 null） */
const profile = computed<ProfileView | null>(() => {
  if (scope.value !== 'contract' && selectedAggregate.value) {
    const row = selectedAggregate.value;
    return {
      buy: row.totalBuy,
      buyChg: row.totalBuyChg,
      sell: row.totalSell,
      sellChg: row.totalSellChg,
      net: row.totalNet,
      netChg: row.totalNetChg,
      buyRatio: null,
      sellRatio: null,
      coveredCount: row.coveredCount,
      totalCount: row.totalCount,
      tag: row.tag,
      tagReason: row.tagReason,
    };
  }
  const row = selectedStats.value;
  if (scope.value === 'contract' && row) {
    return {
      buy: row.buyPos ?? 0,
      buyChg: row.buyChg,
      sell: row.sellPos ?? 0,
      sellChg: row.sellChg,
      net: row.netPos ?? 0,
      netChg: row.netChg,
      buyRatio: row.buyRatio,
      sellRatio: row.sellRatio,
      coveredCount: null,
      totalCount: null,
      tag: row.tag,
      tagReason: row.tagReason,
    };
  }
  return null;
});

/** 其余上榜会员汇总（两口径归一化；未选中时为 null） */
const others = computed<{ net: number; tagReason: string | null } | null>(() => {
  if (scope.value !== 'contract' && othersAggregate.value) {
    return { net: othersAggregate.value.totalNet, tagReason: othersAggregate.value.tagReason };
  }
  if (scope.value === 'contract' && othersStats.value) {
    return { net: othersStats.value.netPos ?? 0, tagReason: othersStats.value.tagReason };
  }
  return null;
});

/** 其他机构家数（当前口径上榜总数 − 中信是否在榜；画像卡与弹窗标题文案用） */
const othersCount = computed(() => {
  const total = scope.value === 'contract' ? stats.value.length : aggregates.value.length;
  return Math.max(total - (zxDisplayRow.value ? 1 : 0), 0);
});

/** 「其他机构」详情弹窗开关 */
const othersOpen = ref(false);

/** 席位 → 跨合约分解原始行（总表任意行展开都用它，不挂在选中席位上） */
const breakdownByMember = computed<Map<string, CcpmMemberRow[]>>(() => {
  const map = new Map<string, CcpmMemberRow[]>();
  for (const row of activeDataList.value.flatMap((item) => item.rows)) {
    const list = map.get(row.memberName);
    if (list) {
      list.push(row);
    } else {
      map.set(row.memberName, [row]);
    }
  }
  return map;
});

/**
 * 席位 → 分解行（模板收口用）
 * @param memberName 席位名
 * @returns 该席位在当前口径下的全部上榜原始行
 */
const breakdownOf = (memberName: string): CcpmMemberRow[] =>
  breakdownByMember.value.get(memberName) ?? [];

/**
 * 汇总各品种合约合计（指标卡数据源）
 * @returns 合并的总量
 */
const grandTotals = computed(() => {
  let volume = 0;
  let buy = 0;
  let sell = 0;
  for (const data of activeDataList.value) {
    for (const total of Object.values(data.totals)) {
      volume += total.volume;
      buy += total.buy;
      sell += total.sell;
    }
  }
  return { volume, buy, sell, net: buy - sell };
});

/** 指标卡（label + 值 + 语义色 + 单位） */
interface StatCard {
  /** 指标名 */
  label: string;
  /** 展示值 */
  value: string;
  /** 语义色类（可空） */
  valueClass?: string;
  /** 单位 / 说明 */
  sub?: string;
}

/** 概览指标卡（三口径各自组装） */
const statCards = computed<readonly StatCard[]>(() => {
  if (scope.value === 'contract') {
    const data = dayData.value;
    const target = instrument.value || data?.instruments[0] || '';
    const totals = data?.totals[target];
    if (!totals) {
      return [];
    }
    return [
      { label: '上榜总多单', value: totals.buy.toLocaleString('en-US'), valueClass: 'text-up', sub: '手' },
      { label: '上榜总空单', value: totals.sell.toLocaleString('en-US'), valueClass: 'text-down', sub: '手' },
      { label: '上榜总成交量', value: totals.volume.toLocaleString('en-US'), sub: '手' },
      {
        label: '上榜多空净差',
        value: (totals.buy - totals.sell).toLocaleString('en-US'),
        valueClass: totals.buy - totals.sell >= 0 ? 'text-up' : 'text-down',
        sub: '多 − 空',
      },
      { label: '上榜席位数', value: String(stats.value.length), sub: '三榜并集' },
    ];
  }
  const memberCount = isAllScope.value
    ? aggregates.value.length
    : new Set(dayData.value?.rows.map((row) => row.memberName)).size;
  const cards: StatCard[] = [
    { label: '合并总多单', value: grandTotals.value.buy.toLocaleString('en-US'), valueClass: 'text-up', sub: '手' },
    { label: '合并总空单', value: grandTotals.value.sell.toLocaleString('en-US'), valueClass: 'text-down', sub: '手' },
  ];
  if (scope.value === 'product') {
    cards.push({ label: '总成交量', value: grandTotals.value.volume.toLocaleString('en-US'), sub: '手' });
  }
  cards.push(
    {
      label: '合并净差',
      value: grandTotals.value.net.toLocaleString('en-US'),
      valueClass: grandTotals.value.net >= 0 ? 'text-up' : 'text-down',
      sub: '多 − 空',
    },
    { label: '上榜席位数', value: String(memberCount), sub: isAllScope.value ? '四品种去重' : '三榜并集' },
  );
  return cards;
});

/**
 * 语义色类（正 up / 负 down / 0 flat）
 * @param value 数值
 * @returns 类名
 */
const signClass = (value: number): string => (value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-flat');

/**
 * 带符号整数文案
 * @param value 数值（null 显 --）
 * @returns 文案
 */
const signed = (value: number | null): string =>
  value === null ? '--' : `${value > 0 ? '+' : ''}${value.toLocaleString('en-US')}`;

/**
 * 百分比文案（保留一位小数，null 显 --）
 * @param value 百分数数值
 * @returns 文案
 */
const pct = (value: number | null): string => (value === null ? '--' : `${value.toFixed(1)}%`);

/** 衍生榜单条目 */
interface RankItem {
  /** 席位名 */
  name: string;
  /** 数值（手） */
  value: number;
}

/** 衍生榜单（contract 六榜 / aggregate 三榜） */
const rankLists = computed(() => {
  if (scope.value === 'contract') {
    const pickTop = (
      rows: readonly CcpmMemberStats[],
      value: (row: CcpmMemberStats) => number | null,
      dir: 'desc' | 'asc',
    ): RankItem[] =>
      rows
        .map((row) => ({ name: row.memberName, value: value(row) }))
        .filter((item): item is RankItem => item.value !== null && item.value !== 0)
        .sort((a, b) => (dir === 'desc' ? b.value - a.value : a.value - b.value))
        .slice(0, 5);
    return [
      { title: '净多 TOP', items: pickTop(stats.value, (row) => row.netPos, 'desc') },
      { title: '净空 TOP', items: pickTop(stats.value, (row) => row.netPos, 'asc') },
      { title: '多单增仓 TOP', items: pickTop(stats.value, (row) => row.buyChg, 'desc') },
      { title: '多单减仓 TOP', items: pickTop(stats.value, (row) => row.buyChg, 'asc') },
      { title: '空单增仓 TOP', items: pickTop(stats.value, (row) => row.sellChg, 'desc') },
      { title: '空单减仓 TOP', items: pickTop(stats.value, (row) => row.sellChg, 'asc') },
    ];
  }
  const pickAgg = (
    rows: readonly CcpmAggregateRow[],
    value: (row: CcpmAggregateRow) => number,
    dir: 'desc' | 'asc',
  ): RankItem[] =>
    rows
      .map((row) => ({ name: row.memberName, value: value(row) }))
      .filter((item) => item.value !== 0)
      .sort((a, b) => (dir === 'desc' ? b.value - a.value : a.value - b.value))
      .slice(0, 5);
  return [
    { title: '合并净多 TOP', items: pickAgg(aggregates.value, (row) => row.totalNet, 'desc') },
    { title: '合并净空 TOP', items: pickAgg(aggregates.value, (row) => row.totalNet, 'asc') },
    { title: '净增减 TOP', items: pickAgg(aggregates.value, (row) => row.totalNetChg, 'desc') },
  ];
});

/**
 * 选中 / 取消选中席位（总表行点击）
 * @param memberName 席位名
 */
const onSelectMember = (memberName: string): void => {
  memberPicked.value = true;
  selectedMember.value = selectedMember.value === memberName ? null : memberName;
};

/**
 * 分组主表行点击：其他机构行 → 开详情弹窗；中信行 → 选中画像
 * @param memberName 席位名
 */
const onGroupRowClick = (memberName: string): void => {
  if (memberName === OTHERS_ROW_NAME) {
    othersOpen.value = true;
    return;
  }
  onSelectMember(memberName);
};

/**
 * 详情弹窗行点击：选中该席位为画像并收起弹窗
 * @param memberName 席位名
 */
const onPickDetailMember = (memberName: string): void => {
  memberPicked.value = true;
  selectedMember.value = memberName;
  othersOpen.value = false;
};

/**
 * 展开 / 收起席位分解行
 * @param memberName 席位名
 */
const onToggleExpand = (memberName: string): void => {
  expandedMembers.value = expandedMembers.value.includes(memberName)
    ? expandedMembers.value.filter((item) => item !== memberName)
    : [...expandedMembers.value, memberName];
};

/** 加载选中席位的净持仓时序（近 N 个披露日，逐日拉取落缓存） */
const loadSeries = async (): Promise<void> => {
  if (!selectedMember.value || !resolvedDay.value) {
    return;
  }
  seriesLoading.value = true;
  try {
    series.value = await props.runtime.data.fetchMemberSeries(
      selectedMember.value,
      isAllScope.value ? CCPM_EQUITY_PRODUCT_ORDER : [product.value as CcpmProductCode],
      resolvedDay.value,
    );
  } finally {
    seriesLoading.value = false;
  }
};

// 选中席位切换时清空旧时序
watch(selectedMember, () => {
  series.value = null;
});

/** 是否含部分头寸（聚合口径选中席位） */
const selectedPartial = computed(() => selectedAggregate.value?.isPartial ?? false);

/** 移仓换月条目（单品种口径且有 ≥2 合约时参与判定） */
const rollEntries = computed(() => (dayData.value ? computeCcpmRollEntries(dayData.value) : []));

/** 移仓面板是否展开（默认收起） */
const rollExpanded = ref(false);

/** 曲线对照数据：中信期货逐日净增减 + 各指数日 K 收盘表（symbol → date → close） */
const combo = ref<{
  points: CcpmMemberDayPoint[];
  closes: Record<string, Map<string, number>>;
} | null>(null);

/** 曲线对照加载中 */
const comboLoading = ref(false);

/** 曲线对照失败文案（空串 = 无错误） */
const comboError = ref('');

/**
 * 加载曲线对照数据：中信期货(代客) 全股指合并逐日净增减（CCPM 时序）
 * + 五大指数日 K 收盘表（腾讯源，会话缓存），供同一画布对照
 */
const loadCombo = async (): Promise<void> => {
  if (comboLoading.value || !resolvedDay.value) {
    return;
  }
  comboLoading.value = true;
  comboError.value = '';
  try {
    const [series, ...closeMaps] = await Promise.all([
      props.runtime.data.fetchMemberSeries(
        DEFAULT_MEMBER,
        CCPM_EQUITY_PRODUCT_ORDER,
        resolvedDay.value,
      ),
      ...INDEX_COMBO_INDEXES.map((ref) =>
        fetchIndexCloses(props.runtime.deps.http, ref.symbol),
      ),
    ]);
    const closes: Record<string, Map<string, number>> = {};
    INDEX_COMBO_INDEXES.forEach((ref, index) => {
      closes[ref.symbol] = closeMaps[index] ?? new Map();
    });
    combo.value = { points: series.points, closes };
  } catch (error) {
    combo.value = null;
    comboError.value = error instanceof Error ? error.message : String(error);
  } finally {
    comboLoading.value = false;
  }
};

// 披露日切换后旧对照数据作废；历史对照尝试从本地快照恢复（同锚点秒开）
watch(resolvedDay, () => {
  combo.value = null;
  comboError.value = '';
  historyCombo.value = null;
  historyError.value = '';
  historyStaleDay.value = '';
  void restoreHistorySnapshot();
});

/* ==================== 历史对照：中信净增减柱状 × 上证指数蜡烛（近 5 年，可缩放） ==================== */

/** 图表主题信号（html class / data-theme 变化时翻转，驱动 option 重算） */
const themeSignal = useChartThemeSignal();

/** 历史对照数据：中信全股指合并逐日净增减（近 5 年披露日）+ 上证指数日 K 蜡烛表 */
const historyCombo = ref<{
  /** 中信净增减时序点（按交易日升序） */
  points: CcpmMemberDayPoint[];
  /** 上证指数日 K 蜡烛（yyyy-MM-dd → 蜡烛） */
  candles: Map<string, IndexCandle>;
} | null>(null);

/** 历史对照加载中 */
const historyLoading = ref(false);

/** 历史对照失败文案（空串 = 无错误） */
const historyError = ref('');

/** 历史对照加载进度文案（空串 = 未在拉取） */
const historyProgress = ref('');

/** 展示中的旧快照锚点日（换日后先展示旧快照再刷新时非空，yyyy-MM-dd） */
const historyStaleDay = ref('');

/**
 * 快照蜡烛元组 → Map（损坏行跳过）
 * @param tuples 快照蜡烛元组数组 [日期, 开, 收, 高, 低]
 * @returns 蜡烛 Map（yyyy-MM-dd → 蜡烛）
 */
const toCandleMap = (tuples: HistoryComboSnapshot['candles']): Map<string, IndexCandle> => {
  const map = new Map<string, IndexCandle>();
  for (const [date, open, close, high, low] of tuples) {
    if (date && [open, close, high, low].every((value) => Number.isFinite(value) && value > 0)) {
      map.set(date, { date, open, close, high, low });
    }
  }
  return map;
};

/**
 * 蜡烛 Map → 快照元组（落库压缩 json 体积）
 * @param candles 蜡烛 Map（yyyy-MM-dd → 蜡烛）
 * @returns 快照蜡烛元组数组 [日期, 开, 收, 高, 低]
 */
const toCandleTuples = (
  candles: Map<string, IndexCandle>,
): HistoryComboSnapshot['candles'] =>
  [...candles.values()].map((candle) => [
    candle.date,
    candle.open,
    candle.close,
    candle.high,
    candle.low,
  ]);

/**
 * 从本地快照恢复历史对照（仅同锚点日命中才使用；换日不恢复，避免新旧数据混淆）
 */
const restoreHistorySnapshot = async (): Promise<void> => {
  if (historyCombo.value || historyLoading.value || !resolvedDay.value) {
    return;
  }
  const snapshot = await props.runtime.repo.readHistorySnapshot().catch(() => null);
  if (snapshot && snapshot.anchorDay === resolvedDay.value && snapshot.points.length >= 2) {
    historyCombo.value = { points: snapshot.points, candles: toCandleMap(snapshot.candles) };
  }
};

/**
 * 加载历史对照数据（中信期货(代客) 全股指合并近 5 年逐日净增减 + 上证指数日 K 蜡烛）：
 * - 同锚点快照命中 → 直接使用本地快照，不回源（秒开）；
 * - 锚点日已更新（新披露日）→ 先展示旧快照（标注数据截止日），后台增量刷新；
 * - 无快照 → 全量回填（逐日落 ctx.db 缓存，中断续传）；成功后写快照供下次秒开。
 * @param force 跳过快照命中强制回源（「刷新」按钮）
 */
const loadHistoryCombo = async (force = false): Promise<void> => {
  if (historyLoading.value || !resolvedDay.value) {
    return;
  }
  const anchor = resolvedDay.value;
  const snapshot = await props.runtime.repo.readHistorySnapshot().catch(() => null);
  const usable =
    snapshot && Array.isArray(snapshot.points) && snapshot.points.length >= 2 ? snapshot : null;
  if (usable && usable.anchorDay === anchor && !force) {
    historyCombo.value = { points: usable.points, candles: toCandleMap(usable.candles) };
    historyStaleDay.value = '';
    historyError.value = '';
    return;
  }
  if (usable && usable.anchorDay !== anchor) {
    // 换日：旧快照先顶上（清晰标注截止日），刷新完成后无缝替换
    historyCombo.value = { points: usable.points, candles: toCandleMap(usable.candles) };
    historyStaleDay.value = usable.anchorDay;
  }
  historyLoading.value = true;
  historyError.value = '';
  historyProgress.value = '准备中…';
  try {
    const [memberSeries, candles] = await Promise.all([
      props.runtime.data.fetchMemberSeries(
        DEFAULT_MEMBER,
        CCPM_EQUITY_PRODUCT_ORDER,
        resolvedDay.value,
        HISTORY_COMBO_DAYS,
        (done, total) => {
          historyProgress.value = `席位数据 ${done}/${total} 个披露日`;
        },
      ),
      fetchIndexCandles(props.runtime.deps.http, HISTORY_COMBO_SYMBOL, HISTORY_KLINE_DAYS),
    ]);
    historyCombo.value = { points: memberSeries.points, candles };
    historyStaleDay.value = '';
    // 快照落库：重进页面 / 同一披露日内重开秒开，不必重跑 1250 个披露日的聚合
    await props.runtime.repo
      .writeHistorySnapshot({
        anchorDay: anchor,
        points: memberSeries.points,
        candles: toCandleTuples(candles),
        at: Date.now(),
      })
      .catch(() => undefined);
  } catch (error) {
    // 无旧快照兜底才清空；有兜底则保留旧数据 + 错误提示
    if (!historyStaleDay.value) {
      historyCombo.value = null;
    }
    historyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    historyLoading.value = false;
    historyProgress.value = '';
  }
};

/** 历史对照视图模型：日期轴 + 净增减柱 + 上证蜡烛（对齐） + tooltip 收盘查表 */
interface HistoryChart {
  /** 披露日标签（yyyy-MM-dd） */
  labels: string[];
  /** 净增减（手，与 labels 对齐） */
  chgs: number[];
  /** 上证蜡烛列（[开, 收, 低, 高]，与 labels 对齐；当日无 K 线为 null） */
  candles: (number[] | null)[];
  /** 蜡烛日 → 收盘价与前一蜡烛日收盘价（tooltip 涨跌幅用） */
  quoteByDate: Map<string, { close: number; prevClose: number | null }>;
  /** 柱状刻度上限（|净增减| 最大值） */
  barMax: number;
  /** dataZoom 初始起点百分比（默认聚焦最近 N 个披露日） */
  startPct: number;
}

/** 历史对照图表数据（披露日不足两个时为 null，视图显示空态） */
const historyChart = computed<HistoryChart | null>(() => {
  const data = historyCombo.value;
  if (!data || data.points.length < 2) {
    return null;
  }
  // CCPM 交易日 yyyyMMdd → yyyy-MM-dd（与腾讯 K 线日期键对齐）
  const labels = data.points.map(
    (point) =>
      `${point.tradingDay.slice(0, 4)}-${point.tradingDay.slice(4, 6)}-${point.tradingDay.slice(6, 8)}`,
  );
  const chgs = data.points.map((point) => point.totalNetChg);
  const barMax = Math.max(1, ...chgs.map((value) => Math.abs(value)));
  const candles: (number[] | null)[] = [];
  const quoteByDate = new Map<string, { close: number; prevClose: number | null }>();
  let prevClose: number | null = null;
  for (const key of labels) {
    const candle = data.candles.get(key);
    if (candle) {
      candles.push([candle.open, candle.close, candle.low, candle.high]);
      quoteByDate.set(key, { close: candle.close, prevClose });
      prevClose = candle.close;
    } else {
      candles.push(null);
    }
  }
  const startPct = Math.max(0, (1 - HISTORY_VIEW_DEFAULT_DAYS / labels.length) * 100);
  return { labels, chgs, candles, quoteByDate, barMax, startPct };
});

/**
 * 历史对照：tooltip 文本组装（日期 + 净增减手数 + 上证 OHLC 与涨跌幅）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const historyTooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    seriesName?: string;
    /** 柱状为数值；蜡烛为 [dataIndex, 开, 收, 低, 高]（4 元组时无 dataIndex 前缀） */
    value?: number | number[] | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const lines: string[] = [params[0]?.axisValue ?? ''];
  for (const param of params) {
    if (param.seriesName === '中信净增减' && typeof param.value === 'number') {
      if (Number.isFinite(param.value)) {
        lines.push(`中信净增减 ${param.value.toLocaleString('en-US')} 手`);
      }
    } else if (param.seriesName === '上证指数' && Array.isArray(param.value)) {
      const dims = param.value.length === 5 ? param.value.slice(1) : param.value;
      const [open, close, low, high] = dims as number[];
      if ([open, close, low, high].every((value) => Number.isFinite(value))) {
        lines.push(`上证指数 开 ${open.toFixed(2)} · 收 ${close.toFixed(2)} · 低 ${low.toFixed(2)} · 高 ${high.toFixed(2)}`);
        const quote = historyChart.value?.quoteByDate.get(param.axisValue ?? '');
        if (quote && quote.prevClose !== null && quote.prevClose > 0) {
          const pctChg = ((close - quote.prevClose) / quote.prevClose) * 100;
          lines.push(`涨跌幅 ${pctChg >= 0 ? '+' : ''}${pctChg.toFixed(2)}%`);
        }
      }
    }
  }
  return lines.join('<br/>');
};

/** 历史对照 ECharts 配置（双 y 轴：左净增减手数 / 右上证点位，dataZoom 缩放） */
const historyOption = computed<EChartsCoreOption | null>(() => {
  const chart = historyChart.value;
  if (!chart) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const up = semanticColor('--color-up', '#dc2626');
  const down = semanticColor('--color-down', '#16a34a');
  const axisLabel = { color: palette.text, fontSize: 10 } as const;
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: historyTooltipFormatter,
    },
    legend: {
      data: ['中信净增减', '上证指数'],
      textStyle: { color: palette.text, fontSize: 11 },
      top: 0,
    },
    grid: { left: 8, right: 8, top: 26, bottom: 56, containLabel: true },
    xAxis: {
      type: 'category',
      data: chart.labels,
      axisLabel: { ...axisLabel, formatter: (value: string) => value.slice(2) },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '手',
        nameTextStyle: { color: palette.text, fontSize: 10 },
        min: -chart.barMax * 1.15,
        max: chart.barMax * 1.15,
        axisLabel: { ...axisLabel, formatter: (value: number) => value.toLocaleString('en-US') },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        scale: true,
        name: '点位',
        nameTextStyle: { color: palette.text, fontSize: 10 },
        axisLabel: { ...axisLabel, formatter: (value: number) => value.toFixed(0) },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', start: chart.startPct, end: 100, zoomOnMouseWheel: true },
      { type: 'slider', start: chart.startPct, end: 100, bottom: 10, height: 20 },
    ],
    series: [
      {
        name: '中信净增减',
        type: 'bar',
        data: chart.chgs.map((value) => ({
          value,
          itemStyle: { color: value >= 0 ? up : down, opacity: 0.85 },
        })),
        barMaxWidth: 14,
      },
      {
        name: '上证指数',
        type: 'candlestick',
        yAxisIndex: 1,
        data: chart.candles,
        itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
      },
    ],
  };
});

/** 曲线对照视图模型：日期轴 + 净增减柱 + 归一化曲线 */
interface ComboChart {
  /** 披露日标签（MM/DD） */
  labels: string[];
  /** 净增减（手，与 labels 对齐） */
  chgs: number[];
  /** 柱状刻度上限（|净增减| 最大值） */
  barMax: number;
  /** 指数曲线（颜色 / 名称 / 归一化涨跌幅 % 点列，与 labels 对齐） */
  lines: { name: string; color: string; values: number[] }[];
  /** 线轴（%）上下界 */
  pctMin: number;
  pctMax: number;
}

/** 曲线对照图表数据（数据不足两个披露日时为 null，视图显示空态） */
const comboChart = computed<ComboChart | null>(() => {
  const data = combo.value;
  if (!data || data.points.length < 2) {
    return null;
  }
  // CCPM 交易日为 yyyyMMdd，腾讯 K 线日期为 yyyy-MM-dd，统一成后者查表
  const dateKeys = data.points.map(
    (point) => `${point.tradingDay.slice(0, 4)}-${point.tradingDay.slice(4, 6)}-${point.tradingDay.slice(6, 8)}`,
  );
  const chgs = data.points.map((point) => point.totalNetChg);
  const barMax = Math.max(1, ...chgs.map((value) => Math.abs(value)));

  const lines: ComboChart['lines'] = [];
  for (const ref of INDEX_COMBO_INDEXES) {
    const map = data.closes[ref.symbol];
    // 窗口首日收盘为归一基准；首日缺席（极少数日历错位）时顺延到首个有收盘的交易日
    let base: number | undefined = map?.get(dateKeys[0] ?? '');
    if (base === undefined) {
      for (const key of dateKeys) {
        const close = map?.get(key);
        if (close !== undefined) {
          base = close;
          break;
        }
      }
    }
    if (!map || base === undefined || base <= 0) {
      continue;
    }
    // 逐日前向填充（节假日两侧日历一致，缺数据时沿用上一收盘，保证线不断）
    const values: number[] = [];
    let last = base;
    for (const key of dateKeys) {
      const close = map.get(key) ?? last;
      last = close;
      values.push(((close / base) - 1) * 100);
    }
    lines.push({ name: ref.name, color: ref.color, values });
  }
  if (lines.length === 0) {
    return null;
  }
  const allPct = lines.flatMap((line) => line.values);
  const pctRawMin = Math.min(...allPct);
  const pctRawMax = Math.max(...allPct);
  const pctPad = Math.max((pctRawMax - pctRawMin) * 0.08, 0.3);
  return {
    labels: dateKeys.map((key) => key.slice(5).replace('-', '/')),
    chgs,
    barMax,
    lines,
    pctMin: pctRawMin - pctPad,
    pctMax: pctRawMax + pctPad,
  };
});

/**
 * 曲线对照：tooltip 文本组装（日期 + 净增减手数 + 各指数涨跌幅）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const comboTooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    seriesName?: string;
    value?: number | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const lines: string[] = [params[0]?.axisValue ?? ''];
  for (const param of params) {
    if (param.value === null || param.value === undefined || !Number.isFinite(param.value)) {
      continue;
    }
    if (param.seriesName === '净增减（手）') {
      lines.push(`净增减 ${param.value.toLocaleString('en-US')} 手`);
    } else if (param.seriesName) {
      lines.push(`${param.seriesName} ${param.value.toFixed(2)}%`);
    }
  }
  return lines.join('<br/>');
};

/** 曲线对照 ECharts 配置（双 y 轴：左净增减手数 / 右指数涨跌幅%） */
const comboOption = computed<EChartsCoreOption | null>(() => {
  const chart = comboChart.value;
  if (!chart) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const axisLabel = { color: palette.text, fontSize: 10 } as const;
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: comboTooltipFormatter,
    },
    grid: { left: 8, right: 8, top: 18, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: chart.labels,
      axisLabel,
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '手',
        nameTextStyle: { color: palette.text, fontSize: 10 },
        min: -chart.barMax * 1.15,
        max: chart.barMax * 1.15,
        axisLabel: { ...axisLabel, formatter: (value: number) => value.toLocaleString('en-US') },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      {
        type: 'value',
        min: chart.pctMin,
        max: chart.pctMax,
        axisLabel: { ...axisLabel, formatter: (value: number) => `${value.toFixed(1)}%` },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '净增减（手）',
        type: 'bar',
        data: chart.chgs.map((value) => ({
          value,
          itemStyle: {
            color: value >= 0 ? semanticColor('--color-up', '#dc2626') : semanticColor('--color-down', '#16a34a'),
            opacity: 0.85,
          },
        })),
        barMaxWidth: 18,
      },
      ...chart.lines.map((line) => ({
        name: line.name,
        type: 'line',
        yAxisIndex: 1,
        data: line.values,
        showSymbol: false,
        lineStyle: { width: 1.6, color: line.color },
        itemStyle: { color: line.color },
      })),
    ],
  };
});

/** 多空并排柱状图数据：只看中信期货与其他机构汇总两行 */
const barRows = computed(() => {
  if (scope.value === 'contract') {
    const zx = stats.value.find((row) => row.memberName === DEFAULT_MEMBER);
    const others = othersStats.value;
    const rows: { name: string; buy: number; sell: number }[] = [];
    if (zx) {
      rows.push({ name: zx.memberName, buy: zx.buyPos ?? 0, sell: zx.sellPos ?? 0 });
    }
    if (others) {
      rows.push({ name: OTHERS_ROW_NAME, buy: others.buyPos ?? 0, sell: others.sellPos ?? 0 });
    }
    return rows;
  }
  const zx = aggregates.value.find((row) => row.memberName === DEFAULT_MEMBER);
  const others = othersAggregate.value;
  const rows: { name: string; buy: number; sell: number }[] = [];
  if (zx) {
    rows.push({ name: zx.memberName, buy: zx.totalBuy, sell: zx.totalSell });
  }
  if (others) {
    rows.push({ name: OTHERS_ROW_NAME, buy: others.totalBuy, sell: others.totalSell });
  }
  return rows;
});

/**
 * 多空并排柱状：tooltip 文本组装（席位 + 多单 / 空单手数）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const barTooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    seriesName?: string;
    value?: number | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const lines: string[] = [params[0]?.axisValue ?? ''];
  for (const param of params) {
    if (param.seriesName) {
      lines.push(`${param.seriesName} ${(param.value ?? 0).toLocaleString('en-US')} 手`);
    }
  }
  return lines.join('<br/>');
};

/** 多空并排柱状 ECharts 配置（横向双系列：多单红 / 空单绿） */
const barOption = computed<EChartsCoreOption | null>(() => {
  if (barRows.value.length === 0) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  // 横向 category 轴自下而上渲染，反转后榜首在最上
  const rows = [...barRows.value].reverse();
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: barTooltipFormatter,
    },
    legend: {
      data: ['多单', '空单'],
      textStyle: { color: palette.text, fontSize: 11 },
      top: 0,
    },
    grid: { left: 8, right: 44, top: 26, bottom: 2, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: palette.text, fontSize: 10, formatter: (value: number) => value.toLocaleString('en-US') },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    yAxis: {
      type: 'category',
      data: rows.map((row) => row.name.slice(0, 10)),
      axisLabel: { color: palette.text, fontSize: 11 },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    series: [
      {
        name: '多单',
        type: 'bar',
        data: rows.map((row) => row.buy),
        itemStyle: { color: semanticColor('--color-up', '#dc2626') },
        barWidth: 7,
      },
      {
        name: '空单',
        type: 'bar',
        data: rows.map((row) => row.sell),
        itemStyle: { color: semanticColor('--color-down', '#16a34a') },
        barWidth: 7,
      },
    ],
  };
});

/**
 * 净持仓时序：tooltip 文本组装（日期 + 净持仓手数）
 * @param raw ECharts 透传的 formatter 参数（unknown 收敛）
 * @returns HTML 文本
 */
const seriesTooltipFormatter = (raw: unknown): string => {
  interface TooltipParam {
    axisValue?: string;
    value?: number | null;
  }
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  const value = params[0]?.value;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return params[0]?.axisValue ?? '';
  }
  return `${params[0]?.axisValue ?? ''}<br/>净持仓 ${value.toLocaleString('en-US')} 手`;
};

/** 净持仓时序 ECharts 配置（线色随净多 / 净空语义：正红负绿） */
const seriesOption = computed<EChartsCoreOption | null>(() => {
  const points = series.value?.points ?? [];
  if (points.length < 2) {
    return null;
  }
  const isDark = themeSignal.value;
  const palette = chartPalette(isDark);
  const latest = points[points.length - 1]?.totalNet ?? 0;
  const lineColor = latest >= 0 ? semanticColor('--color-up', '#dc2626') : semanticColor('--color-down', '#16a34a');
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: isDark ? '#dfe6ee' : '#3a4453', fontSize: 11 },
      formatter: seriesTooltipFormatter,
    },
    grid: { left: 8, right: 12, top: 12, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: points.map((point) => point.tradingDay.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')),
      axisLabel: { color: palette.text, fontSize: 10 },
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.text, fontSize: 10, formatter: (value: number) => value.toLocaleString('en-US') },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        name: '净持仓（手）',
        type: 'line',
        data: points.map((point) => point.totalNet),
        showSymbol: false,
        lineStyle: { width: 1.8, color: lineColor },
        itemStyle: { color: lineColor },
        areaStyle: { opacity: 0.08, color: lineColor },
      },
    ],
  };
});

/** 披露交易日（yyyy-MM-dd，数据未就绪为空串） */
const resolvedDayText = computed(() =>
  resolvedDay.value ? resolvedDay.value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
);

/** 数据来源公告条文案 */
const sourceNoticeText = computed(() =>
  resolvedDayText.value
    ? `数据来源：中金所 CCPM · 披露交易日 ${resolvedDayText.value}`
    : '数据来源：中金所 CCPM',
);

/**
 * 触发历史同步（一次性任务，防重入）
 */
const runSync = async (): Promise<void> => {
  if (syncing.value) {
    return;
  }
  syncing.value = true;
  syncText.value = '同步中…';
  try {
    const result = await syncHistory(props.runtime.repo, props.runtime.data, props.runtime.deps, (p) => {
      syncText.value = `同步中 ${p.done}/${p.total}（${p.product}）`;
    });
    syncText.value = `上次同步：${result.products.length} 品种 × ${result.days} 天`;
  } catch {
    syncText.value = '同步失败，请稍后重试';
  } finally {
    syncing.value = false;
  }
};

/**
 * 收集机构行为的 AI 分析数据段：概览指标 + 席位排行 + 选中席位明细
 * @returns 数据段列表
 */
const collectAiDatasets = (): CcpmAnalysisDataset[] => {
  const overview: CcpmAnalysisDataset = {
    title: '概览指标',
    columns: [
      { label: '指标', key: 'k' },
      { label: '数值（手）', key: 'v' },
    ],
    rows: statCards.value.map((card) => ({ k: card.label, v: `${card.value} ${card.sub ?? ''}`.trim() })),
  };
  const rankRows: Record<string, unknown>[] = [];
  for (const list of rankLists.value) {
    for (const item of list.items) {
      rankRows.push({ rank: list.title, member: item.name, value: item.value });
    }
  }
  const ranks: CcpmAnalysisDataset = {
    title: '衍生榜单（净多 / 净空 / 多空增减仓 TOP）',
    columns: [
      { label: '榜单', key: 'rank' },
      { label: '席位', key: 'member' },
      { label: '数值（手）', key: 'value' },
    ],
    rows: rankRows,
  };
  const datasets: CcpmAnalysisDataset[] = [overview, ranks];
  if (selectedMember.value && selectedAggregate.value !== null) {
    datasets.push({
      title: `选中席位明细：${selectedMember.value}`,
      columns: [
        { label: '多单', key: 'buy' },
        { label: '多单增减', key: 'buyChg' },
        { label: '空单', key: 'sell' },
        { label: '空单增减', key: 'sellChg' },
        { label: '净持仓', key: 'net' },
      ],
      rows: [
        {
          buy: selectedAggregate.value.totalBuy,
          buyChg: selectedAggregate.value.totalBuyChg,
          sell: selectedAggregate.value.totalSell,
          sellChg: selectedAggregate.value.totalSellChg,
          net: selectedAggregate.value.totalNet,
        },
      ],
    });
  }
  return datasets;
};

/**
 * 发起「AI 分析」：把 CCPM 席位持仓数据交给 Agent（经 app:agent-ask 服务）
 */
const runAiAnalysis = async (): Promise<void> => {
  if (aiRunning.value || !props.runtime.deps.agentAsk) {
    return;
  }
  const prompt = buildCcpmAnalysisPrompt(
    CCPM_SCOPE_LABELS[scope.value],
    resolvedDayText.value,
    collectAiDatasets(),
  );
  if (prompt === '') {
    props.runtime.deps.notify?.notify({
      title: '暂无可分析的持仓数据',
      body: '请等待席位数据加载完成后再发起 AI 分析',
    });
    return;
  }
  aiRunning.value = true;
  try {
    await props.runtime.deps.agentAsk.ask(prompt, {
      pluginId: FUTURES_INSTITUTIONAL_PLUGIN_ID,
      pluginName: '期货·机构行为',
    });
  } finally {
    aiRunning.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 数据来源公告条 -->
    <div class="rounded-card bg-flat-weak px-4 py-2 text-xs text-text-secondary">{{ sourceNoticeText }}</div>

    <!-- 筛选卡（品种 / 口径 / 合约走 ui.Tabs 分段按钮组，日期输入用宿主统一类；动作按钮收进卡内） -->
    <section class="rounded-card bg-surface p-4 shadow-card">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="min-w-14 shrink-0 text-xs font-semibold text-text-tertiary">品种</span>
        <component
          :is="runtime.deps.ui.Tabs"
          v-model="product"
          :options="productOptions"
          class="max-w-full"
        />
        <span class="ml-auto text-xs text-text-tertiary">交易日</span>
        <input
          v-model="dayInput"
          type="date"
          class="rounded-lg bg-flat-weak px-3 py-1.5 text-sm text-text outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="min-w-14 shrink-0 text-xs font-semibold text-text-tertiary">合并口径</span>
        <component :is="runtime.deps.ui.Tabs" v-model="scope" :options="scopeOptions" />
        <span class="ml-auto flex items-center gap-2">
          <component
            :is="runtime.deps.ui.Button"
            variant="ghost"
            :disabled="loading"
            @click="void loadDay(dayInput)"
          >
            {{ loading ? '刷新中…' : '刷新' }}
          </component>
          <component
            :is="runtime.deps.ui.Button"
            v-if="aiAvailable"
            variant="ghost"
            :disabled="aiRunning"
            @click="runAiAnalysis"
          >
            {{ aiRunning ? '分析中…' : 'AI 分析' }}
          </component>
        </span>
      </div>

      <div
        v-if="scope === 'contract'"
        class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        <span class="min-w-14 shrink-0 text-xs font-semibold text-text-tertiary">合约</span>
        <component :is="runtime.deps.ui.Tabs" v-model="instrument" :options="instrumentOptions" />
      </div>

      <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="min-w-14 shrink-0 text-xs font-semibold text-text-tertiary">席位</span>
        <component
          :is="runtime.deps.ui.Input"
          v-model="search"
          type="search"
          placeholder="搜索其他机构席位（用于详情弹窗）"
          class="w-56"
        />
        <span class="ml-auto flex items-center gap-3 text-xs text-text-secondary">
          <component
            :is="runtime.deps.ui.Button"
            variant="primary"
            :disabled="syncing"
            @click="runSync"
          >
            {{ syncing ? '同步中…' : '同步历史' }}
          </component>
          <span class="max-w-[420px]">{{ syncText || '首次使用请先点「同步历史」回填本地库（中金所数据可重取，不做旧库迁移）' }}</span>
        </span>
      </div>
    </section>

    <div class="rounded-card bg-flat-weak px-4 py-2.5 text-xs leading-relaxed text-text-secondary">
      <span class="font-semibold text-text">数据边界：</span>{{ FUTURES_PAGE_TEXT.dataBoundary }}
    </div>

    <div
      v-if="isAllScope"
      class="rounded-card bg-up-weak px-4 py-2.5 text-xs leading-relaxed text-up-strong"
    >
      <span class="font-semibold">⚠ 全股指合并口径提醒</span>
      <ul class="mt-1 list-inside list-disc space-y-0.5">
        <li v-for="line in FUTURES_PAGE_TEXT.allScopeWarn" :key="line">{{ line }}</li>
      </ul>
    </div>

    <!-- 首屏骨架（app:ui Card + Skeleton） -->
    <template v-if="loading">
      <component :is="runtime.deps.ui.Card"><component :is="runtime.deps.ui.Skeleton" /></component>
      <component :is="runtime.deps.ui.Card"><component :is="runtime.deps.ui.Skeleton" /></component>
    </template>

    <!-- 空态（app:ui Card + Empty + Button） -->
    <component
      :is="runtime.deps.ui.Card"
      v-else-if="noData || activeDataList.length === 0"
    >
      <component
        :is="runtime.deps.ui.Empty"
        :text="`${dayInput} 无披露数据（非交易日或尚未披露）`"
      />
      <div class="flex justify-center pb-4">
        <component
          :is="runtime.deps.ui.Button"
          variant="ghost"
          @click="void fallbackToLatest()"
        >
          切换到最近披露日
        </component>
      </div>
    </component>

    <template v-else>
      <!-- 概览指标卡 -->
      <div class="grid grid-cols-2 gap-2 min-[900px]:grid-cols-5">
        <div v-for="card in statCards" :key="card.label" class="rounded-card bg-surface px-3 py-2">
          <div class="text-xs text-text-tertiary">{{ card.label }}</div>
          <div class="mt-1 text-base font-semibold" :class="card.valueClass">{{ card.value }}</div>
          <div v-if="card.sub" class="text-xs text-text-tertiary">{{ card.sub }}</div>
        </div>
      </div>

      <!-- 上榜会员总表（分组视图：中信期货 + 其他机构汇总；app:ui Table：列配置驱动 + expandable）；整行 100% 宽 -->
      <component
        :is="runtime.deps.ui.Card"
        fill
        class="min-w-0 w-full"
        :title="scope === 'contract' ? `上榜会员总表 · ${instrument || instruments[0] || ''}` : '上榜会员总表（聚合口径）'"
      >
        <template #extra>
          <span class="text-xs text-text-tertiary">点击中信行选中画像，点击「其他机构」行查看全部机构明细</span>
        </template>
        <component
          :is="runtime.deps.ui.Table"
          :columns="tableColumns"
          :rows="groupRows"
          :row-key="rowKeyOf"
          row-clickable
          expandable
          :expanded-keys="expandedMembers"
          @row-click="onGroupRowClick($event.memberName)"
          @toggle-expand="onToggleExpand($event.memberName)"
        >
          <template #memberName="{ row }">
            <!-- 其他机构行 = 汇总入口（可点击开弹窗）；中信行 = 当前画像锚点 -->
            <template v-if="row.memberName === OTHERS_ROW_NAME">
              <span class="cursor-pointer text-primary font-semibold underline decoration-dotted underline-offset-2">
                {{ row.memberName }}（{{ othersCount }} 家汇总）
              </span>
            </template>
            <span v-else :class="row.memberName === selectedMember ? 'text-primary font-semibold' : ''">
              {{ row.memberName }}
            </span>
          </template>
          <template #buy="{ row }">
            <span class="text-up">{{ row.buy?.toLocaleString('en-US') }}</span>
          </template>
          <template #buyChg="{ row }">
            <span :class="signClass(row.buyChg ?? 0)">{{ signed(row.buyChg) }}</span>
          </template>
          <template #sell="{ row }">
            <span class="text-down">{{ row.sell?.toLocaleString('en-US') }}</span>
          </template>
          <template #sellChg="{ row }">
            <span :class="signClass(row.sellChg ?? 0)">{{ signed(row.sellChg) }}</span>
          </template>
          <template #net="{ row }">
            <span :class="signClass(row.net ?? 0)">{{ row.net?.toLocaleString('en-US') }}</span>
          </template>
          <template #tag="{ row }">
            <component
              :is="runtime.deps.ui.Tag"
              v-if="row.tag"
              :tone="tagTone(row.tag)"
            >
              {{ FUTURES_PAGE_TEXT.tagLabels[row.tag] }}
            </component>
            <span v-else class="text-text-tertiary">--</span>
          </template>
          <template #expanded="{ row }">
            <div v-if="row.memberName === OTHERS_ROW_NAME" class="text-xs text-text-tertiary">
              点击「其他机构」行打开详情弹窗，查看各家机构的多空持仓与跨合约分解
            </div>
            <template v-else>
              <div class="text-xs text-text-tertiary">
                {{ row.memberName }} · 跨合约分解（该席位上榜 {{ breakdownOf(row.memberName).length }} 个合约）
              </div>
              <div class="mt-1 flex flex-wrap gap-2">
                <span
                  v-for="item in breakdownOf(row.memberName)"
                  :key="item.instrumentId"
                  class="rounded-card bg-surface px-2 py-1 tabular-nums"
                >
                  {{ item.instrumentId }}
                  多 <span class="text-up">{{ (item.buyPos ?? 0).toLocaleString('en-US') }}</span>
                  （<span :class="signClass(item.buyChg ?? 0)">{{ signed(item.buyChg) }}</span>）/
                  空 <span class="text-down">{{ (item.sellPos ?? 0).toLocaleString('en-US') }}</span>
                  （<span :class="signClass(item.sellChg ?? 0)">{{ signed(item.sellChg) }}</span>）
                </span>
                <span
                  v-if="breakdownOf(row.memberName).length === 0"
                  class="text-text-tertiary"
                >无披露明细</span>
              </div>
            </template>
          </template>
        </component>
      </component>

      <!-- 席位画像（总表下方整行）：净持仓 hero + 多空双格 + 结构条 + 行为判定 + 其余汇总 -->
      <component
        :is="runtime.deps.ui.Card"
        :title="`席位画像${selectedMember ? ` · ${selectedMember}` : ''}`"
      >
        <template v-if="profile">
          <!-- 净增减 hero：大号数字锚点（左）+ 净持仓次级展示（右） -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-text-tertiary">净增减（手）</div>
              <div
                class="mt-1.5 text-3xl leading-none font-bold tracking-tight tabular-nums"
                :class="profile.netChg === null ? 'text-text-tertiary' : signClass(profile.netChg)"
              >
                {{ signed(profile.netChg) }}
              </div>
            </div>
            <div class="shrink-0 text-right">
              <div class="text-sm font-medium text-text-tertiary">净持仓（手）</div>
              <div
                class="mt-1.5 text-lg leading-none font-semibold tabular-nums"
                :class="signClass(profile.net)"
              >
                {{ signed(profile.net) }}
              </div>
            </div>
          </div>

          <!-- 多 / 空双格：弱色底区分两侧，增减为次级行 -->
          <div class="mt-3 grid grid-cols-2 gap-2">
            <div class="rounded-lg bg-up-weak px-2.5 py-2">
              <div class="text-xs text-text-tertiary">多单（手）</div>
              <div class="mt-1 text-base leading-none font-semibold text-up tabular-nums">
                {{ profile.buy.toLocaleString('en-US') }}
              </div>
              <div class="mt-1.5 text-xs leading-none text-up tabular-nums">
                增减 {{ signed(profile.buyChg) }}
              </div>
            </div>
            <div class="rounded-lg bg-down-weak px-2.5 py-2">
              <div class="text-xs text-text-tertiary">空单（手）</div>
              <div class="mt-1 text-base leading-none font-semibold text-down tabular-nums">
                {{ profile.sell.toLocaleString('en-US') }}
              </div>
              <div class="mt-1.5 text-xs leading-none text-down tabular-nums">
                增减 {{ signed(profile.sellChg) }}
              </div>
            </div>
          </div>

          <!-- 结构条：聚合口径 → 上榜合约覆盖；单合约口径 → 多空占比 -->
          <div v-if="profile.coveredCount !== null" class="mt-3">
            <div class="flex items-baseline justify-between text-xs">
              <span class="text-text-secondary">上榜合约覆盖</span>
              <span class="text-text tabular-nums">{{ profile.coveredCount }} / {{ profile.totalCount }}</span>
            </div>
            <div class="mt-1 h-1 rounded-full bg-flat">
              <div
                class="h-1 rounded-full bg-primary"
                :style="{
                  width: `${Math.min((profile.coveredCount / Math.max(profile.totalCount ?? 1, 1)) * 100, 100)}%`,
                }"
              />
            </div>
            <div v-if="selectedPartial" class="mt-1.5 text-xs leading-relaxed text-up-strong">
              ⚠ {{ FUTURES_PAGE_TEXT.partialWarn }}
            </div>
          </div>
          <div v-else class="mt-3 space-y-2">
            <div>
              <div class="flex items-baseline justify-between text-xs">
                <span class="text-text-secondary">多单占比（占该合约上榜多单）</span>
                <span class="text-text tabular-nums">{{ pct(profile.buyRatio) }}</span>
              </div>
              <div class="mt-1 h-1 rounded-full bg-flat">
                <div
                  class="h-1 rounded-full bg-up"
                  :style="{ width: `${Math.min(profile.buyRatio ?? 0, 100)}%` }"
                />
              </div>
            </div>
            <div>
              <div class="flex items-baseline justify-between text-xs">
                <span class="text-text-secondary">空单占比（占该合约上榜空单）</span>
                <span class="text-text tabular-nums">{{ pct(profile.sellRatio) }}</span>
              </div>
              <div class="mt-1 h-1 rounded-full bg-flat">
                <div
                  class="h-1 rounded-full bg-down"
                  :style="{ width: `${Math.min(profile.sellRatio ?? 0, 100)}%` }"
                />
              </div>
            </div>
          </div>

          <!-- 行为判定：标签 + 依据（弱底块收拢，与表格行为标注同一套文案） -->
          <div class="mt-3 rounded-lg bg-flat-weak px-2.5 py-2">
            <div class="flex items-center gap-2">
              <span class="text-xs text-text-secondary">行为判定</span>
              <component
                :is="runtime.deps.ui.Tag"
                v-if="profile.tag"
                :tone="tagTone(profile.tag)"
              >
                {{ FUTURES_PAGE_TEXT.tagLabels[profile.tag] }}
              </component>
              <span v-else class="text-xs text-text-tertiary">--</span>
            </div>
            <div v-if="profile.tagReason" class="mt-1 text-xs leading-relaxed text-text-secondary">
              {{ profile.tagReason }}
            </div>
          </div>

          <!-- 其余上榜会员对照 + 判定规则：上方分格线，净字号对齐上方净增减 hero -->
          <div class="mt-3 border-t border-flat-weak pt-3">
            <div v-if="others" class="flex items-baseline justify-between gap-2">
              <span class="min-w-0 truncate text-sm text-text-tertiary">其余 {{ othersCount }} 家上榜汇总</span>
              <span
                class="shrink-0 text-3xl leading-none font-bold tracking-tight tabular-nums"
                :class="signClass(others.net)"
              >
                净 {{ others.net.toLocaleString('en-US') }}
              </span>
            </div>

            <div class="mt-2 text-xs leading-relaxed text-text-tertiary">{{ FUTURES_PAGE_TEXT.tagRule }}</div>
          </div>
        </template>
        <div v-else class="py-8 text-center text-xs text-text-tertiary">
          点击上方总表席位行，查看该席位的多空画像与行为判定
        </div>
      </component>

      <!-- 历史对照：中信净增减柱状 × 上证指数蜡烛图（近 5 年披露日，dataZoom 缩放查看区间；快照持久化秒开） -->
      <component
        :is="runtime.deps.ui.Card"
        :title="`历史对照 · 中信净增减 × 上证指数蜡烛（近 ${historyChart?.labels.length ?? HISTORY_COMBO_DAYS} 个披露日）`"
      >
        <template #extra>
          <span class="mr-2 text-xs text-text-tertiary">{{ historyProgress }}</span>
          <component
            :is="runtime.deps.ui.Button"
            variant="ghost"
            :disabled="historyLoading || !resolvedDay"
            @click="void loadHistoryCombo(historyCombo !== null)"
          >
            {{ historyLoading ? '加载中…' : (historyCombo ? '刷新' : '加载历史对照') }}
          </component>
        </template>
        <div v-if="historyError" class="rounded-lg bg-up-weak px-3 py-2 text-xs text-up">
          加载失败：{{ historyError }}（可再次点击重试，已落库的披露日不会重拉）
        </div>
        <template v-else-if="historyChart && historyOption">
          <div v-if="historyStaleDay" class="mb-1 text-xs text-text-tertiary">
            当前展示快照数据（截至 {{ historyStaleDay }}），正在后台刷新到最新披露日，完成后自动替换…
          </div>
          <!-- 图例（HTML 渲染，色块与柱 / 蜡烛同色语义） -->
          <div class="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-2.5 w-2.5 rounded-sm bg-up" aria-hidden="true" />中信净增减为正（左轴·手）
            </span>
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-2.5 w-2.5 rounded-sm bg-down" aria-hidden="true" />中信净增减为负（左轴·手）
            </span>
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-3 w-2 rounded-sm bg-up" aria-hidden="true" />上证阳线
            </span>
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-3 w-2 rounded-sm bg-down" aria-hidden="true" />上证阴线（右轴·点位）
            </span>
          </div>
          <div class="h-[420px] w-full" role="img" aria-label="中信净增减柱状与上证指数蜡烛历史对照图">
            <EChartBox :options="historyOption" not-merge />
          </div>
          <p class="mt-1 text-xs leading-relaxed text-text-tertiary">
            柱 = 中信期货(代客) IF/IH/IC/IM 合并逐日净增减（左轴·手，涨红跌绿）；蜡烛 = 上证指数日 K（右轴·点位，阳线红 / 阴线绿）。
            滚轮或拖动底部滑块缩放查看指定区间（默认显示最近 {{ HISTORY_VIEW_DEFAULT_DAYS }} 个披露日，可缩放至近 {{ HISTORY_COMBO_DAYS }} 日 ≈ 5 年）。
            净增减 ≠ 看多看空；重点观察中信大幅操作后的次日大盘走势。
            首次加载需逐日回填近 5 年披露数据（较慢，中断后重试自动续传）；加载成功后快照落本地库，重进页面同披露日秒开，换披露日先展示旧快照再后台刷新，「刷新」按钮强制重拉。
          </p>
        </template>
        <div v-else class="py-4 text-xs leading-relaxed text-text-tertiary">
          点「加载历史对照」拉取中信期货(代客)近 {{ HISTORY_COMBO_DAYS }} 个披露日（≈ 5 年）的逐日净增减，
          与上证指数日 K 蜡烛同画布对照，支持缩放查看指定区间——用于观察中信操作后次日大盘的走势。
          首次加载较慢（逐日回填落本地缓存），中断后重试自动续传；加载成功后快照持久化，重进页面免重拉。
        </div>
      </component>

      <!-- 「其他机构」详情弹窗：全部其他上榜机构明细（搜索过滤 + 跨合约展开 + 点行选画像） -->
      <component
        :is="runtime.deps.ui.Modal"
        v-model:open="othersOpen"
        :title="`其他机构明细（${othersCount} 家上榜汇总 · 点击行选中画像）`"
      >
        <div class="mb-2 flex items-center gap-2">
          <component
            :is="runtime.deps.ui.Input"
            v-model="search"
            type="search"
            placeholder="搜索席位名称"
            class="w-56"
          />
          <span class="text-xs text-text-tertiary">共 {{ otherDetailRows.length }} 家（排除中信期货）</span>
        </div>
        <component
          :is="runtime.deps.ui.Table"
          :columns="tableColumns"
          :rows="otherDetailRows"
          :row-key="rowKeyOf"
          row-clickable
          expandable
          :expanded-keys="expandedMembers"
          @row-click="onPickDetailMember($event.memberName)"
          @toggle-expand="onToggleExpand($event.memberName)"
        >
          <template #memberName="{ row }">
            <span :class="row.memberName === selectedMember ? 'text-primary font-semibold' : ''">
              {{ row.memberName }}
            </span>
          </template>
          <template #buy="{ row }">
            <span class="text-up">{{ row.buy?.toLocaleString('en-US') }}</span>
          </template>
          <template #buyChg="{ row }">
            <span :class="signClass(row.buyChg ?? 0)">{{ signed(row.buyChg) }}</span>
          </template>
          <template #sell="{ row }">
            <span class="text-down">{{ row.sell?.toLocaleString('en-US') }}</span>
          </template>
          <template #sellChg="{ row }">
            <span :class="signClass(row.sellChg ?? 0)">{{ signed(row.sellChg) }}</span>
          </template>
          <template #net="{ row }">
            <span :class="signClass(row.net ?? 0)">{{ row.net?.toLocaleString('en-US') }}</span>
          </template>
          <template #tag="{ row }">
            <component
              :is="runtime.deps.ui.Tag"
              v-if="row.tag"
              :tone="tagTone(row.tag)"
            >
              {{ FUTURES_PAGE_TEXT.tagLabels[row.tag] }}
            </component>
            <span v-else class="text-text-tertiary">--</span>
          </template>
          <template #expanded="{ row }">
            <div class="text-xs text-text-tertiary">
              {{ row.memberName }} · 跨合约分解（该席位上榜 {{ breakdownOf(row.memberName).length }} 个合约）
            </div>
            <div class="mt-1 flex flex-wrap gap-2">
              <span
                v-for="item in breakdownOf(row.memberName)"
                :key="item.instrumentId"
                class="rounded-card bg-surface px-2 py-1 tabular-nums"
              >
                {{ item.instrumentId }}
                多 <span class="text-up">{{ (item.buyPos ?? 0).toLocaleString('en-US') }}</span>
                （<span :class="signClass(item.buyChg ?? 0)">{{ signed(item.buyChg) }}</span>）/
                空 <span class="text-down">{{ (item.sellPos ?? 0).toLocaleString('en-US') }}</span>
                （<span :class="signClass(item.sellChg ?? 0)">{{ signed(item.sellChg) }}</span>）
              </span>
              <span
                v-if="breakdownOf(row.memberName).length === 0"
                class="text-text-tertiary"
              >无披露明细</span>
            </div>
          </template>
        </component>
      </component>

      <!-- 多空并排柱状（ECharts 横向双系列，只看中信与其他机构汇总两行） -->
      <component
        :is="runtime.deps.ui.Card"
        title="多空并排柱状（中信期货 vs 其他机构汇总）"
      >
        <!-- ECharts 横向双系列柱状（多单红 / 空单绿），高度随行数自适应 -->
        <div v-if="barOption" :style="{ height: `${barRows.length * 34 + 40}px` }">
          <EChartBox :options="barOption" not-merge />
        </div>
      </component>

      <!-- 净持仓时序（app:ui Card，加载按钮入 extra 槽） -->
      <component
        :is="runtime.deps.ui.Card"
        :title="`净持仓时序${selectedMember ? ` · ${selectedMember}` : ''}（近 ${series?.points.length ?? 0} 个披露日）`"
      >
        <template #extra>
          <component
            :is="runtime.deps.ui.Button"
            variant="ghost"
            :disabled="seriesLoading || !selectedMember"
            @click="void loadSeries()"
          >
            {{ seriesLoading ? '加载中…' : '加载时序' }}
          </component>
        </template>
        <div v-if="series && series.points.length >= 2">
          <div class="h-[190px] w-full">
            <EChartBox v-if="seriesOption" :options="seriesOption" />
          </div>
          <div v-if="selectedPartial" class="mt-1 text-xs text-up-strong">{{ FUTURES_PAGE_TEXT.partialWarn }}</div>
        </div>
        <div v-else class="text-xs text-text-tertiary">点「加载时序」拉取该席位近 20 个披露日的合并净持仓（自动落本地缓存）</div>
      </component>

      <!-- 中信期货净增减 × 大盘指数 曲线对照（柱 = CCPM 净增减左轴；线 = 指数归一化涨跌幅右轴） -->
      <component
        :is="runtime.deps.ui.Card"
        :title="`中信期货净增减 × 大盘指数（全股指合并 · 近 ${comboChart?.labels.length ?? combo?.points.length ?? 0} 个披露日）`"
      >
        <template #extra>
          <component
            :is="runtime.deps.ui.Button"
            variant="ghost"
            :disabled="comboLoading || !resolvedDay"
            @click="void loadCombo()"
          >
            {{ comboLoading ? '加载中…' : (combo ? '刷新' : '加载对照曲线') }}
          </component>
        </template>
        <div v-if="comboError" class="rounded-lg bg-up-weak px-3 py-2 text-xs text-up">
          加载失败：{{ comboError }}（可再次点击重试）
        </div>
        <template v-else-if="comboChart">
          <!-- 图例（HTML 渲染，色块与折线同色） -->
          <div class="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-2.5 w-2.5 rounded-sm bg-up" aria-hidden="true" />净增减为正（增仓，左轴·手）
            </span>
            <span class="flex items-center gap-1.5">
              <i class="inline-block h-2.5 w-2.5 rounded-sm bg-down" aria-hidden="true" />净增减为负（减仓，左轴·手）
            </span>
            <span
              v-for="line in comboChart.lines"
              :key="line.name"
              class="flex items-center gap-1.5"
            >
              <i
                class="inline-block h-0.5 w-4 rounded-full"
                :style="{ backgroundColor: line.color }"
                aria-hidden="true"
              />{{ line.name }}（右轴·%）
            </span>
          </div>
          <div class="h-[300px] w-full" role="img" aria-label="中信期货净增减柱状与大盘指数曲线对照图">
            <EChartBox v-if="comboOption" :options="comboOption" />
          </div>
          <p class="mt-1 text-xs leading-relaxed text-text-tertiary">
            柱 = 中信期货(代客) IF/IH/IC/IM 合并逐日净增减（买增减 − 空增减，左轴·手）；线 = 五大指数自窗口首日归一的涨跌幅（右轴·%，科创板口径为科创50）。
            净增减 ≠ 看多看空（含套保与跨期套利，见下方数据局限性）；对照仅呈现时间相关性。
          </p>
        </template>
        <div v-else class="py-4 text-xs text-text-tertiary">
          点「加载对照曲线」拉取中信期货(代客)全股指合并的逐日净增减（近 20 个披露日，自动落本地缓存），
          与上证 / 深证成指 / 沪深300 / 科创50 / 创业板指的归一化涨跌幅曲线同画布对照。
        </div>
      </component>

      <!-- 衍生榜单（app:ui Card；三榜一行平铺，min-w-0 防 nowrap 内容把网格列撑爆） -->
      <div class="grid grid-cols-2 gap-2 min-[900px]:grid-cols-3">
        <component
          :is="runtime.deps.ui.Card"
          v-for="list in rankLists"
          :key="list.title"
          :title="list.title"
          class="min-w-0"
        >
          <div v-for="item in list.items" :key="item.name" class="flex items-center justify-between gap-2 text-xs">
            <span class="min-w-0 truncate">{{ item.name }}</span>
            <span class="shrink-0 tabular-nums" :class="signClass(item.value)">{{ item.value.toLocaleString('en-US') }}</span>
          </div>
          <div v-if="list.items.length === 0" class="text-xs text-text-tertiary">--</div>
        </component>
      </div>

      <!-- 移仓换月（折叠；app:ui Card + extra 展开/收起按钮） -->
      <component
        :is="runtime.deps.ui.Card"
        v-if="!isAllScope && rollEntries.length > 0"
        :title="`移仓换月（${rollEntries.filter((e) => e.rolling).length} 家疑似移仓）`"
      >
        <template #extra>
          <component
            :is="runtime.deps.ui.Button"
            variant="ghost"
            @click="rollExpanded = !rollExpanded"
          >
            {{ rollExpanded ? '收起' : '展开' }}
          </component>
        </template>
        <div v-if="rollExpanded" class="text-xs">
          <p class="text-text-tertiary">
            近月 {{ rollEntries[0]?.nearInstrument }} → 次月 {{ rollEntries[0]?.farInstrument }}；近月某方向减仓且次月同向增仓 ≥100 手记疑似移仓。移仓 ≠ 看多 / 看空。
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <span
              v-for="entry in rollEntries.slice(0, 12)"
              :key="entry.memberName"
              class="rounded-card px-2 py-1"
              :class="entry.rolling ? 'bg-primary-weak text-primary' : 'bg-flat-weak text-text-secondary'"
            >
              {{ entry.memberName }}：近月 {{ signed(entry.nearBuyChg) }}/{{ signed(entry.nearSellChg) }}，次月 {{ signed(entry.farBuyChg) }}/{{ signed(entry.farSellChg) }}{{ entry.rolling ? ' ⤳ 疑似移仓' : '' }}
            </span>
          </div>
        </div>
      </component>

      <!-- 固定风险提示（app:ui Card） -->
      <component :is="runtime.deps.ui.Card" title="数据局限性（常驻提示）">
        <ol class="list-inside list-decimal space-y-1 text-xs leading-relaxed text-text-secondary">
          <li v-for="line in FUTURES_PAGE_TEXT.risks" :key="line">{{ line }}</li>
        </ol>
      </component>
    </template>
  </div>
</template>
