/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 全部常量
 *
 * 口径来源：`.ai/开发方案/2026-10-30-插件-散户情绪指数看板开发方案.md`（宿主仓）与
 * 同日 UI 稿 `2026-10-30-插件-散户情绪指数看板UI稿-v1.html`。要点：
 * - **混合源（2026-10-30 王总确认）**：东财行情域封禁窗口式反复，全链路单点不可接受 ——
 *   板块清单 / 板块日 K / 当日快照字段全部走**同花顺**（dsh-mainline 既有链路，
 *   ≈500 日深度、自带涨跌家数与净流入），东财只保留两个不可替代的点：
 *   fflow 逐日小单拆分（散户提纯核心，全网唯一）与涨停 / 炸板 / 跌停池；
 *   分母走宿主 fetchMarketTurnover（腾讯，与 THS 分子量级一致：板块合计 ≈ 两市 98.5%），
 *   东财指数日 K 为次选降级。东财封禁时散户因子当日缺席（权重自动重分配），不 block 采集；
 * - 「散户」= 东财小单估算口径（fflow daykline f58 小单净占比），UI 固定标注；
 * - 频率红线（2026-10-31 按上游实测收紧）：同花顺与清单类并发 ≤ 3 + 每请求 500ms 错峰；
 *   东财 fflow 走**串行慢车道**（1.2s 间隔 + 探测 + 连拒熔断，见 EM_FFLOW_* 常量）——
 *   dsh-mainline 实测东财行情域「间隔 ≥1s 正常、短时连发立刻拒连（停顿约 20s 恢复）」，
 *   3 并发连发只会自我触发/延长封禁窗口；
 * - 打开页面不联网，只读 ctx.db；采集更新为用户点击触发，不轮询。
 */

/** 插件 id */
export const SENTIMENT_PLUGIN_ID = 'dsh-sentiment-index';

/** 左侧导航路径（菜单贡献点带 component 时自动注册该路由） */
export const SENTIMENT_MENU_PATH = '/sentiment';

/** 左侧导航标题 */
export const SENTIMENT_MENU_TITLE = '散户情绪指数';

/** 菜单图标（MenuIcon 的 key） */
export const SENTIMENT_MENU_ICON = 'breadth';

// ---------- 同花顺（主源：清单 + 板块日K） ----------

/** 同花顺清单页（`{kind}` 注入 thshy / gn；GBK HTML，锚点含全部板块） */
export const THS_LIST_URL: Record<'industry' | 'concept', string> = {
  industry: 'https://q.10jqka.com.cn/thshy/',
  concept: 'https://q.10jqka.com.cn/gn/',
};

/** 同花顺清单翻页地址基址（ajax 形态，只返回表格行；页码与后缀由取数层拼） */
export const THS_LIST_PAGE_URL: Record<'industry' | 'concept', string> = {
  industry: 'https://q.10jqka.com.cn/thshy/index/field/199112/order/desc/page/',
  concept: 'https://q.10jqka.com.cn/gn/index/field/199112/order/desc/page/',
};

/** 清单最多翻页数（实测行业 2 页收全；概念 300+ 留护栏） */
export const THS_LIST_MAX_PAGES = 8;

/** 行业板块代码前缀（881xxx） */
export const THS_INDUSTRY_CODE_PREFIX = '881';

/**
 * 同花顺板块日 K 基址（行业与概念同 48 市场号，实测 2026-10-30）
 *
 * 完整形态 `${base}${code}/${adjust}/${file}.js`，如
 * `https://d.10jqka.com.cn/v6/line/48_881121/01/2026.js`；
 * 返回 JSONP，行内字段序 `日期,开,高,低,收,量,额`。
 */
export const THS_BOARD_KLINE_URL_BASE = 'https://d.10jqka.com.cn/v6/line/48_';

/** 板块日 K 路径中段（`…/<code>/<复权>/<year>.js`） */
export const THS_BOARD_KLINE_URL_MIDDLE = '/';

