import { computed, ref, watch, type Ref } from 'vue';
import { useTabConfigStore } from '../stores/tab-config.ts';

/** tab 选项（与 BaseTabs options 同构） */
export interface TabOption<T extends string> {
  label: string;
  value: T;
  /** 分组首项标记：true 时在其前渲染组间分隔与组名标签（index 0 无分隔线） */
  groupStart?: boolean;
  /** 分组名（groupStart 为 true 时展示；页签条 chip 与「页签配置」弹窗分组标题共用） */
  groupName?: string;
}

/**
 * 归一化 tabs 配置：丢弃未知 / 重复 value，缺失项（新版本新增）补到末尾
 *
 * 补齐而不是丢弃，是为了让新 tab 默认可见（不被历史设置挡住）；
 * 「用户主动取消勾选」由 hidden 表达，不会被这里补回来。
 * @param order 存储的顺序（可能来自 localStorage，内容不可信）
 * @param hidden 存储的未勾选集合
 * @param defaultOptions 默认 tab 项（value 全集）
 * @returns 归一化后的配置；入参全坏时退化为默认全显
 */
export const normalizeTabConfig = <T extends string>(
  order: readonly string[],
  hidden: readonly string[],
  defaultOptions: readonly TabOption<T>[],
): { order: string[]; hidden: string[] } => {
  const known = new Set<string>(defaultOptions.map((option) => option.value));
  const normalizedOrder: string[] = [];
  if (Array.isArray(order)) {
    for (const value of order) {
      if (typeof value === 'string' && known.has(value) && !normalizedOrder.includes(value)) {
        normalizedOrder.push(value);
      }
    }
  }
  for (const option of defaultOptions) {
    if (!normalizedOrder.includes(option.value)) {
      normalizedOrder.push(option.value);
    }
  }
  const hiddenSet = new Set<string>(
    Array.isArray(hidden) ? hidden.filter((value) => known.has(value)) : [],
  );
  return { order: normalizedOrder, hidden: normalizedOrder.filter((v) => hiddenSet.has(v)) };
};

/**
 * 页面顶部 tabs 配置：可见项（按存储顺序）+ 当前激活值
 *
 * - visibleOptions：存储 order/hidden 归一化合并后的可见 tab 项；
 *   全部被隐藏时兜底回默认全显（页面永远至少有一个 tab）
 * - activeValue：默认取首个 tab；激活值被隐藏时自动回退到首个可见 tab
 *
 * @param pageId 页面 key（存储分桶，如 'panorama'）
 * @param defaultOptions 默认 tab 项（声明顺序即默认顺序）
 * @returns visibleOptions 可见项；activeValue 激活值（可直接 v-model 给 BaseTabs）
 */
export const useTabConfig = <T extends string>(
  pageId: string,
  defaultOptions: readonly TabOption<T>[],
): { visibleOptions: Ref<TabOption<T>[]>; activeValue: Ref<T> } => {
  const store = useTabConfigStore();

  /** 当前页面的原始配置（无自定义时为空，走默认） */
  const storedConfig = computed(() => store.configs[pageId]);

  /** 归一化后的配置（与默认项合并，容忍新版本增删 tab） */
  const normalized = computed(() => {
    const config = storedConfig.value;
    if (!config) {
      return normalizeTabConfig([], [], defaultOptions);
    }
    return normalizeTabConfig(config.order, config.hidden, defaultOptions);
  });

  /** value -> 选项（展示名称用） */
  const optionByValue = computed(
    () => new Map(defaultOptions.map((option) => [option.value as string, option])),
  );

  /** 可见 tab 项（按归一化顺序，过滤 hidden；全隐藏兜底默认全显） */
  const visibleOptions = computed<TabOption<T>[]>(() => {
    const visible = normalized.value.order
      .filter((value) => !normalized.value.hidden.includes(value))
      .map((value) => optionByValue.value.get(value))
      .filter((option): option is TabOption<T> => !!option);
    return visible.length > 0 ? visible : [...defaultOptions];
  });

  /** 当前激活 tab（默认取首个） */
  const activeValue = ref<T>(defaultOptions[0]!.value) as Ref<T>;

  // 激活值不在可见项中（被隐藏 / 配置变化）时回退到首个可见 tab，防内容区空白
  watch(
    visibleOptions,
    (options) => {
      if (!options.some((option) => option.value === activeValue.value)) {
        activeValue.value = options[0]!.value;
      }
    },
    { immediate: true },
  );

  return { visibleOptions, activeValue };
};
