/**
 * 插件 dsh-sidebar-watch · 个股分类标签（`watch:tags` 服务的唯一实现）
 *
 * 「这只票是什么分类」的颜色圆点（白色 = 未分类，8 色循环切换）过去只活在
 * 小组件气泡里，色映射（symbol → 色名）锁在 widget/mount.ts 的局部 ref 里。
 * 2.5.0 起把它提升为本插件的公开服务：
 *
 * - **真身不变**：仍是插件 settings 的 `widgetStockColors` 键（老用户数据零迁移），
 *   本模块只是把「reactive 副本 + settings 落库」这对动作收拢成一处；
 * - **唯一写入方**：无论气泡点击（Tauri 事件）、宿主自选股页（服务调用）还是
 *   候选清理，都经本模块改写 —— 消灭多端各写一份的漂移可能；
 * - **跨端共享**：宿主经 `pluginKernel.services.consumeAs('watch:tags')` 按结构取用，
 *   `colors` 是宿主同一个 Vue 实例的 ref（构建时 vue 外部化到运行时桥），
 *   自选股页圆点与小组件行载荷天然双向联动，无需任何事件协议。
 *
 * 注意：本模块必须在 `await createWatchCandidateRepo(ctx.db)` **之后**创建 ——
 * Tauri 端插件 storage 有「启动时以 SQLite 覆盖水合」的异步过程，等第一次 DB
 * 操作让出事件循环后水合基本完成，此时读 settings 才不至于读到水合前的旧值。
 */
import { ref } from 'vue';
import type { Ref } from 'vue';
import { isWidgetColor, readStockColors, rememberStockColors } from './widget/settings';
import type { WatchWidgetColor } from './widget/constants';
import type { PluginSettingsStore } from '../../host/types/plugin.types';

/** 个股分类标签存储（`watch:tags` 服务的实现形状） */
export interface WatchTagsStore {
  /** symbol → 色名（响应式；小组件行载荷与宿主自选股页圆点都直接依赖它） */
  colors: Readonly<Ref<Readonly<Record<string, WatchWidgetColor>>>>;
  /**
   * 设置单只票的分类颜色（非法色名 / 空符号 / 同值一律忽略）
   * @param symbol 完整符号（sh600519 形态）
   * @param color 目标色名（必须是 WATCH_WIDGET_COLOR 的合法取值）
   */
  setColor: (symbol: string, color: WatchWidgetColor) => void;
  /**
   * 整表替换（候选清理等批量场景用；替换后整表落库）
   * @param next 替换后的完整映射
   */
  replaceAll: (next: Record<string, WatchWidgetColor>) => void;
}

/**
 * 创建个股分类标签存储（挂载时调用一次，随后 provide 成 `watch:tags`）
 * @param settings 插件设置存取句柄（`widgetStockColors` 键的读写通道）
 * @returns 标签存储
 */
export const createWatchTagsStore = (settings: PluginSettingsStore): WatchTagsStore => {
  // 持 reactive 副本而不是每次从 settings 现读：改色高频时行载荷与宿主圆点
  // 要立刻跟着变，且 settings 容器的响应式口径是宿主表单的内部约定，
  // 不给「自定义键是否响应式」留赌注（与原 mount.ts 的实现同一考量）
  const colors = ref<Record<string, WatchWidgetColor>>(readStockColors(settings));

  /**
   * 全量改写：先改 reactive 副本（行载荷与宿主圆点随之重算），再整表落库
   * @param next 改写后的完整映射
   */
  const apply = (next: Record<string, WatchWidgetColor>): void => {
    colors.value = next;
    rememberStockColors(settings, next);
  };

  return {
    colors,
    setColor: (symbol: string, color: WatchWidgetColor): void => {
      if (!symbol || !isWidgetColor(color)) return;
      if (colors.value[symbol] === color) return;
      apply({ ...colors.value, [symbol]: color });
    },
    replaceAll: apply,
  };
};

// 把本插件的服务登记进全局服务契约表
declare module '../../host/types/plugin.types' {
  interface AppServiceMap {
    /** 个股分类标签存储（由 dsh-sidebar-watch 提供；自选股页与小组件气泡共用同一份） */
    'watch:tags': WatchTagsStore;
  }
}