/** 同一候选 URL 对 5xx 网关错误的尝试次数（含首次；THS 网关瞬时 502 呈簇） */
export const THS_BOARD_KLINE_URL_ATTEMPTS = 2;

/** 5xx 起始状态码（含）—— 视为可重试的网关瞬时错误 */
export const THS_HTTP_SERVER_ERROR_MIN = 500;

/** 同花顺要求带 Referer，否则可能被拒 */
export const THS_REFERER = 'https://q.10jqka.com.cn/';

// ---------- 东财（fflow 小单拆分 + 池子） ----------

// ---------- 东财（fflow 小单拆分 + 池子 + 分母降级 + BK 映射） ----------

/**
 * 东财网页端公共 ut token（akshare 同款，非用户级凭证）
 *
 * 2026-10-31 实测：浏览器上下文（WebView 指纹 + 东财 Referer）下带 ut 的
 * fflow / clist JSONP 请求畅通；未单独实测无 ut 形态，统一带上最稳。
 */
export const EM_UT_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';

/**
 * 东财板块清单（映射用：THS→BK 名称对齐的前提；`{pz}` 条数、`{fs}` 板块类型由调用方替换）
 *
 * ⚠️ 只用于建立 THS→BK 名称映射（fflow 的前提），不是板块清单来源（板块全集走 THS）。
 */
export const EM_CLIST_URL_TEMPLATE =
  'https://push2delay.eastmoney.com/api/qt/clist/get?pn={pn}&pz={pz}&po=0&np=1&fltt=2&invt=2'
  + '&fid=f12&fs={fs}&fields=f12,f14';

/** 东财行业板块 fs 参数 */
export const EM_FS_INDUSTRY = 'm:90+t:2';

/** 东财概念板块 fs 参数 */
export const EM_FS_CONCEPT = 'm:90+t:3';

/** 清单单页条数（⚠️ 2026-11-01 实测：JSONP 通道服务端把 pz 截断到 100 行/页，reqwest 时代一页 496 的行为已变） */
export const EM_CLIST_PAGE_SIZE = 100;

/** 清单最多翻页数（护栏；100/页 × 8 = 800 ≥ 全部板块 496，留足余量） */
export const EM_CLIST_MAX_PAGES = 8;

/**
 * 东财板块 / 指数日 K（分母的**次选**：主分母为宿主 fetchMarketTurnover 腾讯源；
 * 东财封禁时若腾讯也不可用才走这条）
 */
export const EM_KLINE_URL_TEMPLATE =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}'
  + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg={beg}&end=20500101'
  + `&ut=${EM_UT_TOKEN}`;

/**
 * 同花顺板块名 → 东财板块名（THS→BK 名称映射的别名表）
 *
 * 两套分类口径不同、名称也不同时的人工对应（词序颠倒 / 申万改名），抄自
 * dsh-mainline 的 MAINLINE_THS_TO_EM_ALIAS（其注释含「故意不收录」清单——
 * 成分范围不同的板块宁缺毋滥，映射不上散户因子如实缺席）。
 */
export const EM_THS_TO_EM_ALIAS: Readonly<Record<string, string>> = {
  '公路铁路运输': '铁路公路',
  '港口航运': '航运港口',
  '机场航运': '航空机场',
  '煤炭开采加工': '煤炭开采',
  '石油加工贸易': '炼化及贸易',
  '油气开采及服务': '油气开采',
  '汽车服务及其他': '汽车服务',
  '文化传媒': '传媒',
  '塑料制品': '塑料',
  '橡胶制品': '橡胶',
  '食品加工制造': '食品加工',
  '种植业与林业': '种植业',
};

/** 东财板块逐日资金拆分（fflow daykline；fields2 扩到 f61 = 五档净额 + 五档净占比） */
export const EM_FFLOW_URL_TEMPLATE =
  'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid={secid}'
  + '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&lmt=0'
  + `&ut=${EM_UT_TOKEN}`;

