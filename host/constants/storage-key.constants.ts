/**
 * 本地存储键集中管理
 *
 * 全站持久化统一收敛到单一 localStorage key（STORAGE_KEY_APP）：
 * value 为按命名空间划分的对象 { [ns]: value }，经 appStorage 适配器读写；
 * 本文件常量为各 store 的命名空间（不再是独立 localStorage key）
 */

/** 统一持久化外层 key（localStorage 唯一键） */
export const STORAGE_KEY_APP = 'whf:app';

/** 自选股分组命名空间 */
export const STORAGE_NS_WATCHLIST = 'watchlist';

/** 股票账户命名空间 */
export const STORAGE_NS_STOCK_ACCOUNT = 'stock.account';

/** 应用设置命名空间 */
export const STORAGE_NS_SETTINGS = 'settings';

/** 明暗模式命名空间 */
export const STORAGE_NS_COLOR_SCHEME = 'colorScheme';

/** 右侧停靠面板命名空间（宽度 / 侧栏开关） */
export const STORAGE_NS_DOCK_PANEL = 'dockPanel';

/** 热点新闻页 - 源勾选状态命名空间（用户启用哪些新闻源） */
export const STORAGE_NS_HOT_NEWS_FILTER = 'hotNews.filter';

/** 今天炒什么页 - 平台勾选状态命名空间（用户启用哪些热榜平台） */
export const STORAGE_NS_HOT_BOARD_FILTER = 'hotBoard.filter';

/** 今天炒什么页 - 视图模式命名空间（股票热榜 / ETF 热榜，'stock' | 'etf'） */
export const STORAGE_NS_HOT_BOARD_MODE = 'hotBoard.mode';

/** 标的搜索历史命名空间（用户确认过的标的，最新在前，最多 SEARCH_HISTORY_MAX 条） */
export const STORAGE_NS_STOCK_SEARCH = 'stockSearch';

/** 页面 tabs 配置命名空间（各页面 tab 显隐 + 顺序，按页面 key 分桶） */
export const STORAGE_NS_TAB_CONFIG = 'tabConfig';

/** 板块资金模块（行情全景）- 行业资金曲线已选行业命名空间（BK 编号列表；键名沿用迁移前值） */
export const STORAGE_NS_MARKET_RANK_CURVE = 'marketRank.curve';

/** 板块资金模块（行情全景）- 视图模式命名空间（曲线 / 列表；键名沿用迁移前值） */
export const STORAGE_NS_MARKET_RANK_SECTOR_VIEW = 'marketRank.sectorView';

/** 插件系统命名空间（禁用黑名单 + 侧栏面板折叠态） */
export const STORAGE_NS_PLUGIN = 'plugin';

/** 行情全景 · 行业龙头分组自定义排序（JSON：{ board: string[], segment: string[] }，存分组名顺序） */
export const STORAGE_NS_PANORAMA_LEADERS_ORDER = 'panorama.leaders.order';

/** 用户安装插件命名空间（应用内安装的插件代码持久化） */
export const STORAGE_NS_USER_PLUGINS = 'plugin.user';

/** 插件市场源列表命名空间（内置官方源 + 用户添加的第三方源） */
export const STORAGE_NS_PLUGIN_MARKET = 'plugin.market';

/** 插件市场目录缓存命名空间（per-repo 的 Releases 解析结果；缓存不参与数据迁移） */
export const STORAGE_NS_PLUGIN_MARKET_CATALOG = 'plugin.market.catalog';

/** 盘面雷达页（原市场榜单）- 板块历史净流入独立存储 key（不走 whf:app 整包：历史数据量随使用增长，避免整包写放大） */
export const STORAGE_KEY_SECTOR_FLOW_HISTORY = 'whf:sector-flow-history';

/** ETF 持仓股缓存命名空间（详情页 ETF 持仓 Tab，按 ETF 代码整包存取） */
export const STORAGE_NS_ETF_HOLDINGS = 'etf.holdings';

/** ETF 基金概况缓存命名空间（详情页基金概况 Tab，按 ETF 代码整包存取） */
export const STORAGE_NS_ETF_PROFILE = 'etf.profile';

/** 移动端 · 前台轮询间隔（毫秒数值的 JSON 串，四档：5s/10s/30s/1min） */
export const STORAGE_NS_MOBILE_POLLING = 'mobile.pollingMs';

