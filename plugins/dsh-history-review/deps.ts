/**
 * 插件 dsh-history-review · 视图依赖（plugin.ts 组装后 props 注入）
 */
import type { PluginStorage, UiKitService } from '../../host/types/plugin.types';
import type { ReviewRepo } from './storage';
import type { MonthlyBar } from './types';

/** 视图运行时依赖（宿主能力经 plugin.ts 收口，组件不直接 touch ctx） */
export interface ReviewDeps {
  /** 宿主 UI Kit（app:ui：Card / Tabs / Button / Empty / Table 等） */
  ui: UiKitService;
}

/** 视图运行时（数据能力经 plugin.ts 收口） */
export interface ReviewRuntime {
  /** 行情快照仓储（ctx.storage 水合，响应式） */
  repo: ReviewRepo;
  /** 批量拉取全部指数月 K（app:http 通道，串行错峰） */
  fetchAllMonthlies: (
    onStep?: (done: number, total: number, name: string) => void,
  ) => Promise<Record<string, MonthlyBar[]>>;
  /** 插件存储句柄（仅供根视图读写设置类小数据；行情快照走 repo） */
  storage: PluginStorage;
}