/**
 * 东财板块清单四档资金流快照（**自积累主通道**，2026-10-31 新增）
 *
 * 与 fflow 历史接口不同源不同路径：一次请求返回**全部板块**的当日
 * 主力/小单净额与净占比（四档里的两档即可喂散户因子），每天 1~2 个请求
 * 落库自建历史 —— 从此即便 push2his fflow 历史接口持续被封，散户因子也能
 * 逐日累积（代价：无 121 日回补，分位窗口从安装日起算）。
 */
export const EM_CLIST_FUND_URL_TEMPLATE =
  'https://push2.eastmoney.com/api/qt/clist/get?pn={pn}&pz={pz}&po=1&np=1&fltt=2&invt=2'
  + '&fid=f12&fs={fs}&fields=f12,f14,f62,f184,f84,f87'
  + `&ut=${EM_UT_TOKEN}`;

/** 四档快照单页条数（服务端 pz 截断到 100/页，同 EM_CLIST_PAGE_SIZE） */
export const EM_CLIST_FUND_PAGE_SIZE = 100;

/** 四档快照最多翻页数（护栏，100/页 × 8 覆盖全部板块） */
export const EM_CLIST_FUND_MAX_PAGES = 8;

/** 东财涨停 / 炸板 / 跌停池基址（`{path}` 注入池子端点，`{date}` 注入 YYYYMMDD） */
export const EM_POOL_URL_TEMPLATE =
  'https://push2ex.eastmoney.com{path}?ut=7eea3edcaed734bea9cbfc24409ed989'
  + '&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt:asc&date={date}';

/** 炸板池端点 */
export const EM_POOL_PATH_ZHA_BAN = '/getTopicZBPool';

/** 跌停池端点 */
export const EM_POOL_PATH_LIMIT_DOWN = '/getTopicDTPool';

/** 沪深指数 secid（分母次选：沪 1.000001 + 深 0.399001 日 K 成交额相加） */
export const EM_MARKET_SECIDS = ['1.000001', '0.399001'] as const;

/** 东财要求带 Referer，否则可能被拒 */
export const EM_REFERER = 'https://quote.eastmoney.com/';

// ---------- 东财 JSONP 桥（2026-10-31，宿主 4.32.0 注入） ----------

/**
 * 东财行情域被 WAF 按「浏览器 TLS 指纹 + 东财域 Referer」双条件封杀（reqwest /
 * curl / undici 指纹一律连接层拒连），`app:http` 通道打 push2 系 API 全灭；而
 * WebView 内、以 eastmoney.com 页面为 Referer 的 JSONP 畅通。宿主向东财域注入
 * 桥脚本（`EM_JSONP_BRIDGE_INIT_SCRIPT`，协议见宿主 PLUGIN_API.md §5.5.1），本
 * 插件以隐藏 iframe 承载东财页面、postMessage 代发 JSONP —— 解析层拿到的文本
 * 与 http 通道同构，parse 函数零改动。
 *
 * 信源常量与宿主 `src-tauri/src/lib.rs` 严格同步（**两端**，任一改动必须同步）；
 * 桥缺席（旧宿主 / 纯浏览器 dev / 移动端未注入）→ 回退 app:http 原通道。
 */

/** 桥信源常量（宿主 lib.rs 的 BRIDGE_SOURCE 必须与此一致） */
export const EM_BRIDGE_SOURCE = 'whf-stock-board-em-bridge';

/**
 * 桥 iframe 加载的东财页面（必须是**真实渲染的 HTML 文档**）
 *
 * ⚠️ 2026-10-31 真机 E2E 实测：不能用 `https://push2his.eastmoney.com/`（404 空响应
 * text/plain 0 字节在 WebView2 里渲染为错误页，`initialization_script_for_all_frames`
 * 的脚本不会在错误页上执行 → 桥永远等不到 ready → 静默回退 http 被拒连）。
 * 选 quote.eastmoney.com：完整 HTML 文档 + 最早探针验证过的 JSONP Referer 上下文；
 * init script 在 document 创建时即执行，ready 几乎即时（不等页面资源加载完）。
 */
export const EM_BRIDGE_IFRAME_URL = 'https://quote.eastmoney.com/';

