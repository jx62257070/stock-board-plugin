import { STORAGE_KEY_APP } from '../constants/storage-key.constants.ts';

/**
 * 统一本地存储适配器：全站持久化收敛到单一 localStorage key
 *
 * 外层 value 为按命名空间划分的对象 `{ [namespace]: value }`；
 * 本对象实现标准 Storage 接口，可同时供 pinia-plugin-persistedstate 与
 * vueuse（useDark 等）消费，写入为全量合并回写（数据量小，同步写足够）
 *
 * 首次初始化时迁移历史独立 key（whf:settings / whf:watchlist:groups /
 * whf:color-scheme / whf:dock-panel），迁移完成后移除旧 key
 */

/** 整包结构：命名空间 -> 序列化前的值 */
type AppStorageBundle = Record<string, string>;

/** 历史独立 localStorage key -> 新命名空间（一次性迁移来源与映射） */
const LEGACY_KEY_TO_NAMESPACE: readonly (readonly [string, string])[] = [
  ['whf:settings', 'settings'],
  ['whf:watchlist:groups', 'watchlist'],
  ['whf:color-scheme', 'colorScheme'],
  ['whf:dock-panel', 'dockPanel'],
];

/** 内存中的整包（读写均基于此副本，回写时序列化） */
let bundle: AppStorageBundle = {};

/** 整包回写 localStorage */
const flush = (): void => {
  try {
    localStorage.setItem(STORAGE_KEY_APP, JSON.stringify(bundle));
  } catch (error) {
    console.error('[app-storage] 写入失败', error);
  }
};

// 模块加载时初始化：优先读整包；无整包则迁移历史 key
try {
  const raw = localStorage.getItem(STORAGE_KEY_APP);
  if (raw) {
    bundle = JSON.parse(raw) as AppStorageBundle;
  } else {
    for (const [legacyKey, namespace] of LEGACY_KEY_TO_NAMESPACE) {
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue !== null) {
        bundle[namespace] = legacyValue;
        localStorage.removeItem(legacyKey);
      }
    }
    flush();
  }
} catch (error) {
  console.error('[app-storage] 初始化失败', error);
}

/**
 * 统一本地存储适配器（标准 Storage 接口子集实现）
 *
 * getItem / setItem / removeItem 以命名空间为 key 操作整包，
 * 供 pinia persist 与 vueuse useDark 等共用
 */
export const appStorage: Storage = {
  get length(): number {
    return Object.keys(bundle).length;
  },
  clear(): void {
    bundle = {};
    flush();
  },
  getItem(namespace: string): string | null {
    return bundle[namespace] ?? null;
  },
  key(index: number): string | null {
    return Object.keys(bundle)[index] ?? null;
  },
  removeItem(namespace: string): void {
    delete bundle[namespace];
    flush();
  },
  setItem(namespace: string, value: string): void {
    bundle[namespace] = value;
    flush();
  },
};
