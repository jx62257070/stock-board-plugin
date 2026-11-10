/**
 * ECharts 主题感知（插件自包含版，与宿主 BaseChart 的 useDark 等价）
 *
 * 宿主明暗切换走 `html.dark` class（vueuse useDark 默认行为），主题色切换走
 * `html[data-theme]`；ECharts 选项颜色不能吃 CSS 变量，这里用 MutationObserver
 * 监听这两个属性给出响应式信号，消费方据此重算 option（EChartBox 深度 watch 后重渲染）。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * 当前是否暗色 / 主题色是否变化（html 的 class 或 data-theme 变化都翻转信号）
 * @returns 响应式信号值（isDark 语义 + data-theme 变化时也刷新以触发重算）
 */
export const useChartThemeSignal = (): Ref<boolean> => {
  const isDark = ref(document.documentElement.classList.contains('dark'));
  const observer = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains('dark');
  });
  onMounted(() => {
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
  });
  onBeforeUnmount(() => observer.disconnect());
  return isDark;
};

/**
 * 读取宿主 CSS 变量的当前值（如 --color-up）
 * @param name 变量名
 * @returns 变量值（读不到时返回空串）
 */
export const readCssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * 读取语义色（涨红 / 跌绿等），读不到时回落给定值
 * @param name CSS 变量名
 * @param fallback 回落色
 * @returns hex 颜色值
 */
export const semanticColor = (name: string, fallback: string): string =>
  readCssVar(name) || fallback;

/** 图表坐标 / 文本配色（亮暗两档，hex 取值与宿主 chart.constants 同源） */
export interface ChartPalette {
  /** 轴标签文本色 */
  text: string;
  /** 轴线颜色 */
  axisLine: string;
  /** 分隔线颜色 */
  splitLine: string;
  /** 十字准线（axisPointer）线色 */
  axisPointer: string;
  /** tooltip 背景色 */
  tooltipBg: string;
  /** tooltip 边框色 */
  tooltipBorder: string;
}

/**
 * 按明暗取图表配色
 * @param isDark 是否暗色
 * @returns 配色表
 */
export const chartPalette = (isDark: boolean): ChartPalette =>
  isDark
    ? {
        text: '#9aa8ba',
        axisLine: '#2c3540',
        splitLine: '#232a33',
        axisPointer: '#4a5866',
        tooltipBg: '#1f262e',
        tooltipBorder: '#2c3540',
      }
    : {
        text: '#5c6b80',
        axisLine: '#e5eaf0',
        splitLine: '#eef1f5',
        axisPointer: '#b8c4d2',
        tooltipBg: '#ffffff',
        tooltipBorder: '#e5eaf0',
      };
