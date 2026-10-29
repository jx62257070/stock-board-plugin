/**
 * 插件 dsh-market-breadth（市场宽度）· 常量
 *
 * 口径自宿主 `src/common/constants/market-breadth.constants.ts` 与
 * `src/common/constants/agent-ask.constants.ts` 复制（插件禁 import 宿主 src/，
 * 内容注明来源口径，宿主改口径时需手动同步）。
 * 另收纳：插件身份与菜单、ctx.db 表与列声明、快照取数参数、MCP 工具、全部界面文案。
 */

// ---------- 插件身份与菜单 ----------

/** 插件 id（= 目录名 = manifest.id；同时是 db 表名与存储命名空间的一部分，定了不能改） */
export const BREADTH_PLUGIN_ID = 'dsh-market-breadth';

/** 插件展示名 */
export const BREADTH_PLUGIN_NAME = '市场宽度';

/** 插件版本（与 manifest.json 保持一致，构建脚本会校验） */
export const BREADTH_PLUGIN_VERSION = '1.1.0';

/** 左侧导航菜单路径（沿用宿主内置页的历史路径，老书签直达；宿主删自带页后由本插件接管） */
export const BREADTH_MENU_PATH = '/market-breadth';

/** 左侧导航菜单标题 */
export const BREADTH_MENU_TITLE = '市场宽度';

/** 左侧导航菜单图标（宿主 MenuIcon 的 key，= 宿主 MENU_ICON.BREADTH） */
export const BREADTH_MENU_ICON = 'breadth';

/** 插件贡献的 Agent MCP 服务器 key（管理弹窗展示与归属记账用） */
export const BREADTH_MCP_KEY = 'breadth-data';

/** 插件贡献的 Agent MCP 服务器资源 id（负数段约定，避开内置 -1 ~ -4 与 screener 的 -101） */
export const BREADTH_MCP_ID = -102;

// ---------- ctx.db 表与列 ----------

/** 分钟点表名（物理表 `plugin_dsh_market_breadth_minute_point`） */
export const BREADTH_MINUTE_TABLE = 'minute_point';

/** 日 bar 表名（物理表 `plugin_dsh_market_breadth_day_bar`） */
export const BREADTH_BAR_TABLE = 'day_bar';

/** 分钟点表的列声明（(date, time) 组合唯一：同分钟覆盖；业务列，不含宿主自动维护的 id 三列） */
export const BREADTH_MINUTE_COLUMNS = [
  { name: 'date', type: 'text', indexed: true },
  { name: 'time', type: 'integer' },
  { name: 'up_count', type: 'integer' },
  { name: 'down_count', type: 'integer' },
  { name: 'flat_count', type: 'integer' },
  { name: 'up_vol', type: 'integer' },
  { name: 'down_vol', type: 'integer' },
  { name: 'arms', type: 'real' },
  { name: 'active_count', type: 'integer' },
  { name: 'active_total', type: 'integer' },
] as const;

/** 日 bar 表的列声明（date 唯一：upsert 幂等；业务列，不含宿主自动维护的 id 三列） */
export const BREADTH_BAR_COLUMNS = [
  { name: 'date', type: 'text', indexed: true },
  { name: 'up_count', type: 'integer' },
  { name: 'down_count', type: 'integer' },
  { name: 'up_vol', type: 'integer' },
  { name: 'down_vol', type: 'integer' },
  { name: 'arms', type: 'real' },
  { name: 'active_count', type: 'integer' },
  { name: 'active_total', type: 'integer' },
] as const;

// ---------- 快照取数参数（口径自宿主 api/quotes.api.ts 的 MARKET_SNAPSHOT_OPTIONS） ----------

/** 每页标的数（上游 clist 单页上限约 500） */
export const MARKET_SNAPSHOT_BATCH_SIZE = 500;

/**
 * 并发页数：3（约 11 页 → 4 轮）
 *
 * ⚠️ 东财反爬红线：并发不得超过 3，不要调回 SDK 默认 7。
 */
