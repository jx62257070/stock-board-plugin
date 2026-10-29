/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 全部常量
 *
 * 数据源：中金所每日收盘披露的成交持仓排名 CSV（每品种每日一个文件，
 * 成交量 / 持买单量 / 持卖单量三榜并排，GBK 编码，仅 HTTP 无 HTTPS）。
 * 常量从宿主 `src/common/constants/futures.constants.ts` 的 CCPM 段与
 * `src/common/constants/agent-ask.constants.ts` 机构行为段复制（注明来源），插件禁 import 宿主 src/。
 */

/** 插件 id */
export const FUTURES_INSTITUTIONAL_PLUGIN_ID = 'dsh-futures-institutional';

/** 左侧导航路径（沿用宿主「期货·机构行为」页，后续宿主删自带页由本插件接管） */
export const FUTURES_INSTITUTIONAL_MENU_PATH = '/futures/institutional';

/** 左侧导航标题 */
export const FUTURES_INSTITUTIONAL_MENU_TITLE = '机构行为';

/** 菜单图标（宿主 MenuIcon 已有 futures 内联 SVG） */
export const FUTURES_INSTITUTIONAL_MENU_ICON = 'futures';

/** 贡献的 MCP 服务器稳定 key */
export const FUTURES_MCP_KEY = 'futures-ccpm';

/** 贡献的 MCP 服务器授权用负数 id（避开内置 -1 ~ -4 与 screener 的 -101） */
export const FUTURES_MCP_ID = -103;

// ---------- 上游（源自宿主 futures.constants.ts CCPM 段） ----------

/** 中金所 CCPM CSV 上游地址模板（仅 HTTP；{yyyymm}/{dd}/{product} 由调用方填充） */
export const CCPM_CSV_URL_TEMPLATE = 'http://www.cffex.com.cn/sj/ccpm/{yyyymm}/{dd}/{product}_1.csv';

/** 上游代理目标域名（宿主 app:http 白名单已含 cffex.com.cn） */
export const CCPM_UPSTREAM_HOST = 'www.cffex.com.cn';

/** CSV 数据行首列固定为 8 位数字日期（解析校验） */
export const CCPM_DATE_CELL_LENGTH = 8;

/**
 * 品种清单（展示顺序即筛选器顺序）
 *
 * 股指四品种（IF/IH/IC/IM）支持「全股指合并」口径；国债品种持仓量级与结构
 * 与股指差异大，不参与跨品种合并。
 */
export const CCPM_PRODUCTS = [
  { code: 'IF', name: '沪深300' },
  { code: 'IH', name: '上证50' },
  { code: 'IC', name: '中证500' },
  { code: 'IM', name: '中证1000' },
  { code: 'T', name: '10年国债' },
  { code: 'TF', name: '5年国债' },
  { code: 'TS', name: '2年国债' },
  { code: 'TL', name: '30年国债' },
] as const;

/** 品种代码类型 */
export type CcpmProductCode = (typeof CCPM_PRODUCTS)[number]['code'];

/** 全股指合并口径的品种顺序（聚合明细按此排序） */
export const CCPM_EQUITY_PRODUCT_ORDER: readonly CcpmProductCode[] = ['IF', 'IH', 'IC', 'IM'];

/**
 * 行为标签阈值：|净持仓| ÷ max(多单, 空单) 低于此比例且多空同向增仓 → 对冲特征；
 * 不低于此比例 → 单边多 / 空
 */
export const CCPM_HEDGE_RATIO_THRESHOLD = 0.2;

/**
 * 移仓判定阈值（手）：近月某方向减仓、更远合约同方向增仓幅度不低于此值时，
 * 标记疑似移仓
 */
export const CCPM_ROLL_CHG_THRESHOLD = 100;

/** 时序图默认回看交易日数（席位净持仓时序） */
export const CCPM_SERIES_DAYS = 20;

/** 时序回看探测自然日上限：找不到足够披露日时停止（约一个月窗口） */
export const CCPM_SERIES_MAX_PROBE_DAYS = 45;

/** 逐日拉取并发上限（频率红线：同一上游 ≤3；上游为静态 CSV，3 足够稳） */
export const CCPM_FETCH_CONCURRENCY = 3;

/** 同一上游连续请求间隔（毫秒，错峰硬性要求） */
export const CCPM_FETCH_DELAY_MS = 500;

/** 历史同步默认回溯披露日数（「同步历史」按钮一次回填的深度） */
export const CCPM_SYNC_HISTORY_DAYS = 60;

/** 会话内数据缓存 TTL（毫秒）：披露日数据收盘后定稿，缓存 30 分钟即可 */
export const CCPM_CACHE_TTL_MS = 30 * 60 * 1000;

// ---------- 页面文案（源自宿主 futures.constants.ts FUTURES_PAGE_TEXT） ----------

