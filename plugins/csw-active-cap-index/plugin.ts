/**
 * 插件 csw-active-cap-index · 活跃市值与指数贡献
 *
 * 一页两段式的市场结构看板（`ctx.menu` 贡献整页路由，`fallbackLanding` 兜底）：
 *
 * 【上半部 · 活跃市值 —— 对齐指南针 0AMV（活筹指数）口径】
 *   0AMV 的市场含义是「市场上活跃交易的那部分筹码的市值」，经典用法是看趋势：
 *   向上 = 场外资金进场，向下 = 场内资金出逃。本插件用可解释的近似口径复刻该序列：
 *
 *     当日活跃市值 = 当日成交额 ≥ 门槛（默认 1 亿，可设置）的个股流通市值之和
 *
 *   每个交易日把快照落在本插件数据表（`ctx.db`，逐日自动累积），页面画
 *   近 60 个交易日的趋势曲线 + 5 日均线，并附活跃股榜单（成交额榜，带比例条）。
 *
 * 【下半部 · 指数贡献 —— 对齐通达信口径】
 *   个股对指数涨跌点数的贡献（总市值加权指数的通用公式）：
 *
 *     贡献点(i) = 涨跌幅(i)% × (总市值(i) ÷ 指数样本总市值) × 指数点位
 *
 *   样本总市值直接取指数 ulist 的 f20（上证 = 沪市全样本总市值，精确口径；
 *   深证成指 / 创业板指按代码前缀近似圈定个股样本）。展示为通达信风格的
 *   「拉指数 Top10 / 拖指数 Top10」正负两榜，并给出「样本合计 vs 指数实际涨跌点」对账。
 *
 * 数据面（每轮 6 个轻请求，错峰 400ms，每个请求双域回落 + 整体重试一次）：
 *   1. clist fid=f6 成交额降序 Top 300（3 页：活跃市值 + 活跃榜 + 贡献候选）；
 *   2. clist fid=f20 总市值降序 Top 200（2 页：贡献候选池补「大市值低成交」）；
 *   3. ulist 三指数快照（f2 点位 / f3 涨跌幅 / f4 涨跌点 / f20 样本总市值）；
 *   另经宿主 `app:market-data` 取两市实时总成交额（占比分母，缺席可降级）。
 *
 * 生命周期：刷新调度写在插件层（`app:polling` 工厂，交易窗口感知 + 30s 低频），
 * 页面组件只负责「挂载时补一轮 + 标记自己在场」；自动刷新默认关闭。
 * 卸载插件时轮询、页面、数据表一起被内核回收。
 */
import { h, ref, computed, onMounted, onUnmounted } from 'vue';
import {
  CAP_PAGES,
  CLIST_FALLBACK,
  CLIST_PRIMARY,
  FS_ALL_A,
  INDEX_FIELDS,
  INDEX_SECIDS,
  INDEX_SCOPE_PREFIX,
  INDEX_TABS,
  MIN_TRADING_AMOUNT,
  PAGE_SIZE,
  REQUEST_GAP_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_GAP_MS,
  RETRY_ROUNDS,
  STOCK_FIELDS,
  THRESHOLD_OPTIONS,
  TOP_N_OPTIONS,
  TURNOVER_PAGES,
  ULIST_FALLBACK,
  ULIST_PRIMARY,
} from './constants';
import {
  buildActiveView,
  buildContributionView,
  createHistoryRepo,
  formatAmountCn,
  formatPoints,
  indexRowsToMap,
  isWeekday,
  localDate,
  maSeries,
  toFullSymbol,
  toStockRow,
} from './compute';
import type {
  ActiveDisplayRow,
  ContributionRow,
  ClistRawRow,
  IndexKey,
  IndexRawRow,
  IndexSnapshotMap,
  MarketDataService,
  PageState,
  StockRow,
  TrendPoint,
} from './types';
import type {
  FormatService,
  HttpService,
  PluginDefinition,
  StockOpenService,
  UiKitService,
} from '../../host/types/plugin.types';

/** 插件 id（数据表 / 存储命名空间的一部分，装过就不可再改） */
export const PLUGIN_ID = 'csw-active-cap-index';

/** 页面路由（`ctx.menu` 自动注册） */
export const PAGE_PATH = '/active-cap-index';

//#region 取数层（app:http，双域回落 + 整体重试 + 超时）

/** 上游 JSON 响应体（clist / ulist 共用形状：data.diff 行数组） */
interface UpstreamBody {
  /** 数据体（上游空数据时为 null） */
  data?: {
    /** 行数组（ulist 三指数请求也是数组，按名称圈定） */
    diff?: ClistRawRow[] | IndexRawRow[];
  } | null;
}