/** 移动端 · 榜单与新闻快照持久化缓存（30 分钟 TTL，键为 `news:*` / `board:*`） */
export const STORAGE_NS_MOBILE_CACHE = 'mobile.cache';

/** 移动端 · 今天炒什么平台设置（顺序 + 显隐，JSON：{ order, hidden }） */
export const STORAGE_NS_MOBILE_BOARD_SETTINGS = 'mobile.boardSettings';

/** 移动端 · 热点新闻源设置（顺序 + 显隐，JSON：{ order, hidden }） */
export const STORAGE_NS_MOBILE_NEWS_SETTINGS = 'mobile.newsSettings';

/** 移动端 · 搜索页最近搜索（上次点选的股票，JSON 数组：[{ code, name }]，最多 10 条） */
export const STORAGE_NS_MOBILE_SEARCH_HISTORY = 'mobile.searchHistory';

/** 移动端 · 历史牛熊指数月K快照（JSON：{ syncedAt, bars }，手动「更新到最新」刷新） */
export const STORAGE_NS_MOBILE_BULL_REVIEW = 'mobile.bullReview';

/** 移动端 · 资金流向页已选板块（板块资金曲线 + 历史净流入共用，JSON：{ codes }；
 *  独立于 PC 的 marketRank.curve，两端互不影响） */
export const STORAGE_NS_MOBILE_FUND_FLOW_CURVE = 'mobile.fundFlowCurve';

/** 移动端 · 首页金刚区入口设置（顺序 + 显隐，JSON：{ order, hidden }；
 *  长按任意金刚区 tile 打开设置弹窗，key 为入口路由路径（to）；
 *  2026-10-30 起行情页并入首页（P4），原独立键 mobile.quoteKingSettings 废弃） */
export const STORAGE_NS_MOBILE_KING_SETTINGS = 'mobile.kingSettings';

/** 移动端 · 调试模式开关（'1'/'0'；「我的」页应用信息卡连点 10 次切换） */
export const STORAGE_NS_MOBILE_DEBUG = 'mobile.debug';

/** 移动端 · 调试悬浮球位置（JSON：{ x, y }，视口 px 坐标，球心左上角） */
export const STORAGE_NS_MOBILE_DEBUG_BALL = 'mobile.debugBall';

/** PC · 浏览器模拟客户端标题栏开关（'1'/'0'；URL `?desktopTitlebar=` 优先写入，样式比对用） */
export const STORAGE_NS_DEBUG_DESKTOP_CHROME = 'pc.debugDesktopChrome';

/** 大盘评分历史（按本地日积累，近 5 日评分柱消费；值 = RatingHistoryEntry[]） */
export const STORAGE_NS_THS_RATING_HISTORY = 'ths.ratingHistory';

/** 命令面板 · 最近使用（空输入态展示；值 = RecentPaletteEntry[]，最多 PALETTE_RECENT_MAX 条） */
export const STORAGE_NS_COMMAND_PALETTE_RECENT = 'pc.commandPaletteRecent';

/** 自选 · 叠加对比组合（勾选符号 + 区间交易日数，JSON：{ symbols, rangeDays }） */
export const STORAGE_NS_WATCHLIST_COMPARE = 'pc.watchlistCompare';

/** 自选 · 隐藏的分组 id 列表（分组设置弹窗勾选显隐，JSON：string[]） */
export const STORAGE_NS_WATCHLIST_GROUP_HIDDEN = 'pc.watchlistGroupHidden';

/** 盘面雷达 · 页签列设置（顺序 + 显隐，JSON：{ order: string[]; hidden: string[] }） */
export const STORAGE_NS_MARKET_RANK_TABS = 'pc.marketRankTabs';

/** 市场宽度 · 分钟点序列（按本地日积累；值 = { [date]: BreadthPoint[] }，滚存最近 3 日） */
export const STORAGE_NS_MARKET_BREADTH_DAYS = 'marketBreadth.days';

/** 市场宽度 · 日 bar（收盘定稿聚合，滚存 250 日；值 = BreadthDayBar[]，日期升序） */
export const STORAGE_NS_MARKET_BREADTH_BARS = 'marketBreadth.bars';
