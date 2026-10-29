import { defineStore } from 'pinia';
import { STORAGE_NS_TAB_CONFIG } from '../constants/storage-key.constants.ts';
import { appStorage } from '../utils/app-local-storage.ts';

/** 单个页面的 tabs 配置 */
export interface TabConfig {
  /** tab value 的完整排列（决定展示顺序） */
  order: string[];
  /** 未勾选（不展示）的 tab value 集合 */
  hidden: string[];
}

/** tabs 配置 store 状态 */
interface TabConfigState {
  /** 页面 key -> 配置（页面 key 由 use-tab-config 调用方约定） */
  configs: Record<string, TabConfig>;
}

/**
 * 页面顶部 tabs 配置 store：各页面 tab 的显隐 + 顺序
 *
 * 顺序与勾选分开存（同板块日历 boardCalendarOrder/Hidden 模式）：
 * `order` 是完整排列，`hidden` 是未勾选项，这样才能区分
 * 「用户主动取消勾选」与「新版本新增的 tab」。
 */
export const useTabConfigStore = defineStore('tab-config', {
  state: (): TabConfigState => ({
    configs: {},
  }),

  actions: {
    /**
     * 保存某页面的 tabs 配置
     * @param pageId 页面 key（如 'panorama' / 'market-rank'）
     * @param config 完整排列 + 未勾选集合
     */
    setConfig(pageId: string, config: TabConfig): void {
      this.configs[pageId] = { order: [...config.order], hidden: [...config.hidden] };
    },

    /**
     * 清除某页面的自定义配置（恢复默认由调用方回退到默认项实现）
     * @param pageId 页面 key
     */
    resetConfig(pageId: string): void {
      delete this.configs[pageId];
    },
  },

  persist: {
    key: STORAGE_NS_TAB_CONFIG,
    storage: appStorage,
  },
});