/**
 * 带超时与重试的上游请求
 *
 * 每轮按 [主域, 回落域] 依次尝试，整轮失败后等待再重试（`RETRY_ROUNDS` 轮）。
 * push2delay 在部分网络下会 TCP 断连 / 挂起，多一轮重试能把「部分数据未更新」
 * 的概率压到很低。
 * @param http app:http 服务句柄
 * @param delay 宿主 `format.delay`（错峰节拍）
 * @param primaryUrl 主域地址
 * @param fallbackUrl 回落域地址
 * @returns 响应 JSON
 */
const fetchWithRetry = async (
  http: HttpService,
  delay: FormatService['delay'],
  primaryUrl: string,
  fallbackUrl: string,
): Promise<UpstreamBody> => {
  let lastError: unknown;
  for (let round = 0; round <= RETRY_ROUNDS; round += 1) {
    if (round > 0) await delay(RETRY_GAP_MS);
    for (const url of round === 0 ? [primaryUrl, fallbackUrl] : [fallbackUrl, primaryUrl]) {
      try {
        const response = await http.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as UpstreamBody;
      } catch (err) {
        lastError = err;
        await delay(REQUEST_GAP_MS);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/**
 * clist 单页请求
 * @param http app:http 服务
 * @param delay 宿主 delay
 * @param fid 排序字段（f6 成交额 / f20 总市值）
 * @param pn 页码（1 起）
 * @returns 行数组（上游空 data 返回空数组）
 */
const fetchClistPage = async (
  http: HttpService,
  delay: FormatService['delay'],
  fid: string,
  pn: number,
): Promise<ClistRawRow[]> => {
  // fs 含 '+'，不能走 URLSearchParams（'+' 会被编码成 %2B 上游不识别），手工拼接原样透传
  const query = [
    `pn=${pn}`,
    `pz=${PAGE_SIZE}`,
    'po=1',
    'np=1',
    'fltt=2',
    'invt=2',
    `fid=${fid}`,
    `fs=${FS_ALL_A}`,
    `fields=${STOCK_FIELDS}`,
  ].join('&');
  const body = await fetchWithRetry(http, delay, `${CLIST_PRIMARY}?${query}`, `${CLIST_FALLBACK}?${query}`);
  const diff = body.data?.diff;
  return Array.isArray(diff) ? (diff as ClistRawRow[]) : [];
};

/**
 * 指数快照（一次拿三指数：点位 / 涨跌幅 / 涨跌点 / 样本总市值）
 * @param http app:http 服务
 * @param delay 宿主 delay
 * @returns 映射（key: sh / sz / cyb，缺者缺省）
 */
const fetchIndexSnapshots = async (
  http: HttpService,
  delay: FormatService['delay'],
): Promise<IndexSnapshotMap> => {
  const query = ['fltt=2', `fields=${INDEX_FIELDS}`, `secids=${INDEX_SECIDS}`].join('&');
  const body = await fetchWithRetry(http, delay, `${ULIST_PRIMARY}?${query}`, `${ULIST_FALLBACK}?${query}`);
  const diff = body.data?.diff;
  return indexRowsToMap(Array.isArray(diff) ? (diff as IndexRawRow[]) : []);
};

//#endregion

//#region 页面组件

/** 页面组件的宿主依赖（apply 里取齐后注入，依赖链显式可见） */
interface PageDeps {
  /** 宿主 UI Kit */
  ui: UiKitService;
  /** 格式化与涨跌语义 */
  format: FormatService;
  /** 个股打开交互 */
  stockOpen: StockOpenService;
  /** 插件设置（只读 values） */
  settings: { readonly values: Record<string, unknown> };
  /** 活跃门槛（亿元，来自设置） */
  thresholdYi: () => number;
  /** 页面共享状态（apply 闭包经 getter 暴露） */
  state: PageState;
  /** 拉一轮全量数据 */
  refresh: () => Promise<void>;
  /** 标记页面在场 / 离场（轮询任务门控） */
  setPageActive: (value: boolean) => void;
}

/**
 * 创建看板页面组件（渲染函数搭建，全部界面走 app:ui 组件 + 内联样式）
 * @param deps 宿主服务与共享状态
 * @returns 组件定义（options 形态，setup 返回渲染函数）
 */
const createPageComponent = (deps: PageDeps) => {
  const { ui, format } = deps;

  /** 当前选中的指数 tab */
  const activeIndex = ref<IndexKey>('sh');
  /** 首次加载中（只在一条数据都没有时进骨架屏，刷新不翻 loading） */
  const firstLoading = ref(false);
  /** 首次加载失败（整页空态 + 重试按钮） */
  const firstError = ref('');

  /** 上半部视图（由原始数据派生，保持响应式） */
  const activeView = computed(() =>
    deps.state.rows ? buildActiveView(deps.state.rows, deps.thresholdYi(), deps.state.totalAmount) : null,
  );
  /** 贡献视图（跟随指数 tab 切换） */
  const contributionView = computed(() => {
    const raw = deps.state.indices ? deps.state.indices[activeIndex.value] : undefined;
    if (!raw) return null;
    return buildContributionView(deps.state.candidates, raw, INDEX_SCOPE_PREFIX[activeIndex.value]);
  });

  /** 活跃榜展示条数（设置里的字符串转数值） */
  const topN = computed(() => {
    const parsed = Number.parseInt(String(deps.settings.values.topN ?? '20'), 10);
    return Number.isFinite(parsed) ? parsed : 20;
  });

  /** 更新时间文案 */
  const updatedAtText = computed(() =>
    deps.state.updatedAt ? format.relativeTime(deps.state.updatedAt) : '',
  );

  /** 首次拉取（组件挂载时调用） */
  const ensureFirstFetch = async (): Promise<void> => {
    if (deps.state.rows) return;
    firstLoading.value = true;
    firstError.value = '';
    await deps.refresh();
    firstLoading.value = false;
    if (!deps.state.rows) firstError.value = deps.state.error || '取数失败';
  };

  /**
   * 涨跌文本色类名（红涨绿跌走宿主口径，插件不碰色值）
   * @param value 涨跌幅或贡献点（null 按 0 处理）
   * @returns 主题文本色类名
   */
  const pctClass = (value: number | null | undefined): string =>
    format.trendClass(format.trend(value ?? 0));

  /**
   * 数值或 '--'（null 化展示的统一入口）
   * @param value 待展示值（可 null）
   * @param render 非空时的格式化函数
   * @returns 展示文案
   */
  const orDash = <T,>(value: T | null | undefined, render: (value: T) => string): string =>
    value == null ? '--' : render(value);

  //#region 上半部渲染

  /**
   * 汇总卡（标题 + 数值 + 说明）
   * @param title 卡片标题
   * @param value 主数值文案
   * @param hint 底部说明（缺省不渲染）
   * @param valueClass 主数值附加类名（如涨跌色）
   * @returns 卡片 vnode
   */
  const statCard = (title: string, value: string, hint?: string, valueClass?: string) =>
    h(
      'div',
      {
        style: {
          flex: '1 1 0',
          minWidth: '150px',
          padding: '10px 14px',
          borderRadius: '10px',
          border: '1px solid var(--color-border, rgba(128,128,128,.2))',
          background: 'var(--color-bg-soft, rgba(128,128,128,.06))',
        },
      },
      [
        h('div', { class: 'text-xs text-text-secondary', style: { marginBottom: '4px' } }, title),
        h('div', { class: `text-lg font-semibold tabular-nums ${valueClass ?? ''}` }, value),
        hint
          ? h('div', { class: 'text-xs text-text-secondary', style: { marginTop: '2px' } }, hint)
          : null,
      ],
    );

  /** 活跃榜表格插槽（名称 / 现价 / 涨跌幅 / 成交额比例条 / 流通市值 / 占比） */
  const activeSlots = {
    name: (ctx: { row: ActiveDisplayRow }) =>
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } }, [
        h('span', { style: { fontWeight: 500 } }, ctx.row.name),
        h('span', { class: 'text-xs text-text-secondary tabular-nums' }, ctx.row.code),
      ]),
    price: (ctx: { row: ActiveDisplayRow }) =>
      h('span', { class: 'tabular-nums' }, orDash(ctx.row.price, (v) => v.toFixed(2))),
    changePct: (ctx: { row: ActiveDisplayRow }) =>
      h(
        'span',
        { class: `tabular-nums ${pctClass(ctx.row.changePct)}` },
        orDash(ctx.row.changePct, (v) => format.percent(v)),
      ),
    // 成交额：数值 + 行内比例条（宽度相对榜内最大成交额，未达标置灰）
    amount: (ctx: { row: ActiveDisplayRow }) =>
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' } },
        [
          h('span', { class: 'tabular-nums' }, orDash(ctx.row.amount, (v) => formatAmountCn(v))),
          h('div', {
            style: {
              width: `${Math.max(4, ctx.row.amountBarRatio * 100)}%`,
              maxWidth: '120px',
              height: '3px',
              borderRadius: '2px',
              background: ctx.row.isActive ? 'var(--color-primary, #e8a33d)' : 'rgba(128,128,128,.4)',
              opacity: 0.75,
            },
          }),
        ],
      ),
    floatCap: (ctx: { row: ActiveDisplayRow }) =>
      h('span', { class: 'tabular-nums' }, orDash(ctx.row.floatCap, (v) => formatAmountCn(v))),
    amountShare: (ctx: { row: ActiveDisplayRow }) =>
      h(
        'span',
        { class: 'tabular-nums text-text-secondary' },
        orDash(ctx.row.amountShare, (v) => `${v.toFixed(1)}%`),
      ),
  };

  /** 活跃榜表格列 */
  const activeColumns = [
    { key: 'rank', label: '#', align: 'right' },
    { key: 'name', label: '名称 / 代码' },
    { key: 'price', label: '现价', align: 'right', sortable: true, sortValue: (row: ActiveDisplayRow) => row.price },
    { key: 'changePct', label: '涨跌幅', align: 'right', sortable: true, sortValue: (row: ActiveDisplayRow) => row.changePct },
    { key: 'amount', label: '成交额', align: 'right', sortable: true, sortValue: (row: ActiveDisplayRow) => row.amount },
    { key: 'floatCap', label: '流通市值', align: 'right', sortable: true, sortValue: (row: ActiveDisplayRow) => row.floatCap },
    { key: 'amountShare', label: '占活跃成交比', align: 'right' },
  ];

  /**
   * 趋势曲线（近 N 日活跃市值主线 + 5 日均线虚线，内联 SVG 不依赖图表库）
   * @param history 快照列表（升序）
   * @returns SVG vnode（数据不足 2 点时返回累积提示）
   */
  const renderTrendChart = (history: readonly TrendPoint[]) => {
    const W = 680;
    const H = 150;
    const PAD_X = 8;
    const PAD_Y = 14;
    const values = history.map((item) => item.activeCap);
    const valid = values.filter((v): v is number => v != null && v > 0);
    if (valid.length < 2) {
      return h(
        'div',
        {
          style: {
            padding: '18px 8px',
            textAlign: 'center',
            fontSize: '12px',
            opacity: 0.65,
          },
        },
        '趋势曲线逐日累积中：每个交易日刷新后记录一个点，攒够 2 个点即出曲线（今天起算）',
      );
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;
    const toX = (index: number): number => PAD_X + (index / (history.length - 1)) * (W - PAD_X * 2);
    const toY = (value: number): number => H - PAD_Y - ((value - min) / span) * (H - PAD_Y * 2);
    const lineOf = (series: readonly (number | null)[]): string =>
      series
        .map((value, index) => (value == null ? null : `${toX(index).toFixed(1)},${toY(value).toFixed(1)}`))
        .filter((point): point is string => point != null)
        .join(' ');
    const ma = maSeries(values);
    const maxLabel = formatAmountCn(max);
    const minLabel = formatAmountCn(min);
    const last = history[history.length - 1];
    return h('div', { style: { width: '100%' } }, [
      h(
        'svg',
        {
          viewBox: `0 0 ${W} ${H}`,
          preserveAspectRatio: 'none',
          style: { width: '100%', height: '140px', display: 'block' },
        },
        [
          // 5 日均线（虚线，先画在底层）
          h('polyline', {
            points: lineOf(ma),
            fill: 'none',
            stroke: 'rgba(128,128,128,.55)',
            'stroke-width': 1.2,
            'stroke-dasharray': '4 3',
          }),
          // 活跃市值主线
          h('polyline', {
            points: lineOf(values),
            fill: 'none',
            stroke: 'var(--color-primary, #e8a33d)',
            'stroke-width': 2,
            'stroke-linejoin': 'round',
          }),
          // 末点高亮
          h('circle', {
            cx: toX(values.length - 1),
            cy: toY(values[values.length - 1] ?? min),
            r: 3,
            fill: 'var(--color-primary, #e8a33d)',
          }),
        ],
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            opacity: 0.65,
            marginTop: '2px',
          },
        },
        [
          h('span', null, `低 ${minLabel}`),
          h('span', null, `高 ${maxLabel}`),
          h('span', null, `最新 ${formatAmountCn(last?.activeCap)}（${last?.date ?? ''}）`),
        ],
      ),
    ]);
  };

  /**
   * 上半部整体（汇总卡 + 趋势曲线 + 活跃榜）
   * @returns 卡片 vnode
   */
  const renderActiveSection = () =>
    h(ui.Card, { title: '活跃市值（0AMV 口径）', fill: true }, {
      extra: () =>
        h(
          'div',
          { class: 'text-xs text-text-secondary' },
          `活跃 = 成交额 ≥ ${deps.thresholdYi()} 亿（插件设置可调）`,
        ),
      default: () =>
        h('div', { class: 'flex flex-col gap-3', style: { padding: '4px 2px' } }, [
          h('div', { class: 'flex flex-wrap gap-2' }, [
            statCard(
              '今日活跃市值',
              orDash(activeView.value?.activeCap, (v) => formatAmountCn(v)),
              '活跃股流通市值合计',
            ),
            statCard(
              '活跃家数',
              activeView.value ? String(activeView.value.activeCount) : '--',
              `成交额 Top ${deps.state.rows?.length ?? 0} 内达标`,
            ),
            statCard(
              '活跃成交额',
              orDash(activeView.value?.activeAmount, (v) => formatAmountCn(v)),
              `占两市 ${orDash(activeView.value?.amountShareOfMarket, (v) => `${v.toFixed(1)}%`)}`,
            ),
            statCard(
              '历史曲线',
              `${deps.state.history.length} 日`,
              '逐日累积（本插件数据表）',
            ),
          ]),
          renderTrendChart(deps.state.history),
          h(ui.Table, {
            columns: activeColumns,
            rows: (activeView.value?.displayRows ?? []).slice(0, topN.value),
            rowKey: (row: ActiveDisplayRow) => row.code,
            rowClickable: true,
            minWidth: '680px',
            onRowClick: (row: ActiveDisplayRow) => deps.stockOpen.openSidebar(toFullSymbol(row.code)),
          }, activeSlots),
        ]),
    });

  //#endregion

  //#region 下半部渲染（通达信风格正负两榜）

  /** 单侧贡献榜单插槽 */
  const contribSlots = {
    name: (ctx: { row: ContributionRow }) =>
      h('span', { style: { fontWeight: 500 } }, ctx.row.name),
    changePct: (ctx: { row: ContributionRow }) =>
      h(
        'span',
        { class: `tabular-nums ${pctClass(ctx.row.changePct)}` },
        orDash(ctx.row.changePct, (v) => format.percent(v)),
      ),
    points: (ctx: { row: ContributionRow }) =>
      h(
        'span',
        { class: `tabular-nums ${pctClass(ctx.row.points)}`, style: { fontWeight: 600 } },
        formatPoints(ctx.row.points),
      ),
    share: (ctx: { row: ContributionRow }) =>
      h(
        'span',
        { class: 'tabular-nums text-text-secondary' },
        orDash(ctx.row.share, (v) => `${v.toFixed(1)}%`),
      ),
  };

  /** 单侧贡献榜单列配置 */
  const contribColumns = [
    { key: 'name', label: '名称' },
    { key: 'changePct', label: '涨跌幅', align: 'right' },
    { key: 'points', label: '贡献点', align: 'right', sortable: true, sortValue: (row: ContributionRow) => row.points },
    { key: 'share', label: '占比', align: 'right' },
  ];

  /** 对账文案（样本合计 vs 指数实际涨跌 + 正负家数） */
  const reconcileText = computed(() => {
    const view = contributionView.value;
    if (!view) return '';
    const sample = formatPoints(view.samplePointsSum);
    const actual = orDash(view.indexChangePoints, (v) => formatPoints(v));
    const cov = view.coverage == null ? '--' : `${Math.abs(view.coverage).toFixed(0)}%`;
    return `样本合计 ${sample} 点 / 指数实际 ${actual} 点（覆盖 ${cov}）；正贡献 ${view.positiveCount} 只 / 负贡献 ${view.negativeCount} 只`;
  });

  /**
   * 单侧榜单卡片（标题行 + 小表）
   * @param title 标题（▲ 拉指数 / ▼ 拖指数）
   * @param rows 榜单行
   * @param tone 标题文本色类名（跟涨跌语义）
   * @returns 榜单 vnode
   */
  const renderContribSide = (title: string, rows: readonly ContributionRow[], tone: string) =>
    h('div', { style: { flex: '1 1 260px', minWidth: '260px' } }, [
      h('div', {
        class: `text-xs ${tone}`,
        style: { marginBottom: '4px', fontWeight: 600 },
      }, title),
      h(ui.Table, {
        columns: contribColumns,
        rows: [...rows],
        rowKey: (row: ContributionRow) => row.code,
        rowClickable: true,
        minWidth: '260px',
        onRowClick: (row: ContributionRow) => deps.stockOpen.openSidebar(toFullSymbol(row.code)),
      }, contribSlots),
    ]);

  /**
   * 下半部整体（指数卡 + 对账行 + 正负两榜 + 口径说明）
   * @returns 卡片 vnode
   */
  const renderContributionSection = () =>
    h(ui.Card, { title: '指数贡献（通达信口径）', fill: true }, {
      extra: () =>
        h(ui.Tabs, {
          options: INDEX_TABS,
          modelValue: activeIndex.value,
          variant: 'segmented',
          'onUpdate:modelValue': (value: unknown) => {
            if (typeof value === 'string') activeIndex.value = value as IndexKey;
          },
        }),
      default: () => {
        const view = contributionView.value;
        if (!view) {
          return h(ui.Empty, { text: '暂无指数快照，点右上角刷新试试' });
        }
        return h('div', { class: 'flex flex-col gap-3', style: { padding: '4px 2px' } }, [
          h('div', { class: 'flex flex-wrap gap-2' }, [
            statCard(
              '指数点位',
              orDash(view.indexPrice, (v) => v.toFixed(2)),
              `涨跌幅 ${orDash(view.indexChangePct, (v) => format.percent(v))}`,
              pctClass(view.indexChangePct),
            ),
            statCard(
              '实际涨跌',
              orDash(view.indexChangePoints, (v) => formatPoints(v)),
              '点（上游口径）',
              pctClass(view.indexChangePoints),
            ),
            statCard(
              '样本总市值',
              orDash(view.scopeTotalCap, (v) => formatAmountCn(v)),
              '权重归一分母（指数口径）',
            ),
            statCard(
              '候选样本',
              String(view.sampleCount),
              '总市值 Top 200 ∪ 成交额 Top 300',
            ),
          ]),
          h('div', { class: 'text-xs text-text-secondary' }, reconcileText.value),
          h('div', { class: 'flex flex-wrap gap-4' }, [
            renderContribSide('▲ 拉指数 Top 10（正贡献）', view.positive, pctClass(1)),
            renderContribSide('▼ 拖指数 Top 10（负贡献）', view.negative, pctClass(-1)),
          ]),
          h(
            'div',
            { class: 'text-xs text-text-secondary' },
            '贡献点 = 涨跌幅 × 总市值 ÷ 样本总市值 × 指数点位（总市值加权，通达信口径）；上证为沪市全样本精确口径，深证成指 / 创业板指按代码前缀近似圈定样本。',
          ),
        ]);
      },
    });

  //#endregion

  return {
    name: 'ActiveCapIndexPage',
    setup() {
      onMounted(() => {
        deps.setPageActive(true);
        void ensureFirstFetch();
      });
      onUnmounted(() => {
        deps.setPageActive(false);
      });
      return () => {
        if (firstLoading.value) {
          return h('div', { style: { padding: '16px' } }, [h(ui.Skeleton)]);
        }
        if (firstError.value) {
          return h('div', { style: { padding: '16px' } }, [
            h(ui.Empty, { text: firstError.value }),
            h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '8px' } }, [
              h(ui.Button, { variant: 'primary', onClick: () => { firstError.value = ''; void ensureFirstFetch(); } }, () => '重试'),
            ]),
          ]);
        }
        return h('div', { class: 'flex flex-col gap-3', style: { padding: '12px 14px' } }, [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
            h('div', { style: { fontSize: '16px', fontWeight: 600 } }, '活跃市值与指数贡献'),
            h('div', { class: 'text-xs text-text-secondary' }, updatedAtText.value ? `更新于 ${updatedAtText.value}` : ''),
            deps.state.error
              ? h('span', { class: 'text-xs', style: { color: 'var(--color-down, #e05656)' } }, deps.state.error)
              : null,
            h('div', { style: { flex: 1 } }),
            h(ui.Button, { variant: 'ghost', onClick: () => { void deps.refresh(); } }, () => '刷新'),
          ]),
          renderActiveSection(),
          renderContributionSection(),
        ]);
      };
    },
  };
};

