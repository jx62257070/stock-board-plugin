/**
 * 插件 dsh-futures-institutional（期货·机构行为）· 入口
 *
 * 左侧导航新增「机构行为」页面（沿用宿主 `/futures/institutional` 路径，宿主删自带页后由本插件接管）：
 * 中金所 CCPM 成交持仓排名（代客口径、达标 / 前 20 会员）的多空席位行为观测 ——
 * 概览指标、席位总表（行为标注：做多 / 做空 / 对冲）、多空并排柱状、席位净持仓时序、
 * 衍生榜单、移仓换月。历史数据落 `ctx.db` 两张插件表，用户点「同步历史」一次性回填（非轮询）。
 *
 * Agent 双向联动：
 * - 「AI 分析」按钮经 `app:agent-ask` 把当前口径席位数据摘要发给 Agent 分析窗口；
 * - `ctx.agent.addServer()` 贡献 `futures-ccpm` MCP 服务器（get_ccpm_summary /
 *   get_ccpm_history 两只只读工具，读本地缓存不触网）。
 */
import InstitutionalBoard from './InstitutionalBoard.vue';
import { createFuturesAgentServer } from './agent';
import { createFuturesDataApi } from './data';
import {
  FUTURES_INSTITUTIONAL_MENU_ICON,
  FUTURES_INSTITUTIONAL_MENU_PATH,
  FUTURES_INSTITUTIONAL_MENU_TITLE,
  FUTURES_INSTITUTIONAL_PLUGIN_ID,
} from './constants';
import { createFuturesRepo } from './storage';
import type { FuturesDeps, FuturesRuntime } from './types';
import type { PluginDefinition } from '../../host/types/plugin.types';

/**
 * 期货·机构行为插件定义
 */
export const futuresInstitutionalPlugin: PluginDefinition = {
  id: FUTURES_INSTITUTIONAL_PLUGIN_ID,
  name: '期货·机构行为',
  version: '1.1.0',
  description:
    '左侧导航新增「机构行为」看板：中金所 CCPM 成交持仓排名（代客口径、达标/前20会员）的多空席位行为观测 —— '
    + '概览指标、席位总表（做多/做空/对冲标注）、多空柱状、净持仓时序、移仓换月；'
    + '历史数据落本地插件库（「同步历史」一次性回填），重进页面不联网；'
    + '附 AI 分析入口与 get_ccpm_summary / get_ccpm_history 两只 Agent 只读工具。',
  author: '内置',
  apply: async (ctx) => {
    // 宿主能力一次性取齐后沿调用链注入（单文件产物形态没有 import 可用）
    const http = ctx.consume('app:http');
    const format = ctx.consume('app:format');
    const ui = ctx.consume('app:ui');
    if (!http || !format || !ui) {
      throw new Error('宿主未提供 app:http / app:format / app:ui 服务');
    }
    const deps: FuturesDeps = {
      http,
      format,
      ui,
      notify: ctx.consume('app:notify') ?? null,
      agentAsk: ctx.consume('app:agent-ask') ?? null,
    };

    // 建表 + 取数器就绪后才注册页面（页面首屏即可读库 / 回源）
    const repo = await createFuturesRepo(ctx.db);
    const data = createFuturesDataApi(repo, deps);
    const runtime: FuturesRuntime = { repo, data, deps };

    ctx.menu.add({
      path: FUTURES_INSTITUTIONAL_MENU_PATH,
      title: FUTURES_INSTITUTIONAL_MENU_TITLE,
      icon: FUTURES_INSTITUTIONAL_MENU_ICON,
      component: InstitutionalBoard,
      props: { runtime },
    });

    // Agent 只读工具：随插件挂载生效、卸载失效
    ctx.agent.addServer(createFuturesAgentServer(runtime));

    ctx.logger.info('已注册「机构行为」导航项、看板页面与 futures-ccpm MCP 服务器');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走上面的具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default futuresInstitutionalPlugin;
