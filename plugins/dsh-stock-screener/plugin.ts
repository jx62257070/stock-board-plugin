/**
 * 插件 dsh-stock-screener（选股器）
 *
 * 左侧导航新增「选股器」页面（自宿主内置页迁移，路径沿用 /screener）：
 * - 基础筛选：全市场快照条件筛选（涨幅/换手/量比/PE）+ MA5/20 金叉死叉回测；
 * - 信号扫描：股票池（自选/板块/榜单/涨停强势池/盘口异动）× 八种技术信号模板；
 * - 尾盘选股：全市场快照基础过滤 + 分时强度精筛。
 *
 * 取数走宿主 `app:http` 通道（SDK fetchImpl 注入），重接口全部用户点击触发；
 * 日 K 走新浪源 + 会话内缓存（首次取满、之后只补尾部缺口）。
 * 另向 Agent 贡献 run_backtest 工具（宿主内置版同名工具随本插件迁移）。
 */
import ScreenerView from './ScreenerView.vue';
import { createScreenerAgentServer } from './agent';
import {
  SCREENER_MENU_ICON,
  SCREENER_MENU_PATH,
  SCREENER_MENU_TITLE,
  SCREENER_PLUGIN_ID,
  SCREENER_PLUGIN_NAME,
  SCREENER_PLUGIN_VERSION,
} from './constants';
import { createKlineCache } from './kline';
import { createScreenerSdk } from './sdk';
import type { PluginDefinition } from '../../host/types/plugin.types';
import type { ScreenerDeps, ScreenerRuntime } from './types';

/**
 * 选股器插件定义
 */
export const stockScreenerPlugin: PluginDefinition = {
  id: SCREENER_PLUGIN_ID,
  name: SCREENER_PLUGIN_NAME,
  version: SCREENER_PLUGIN_VERSION,
  description:
    '左侧导航新增「选股器」页面：基础筛选（条件筛选 + MA 金叉回测）、信号扫描（股票池 × MA/MACD/RSI/BOLL 信号模板）、尾盘选股（市值/量比/涨幅/换手过滤 + 分时强度精筛）；重接口全部用户点击触发，并为 Agent 贡献单票回测工具。',
  author: '内置',
  apply: async (ctx) => {
    // 宿主能力一次性取齐后沿调用链注入 —— 单文件产物形态下没有 import 可用，
    // 所有宿主依赖只能从 ctx 上来（`ScreenerDeps` 就是这条依赖链的显式声明）
    const http = ctx.consume('app:http');
    const format = ctx.consume('app:format');
    const ui = ctx.consume('app:ui');
    const stockOpen = ctx.consume('app:stock-open');
    const watchlist = ctx.consume('app:watchlist');
    if (!http || !format || !ui || !stockOpen || !watchlist) {
      throw new Error('宿主未提供 app:http / app:format / app:ui / app:stock-open / app:watchlist 服务');
    }
    const deps: ScreenerDeps = { format, ui, stockOpen, watchlist };

    // 取数运行时：SDK 单例（fetchImpl 走宿主通道）+ 日 K 会话缓存，页面与 Agent 工具共用
    const runtime: ScreenerRuntime = {
      sdk: createScreenerSdk(http),
      fetchDailyKline: createKlineCache(http).fetch,
    };

    // Agent 工具：run_backtest（自宿主 stock-sdk 服务器的同名工具迁移而来）
    ctx.agent.addServer(createScreenerAgentServer(runtime, deps));

    ctx.menu.add({
      path: SCREENER_MENU_PATH,
      title: SCREENER_MENU_TITLE,
      icon: SCREENER_MENU_ICON,
      component: ScreenerView,
      props: { deps, runtime },
      // 本页随插件被停用 / 卸载时，作为「兜底落点」的候选声明
      fallbackLanding: true,
    });

    ctx.logger.info('已注册「选股器」导航项与页面，并贡献 Agent 回测工具');
  },
};

/**
 * 打包用的默认导出
 *
 * 产物包的安装链路读的是模块的默认导出（`mod.default ?? mod.plugin`）——
 * 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default stockScreenerPlugin;
