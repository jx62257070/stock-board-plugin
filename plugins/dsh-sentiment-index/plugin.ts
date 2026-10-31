/**
 * 插件 dsh-sentiment-index（散户情绪指数）
 *
 * 以「板块成交额占全市场比重」为热度锚点，叠加东财小单资金拆分做散户提纯，
 * 输出 0~100 的题材热度指数与散户情绪指数；详情页价格-情绪-量能三栏联动，
 * 背离（钝化 / 衰竭）标记一眼可见。参照范式与 dsh-mainline 同构：
 * 外部数据源（全东财单源）+ 纯函数指标 + 只读看板 + ctx.db 本地累积。
 *
 * 硬口径（界面已落实）：
 * - 「散户」= 东财小单估算口径，UI 固定标注「题材情绪参考，非精确散户测量」；
 * - 占比分子分母同源（板块成交额与沪深两市成交额都取东财指数日 K）；
 * - 因子先归一化为近 250 日历史分位再加权，权重进常量并标「试验性」；
 * - 交易日 15:30 前的半日 bar 不入库（防永久污染分位序列）；
 * - 打开页面不联网，只读 ctx.db；「采集更新」用户点击触发，并发 ≤3 + 500ms 错峰。
 *
 * 数据落地：`ctx.db` 三张插件表（board_history / index_daily / scan_meta）。
 * 数据源：同花顺主源（板块清单 / 年K / 当日快照，≈500 日深度）+ 东财 fflow 小单拆分
 * 与涨停池（不可替代的两个点）+ 宿主腾讯分母；东财限流时散户因子缺席自动重分配。
 */
import SentimentBoardView from './SentimentBoardView.vue';
import {
  SENTIMENT_MENU_ICON,
  SENTIMENT_MENU_PATH,
  SENTIMENT_MENU_TITLE,
  SENTIMENT_PLUGIN_ID,
} from './constants';
import { createSentimentRepo } from './storage';
import type { SentimentDeps } from './types';
import type { PluginDefinition } from '../../host/types/plugin.types';

/**
 * 散户情绪指数插件定义
 */
export const sentimentPlugin: PluginDefinition = {
  id: SENTIMENT_PLUGIN_ID,
  name: SENTIMENT_MENU_TITLE,
  version: '1.1.0',
  description:
    '题材热度 + 散户情绪双指数看板：板块成交额占全市场比重为热度锚点，东财小单资金拆分做散户提纯，'
    + '输出 0~100 双指数；价格-情绪-量能同图对照，背离标记一眼可见。打开页面不联网，采集更新用户点击触发。',
  author: '内置',
  // 2026-10-30 王总指定：PC + 移动端双端可用（组件按容器断点自适应三档形态）
  // 1.1.0 混合源改造：同花顺主源（清单/日K/快照）+ 东财仅 fflow 小单与池子
  devices: ['pc', 'mobile'],
  apply: async (ctx) => {
    // 宿主能力一次性取齐后沿调用链注入 —— 单文件产物形态下没有 import 可用，
    // 所有宿主依赖只能从 ctx 上来（`SentimentDeps` 就是这条依赖链的显式声明）
    const http = ctx.consume('app:http');
    const format = ctx.consume('app:format');
    const market = ctx.consume('app:market');
    const ui = ctx.consume('app:ui');
    const notify = ctx.consume('app:notify') ?? undefined;
    if (!http || !format || !market || !ui) {
      throw new Error('宿主未提供 app:http / app:format / app:market / app:ui 服务');
    }
    const deps: SentimentDeps = { http, format, market, ui, notify };

    // 建表 + 水合快照完成后才注册页面（页面首屏即可直接读库渲染，不联网）
    const repo = await createSentimentRepo(ctx.db);

    // 能力对外公开：其他插件 consume('sentiment:repo') 即可读同一份快照
    ctx.provide('sentiment:repo', repo);

    ctx.menu.add({
      path: SENTIMENT_MENU_PATH,
      title: SENTIMENT_MENU_TITLE,
      icon: SENTIMENT_MENU_ICON,
      component: SentimentBoardView,
      props: { repo, deps },
      fallbackLanding: true,
    });

    ctx.logger.info('已注册「散户情绪指数」导航项与看板页面');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 同一个定义同时满足两条链路。
 */
export default sentimentPlugin;
