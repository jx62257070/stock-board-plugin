<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import {
  CCPM_EQUITY_PRODUCT_ORDER,
  CCPM_PRODUCTS,
  CCPM_SCOPE_LABELS,
  FUTURES_PAGE_TEXT,
  FUTURES_INSTITUTIONAL_PLUGIN_ID,
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
import { syncHistory } from './scan';
import type { TableColumn } from '../../host/types/table.types';
import type {
  CcpmAggregateRow,
  CcpmAnalysisDataset,
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
 * 概览指标卡 → 上榜会员总表（行展开 = 席位跨合约分解）+ 席位画像 →
 * 多空并排柱状 + 净持仓时序（SVG 轻量图）→ 衍生榜单 → 移仓换月（折叠）→
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

/** 口径合约总数（完整性的分母） */
const totalCount = computed(() =>
  activeDataList.value.reduce((sum, item) => sum + item.instruments.length, 0),
);

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

/** 总表行（搜索过滤后） */
const visibleStats = computed(() => stats.value.filter((row) => matchSearch(row.memberName)));
/** 总表行（聚合口径，搜索过滤后） */
const visibleAggregates = computed(() =>
  aggregates.value.filter((row) => matchSearch(row.memberName)),
);

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

/** 总表展示行（含搜索过滤；单合约与聚合口径归一化） */
const displayRows = computed<readonly DisplayRow[]>(() => {
  if (scope.value === 'contract') {
    return visibleStats.value.map((row) => ({
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
  return visibleAggregates.value.map((row) => ({
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

/** 单合约口径：其余上榜会员汇总 */
const othersStats = computed<CcpmMemberStats | null>(() => {
  const data = dayData.value;
  if (scope.value !== 'contract' || !selectedMember.value || !data) {
    return null;
  }
  const target = instrument.value || data.instruments[0] || '';
  const totals = data.totals[target];
  if (!totals || stats.value.length === 0) {
    return null;
  }
  return computeCcpmOthersStats(stats.value, totals, selectedMember.value);
});

/** 聚合口径：其余全部上榜会员汇总 */
const othersAggregate = computed<CcpmAggregateRow | null>(() => {
  if (scope.value === 'contract' || !selectedMember.value) {
    return null;
  }
  return aggregateCcpmOthers(activeDataList.value, selectedMember.value);
});

/** 选中席位在当前口径下的全部上榜原始行（分解表数据源） */
const selectedBreakdownRows = computed(() => {
  if (!selectedMember.value) {
    return [];
  }
  return activeDataList.value
    .flatMap((item) => item.rows)
    .filter((row) => row.memberName === selectedMember.value);
});

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

/** 柱状图取前 N 个席位 */
const BAR_CHART_TOP = 10;

/** 多空并排柱状图数据（聚合口径取 |净持仓| 前 N） */
const barRows = computed(() => {
  const source =
    scope.value === 'contract'
      ? stats.value.map((row) => ({
          name: row.memberName,
          buy: row.buyPos ?? 0,
          sell: row.sellPos ?? 0,
        }))
      : aggregates.value.map((row) => ({
          name: row.memberName,
          buy: row.totalBuy,
          sell: row.totalSell,
        }));
  return [...source]
    .sort((a, b) => Math.abs(b.buy - b.sell) - Math.abs(a.buy - a.sell))
    .slice(0, BAR_CHART_TOP);
});

/** 柱状图的最大单侧值（归一化用） */
const barMax = computed(() =>
  Math.max(1, ...barRows.value.flatMap((row) => [row.buy, row.sell])),
);

/** 净持仓时序折线的极值（归一化用） */
const seriesRange = computed(() => {
  const points = series.value?.points ?? [];
  if (points.length === 0) {
    return { min: 0, max: 1 };
  }
  const values = points.map((p) => p.totalNet);
  return { min: Math.min(...values, 0), max: Math.max(...values, 0) };
});

/**
 * 折线 SVG 路径（宽 300 高 80 视窗归一化）
 * @returns path d 属性；无数据为空串
 */
const seriesPath = computed<string>(() => {
  const points = series.value?.points ?? [];
  if (points.length < 2) {
    return '';
  }
  const { min, max } = seriesRange.value;
  const span = max - min || 1;
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 300;
      const y = 80 - ((point.totalNet - min) / span) * 80;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
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
          placeholder="搜索席位，如「中信期货」"
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

      <div v-if="selectedPartial" class="rounded-card bg-up-weak px-4 py-2 text-xs text-up-strong">
        {{ FUTURES_PAGE_TEXT.partialWarn }}
      </div>

      <!-- 上榜会员总表（app:ui Table：列配置驱动 + expandable + 作用域插槽）；与画像 6:4 并排 -->
      <div class="grid grid-cols-1 gap-3 min-[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <component
          :is="runtime.deps.ui.Card"
          fill
          class="min-w-0"
          :title="scope === 'contract' ? `上榜会员总表 · ${instrument || instruments[0] || ''}` : '上榜会员总表（聚合口径）'"
        >
          <template #extra>
            <span class="text-xs text-text-tertiary">点击行选中画像，点击行首箭头展开分解</span>
          </template>
          <component
            :is="runtime.deps.ui.Table"
            :columns="tableColumns"
            :rows="displayRows"
            :row-key="rowKeyOf"
            row-clickable
            expandable
            :expanded-keys="expandedMembers"
            @row-click="onSelectMember($event.memberName)"
            @toggle-expand="onToggleExpand($event.memberName)"
          >
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
                {{ row.memberName }} · 跨合约分解（共 {{ totalCount }} 个合约口径）
              </div>
              <div class="mt-1 flex flex-wrap gap-2">
                <span
                  v-for="item in selectedBreakdownRows.filter((r) => r.memberName === row.memberName)"
                  :key="item.instrumentId"
                  class="rounded-card bg-surface px-2 py-1"
                >
                  {{ item.instrumentId }}：多 {{ (item.buyPos ?? 0).toLocaleString('en-US') }}（{{ signed(item.buyChg) }}）/
                  空 {{ (item.sellPos ?? 0).toLocaleString('en-US') }}（{{ signed(item.sellChg) }}）
                </span>
                <span
                  v-if="selectedBreakdownRows.filter((r) => r.memberName === row.memberName).length === 0"
                  class="text-text-tertiary"
                >无披露明细</span>
              </div>
            </template>
          </component>
        </component>

        <!-- 席位画像（与总表并排，栅格对齐原宿主页） -->
        <component
          :is="runtime.deps.ui.Card"
          :title="`席位画像${selectedMember ? ` · ${selectedMember}` : ''}`"
        >
          <div v-if="scope !== 'contract' && selectedAggregate" class="space-y-1 text-xs">
            <div>多单 <span class="text-up">{{ selectedAggregate.totalBuy.toLocaleString('en-US') }}</span> / 空单 <span class="text-down">{{ selectedAggregate.totalSell.toLocaleString('en-US') }}</span> / 净 <span :class="signClass(selectedAggregate.totalNet)">{{ selectedAggregate.totalNet.toLocaleString('en-US') }}</span>（手）</div>
            <div>净增减 <span :class="signClass(selectedAggregate.totalNetChg)">{{ signed(selectedAggregate.totalNetChg) }}</span>，覆盖 {{ selectedAggregate.coveredCount }}/{{ selectedAggregate.totalCount }} 合约</div>
            <div class="text-text-secondary">{{ selectedAggregate.tagReason }}</div>
          </div>
          <div v-else-if="selectedStats" class="space-y-1 text-xs">
            <div>多单 <span class="text-up">{{ (selectedStats.buyPos ?? 0).toLocaleString('en-US') }}</span> / 空单 <span class="text-down">{{ (selectedStats.sellPos ?? 0).toLocaleString('en-US') }}</span> / 净 <span :class="signClass(selectedStats.netPos ?? 0)">{{ (selectedStats.netPos ?? 0).toLocaleString('en-US') }}</span>（手）</div>
            <div>多占比 {{ selectedStats.buyRatio === null ? '--' : `${selectedStats.buyRatio.toFixed(1)}%` }}，空占比 {{ selectedStats.sellRatio === null ? '--' : `${selectedStats.sellRatio.toFixed(1)}%` }}</div>
            <div class="text-text-secondary">{{ selectedStats.tagReason }}</div>
          </div>
          <div v-else class="text-xs text-text-tertiary">点击总表行查看席位画像</div>
          <div v-if="scope !== 'contract' && othersAggregate" class="mt-3 border-t border-border pt-2 text-xs text-text-secondary">
            其余 {{ (aggregates.length - 1) }} 家汇总：净 <span :class="signClass(othersAggregate.totalNet)">{{ othersAggregate.totalNet.toLocaleString('en-US') }}</span>（{{ othersAggregate.tagReason }}）
          </div>
          <div v-else-if="scope === 'contract' && othersStats" class="mt-3 border-t border-border pt-2 text-xs text-text-secondary">
            其他机构汇总：净 <span :class="signClass(othersStats.netPos ?? 0)">{{ (othersStats.netPos ?? 0).toLocaleString('en-US') }}</span>（{{ othersStats.tagReason }}）
          </div>
          <div class="mt-2 text-xs text-text-tertiary">{{ FUTURES_PAGE_TEXT.tagRule }}</div>
        </component>
      </div>

      <!-- 多空并排柱状（纯 SVG，涨跌配色走语义类） -->
      <component
        :is="runtime.deps.ui.Card"
        :title="`多空并排柱状（|净持仓| 前 ${barRows.length}）`"
      >
        <!-- SVG 视窗 800×230（10 行 × 23）：相对视窗的 12px 字号在全宽渲染下约 15px，与正文一致 -->
        <svg viewBox="0 0 800 230" class="w-full">
          <g v-for="(row, index) in barRows" :key="row.name" :transform="`translate(0, ${index * 23})`">
            <text x="0" :y="15" class="fill-current text-text-secondary" font-size="12">{{ row.name.slice(0, 10) }}</text>
            <rect x="170" :y="5" :width="(row.buy / barMax) * 380" height="6" class="fill-up" />
            <rect x="170" :y="13" :width="(row.sell / barMax) * 380" height="6" class="fill-down" />
            <text x="570" :y="15" class="fill-current text-text-tertiary tabular-nums" font-size="12">
              {{ row.buy.toLocaleString('en-US') }} / {{ row.sell.toLocaleString('en-US') }}
            </text>
          </g>
        </svg>
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
          <svg viewBox="0 0 300 84" class="w-full">
            <path :d="seriesPath" fill="none" class="stroke-up" stroke-width="1.5" />
          </svg>
          <div class="flex justify-between text-xs text-text-tertiary">
            <span>{{ series.points[0]?.tradingDay }}</span>
            <span>{{ series.points[series.points.length - 1]?.tradingDay }}</span>
          </div>
          <div v-if="selectedPartial" class="mt-1 text-xs text-up-strong">{{ FUTURES_PAGE_TEXT.partialWarn }}</div>
        </div>
        <div v-else class="text-xs text-text-tertiary">点「加载时序」拉取该席位近 20 个披露日的合并净持仓（自动落本地缓存）</div>
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