/** 桥 iframe 无障碍标题 */
export const EM_BRIDGE_IFRAME_TITLE = '东财数据桥（隐藏）';

/** 桥就绪等待超时（毫秒；超时视为宿主未注入，回退 app:http） */
export const EM_BRIDGE_READY_TIMEOUT_MS = 10000;

/** 桥内单次 JSONP 超时（毫秒；与宿主桥脚本内的超时一致，双保险） */
export const EM_JSONP_TIMEOUT_MS = 15000;

/**
 * 桥空闲自动拆除（毫秒）
 *
 * 桥用完不挂常驻 iframe（东财页面留在文档里会一直持有连接与内存）：自最后一次
 * 桥活动起空闲该时长即自动拆除；期间的桥请求（THS 段之后回到桥时）会自动重建，
 * 重建失败回退 app:http —— 比 runScan 显式 dispose 更稳（并发扫描互不拆台）。
 */
export const EM_BRIDGE_IDLE_MS = 120000;

/** 走桥的东财行情域（push2ex 池子未被风控波及，继续走 app:http 不引入桥依赖） */
export const EM_BRIDGE_ROUTE_HOSTS: readonly string[] = [
  'push2his.eastmoney.com',
  'push2.eastmoney.com',
  'push2delay.eastmoney.com',
];

// ---------- 请求与节流 ----------

/** 同一上游 URL 的原地重试次数（含首次；东财掐连接呈瞬时簇，稍等自愈） */
export const EM_FETCH_ATTEMPTS = 3;

/** 采集的同一上游并发上限（频率红线：不得超过 3） */
export const SCAN_CONCURRENCY = 3;

/** 采集的相邻请求间隔（毫秒，频率红线：东财系同一上游 500ms 错峰） */
export const SCAN_DELAY_MS = 500;

/** 失败补采轮之前的等待与轮内间隔（毫秒；给限速留恢复时间） */
export const SCAN_RETRY_DELAY_MS = 2000;

/**
 * 东财 fflow 串行慢车道的相邻请求间隔（毫秒）
 *
 * dsh-mainline 实测（2026-09-18）：东财行情域是**突发限速** —— 间隔 ≥1s 正常返回、
 * 短时连发立刻拒连（TCP RST）、停顿约 20s 恢复。fflow 全量拉取本就是采集大头，
 * 串行 1.2s 对 30 板块 ≈ 36s，换「整轮能拿到数据」值得；并发 3 × 500ms 的旧节奏
 * 已实测触发整轮 0/20 全拒。
 */
export const EM_FFLOW_SCAN_DELAY_MS = 1200;

/**
 * fflow 车道内首次「连接被拒」后的恢复等待（毫秒）
 *
 * dsh-mainline 实测封禁窗口约 20s 自愈：首拒后停这一拍再继续，窗口刚开时
 * 剩余板块还能救回来；连续再拒说明窗口仍开着，交给熔断（EM_FFLOW_BLOCK_ABORT_RUNS）。
 */
export const EM_FFLOW_BLOCK_COOLDOWN_MS = 20000;

/**
 * fflow 车道的连拒熔断阈值（连续「连接被拒」次数，含冷却后再拒的那次）
 *
 * 对封禁中的上游连发只会延长封禁（em-data.ts 头注释同源结论）：达到该次数立即
 * 跳过剩余板块，本轮散户因子整体缺席，等下次采集（恢复后自动补历史）。
 */
export const EM_FFLOW_BLOCK_ABORT_RUNS = 2;

// ---------- 历史与口径 ----------

/** 日 K 起始年份向前推的年数（2 → 约 500 个交易日，覆盖 420 日上限与 250 日分位窗口） */
export const KLINE_YEARS_BACK = 2;

/** 每板块保留的最大历史交易日数（约两年，够 250 日分位窗口与 250 日时间档） */
export const MAX_HISTORY_DAYS = 420;

/** 因子分位的回看窗口（交易日；不足取全部可得历史） */
export const PERCENTILE_WINDOW = 250;

/** 因子分位的最小样本数（不足视为样本不足，指数记 null —— 缺样本 ≠ 状态正常） */
export const MIN_FACTOR_SAMPLES = 20;

