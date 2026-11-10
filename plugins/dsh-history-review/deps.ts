/**
 * 插件 dsh-history-review · 视图依赖（plugin.ts 组装后 props 注入）
 *
 * 行情数据为随插件打包的静态周 K（weekly-data.ts），运行时只需宿主 UI Kit。
 */
import type { UiKitService } from '../../host/types/plugin.types';

/** 视图运行时依赖（宿主能力经 plugin.ts 收口，组件不直接 touch ctx） */
export interface ReviewDeps {
  /** 宿主 UI Kit（app:ui：Card / Tabs / Button / Empty / Table 等） */
  ui: UiKitService;
}
