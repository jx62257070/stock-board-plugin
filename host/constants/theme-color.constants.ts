/**
 * 主题色常量（清新绿为默认，data-theme 属性切换，settings store 持久化）
 *
 * 色值需与 `src/assets/styles/theme.css` 里的 `[data-theme='*']` 保持一致：
 * 这里只用于设置页色块展示，真正的换肤发生在 CSS。
 * custom 例外：无内置 CSS 规则，主色由 useDocumentThemeSync 以内联 CSS 变量
 * 动态下发（色值来自 settings.customThemeColor，用户在颜色选择器里自选）。
 */
export const THEME_COLOR = {
  GREEN: 'green',
  BLUE: 'blue',
  ORANGE: 'orange',
  GOLD: 'gold',
  /** 热情红（王总 2026-10-11 指定 #ff4134） */
  RED: 'red',
  /** 自定义（色值取 settings.customThemeColor，运行期内联覆盖主色变量） */
  CUSTOM: 'custom',
} as const;

/** 主题色类型 */
export type ThemeColor = (typeof THEME_COLOR)[keyof typeof THEME_COLOR];

/** 自定义主题色合法格式（#rrggbb，颜色选择器原生输出即此形态） */
export const CUSTOM_THEME_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 自定义主题色默认值（首次切到「自定义」时的初始色 = 默认清新绿主色） */
export const CUSTOM_THEME_COLOR_DEFAULT = '#0e9488';

/**
 * 主题色选项（swatch 供设置页色块展示）
 *
 * ⚠️ swatch 用「亮色模式下的主色」——色块画在弹窗里，需要自身可辨识；
 * 暗色模式下主色不变，所以色块不必区分模式。
 */
export const THEME_COLOR_OPTIONS: readonly { label: string; value: ThemeColor; swatch: string }[] = [
  { label: '清新绿', value: THEME_COLOR.GREEN, swatch: '#0e9488' },
  { label: '淡雅蓝', value: THEME_COLOR.BLUE, swatch: '#4f83cc' },
  { label: '活力橙', value: THEME_COLOR.ORANGE, swatch: '#f97316' },
  { label: '黑金', value: THEME_COLOR.GOLD, swatch: '#c8920b' },
  { label: '热情红', value: THEME_COLOR.RED, swatch: '#ff4134' },
  { label: '自定义', value: THEME_COLOR.CUSTOM, swatch: CUSTOM_THEME_COLOR_DEFAULT },
];

/**
 * 判定一个未知值是否为有效主题色（持久化水合校验用：旧版存过的
 * 已删除主题值要拦下来，避免 <html data-theme> 落在无 CSS 规则的值上）
 * @param value 任意值
 * @returns 是否为当前仍支持的主题色
 */
export const isThemeColor = (value: unknown): value is ThemeColor =>
  typeof value === 'string' && (Object.values(THEME_COLOR) as readonly string[]).includes(value);

/** 默认主题色 */
export const THEME_COLOR_DEFAULT: ThemeColor = THEME_COLOR.GREEN;

/**
 * 自定义主题色的弱色底（--color-primary-weak）掺色比例
 *
 * 内置主题的弱色底是「主色的浅淡底」，这里用 color-mix 按比例向透明掺主色得到：
 * 暗色模式比例更高（低比例掺色压在近黑底上几乎不可见）。
 */
export const CUSTOM_THEME_WEAK_TINT = {
  /** 亮色模式：主色掺 14% */
  LIGHT: 0.14,
  /** 暗色模式：主色掺 24% */
  DARK: 0.24,
} as const;

/** 主题色 CSS 变量名（ECharts 等非 CSS 上下文经 readCssVar 运行时读取） */
export const CSS_VAR_PRIMARY = '--color-primary';