/** 相对放量的均值窗口（交易日：自身过去 20 日均额，不含当日） */
export const VOLUME_RATIO_WINDOW = 20;

/**
 * 当日数据「落定」时刻（本地时间，当日 0 点起的分钟数）
 *
 * 收盘 15:00 后上游行情与资金还需落定，取 15:30 作缓冲：早于该时刻扫描时，
 * **当日 bar 一律不入库**（半日 bar 一旦落库就会永久污染分位序列，且不会自愈）。
 */
export const SETTLE_MINUTES = 15 * 60 + 30;

/** 非关注板块（行业 90 + 未关注概念）只保留最近几个交易日的快照行（排行表今日截面用） */
export const TAIL_KEEP_DAYS = 5;

/** 涨停池历史回补深度（交易日；上游只覆盖近端约一个月） */
export const LIMIT_UP_BACKFILL_DAYS = 30;

/** 关注题材上限（个） */
export const WATCHLIST_CAP = 30;

/** 首次扫描默认关注清单：行业按成交额取前 N */
export const DEFAULT_WATCH_INDUSTRY_TOP = 20;

/** 首次扫描默认关注清单：概念按主力净额取前 N */
export const DEFAULT_WATCH_CONCEPT_TOP = 10;

// ---------- 指标权重（试验性，王总可回测后在常量层调整） ----------

/**
 * 热度指数权重：成交占比 0.6 + 相对放量 0.2 + 换手 0.2
 *
 * 因子先各自归一化为「该板块近 250 日历史分位」再加权；某因子缺席时其权重
 * 按比例摊给其余因子（换手率 clist f8 未实测，缺席概率不低，必须能降级）。
 */
export const HEAT_WEIGHTS = { amountShare: 0.6, volumeRatio: 0.2, turnover: 0.2 } as const;

/**
 * 散户情绪指数权重：小单净占比 0.4 + 成交占比 0.3 + 赚钱效应 0.3
 *
 * 与豆包原案（40/30/20/10）的差异：其「散户成交占全市场散户成交」因子无数据源
 * （东财只披露小单净额与净占比，无双边成交额），权重并入分位合成。
 */
export const RETAIL_WEIGHTS = { smallNetRatio: 0.4, amountShare: 0.3, moneyEffect: 0.3 } as const;

/** 赚钱效应组内部权重：上涨家数占比与涨停占比再对半（各自先取分位） */
export const MONEY_EFFECT_WEIGHTS = { upRatio: 0.5, limitUpRatio: 0.5 } as const;

// ---------- 指数色阶与背离 ----------

/** 指数色阶：≥ 该值为「亢奋」（红） */
export const INDEX_HOT_THRESHOLD = 70;

/** 指数色阶：< 该值为「冰点」（灰），其间为「中性」（橙） */
export const INDEX_COOL_THRESHOLD = 40;

/** 背离（情绪钝化）：情绪指数须高于该值而价格创新低 */
export const DIVERGENCE_BLUNT_MIN_RETAIL = 60;

/** 背离窗口：价格 / 情绪「近 5 日创新低 / 新高」的窗口长度（交易日，不含当日） */
export const DIVERGENCE_WINDOW = 5;

/** 背离（情绪衰竭）：小单净额连续为负的天数 */
export const DIVERGENCE_FADE_NEGATIVE_DAYS = 3;

// ---------- 单位换算 ----------

/** 元 → 亿元 的换算基数（展示用） */
export const YUAN_PER_YI = 1e8;

/** 万亿换算基数（两市成交额展示用） */
export const YUAN_PER_TRILLION = 1e12;

/** 亿元单位文案 */
export const YI_UNIT = '亿';

/** 百分比数值转小数比率时的基数 */
export const PERCENT_BASE = 100;

// ---------- 采集流程步骤（进度条分段） ----------

/** 采集流程步骤（顺序即 §5 五步） */
export const SCAN_STEPS = {
  SNAPSHOT: 'snapshot',
  MARKET: 'market',
  HISTORY: 'history',
  LIMIT_UP: 'limitUp',
  COMPUTE: 'compute',
} as const;

