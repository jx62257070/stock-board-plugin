/**
 * 有并发上限的逐项映射（worker 池模式，支持 AbortSignal 中断与进度回调）
 *
 * 从宿主 `utils/map-with-concurrency.ts` 移植：插件以单文件产物分发，
 * 运行时拿不到宿主模块，工具函数随插件自带（行为保持一致）。
 */

/** 并发映射选项 */
interface MapWithConcurrencyOptions {
  /** 最大并发数（默认 3） */
  concurrency?: number;
  /** 中断信号（abort 后进行中的 worker 在下一项前抛出） */
  signal?: AbortSignal;
  /** 每完成一项回调（completed / total） */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * 按并发上限逐项异步映射
 *
 * ⚠️ 返回**完成顺序**（不是入参顺序）：worker 池谁先跑完谁先进结果数组。
 * 需要入参顺序时由调用方自行按 id 归位。
 * @param items 输入列表
 * @param mapper 异步映射函数
 * @param options 并发 / 中断 / 进度选项
 * @returns 映射结果（**完成顺序**）
 * @throws Error 映射过程中被 abort 时抛出「分析已取消」
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  options?: MapWithConcurrencyOptions,
): Promise<R[]> => {
  const concurrency = Math.max(1, options?.concurrency ?? 3);
  const results: R[] = [];
  let cursor = 0;
  let completed = 0;

  const throwIfAborted = (): void => {
    if (options?.signal?.aborted) {
      throw new Error(ANALYSIS_ABORTED_MESSAGE);
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted();
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results.push(await mapper(items[currentIndex], currentIndex));
      throwIfAborted();
      completed += 1;
      options?.onProgress?.(completed, items.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return results;
};

/** 中断文案（与宿主信号扫描的取消判定保持一致） */
export const ANALYSIS_ABORTED_MESSAGE = '分析已取消';

/**
 * 判断错误是否为并发映射被取消
 * @param error 捕获的错误
 * @returns 是否为取消
 */
export const isAnalysisAborted = (error: unknown): boolean =>
  error instanceof Error && error.message === ANALYSIS_ABORTED_MESSAGE;