export const MARKET_SNAPSHOT_CONCURRENCY = 3;

// ---------- 本地积累参数（口径自宿主 market-breadth.constants.ts） ----------

/** 日 bar 滚存上限（约一年交易日） */
export const BREADTH_BAR_KEEP_DAYS = 250;

/** 分钟点按日滚存上限（仅保留最近 N 日，bar 落库后旧分时无用） */
export const BREADTH_DAY_SERIES_KEEP_DAYS = 3;

/** 收盘分钟数（15:00，本地时区；此后快照定稿，聚合日 bar） */
export const BREADTH_BAR_CLOSE_MINUTE = 15 * 60;

/** 毫秒 → 分钟取整除数 */
export const MINUTE_MS = 60_000;

/** 页面快照轮询间隔（毫秒；= 宿主 POLLING_INTERVAL.MARKET_BREADTH） */
export const BREADTH_POLL_INTERVAL_MS = 30_000;

// ---------- ARMS 阈值与状态（口径自宿主 market-breadth.constants.ts） ----------

/** ARMS 强势上限（< 此值为强势，红档） */
export const ARMS_STRONG_MAX = 0.75;

/** ARMS 偏强上限（0.75 ~ 0.9 为偏强，红档） */
export const ARMS_FAVORABLE_MAX = 0.9;

/** ARMS 平衡上限（0.9 ~ 1.1 为平衡；1.1 ~ 1.3 为偏弱，绿档） */
export const ARMS_NEUTRAL_MAX = 1.1;

/** ARMS 偏弱上限（> 1.3 为弱势，绿档） */
export const ARMS_WEAK_MIN = 1.3;

/** ARMS 平衡参考线（y = 1 虚线基准） */
export const ARMS_NEUTRAL_LINE = 1;

/** ARMS 五档状态 key */
export const ARMS_STATE = {
  /** < 0.75 强势 */
  STRONG: 'strong',
  /** 0.75 ~ 0.9 偏强 */
  FAVORABLE: 'favorable',
  /** 0.9 ~ 1.1 平衡 */
  NEUTRAL: 'neutral',
  /** 1.1 ~ 1.3 偏弱 */
  UNFAVORABLE: 'unfavorable',
  /** > 1.3 弱势 */
  WEAK: 'weak',
} as const;

/** ARMS 状态 key 类型 */
export type ArmsStateKey = (typeof ARMS_STATE)[keyof typeof ARMS_STATE];

/** ARMS 状态文案（key → 中文标签） */
export const ARMS_STATE_LABEL: Record<ArmsStateKey, string> = {
  [ARMS_STATE.STRONG]: '强势',
  [ARMS_STATE.FAVORABLE]: '偏强',
  [ARMS_STATE.NEUTRAL]: '平衡',
  [ARMS_STATE.UNFAVORABLE]: '偏弱',
  [ARMS_STATE.WEAK]: '弱势',
};

// ---------- 广度指标参数（口径自宿主 market-breadth.constants.ts，对齐通达信） ----------

/** ADR 涨跌比率统计周期（N 日涨跌家数总和之比） */
export const BREADTH_ADR_PERIOD = 10;

/** ADR 超买阈值（> 此值行情过热） */
export const BREADTH_ADR_OVERBOUGHT = 1.5;

/** ADR 超卖阈值（< 此值恐慌杀跌） */
export const BREADTH_ADR_OVERSOLD = 0.5;

/** OBOS 超买超卖统计周期（N 日涨跌家数总和之差） */
export const BREADTH_OBOS_PERIOD = 10;

/** OBOS 均线周期（MA） */
export const BREADTH_OBOS_MA_PERIOD = 6;

/** ADL 腾落线均线周期（MA） */
export const BREADTH_ADL_MA_PERIOD = 10;

/** ARMS 日线平滑均线周期（MA，阿姆氏 4/21 日惯例取 21） */
export const BREADTH_ARMS_MA_PERIOD = 21;

/** MCO 麦克莱伦短周期 EMA */
export const BREADTH_MCO_FAST_PERIOD = 19;