/** 采集步骤取值类型 */
export type ScanStep = (typeof SCAN_STEPS)[keyof typeof SCAN_STEPS];

/** 采集步骤中文名（进度文案用） */
export const SCAN_STEP_LABEL: Record<ScanStep, string> = {
  snapshot: '当日快照',
  market: '全市场分母',
  history: '增量历史',
  limitUp: '涨停池',
  compute: '重算指数',
};

/** 采集步骤顺序（进度条分段顺序） */
export const SCAN_STEP_ORDER: readonly ScanStep[] = [
  SCAN_STEPS.SNAPSHOT,
  SCAN_STEPS.MARKET,
  SCAN_STEPS.HISTORY,
  SCAN_STEPS.LIMIT_UP,
  SCAN_STEPS.COMPUTE,
];

/**
 * 采集步骤的总进度权重（%，五步合计 100；历史与涨停池是请求大头）
 *
 * 增量轮的涨停池只有 1 个请求，该步会「跳得快」—— 权重按首扫（最慢路径）标定，
 * 进度条只做体感示意，不做精确耗时承诺。
 */
export const SCAN_STEP_WEIGHT: Record<ScanStep, number> = {
  snapshot: 10,
  market: 10,
  history: 55,
  limitUp: 15,
  compute: 10,
};

/**
 * 东财临时封禁的采集提示（连接被拒时的可读状态，替代裸 URL 报错）
 *
 * 2026-10-30 实测：本机对东财 push2 系存在间歇性 TCP RST 封禁（窗口式反复）。
 * 东财只承担 fflow 小单拆分 —— 封禁中**不 block 采集**，散户因子当日缺席
 * （权重自动重分配），恢复后自动补历史；此文案作为页内提示。
 */
export const EM_BLOCKED_NOTICE =
  '东财行情域临时限流中（连接被拒）：价量与热度数据照常采集，散户因子（小单净占比）今日缺席；历史恢复后自动补齐。';

/** 同花顺主源不可用的采集提示 */
export const THS_BLOCKED_NOTICE =
  '同花顺清单不可用：本轮无法采集（清单是板块全集的来源）；已用本地缓存清单或宿主行业清单兜底的轮次不受影响。';

/**
 * 散户因子缺席的提示模板（count 为缺席数 —— v1.1.0 曾把分子写成 total - count，
 * 全缺席时显示「0/20 缺席」的假数，2026-10-31 修正）
 * @param count 缺席板块数
 * @param total 目标板块总数
 * @returns 提示文案
 */
export const fflowMissNotice = (count: number, total: number): string =>
  `东财资金拆分本轮 ${count}/${total} 个板块缺席（限流中），散户因子以可得子集计算；恢复后采集自动补历史。`;

/** 采集进行中的进度卡标题 */
export const PROGRESS_CARD_TITLE = '正在采集更新';

// ---------- 界面文案 ----------

/** 页面副标题（口径说明） */
export const SENTIMENT_PAGE_SUBTITLE =
  '以「板块成交额占全市场比重」为热度锚点，叠加东财小单资金拆分做散户提纯，'
  + '输出 0~100 的题材热度指数与散户情绪指数；价格-情绪-量能同图对照，背离关系一眼可见。'
  + '打开页面不联网，读本地累积数据；「采集更新」为唯一联网入口（用户点击触发，不轮询）。';

/** 数据源徽标文案（混合源：THS 主源 + 东财散户因子） */
export const SOURCE_BADGE_TEXT = '数据源 同花顺 + 东财';

/** 试验性徽标文案（权重未经回测） */
export const TRIAL_BADGE_TEXT = '试验性权重';

/** 小单口径常驻标注 */
export const SMALL_ORDER_NOTICE =
  'ⓘ 小单 ≈ 散户为东财估算口径，指数为题材情绪参考而非精确散户测量';

