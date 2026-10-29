/**
 * 插件 dsh-history-review（历史牛熊复盘）· 常量
 *
 * 插件身份 / 菜单注册 + 复盘口径常量（页签 / 同步节奏 / 图表尺寸 / 色板 CSS 变量键 /
 * 指数清单）全部收敛于此，组件里不散落字面量。
 */

/** 插件 id（也是插件 storage 的命名空间键） */
export const HISTORY_REVIEW_PLUGIN_ID = 'dsh-history-review';

/** 插件展示名 */
export const HISTORY_REVIEW_PLUGIN_NAME = '历史牛熊复盘';

/** 插件版本（与 manifest.json 保持一致，构建时校验） */
export const HISTORY_REVIEW_PLUGIN_VERSION = '1.0.0';

/** 左侧导航菜单路径 */
export const HISTORY_REVIEW_MENU_PATH = '/history-review';

/** 左侧导航菜单标题 */
export const HISTORY_REVIEW_MENU_TITLE = '历史牛熊复盘';

/** 左侧导航菜单图标（宿主 MenuIcon 的 key） */
export const HISTORY_REVIEW_MENU_ICON = 'book';

/** 快照在插件 storage 里的键 */
export const HISTORY_REVIEW_SNAPSHOT_KEY = 'review-snapshot';

/** 同一上游连续请求的错峰间隔（毫秒）—— 频率红线 */
export const BULL_SYNC_DELAY_MS = 500;

/** 行情图容器高度（像素） */
export const BULL_CHART_HEIGHT_PX = 320;

/** 模式库对比表的最小宽度（窄屏横向滚动） */
export const BULL_TABLE_MIN_WIDTH = '880px';

/** 复盘视图的三页签 */
export const BULL_VIEW_TABS = [
  { label: '历史牛市', value: 'bull' },
  { label: '历史熊市', value: 'bear' },
  { label: '模式库', value: 'library' },
] as const;

/** 复盘视图默认页签（牛市） */
export const BULL_VIEW_TAB_DEFAULT = 'bull';

/** 模式库页签的值 */
export const BULL_VIEW_TAB_LIBRARY = 'library';

/** 牛市阶段色带消费的 CSS 变量名（s1 启动 / s2 主升 / s3 鱼尾 / s4 退潮，随主题与暗色切换） */
export const BULL_STAGE_CSS_VAR: Record<string, string> = {
  s1: '--color-primary-weak',
  s2: '--color-up-weak',
  s3: '--color-up-pale',
  s4: '--color-down-weak',
};

/** 牛市阶段文字色消费的 CSS 变量名（同上顺序） */
export const BULL_STAGE_TEXT_CSS_VAR: Record<string, string> = {
  s1: '--color-primary',
  s2: '--color-up-strong',
  s3: '--color-up-strong',
  s4: '--color-down-strong',
};

/** 熊市阶段色带消费的 CSS 变量名（s1 初跌 / s2 反弹中继 / s3 主跌磨底 / s4 见底反转） */
export const BEAR_STAGE_CSS_VAR: Record<string, string> = {
  s1: '--color-down-weak',
  s2: '--color-flat-weak',
  s3: '--color-down-pale',
  s4: '--color-primary-weak',
};

/** 熊市阶段文字色消费的 CSS 变量名（同上顺序） */
export const BEAR_STAGE_TEXT_CSS_VAR: Record<string, string> = {
  s1: '--color-down-strong',
  s2: '--color-flat',
  s3: '--color-down-strong',
  s4: '--color-primary',
};

/** 复盘页叠加的宽基指数清单（新浪符号形态；月K一次拿全历史） */
export const BULL_INDEX_LIST: readonly { symbol: string; name: string }[] = [
  { symbol: 'sh000001', name: '上证指数' },
  { symbol: 'sh000300', name: '沪深300' },
  { symbol: 'sz399006', name: '创业板指' },
];
