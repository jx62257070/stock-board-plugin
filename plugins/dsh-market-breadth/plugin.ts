/**
 * 插件 dsh-market-breadth（市场宽度）· 入口
 *
 * 左侧导航新增「市场宽度」页面（自宿主内置页迁移，路径沿用 /market-breadth）：
 * 当日概览（涨跌家数 / ARMS / 活跃占比）+ 六大广度指标副图（ADL / ADR / OBOS /
 * ARMS / MCO / 活跃占比）。数据落 `ctx.db` 两张插件表（分钟点 / 日 bar），
 * 页面挂载期间轻轮询全市场快照做当日积累；「总结」可选已采集日期，「刷新」
 * 重取选中日期；另向 Agent 贡献两个只读工具（get_breadth_snapshot /
 * get_breadth_history）。
 */
import BreadthView from './BreadthView.vue';
import { createBreadthAgentServer } from './agent';
import {
  BREADTH_MENU_ICON,
  BREADTH_MENU_PATH,
  BREADTH_MENU_TITLE,
  BREADTH_PLUGIN_ID,
  BREADTH_PLUGIN_NAME,
  BREADTH_PLUGIN_VERSION,
} from './constants';
import { createBreadthSdk, createFullMarketFetcher } from './sdk';
import { createBreadthRepo } from './storage';
import type { PluginContext, PluginDefinition } from '../../host/types/plugin.types';
import type { BreadthDeps, BreadthRuntime } from './types';

/**
 * 组装宿主能力依赖（服务缺席时降级而不是挂载失败：
 * agentAsk 缺席只影响「AI 分析」按钮；盘中判定缺席退化为「始终轮询」）
 * @param ctx 插件上下文
 * @returns 宿主能力依赖
 */
const buildDeps = (ctx: PluginContext): BreadthDeps => {
  const agentAsk = ctx.consume('app:agent-ask') ?? null;
  const marketStatus = ctx.consume('app:market-status') ?? null;
  const ui = ctx.consume('app:ui');
  if (!ui) {
    throw new Error('宿主未提供 app:ui 服务');
  }
  return {
    agentAsk,
    isIntraday: () => marketStatus?.isIntraday.value ?? true,
    ui,
  };
};

/**
 * 市场宽度插件定义
 */
export const marketBreadthPlugin: PluginDefinition = {
  id: BREADTH_PLUGIN_ID,
  name: BREADTH_PLUGIN_NAME,
  version: BREADTH_PLUGIN_VERSION,
  description:
    '左侧导航新增「市场宽度」页面：当日概览（涨跌家数 / ARMS 现值 / 活跃占比）与六大市场广度指标副图'
    + '（ADL / ADR / OBOS / ARMS / MCO / 活跃占比，口径对齐通达信）。历史无免费上游源，'
    + '由本页在盘中逐日拉取全市场快照本地积累（收盘定稿为日 bar，落 ctx.db），'
    + '附「总结」（可选已采集日期）、「刷新」与「AI 分析」，并为 Agent 贡献宽度快照与历史序列两个只读工具。',
  author: '内置',
  apply: async (ctx) => {
    const deps = buildDeps(ctx);
    const http = ctx.consume('app:http');
    if (!http) {
      throw new Error('宿主未提供 app:http 服务');
    }

    // 建表 + 水合完成后才注册页面（页面首屏直接读库渲染，不联网）
    const repo = await createBreadthRepo(ctx.db);

    // 取数运行时：SDK 单例（fetchImpl 走宿主通道 + 东财镜像域改道），页面与 Agent 工具共用
    const runtime: BreadthRuntime = {
      fetchAllQuotes: createFullMarketFetcher(createBreadthSdk(http)),
    };

    // Agent 工具：get_breadth_snapshot / get_breadth_history（只读）
    ctx.agent.addServer(createBreadthAgentServer(repo, runtime));

    ctx.menu.add({
      path: BREADTH_MENU_PATH,
      title: BREADTH_MENU_TITLE,
      icon: BREADTH_MENU_ICON,
      component: BreadthView,
      props: { repo, runtime, deps },
      // 本页随插件被停用 / 卸载时，作为「兜底落点」的候选声明
      fallbackLanding: true,
    });

    ctx.logger.info('已注册「市场宽度」导航项与页面，并贡献 Agent 宽度数据工具');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走上面的具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default marketBreadthPlugin;