/** MCO 麦克莱伦长周期 EMA */
export const BREADTH_MCO_SLOW_PERIOD = 39;

/** MCO 信号线 MA 周期（MAMCO） */
export const BREADTH_MCO_SIGNAL_PERIOD = 9;

/** MCO 超买阈值（> 此值进入超买区） */
export const BREADTH_MCO_OVERBOUGHT = 25;

/** MCO 超卖阈值（< 此值进入超卖区） */
export const BREADTH_MCO_OVERSOLD = -25;

/** 活跃股换手率阈值（%：日换手率 > 此值计入活跃家数） */
export const BREADTH_ACTIVE_TURNOVER_THRESHOLD = 5;

/** 活跃占比过热阈值（%：≥ 此值交投过热，短线情绪亢奋） */
export const BREADTH_ACTIVE_OVERHEAT = 20;

/** 活跃占比冰点阈值（%：≤ 此值交投冰点，观望情绪浓） */
export const BREADTH_ACTIVE_COLD = 5;

/** MCO 趋稳所需参考积累天数（EMA39 + 信号线预热） */
export const MCO_READY_DAYS = 50;

/** ADR/OBOS 达标准口径周期所需积累天数 */
export const ADR_READY_DAYS = 10;

// ---------- 视图档位与副图 kind（口径自宿主 market-breadth.constants.ts） ----------

/** 广度指标页视图 key（近 60 日 / 近 120 日 / 全部积累） */
export const BREADTH_INDICATOR_VIEW = {
  D60: 'd60',
  D120: 'd120',
  ALL: 'all',
} as const;

/** 广度指标页视图 key 类型 */
export type BreadthIndicatorViewKey =
  (typeof BREADTH_INDICATOR_VIEW)[keyof typeof BREADTH_INDICATOR_VIEW];

/** 广度指标页日线视图档位（视图 key → 交易日窗口天数；ALL 无键表示全量） */
export const BREADTH_INDICATOR_VIEW_DAYS: Partial<Record<BreadthIndicatorViewKey, number>> = {
  [BREADTH_INDICATOR_VIEW.D60]: 60,
  [BREADTH_INDICATOR_VIEW.D120]: 120,
};

/** 广度指标页视图选项（页签数据源） */
export const BREADTH_INDICATOR_VIEW_OPTIONS: ReadonlyArray<{
  label: string;
  value: BreadthIndicatorViewKey;
}> = [
  { label: '近 60 日', value: BREADTH_INDICATOR_VIEW.D60 },
  { label: '近 120 日', value: BREADTH_INDICATOR_VIEW.D120 },
  { label: '全部', value: BREADTH_INDICATOR_VIEW.ALL },
];

/** 广度指标副图 kind（ADL / ADR / OBOS / ARMS / MCO / 活跃占比） */
export const BREADTH_INDICATOR_KIND = {
  ADL: 'adl',
  ADR: 'adr',
  OBOS: 'obos',
  ARMS: 'arms',
  MCO: 'mco',
  ACTIVE: 'active',
} as const;

/** 广度指标副图 kind 类型 */
export type BreadthIndicatorKind =
  (typeof BREADTH_INDICATOR_KIND)[keyof typeof BREADTH_INDICATOR_KIND];

/** 六指标中文名（副图卡标题与「总结」弹窗条目共用，口径自宿主 BREADTH_INDICATOR_INFO 同源） */
export const BREADTH_INDICATOR_LABEL: Record<BreadthIndicatorKind, string> = {
  [BREADTH_INDICATOR_KIND.ADL]: 'ADL 腾落线',
  [BREADTH_INDICATOR_KIND.ADR]: 'ADR 涨跌比率',
  [BREADTH_INDICATOR_KIND.OBOS]: 'OBOS 超买超卖',
  [BREADTH_INDICATOR_KIND.ARMS]: 'TRIN 阿姆氏（ARMS）',
  [BREADTH_INDICATOR_KIND.MCO]: '麦克莱伦震荡（MCO）',
  [BREADTH_INDICATOR_KIND.ACTIVE]: '活跃占比',
};