//#endregion

//#region 插件定义

/**
 * 活跃市值与指数贡献插件
 *
 * - 页面贡献：`ctx.menu`（整页看板，上下两段）；
 * - 数据累积：交易日快照落 `ctx.db`（0AMV 序列逐日生长）；
 * - 刷新调度：`app:polling` 插件层工厂（30s 低频、交易窗口感知），
 *   仅「页面在场 && 设置开关打开」时真正取数；
 * - 可选依赖：`app:market-data`（两市实时总成交额）缺席时占比显示 `--`，不影响主体。
 */
export const activeCapIndexPlugin: PluginDefinition = {
  id: PLUGIN_ID,
  name: '活跃市值与指数贡献',
  version: '1.1.0',
  description:
    '上下两段式市场结构看板。上半部「活跃市值」对齐指南针 0AMV（活筹指数）口径：统计成交额达门槛的活跃股流通市值合计，逐日累积成本地趋势曲线（近 60 日 + 5 日均线），附成交额活跃榜；下半部「指数贡献」对齐通达信口径：按总市值加权计算个股对上证指数 / 深证成指 / 创业板指涨跌点数的贡献，拉指数 / 拖指数正负两榜，样本合计可与指数实际涨跌对账。',
  author: 'shuchenye',
  settings: {
    title: '活跃市值与指数贡献',
    description: '看板口径与刷新行为',
    fields: [
      {
        key: 'thresholdYi',
        label: '活跃门槛（当日成交额）',
        type: 'select',
        default: '1',
        options: THRESHOLD_OPTIONS,
      },
      {
        key: 'topN',
        label: '活跃榜展示条数',
        type: 'select',
        default: '20',
        options: TOP_N_OPTIONS,
      },
      {
        key: 'autoRefresh',
        label: '交易时段自动刷新（30 秒）',
        type: 'boolean',
        default: false,
      },
    ],
  },
  apply: async (ctx) => {
    const ui = ctx.consume('app:ui');
    const format = ctx.consume('app:format');
    const polling = ctx.consume('app:polling');
    const stockOpen = ctx.consume('app:stock-open');
    const http = ctx.consume('app:http');
    if (!ui || !format || !polling || !stockOpen || !http) {
      throw new Error('宿主未提供 app:ui / app:format / app:polling / app:stock-open / app:http 服务');
    }
    // 可选：两市实时总成交额（老版本宿主可能没有，缺席只影响占比显示）
    const marketData: MarketDataService | undefined = ctx.consume('app:market-data');

    //#region 共享状态与刷新

    /** 全市场成交额 Top 300（活跃统计池原始行） */
    const rows = ref<StockRow[] | null>(null);
    /** 总市值 Top 200 ∪ 成交额 Top 300 去重候选池（贡献榜原始行） */
    const candidates = ref<StockRow[]>([]);
    /** 三指数快照（key: sh / sz / cyb） */
    const indices = ref<IndexSnapshotMap | null>(null);
    /** 两市实时总成交额（元；服务缺席 / 上游缺失为 null） */
    const totalAmount = ref<number | null>(null);
    /** 交易日快照历史（升序） */
    const history = ref<TrendPoint[]>([]);
    /** 最后一轮成功时间戳 */
    const updatedAt = ref(0);
    /** 最后一轮错误文案（空串 = 无错误） */
    const error = ref('');
    /** 页面是否在场（组件挂载中；轮询任务的门控） */
    const pageActive = ref(false);
    /** 刷新互斥（上一轮没跑完不叠轮） */
    let refreshing = false;

    /**
     * 活跃门槛（亿元，来自设置）
     * @returns 门槛数值（非法配置回落 1）
     */
    const thresholdYi = (): number => {
      const parsed = Number.parseFloat(String(ctx.settings.values.thresholdYi ?? '1'));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    };

    /** 历史仓库（ctx.db） */
    const historyRepo = createHistoryRepo(ctx.db);

    /** 重读历史序列（刷新后调用，驱动曲线更新） */
    const reloadHistory = async (): Promise<void> => {
      try {
        history.value = await historyRepo.list();
      } catch (err) {
        ctx.logger.warn(`读取历史快照失败：${String(err)}`);
      }
    };

    /**
     * 拉一轮全量数据（clist × 5 页 + ulist × 1，错峰 400ms，单页双域 + 重试）。
     * 单页失败不拖垮整轮：该页数据维持旧值，错误汇总进状态条。
     */
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      error.value = '';
      const failures: string[] = [];
      try {
        // 1) 成交额榜 Top 300（活跃市值统计池）
        const turnoverRaw: ClistRawRow[] = [];
        for (let pn = 1; pn <= TURNOVER_PAGES; pn += 1) {
          try {
            turnoverRaw.push(...(await fetchClistPage(http, format.delay, 'f6', pn)));
          } catch (err) {
            failures.push(`成交额榜 p${pn}：${String(err)}`);
          }
          if (pn < TURNOVER_PAGES) await format.delay(REQUEST_GAP_MS);
        }
        if (turnoverRaw.length > 0) rows.value = turnoverRaw.map(toStockRow);
        await format.delay(REQUEST_GAP_MS);
        // 2) 贡献候选池：总市值 Top 200（两页）
        const capRaw: ClistRawRow[] = [];
        for (let pn = 1; pn <= CAP_PAGES; pn += 1) {
          try {
            capRaw.push(...(await fetchClistPage(http, format.delay, 'f20', pn)));
          } catch (err) {
            failures.push(`市值池 p${pn}：${String(err)}`);
          }
          if (pn < CAP_PAGES) await format.delay(REQUEST_GAP_MS);
        }
        await format.delay(REQUEST_GAP_MS);
        // 3) 指数快照（一次拿三只）
        try {
          indices.value = await fetchIndexSnapshots(http, format.delay);
        } catch (err) {
          failures.push(`指数快照：${String(err)}`);
        }
        // 4) 两市实时总成交额（宿主服务，缺席静默降级）
        if (marketData) {
          try {
            const snapshot = await marketData.fetchRealtimeTurnover();
            totalAmount.value = snapshot?.turnover ?? null;
          } catch {
            totalAmount.value = null;
          }
        }
        // 贡献候选池合并去重（市值池 + 活跃池，覆盖「大市值低成交」与「中小市值大涨跌」两端）
        const merged = new Map<string, StockRow>();
        for (const row of [...capRaw.map(toStockRow), ...(rows.value ?? [])]) {
          if (!merged.has(row.code)) merged.set(row.code, row);
        }
        candidates.value = [...merged.values()];
        updatedAt.value = Date.now();
        if (failures.length > 0) {
          error.value = `部分数据未更新（${failures.length} 项失败，下一轮刷新会补齐）`;
          ctx.logger.warn(`刷新部分失败：${failures.join('；')}`);
        }
        // 5) 交易日快照入库（0AMV 序列逐日生长；周末 / 成交额异常低不记）
        if (rows.value && isWeekday() && (totalAmount.value ?? Number.POSITIVE_INFINITY) >= MIN_TRADING_AMOUNT) {
          const view = buildActiveView(rows.value, thresholdYi(), totalAmount.value);
          if (view.activeCap != null && view.activeAmount != null) {
            try {
              await historyRepo.record(localDate(), view.activeCap, view.activeCount, view.activeAmount);
            } catch (err) {
              ctx.logger.warn(`记录当日快照失败：${String(err)}`);
            }
          }
        }
        await reloadHistory();
      } finally {
        refreshing = false;
      }
    };

    //#endregion

    //#region 插件层轮询（交易窗口感知，页面在场 + 开关打开才真正取数）

    const scheduler = polling.create({
      task: async () => {
        if (!pageActive.value) return;
        if (!ctx.settings.values.autoRefresh) return;
        await refresh();
      },
      intervalMs: 30_000,
      tradingAware: true,
    });
    ctx.effect(() => () => scheduler.stop());

    //#endregion

    //#region 页面贡献

    ctx.menu.add({
      path: PAGE_PATH,
      title: '活跃市值与指数贡献',
      icon: 'dashboard',
      order: 520,
      component: createPageComponent({
        ui,
        format,
        stockOpen,
        settings: ctx.settings,
        thresholdYi,
        state: {
          get rows() {
            return rows.value;
          },
          get candidates() {
            return candidates.value;
          },
          get indices() {
            return indices.value;
          },
          get totalAmount() {
            return totalAmount.value;
          },
          get history() {
            return history.value;
          },
          get updatedAt() {
            return updatedAt.value;
          },
          get error() {
            return error.value;
          },
        },
        refresh,
        setPageActive: (value: boolean) => {
          pageActive.value = value;
        },
      }),
      fallbackLanding: true,
    });

    //#endregion

    await reloadHistory();
    ctx.logger.info('已注册「活跃市值与指数贡献」看板页（0AMV 口径 + 通达信贡献）与 30s 低频刷新调度');
  },
};

//#endregion

/**
 * 打包用的默认导出
 *
 * 产物包的安装链路读的是模块的默认导出（见宿主 `user-plugin-loader.ts`：
 * `mod.default ?? mod.plugin`）—— 与官方插件保持同一形态。
 */
export default activeCapIndexPlugin;
