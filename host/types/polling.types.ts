/**
 * 轮询所属市场（决定轮询窗口）
 *
 * - `A`：A 股交易日 09:15-15:00
 * - `US`：美股 21:30-24:00 与 00:00-04:00
 * - `HK`：港股周一~五 09:30-16:00
 */
export type PollingMarket = 'A' | 'US' | 'HK';

/**
 * 轮询选项
 */
export interface PollingOptions {
  /**
   * 轮询任务
   *
   * 应使用 sdk.quotes / sdk.batch 合并批量请求，而非逐只循环调用
   */
  task: () => Promise<void>;
  /** 盘中轮询间隔（毫秒）；非交易时段由 tradingAware 决定是否降级 */
  intervalMs: number;
  /** 是否启用交易窗口治理：仅在所属市场轮询窗口内轮询，窗口外只请求一次 */
  tradingAware?: boolean;
  /**
   * 所属市场（决定轮询窗口），默认 A
   *
   * 传 getter 可在「组件实例跨标的复用」场景下随符号响应式切换
   * （如详情面板在 A 股 / 港股标的间切换）：调度器在窗口 computed 内调用，
   * getter 内读取的响应式依赖会被自动追踪
   */
  market?: PollingMarket | (() => PollingMarket);
  /** 启动时是否立即执行一次任务 */
  immediate?: boolean;
}

/**
 * usePolling 返回的手动控制句柄
 */
export interface UsePollingReturn {
  /** 暂停轮询 */
  pause: () => void;
  /** 恢复轮询（不立即执行任务） */
  resume: () => void;
}

/**
 * 轮询调度器（`createPollingScheduler` 返回；无组件依赖，插件可在 `apply` 里使用）
 */
export interface PollingScheduler {
  /** 暂停轮询（不释放监听，可 resume） */
  pause: () => void;
  /** 恢复轮询（不立即执行任务） */
  resume: () => void;
  /** 立即执行一次任务（受互斥标记保护，执行中调用会被忽略） */
  runNow: () => Promise<void>;
  /**
   * 当前是否允许轮询（总开关打开且处于交易窗口内）
   * @returns 是否允许轮询
   */
  isEligible: () => boolean;
  /** 页面重新激活（KeepAlive）：允许轮询时恢复并立即补刷一次 */
  activate: () => void;
  /** 彻底停止：暂停计时并释放窗口 / 可见性监听（插件卸载时必须调） */
  stop: () => void;
}