/** 单个广度指标的说明（副图标题 icon hover 展示） */
export interface BreadthIndicatorInfo {
  /** 计算公式（\n 分行） */
  formula: string;
  /** 指标意义与判读口径 */
  meaning: string;
}

/** 六大广度指标说明（公式口径对齐通达信；自宿主同款常量复制） */
export const BREADTH_INDICATOR_INFO: Record<BreadthIndicatorKind, BreadthIndicatorInfo> = {
  [BREADTH_INDICATOR_KIND.ADL]: {
    formula: 'ADL = Σ(上涨家数 − 下跌家数)，逐日累加\nMADL = MA(ADL, 10)',
    meaning:
      '市场广度趋势线，看广度的长期累积状态。指数新高且 ADL 同步新高：普涨健康，趋势延续；指数新高但 ADL 不创新高：顶背离，权重拉指数、小票走弱，风险预警；指数新低但 ADL 不创新低：底背离，抛压衰竭，底部信号。本页 ADL 起点为本地首条 bar（历史无法回填），仅具相对意义。',
  },
  [BREADTH_INDICATOR_KIND.ADR]: {
    formula: 'ADR = N日上涨家数总和 ÷ N日下跌家数总和（N = 10）',
    meaning:
      'N 日内涨跌股票数量比值，衡量多空数量对比。ADR > 1.5：超买，行情过热；ADR < 0.5：超卖，恐慌杀跌；0.7 ~ 1.3：多空均衡震荡。',
  },
  [BREADTH_INDICATOR_KIND.OBOS]: {
    formula: 'OBOS = N日上涨家数总和 − N日下跌家数总和（N = 10）\nMOBOS = MA(OBOS, 6)',
    meaning:
      'ADR 的差值版，直接看多空数量净差，更直观。大幅正值：上涨家数占绝对优势；大幅负值：下跌家数占绝对优势；同样重点看与指数的背离。',
  },
  [BREADTH_INDICATOR_KIND.ARMS]: {
    formula:
      'TRIN = (上涨家数 ÷ 下跌家数) ÷ (上涨成交量 ÷ 下跌成交量)\nARMS = MA(TRIN, 21)',
    meaning:
      '唯一同时叠加家数与成交量的广度指标，逆向情绪指标。TRIN = 1：多空均衡；< 1：多头更强，数值越低越狂热（超买，警惕见顶）；> 1：空头更强，数值越高越恐慌（超卖，短线反弹机会）。实战看均线平滑后的 ARMS，而非盘中瞬时值。',
  },
  [BREADTH_INDICATOR_KIND.MCO]: {
    formula:
      'DIF = 上涨家数 − 下跌家数\nMCO = EMA(DIF, 19) − EMA(DIF, 39)\nMAMCO = MA(MCO, 9)',
    meaning:
      '广度动量指标（ADL 的动量版），对广度拐点敏感，比 ADL 更早提示背离。MCO > 0：多头占优；MCO < 0：空头占优；+25 ~ +35 超买区、−25 ~ −35 超卖区；看 MCO 与指数的背离，以及 0 轴穿越（金叉死叉）。EMA 需预热，约 50 个交易日后趋稳。',
  },
  [BREADTH_INDICATOR_KIND.ACTIVE]: {
    formula:
      `活跃占比 = 换手率 > ${BREADTH_ACTIVE_TURNOVER_THRESHOLD}% 家数 ÷ 换手率有效（正常交易）家数 × 100%`,
    meaning:
      '市场交投活跃度的温度计，衡量有多少比例的股票被资金重点参与。占比持续走高：题材轮动加快、短线情绪升温；占比 ≥ 20%：交投过热，提防情绪退潮；占比 ≤ 5%：交投冰点，存量博弈。历史无法回填，自上线日起本地逐日积累。',
  },
};

// ---------- MCP 工具参数 ----------

/** MCP 历史序列工具的默认返回天数 */
export const MCP_HISTORY_DEFAULT_DAYS = 30;

