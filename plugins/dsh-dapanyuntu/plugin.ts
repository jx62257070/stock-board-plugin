/**
 * 插件 dsh-dapanyuntu（大盘云图）· 入口
 *
 * 注册隐藏路由页面（自宿主内置页迁移，路径沿用 /heatmap，2026-10-29 转插件分发）：
 * dapanyuntu.com 第三方云图 iframe 直嵌 + 明暗主题 postMessage 跟随 + 「访问原站」外链。
 * 无数据层、无持久化——宿主 Rust 侧 HEATMAP_THEME_INIT_SCRIPT 按域名注入、
 * 不感知页面承载者，插件页照常生效；未安装本插件时宿主入口落到 404 兜底页。
 *
 * 入口不变：市场总览页头「大盘云图」按钮与「板块热力」卡标题（宿主 ROUTE_PATH.HEATMAP）。
 */
import DapanyuntuView from './DapanyuntuView.vue';
import {
  DAPANYUNTU_PAGE_TITLE,
  DAPANYUNTU_PLUGIN_ID,
  DAPANYUNTU_PLUGIN_NAME,
  DAPANYUNTU_PLUGIN_VERSION,
  DAPANYUNTU_ROUTE_PATH,
} from './constants';
import type { PluginContext, PluginDefinition } from '../../host/types/plugin.types';
import type { DapanyuntuDeps } from './types';

/**
 * 组装宿主能力依赖（全部允许缺席降级：
 * 主题服务缺席退化为系统 prefers-color-scheme；外链服务缺席隐藏「访问原站」按钮）
 * @param ctx 插件上下文
 * @returns 宿主能力依赖
 */
const buildDeps = (ctx: PluginContext): DapanyuntuDeps => {
  const theme = ctx.consume('app:theme');
  const openExternal = ctx.consume('app:open-url') ?? null;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  return {
    isDark: theme ? () => theme.isDark.value : () => systemDark.matches,
    openExternal,
  };
};

/**
 * 大盘云图插件定义
 */
export const dapanyuntuPlugin: PluginDefinition = {
  id: DAPANYUNTU_PLUGIN_ID,
  name: DAPANYUNTU_PLUGIN_NAME,
  version: DAPANYUNTU_PLUGIN_VERSION,
  description:
    '注册「大盘云图」整页（市场总览页头按钮进入，路径 /heatmap）：第三方站点 dapanyuntu.com 的'
    + ' A 股板块 / 个股树图直嵌展示，数据与交互均由原站提供；桌面端明暗主题自动跟随'
    + '（依赖宿主注入脚本），并提供「访问原站」入口。无本地数据，卸载即干净移除。',
  author: '内置',
  apply: (ctx) => {
    const deps = buildDeps(ctx);

    ctx.router.add({
      path: DAPANYUNTU_ROUTE_PATH,
      component: DapanyuntuView,
      props: { deps },
      meta: { title: DAPANYUNTU_PAGE_TITLE },
    });

    ctx.logger.info('已注册「大盘云图」页面路由（/heatmap，主题跟随 + 原站外链）');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走上面的具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default dapanyuntuPlugin;
