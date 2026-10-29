/**
 * 插件 dsh-history-review（历史牛熊复盘）· 入口
 *
 * 左侧导航新增「历史牛熊复盘」页面（自行情全景「历史复盘」页签转插件分发，
 * 2026-10-30）：历史牛市 / 历史熊市轮次档案复盘 + 模式库（牛熊七轮横向对比 /
 * 可复用规律 / 预警能力对比）。数据为新浪月 K（app:http 通道，首次进入自动
 * 全量同步，串行 500ms 错峰）落 `ctx.storage` 快照，重进页面零联网；页面所有
 * 数字由 judge.ts 纯函数回算。
 */
import HistoryReviewView from './components/HistoryReviewView.vue';
import {
  HISTORY_REVIEW_MENU_ICON,
  HISTORY_REVIEW_MENU_PATH,
  HISTORY_REVIEW_MENU_TITLE,
  HISTORY_REVIEW_PLUGIN_ID,
  HISTORY_REVIEW_PLUGIN_NAME,
  HISTORY_REVIEW_PLUGIN_VERSION,
} from './constants';
import type { ReviewDeps, ReviewRuntime } from './deps';
import { fetchAllIndexMonthlies } from './history-data';
import { createIndexMonthlyFetcher } from './sina-kline';
import { createReviewRepo } from './storage';
import type { PluginContext, PluginDefinition } from '../../host/types/plugin.types';

/**
 * 组装宿主能力依赖（服务缺席时直接挂载失败：UI 与网络是本插件的硬依赖）
 * @param ctx 插件上下文
 * @returns 视图依赖与运行时
 */
const buildDeps = (
  ctx: PluginContext,
): { deps: ReviewDeps; runtime: ReviewRuntime } => {
  const ui = ctx.consume('app:ui');
  if (!ui) {
    throw new Error('宿主未提供 app:ui 服务');
  }
  const http = ctx.consume('app:http');
  if (!http) {
    throw new Error('宿主未提供 app:http 服务');
  }
  return {
    deps: { ui },
    runtime: {
      repo: createReviewRepo(ctx.storage),
      fetchAllMonthlies: (onStep) => fetchAllIndexMonthlies(createIndexMonthlyFetcher(http), onStep),
      storage: ctx.storage,
    },
  };
};

/**
 * 历史牛熊复盘插件定义
 */
export const historyReviewPlugin: PluginDefinition = {
  id: HISTORY_REVIEW_PLUGIN_ID,
  name: HISTORY_REVIEW_PLUGIN_NAME,
  version: HISTORY_REVIEW_PLUGIN_VERSION,
  description:
    '左侧导航新增「历史牛熊复盘」页面：历史牛市 / 历史熊市轮次档案复盘（阶段拆解 / 事件时间线 / '
    + '多因子错配画像，数字由月 K 回算）+ 模式库（牛熊七轮横向对比、可复用规律、预警能力对比）。'
    + '首次进入自动同步新浪指数月 K 落本地快照，此后零联网。',
  author: '内置',
  apply: async (ctx) => {
    const { deps, runtime } = buildDeps(ctx);

    ctx.menu.add({
      path: HISTORY_REVIEW_MENU_PATH,
      title: HISTORY_REVIEW_MENU_TITLE,
      icon: HISTORY_REVIEW_MENU_ICON,
      component: HistoryReviewView,
      props: { deps, runtime },
      // 本页随插件被停用 / 卸载时，作为「兜底落点」的候选声明
      fallbackLanding: true,
    });

    ctx.logger.info('已注册「历史牛熊复盘」导航项与页面');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走上面的具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default historyReviewPlugin;
