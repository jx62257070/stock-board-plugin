/**
 * 插件 dsh-quick-note · 文案与展示常量
 *
 * 面板 / 个股详情扩展区共用的文案集中于此（项目规范：禁止散落字面量）。
 * 关联股票的挑选界面已复用全站统一的搜索弹窗（`StockSearchModal`），
 * 其内部文案不在此维护。
 */

/** 关联股票按钮文案 */
export const QUICK_NOTE_ASSOCIATE_BUTTON = '关联股票';

/** 已关联时按钮的提示（展示当前关联） */
export const QUICK_NOTE_ASSOCIATED_TITLE = '点击更换关联股票';

/** 清除关联按钮的 aria 文案 */
export const QUICK_NOTE_ASSOCIATE_CLEAR_ARIA = '清除关联股票';

/** 悬浮速记条：输入框占位文案 */
export const QUICK_NOTE_BAR_PLACEHOLDER = '给这只股票记一笔…（Enter 保存，Shift+Enter 换行）';

/** 悬浮速记条：跳转归档列表按钮文案（`{n}` 会替换成该股速记条数） */
export const QUICK_NOTE_BAR_ARCHIVE_LINK = '该股已有 {n} 条速记，点此查看 ↓';

/** 详情扩展区（归档列表）：无速记空态 */
export const QUICK_NOTE_SECTION_EMPTY = '这只股票还没有速记';

/** 悬浮速记条：保存按钮文案 */
export const QUICK_NOTE_SECTION_SAVE = '记下';

/** 删除速记的 aria 前缀（拼接股票名 / 时间由调用方处理） */
export const QUICK_NOTE_REMOVE_ARIA = '删除这条速记';