/** 页面常驻文案（数据边界 / 口径提醒 / 风险提示，规范要求不可隐藏） */
export const FUTURES_PAGE_TEXT = {
  /** 顶部常驻数据边界提示 */
  dataBoundary:
    '数据来源中金所成交持仓排名（CCPM），仅披露代客经纪业务（会员全部客户合并数据，不等于单一机构）；仅披露达标 / 前 20 会员，非全市场数据；净持仓为收盘隔夜快照。标签为算法自动识别，仅供分析，不构成交易信号。',
  /** 全股指合并口径提醒（切到该口径时强制展示） */
  allScopeWarn: [
    '合并仅统计上榜 TOP20 合约，未上榜合约数据缺失，结果为不完全统计；',
    '代客席位是全部客户头寸合并，不是单一机构；',
    '净增减 ≠ 多头新开仓，不等于看多大盘（内部可能同时加多与加空，含套保、跨期套利）；',
    'IF / IH / IC / IM 属于不同指数，跨品种直接相加逻辑粗糙，仅供核验口径参考。',
  ],
  /** 聚合口径的部分头寸提示（isPartial 时展示） */
  partialWarn:
    '该席位仅部分合约上榜，合并结果为部分头寸（未进 TOP20 的合约无公开数据），不得当作完整净头寸解读。',
  /** 底部固定风险提示 */
  risks: [
    '所有数据为期货公司代客合并持仓：是席位全部客户总和（公募 / 私募 / 量化 / 散户 / 套保混合），不是某一家机构的单独头寸。',
    '中金所只披露达标 / 前 20 会员：未上榜会员与合约无公开数据，分析样本是部分样本。',
    '净持仓是收盘隔夜快照，看不到盘中 T+0 日内交易。',
    '空头持仓 ≠ 看空大盘：大量空单是股票现货多头的套保盘。',
    '净增减 ≠ 多头新开仓：净多变化 = 多头增减 − 空头增减，内部可能同时加多与加空。',
    '本页面仅做资金行为观测工具，所有标签、图表不构成任何投资建议。',
  ],
  /** 行为标签展示文案 */
  tagLabels: { hedge: '✅ 对冲特征', long: '⚠ 单边多头', short: '⚠ 单边空头' } as Record<string, string>,
  /** 行为标签判定说明（画像卡脚注） */
  tagRule: '|净持仓| ÷ max(多单, 空单) < 20% 且多空同向增仓 → 对冲；占比 ≥ 20% → 单边。空值席位不参与判定。',
} as const;

// ---------- AI 分析（源自宿主 agent-ask.constants.ts 机构行为段） ----------

/** 机构行为分析数据整体字符上限（超出截断，宁少勿爆上下文） */
export const CCPM_ANALYSIS_MAX_CHARS = 8000;

/**
 * 机构行为分析提示词模板（{scope} = 当前口径 / {day} = 披露交易日 / {data} = 席位数据占位）
 *
 * 公共骨架：持仓研判 → 指数印证 → 政策日历 → 地缘 → 综合结论；非单纯多空单分析
 */
export const CCPM_ANALYSIS_PROMPT_TEMPLATE =
  '以下是「机构行为」页面当前口径「{scope}」的中金所 CCPM 席位持仓数据（披露交易日 {day}，' +
  '持仓单位为手；表头 | 值）。\n' +
  '要求先调用可用的行情与市场数据工具查证，不要凭记忆编造，再输出分析：\n' +
  '① 持仓研判：多头增仓 vs 空头增仓的力量对比与多空分歧程度；异常席位' +
  '（单一会员大幅增 / 减仓的试探、对锁、反转信号解读）；持仓集中度变化；\n' +
  '② 指数印证：结合前几日与当日的上证指数、创业板指、科创 50 走势，把持仓行为放回指数语境解读' +
  '（如席位增多 + 指数阴跌 = 空头对锁避险；空减多增 + 指数放量企稳 = 反转确认），不要孤立看多空单；\n' +
  '③ 政策日历：美联储降息 / 加息预期及公布日期（FOMC 议息时间表、通胀与就业数据发布日程）——' +
  '点明下一个关键时间节点，以及两种结果分别对该品种意味着什么；\n' +
  '④ 地缘因素：俄乌冲突、以色列—伊朗局势等地缘事件对该品种（尤其贵金属、能源、黑色系）' +
  '供需与避险情绪的影响路径；\n' +
  '⑤ 结论：综合持仓 + 指数 + 政策日历 + 地缘四个层面，给出短期多空倾向的定性判断、' +
  '核心驱动与主要风险（不构成投资建议）。\n' +
  '政策预期与地缘动态若无法查证到最新信息，须在结论中标注「基于既有认知，时效未经验证」，不得编造具体日期或事件。\n' +
  '席位数据：\n{data}';

/** 口径展示名（提示词与页头用） */
export const CCPM_SCOPE_LABELS = {
  contract: '品种合约（单合约席位榜）',
  product: '同品种合并（会员跨合约合并）',
  all: '全部品种合并（四股指品种去重会员）',
} as const;