/** 表底口径标注（历史起点 + 小单口径，合并一条） */
export const TABLE_FOOTER_NOTICE =
  'ⓘ 情绪历史自 2026-03-27 起（上游 fflow 限制）· 小单 ≈ 散户为估算口径 · 指数为题材情绪参考';

/** 采集按钮文案 */
export const SCAN_BUTTON_TEXT = '采集更新';

/** 采集按钮进行中文案 */
export const SCAN_BUTTON_RUNNING = '采集中';

/** 首次空态主文案 */
export const EMPTY_TITLE = '还没有任何情绪数据';

/** 首次空态说明文案 */
export const EMPTY_TEXT =
  '首次采集将回补约 121 个交易日历史（关注题材逐板块拉取，约百个请求）；'
  + '之后每次增量 ≤ 5 个请求。也可先在「管理」里调整关注题材再采集。';

/** 空态按钮文案 */
export const EMPTY_SCAN_BUTTON = '开始首次采集';

/** 采集失败文案前缀 */
export const SCAN_FAILED_TEXT = '采集失败';

/**
 * 盘中未落定提示模板
 * @param date 被排除的日期
 * @returns 提示文案
 */
export const intradayNotice = (date: string): string =>
  `${date} 当日数据尚未落定（盘中为半日值），本次未写入当日行情；指数按最近完整交易日计算。`;

/**
 * 采集完成浮窗标题模板
 * @param asOf 基准交易日
 * @returns 标题
 */
export const SCAN_DONE_TITLE = (asOf: string): string =>
  `散户情绪 · 已更新至 ${asOf.slice(5).replace('-', '/')}`;

/**
 * 采集完成浮窗正文模板
 * @param added 新增行数（板块 × 交易日）
 * @param failureCount 失败板块数
 * @returns 正文
 */
export const SCAN_DONE_BODY = (added: number, failureCount: number): string =>
  `新增 ${added} 条板块日数据${failureCount > 0 ? ` · ${failureCount} 个板块本轮失败` : ''}`;

/**
 * 失败清单卡片标题模板
 * @param count 失败板块数
 * @returns 标题
 */
export const FAILURE_CARD_TITLE = (count: number): string => `${count} 个板块本轮失败`;

/**
 * 失败板块滞后徽标模板
 * @param days 滞后交易日数
 * @returns 徽标文案
 */
export const staleBadgeText = (days: number): string => `滞后${days}日`;

/** 失败板块无数据徽标 */
export const STALE_NO_DATA_BADGE = '无数据';

/** 失败清单重试按钮文案 */
export const RETRY_BUTTON_TEXT = '重试';

/** 失败清单底部说明 */
export const FAILURE_FOOTER_NOTICE =
  '失败板块保留本地旧数据并标「滞后 N 日」；重试只重跑失败板块，不整轮重扫。';

/** 关注管理弹层标题 */
export const WATCH_MODAL_TITLE = '关注题材';

/**
 * 关注清单计数文案模板
 * @param count 当前数量
 * @param cap 上限
 * @returns 文案
 */
export const WATCH_COUNT_TEXT = (count: number, cap: number): string => `${count} / ${cap}`;

/** 关注搜索框占位 */
export const WATCH_SEARCH_PLACEHOLDER = '搜索板块（支持行业 + 概念全量）';

/** 关注弹层空态（清单缓存为空时的引导） */
export const WATCH_EMPTY_NOTICE =
  '板块清单为空：点「采集更新」拉取全量板块清单；若提示限流中，请等东财封禁解除后再试。';

/** 关注弹层底部说明 */
export const WATCH_MODAL_FOOTER_NOTICE = '移除不删除已落库历史；新增板块会在下次采集时自动补拉历史。';

/** 关注满额提示 */
export const WATCH_FULL_NOTICE = `关注题材已达上限 ${WATCHLIST_CAP} 个，先移除一些再添加`;

/** 行业筛选 chip 文案 */
export const KIND_CHIPS = [
  { key: 'watch', label: '★ 关注' },
  { key: 'industry', label: '行业' },
  { key: 'concept', label: '概念' },
] as const;

