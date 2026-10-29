/**
 * 插件 dsh-dapanyuntu（大盘云图）· 类型
 */

/**
 * 宿主能力依赖（插件 apply 时组装，视图经 props 拿到）
 *
 * 全部允许缺席降级：主题服务缺席退化为系统偏好；外链服务缺席隐藏「访问原站」按钮。
 */
export interface DapanyuntuDeps {
  /** 当前是否暗色（宿主 `app:theme` 的 isDark 快照；缺席时按系统 prefers-color-scheme） */
  isDark: () => boolean;
  /** 系统默认浏览器打开外部链接（宿主 `app:open-url`；缺席为 null） */
  openExternal: ((url: string) => void) | null;
}
