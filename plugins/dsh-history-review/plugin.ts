/**
 * 插件 dsh-history-review（历史牛熊复盘）· 入口
 *
 * 左侧导航新增「历史牛熊复盘」页面（自行情全景「历史复盘」页签转插件分发，
 * 2026-10-30）：历史牛市 / 历史熊市轮次档案复盘 + 模式库（牛熊七轮横向对比 /
 * 可复用规律 / 预警能力对比）。行情为随插件打包的静态周 K（开发期 gen-weekly-kline.mjs
 * 一次性生成 data/weekly-kline.json，运行时零请求零存储）；页面所有数字由
 * judge.ts 纯函数回算。进行中轮次的数据推进时重跑生成脚本并重新构建。
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
import type { ReviewDeps } from './deps';
import type { PluginContext, PluginDefinition } from '../../host/types/plugin.types';

/**
 * 组装宿主能力依赖（UI 是本插件的硬依赖，缺席时直接挂载失败）
 * @param ctx 插件上下文
 * @returns 视图依赖
 */
const buildDeps = (ctx: PluginContext): ReviewDeps => {
  const ui = ctx.consume('app:ui');
  if (!ui) {
    throw new Error('宿主未提供 app:ui 服务');
  }
  return { ui };
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
    + '多因子错配画像，数字由周 K 回算）+ 模式库（牛熊七轮横向对比、可复用规律、预警能力对比）。'
    + '行情为随插件打包的静态指数周 K（带成交量），默认展示「本轮科技 AI 抱团」，零请求零存储。',
  author: '内置',
  apply: async (ctx) => {
    const deps = buildDeps(ctx);

    ctx.menu.add({
      path: HISTORY_REVIEW_MENU_PATH,
      title: HISTORY_REVIEW_MENU_TITLE,
      icon: HISTORY_REVIEW_MENU_ICON,
      component: HistoryReviewView,
      props: { deps },
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
