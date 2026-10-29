/**
 * 快照类型支撑（非 sync-host-contract 闭包成员，勿删）
 *
 * 宿主 main.ts 里 `pinia.use(piniaPluginPersistedstate)` 的副作用 import 负责把
 * persist 选项的类型扩展注入整个编译单元；契约快照不含 main.ts，这里补同款
 * import，使 host/stores/tab-config.ts 的 `persist: { key, storage }` 类型成立。
 */
import 'pinia-plugin-persistedstate';