/** kind 筛选取值类型 */
export type KindFilter = (typeof KIND_CHIPS)[number]['key'];

/** 时间档 chips（交易日数） */
export const RANGE_OPTIONS = [
  { key: '60', label: '60 日' },
  { key: '121', label: '121 日' },
  { key: '250', label: '250 日' },
] as const;

/** 时间档取值类型 */
export type RangeKey = (typeof RANGE_OPTIONS)[number]['key'];

/** 时间档对应的交易日数 */
export const RANGE_DAYS: Record<RangeKey, number> = { '60': 60, '121': 121, '250': 250 };

/** 情绪胶囊色阶类名（红 = 亢奋 / 橙 = 中性 / 灰 = 冰点，随主题 token） */
export const INDEX_PILL_CLASS = {
  hot: 'bg-up-weak text-up',
  warm: 'bg-flat-weak text-text-secondary',
  cool: 'bg-flat-weak/60 text-text-tertiary',
} as const;

/**
 * 指数色阶判定（≥70 红 / 40~69 橙 / <40 灰）
 * @param value 指数值（0~100）
 * @returns 色阶键
 */
export const indexPillKey = (value: number): keyof typeof INDEX_PILL_CLASS => {
  if (value >= INDEX_HOT_THRESHOLD) return 'hot';
  if (value >= INDEX_COOL_THRESHOLD) return 'warm';
  return 'cool';
};

/** 排行表列标题 */
export const COLUMN_LABEL = {
  name: '板块',
  heat: '热度指数',
  retail: '散户情绪指数',
  share: '成交占比',
  smallRatio: '小单净占比',
  change: '涨跌幅',
} as const;

/** 排行卡标题 */
export const RANK_CARD_TITLE = '题材指数排行';

/** 详情卡标题（宽容器右栏 / 堆叠下部） */
export const DETAIL_CARD_TITLE = '单题材详情';

/** 详情区字段标签（tooltip 与头部胶囊） */
export const DETAIL_LABEL = {
  retailPill: '散户情绪',
  heatPill: '热度',
  watchAdd: '★ 加关注',
  watchRemove: '★ 取消关注',
  klineMode: 'K 线',
  lineMode: '收盘价线',
  volumeTitle: '量能（成交量，涨红跌绿）',
  fundTitle: '资金 · 小单净占比（%）',
  fundToggle: '显示资金副图',
  legendBoard: '板块日K',
  legendRetail: '散户情绪指数（右轴 0~100）',
  legendDivergence: '⚠ 背离标记',
} as const;

/** 图表底部说明（250 日档情绪曲线前段留空属预期） */
export const CHART_FOOTER_NOTICE =
  '← 拖动平移 · 滚轮缩放（三栏联动） · 情绪曲线仅 121 日内有值，250 日档前段留空 →';

/**
 * 背离标记 tooltip 模板：情绪钝化
 * @param retail 当前情绪指数
 * @returns tooltip 文案
 */
export const divergenceBluntTip = (retail: number): string =>
  `情绪钝化：价格创 5 日新低，而散户情绪指数仍高于 ${DIVERGENCE_BLUNT_MIN_RETAIL}（当前 ${retail.toFixed(0)}）`;

/**
 * 背离标记 tooltip 模板：情绪衰竭
 * @returns tooltip 文案
 */
export const divergenceFadeTip = (): string =>
  `情绪衰竭：散户情绪指数创 ${DIVERGENCE_WINDOW} 日新高，而小单净额已连续 ${DIVERGENCE_FADE_NEGATIVE_DAYS} 日为负`;

/** 全市场情绪格标题 */
export const MOOD_LABEL = {
  amount: '两市成交额',
  riseFall: '上涨 / 下跌',
  limitUp: '涨停',
  zhaBan: '炸板',
  limitDown: '跌停',
} as const;

/** 移动端详情返回按钮文案（aria） */
export const MOBILE_BACK_LABEL = '返回排行';

/** 手机档行点击提示（详情视图切换）—— 无文字，仅 aria */
export const MOBILE_ROW_OPEN_LABEL = '查看题材详情';