/** MCP 历史序列工具的天数上限（控制 token，宁少勿爆） */
export const MCP_HISTORY_MAX_DAYS = 120;

/** MCP 历史序列工具的单行字符上限（超长行截断） */
export const MCP_HISTORY_LINE_MAX_CHARS = 80;

// ---------- AI 分析提示词（口径自宿主 agent-ask.constants.ts） ----------

/** 市场宽度分析数据整体字符上限（超出截断，宁少勿爆上下文；= 宿主 BREADTH_ANALYSIS_MAX_CHARS） */
export const BREADTH_ANALYSIS_MAX_CHARS = 8000;

/** 市场宽度分析提示词模板（{days} = 数据积累天数 / {data} = 指标摘要占位；自宿主复制） */
export const BREADTH_ANALYSIS_PROMPT_TEMPLATE =
  '以下是「市场宽度」页面的广度指标摘要（本地逐日积累 {days} 个交易日；' +
  '积累不足 50 日时 MCO 等长窗口指标未成熟，请据此降低相应结论的置信度）。\n' +
  '要求先调用可用的行情与市场数据工具查证，不要凭记忆编造，再输出分析：\n' +
  '① 阶段判断：当前市场处于底部区域 / 健康上行 / 过热 / 退潮的哪一档，给出判据；\n' +
  '② 背离信号：指数与涨跌家数、ARMS 与活跃占比之间的背离；与区间极值（新高 / 新低）的对比；\n' +
  '③ 指数印证：结合前几日与当日的上证指数、创业板指、科创 50 走势与广度数据交叉验证' +
  '（如指数微涨而下跌家数占优 = 拉权重撑指数；指数回调而上涨家数反增 = 普涨修复；' +
  '三者指数间强弱指示资金偏价值还是偏成长）；\n' +
  '④ 政策日历：美联储降息 / 加息预期及公布日期（FOMC 时间表、通胀就业数据日程）、' +
  '国内重要会议与政策窗口——关键节点前后的广度收缩 / 修复规律对仓位节奏的提示；\n' +
  '⑤ 地缘风险：俄乌冲突、以色列—伊朗局势等地缘动态对风险偏好的压制或提振路径；\n' +
  '⑥ 结论：综合以上给出短期仓位建议倾向（仅定性判断，不构成投资建议）。\n' +
  '政策预期与地缘动态若无法查证到最新信息，须在结论中标注「基于既有认知，时效未经验证」，不得编造具体日期或事件。\n' +
  '指标摘要：\n{data}';

// ---------- 界面文案 ----------

/** 「总结」按钮文案 */
export const BREADTH_SUMMARY_BUTTON_TEXT = '总结';

/** 总结弹窗日期下拉的 aria-label */
export const BREADTH_SUMMARY_DATE_ARIA_LABEL = '选择总结日期';

/** 「刷新」按钮文案 */
export const BREADTH_REFRESH_BUTTON_TEXT = '刷新';

/** 刷新进行中的按钮文案 */
export const BREADTH_REFRESHING_TEXT = '刷新中…';

/** AI 分析按钮文案 */
export const BREADTH_AI_BUTTON_TEXT = 'AI 分析';

/** AI 分析进行中的按钮文案 */
export const BREADTH_AI_RUNNING_TEXT = '分析中…';

/** 无可分析数据时的浮窗提示标题 */
export const BREADTH_AI_EMPTY_TITLE = '暂无可分析的宽度数据';

/** 无可分析数据时的浮窗提示正文 */
export const BREADTH_AI_EMPTY_BODY = '请等待广度数据积累后再发起 AI 分析';

/** 总结弹窗标题 */
export const BREADTH_SUMMARY_MODAL_TITLE = '总结';

/** 总结弹窗副标题模板（{date} = 指标截至日期） */
export const BREADTH_SUMMARY_SUBTITLE = '各项指标截至 {date} 的解读，按指标逐条罗列';

/** 指标积累中的占位解读文案 */
export const BREADTH_INTERPRET_EMPTY = '暂无数据（指标积累中）';
