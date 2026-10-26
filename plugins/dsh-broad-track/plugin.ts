/**
 * 插件 dsh-broad-track（宽基跟踪）· 入口
 *
 * 左侧导航新增「宽基跟踪」页面：跟踪宽基 ETF 的流入流出（日频资金流 + 季频份额申赎），
 * 预估国家队持仓与操作。数据落地 `ctx.db` 四张插件表，读库即渲染、零联网；
 * 重接口只在用户点击「刷新日频 / 同步季度」时触发。
 */
import BroadTrackView from './BroadTrackView.vue';
import {
  BROAD_MENU_ICON,
  BROAD_MENU_PATH,
  BROAD_MENU_TITLE,
  BROAD_PLUGIN_ID,
  NATIONAL_TEAM_OF_INST_RATIO,
} from './constants';
import { createBroadRepo } from './storage';
import type { BroadRepo } from './storage';
import type { PluginDefinition } from '../../host/types/plugin.types';
import type { BroadDeps } from './types';

/**
 * 宽基跟踪插件定义
 */
export const broadTrackPlugin: PluginDefinition = {
  id: BROAD_PLUGIN_ID,
  name: '宽基跟踪',
  version: '1.1.2',
  description:
    '左侧导航新增「宽基跟踪」看板：跟踪宽基 ETF 的流入流出（日频主力资金流 + 季频份额申赎 + 半年频持有人结构），'
    + '以披露锚点 + 净申购分摊预估国家队持仓，按「大跌 + 资金流入 + 成交异动」等形态推定其操作；'
    + '结果落本地插件库，重进页面不联网。',
  author: '内置',
  settings: {
    title: '宽基跟踪设置',
    description: '国家队在宽基 ETF 机构持仓中的占比（持仓预估模型的分摊系数）。',
    fields: [
      {
        key: 'national_share',
        label: '国家队占机构持仓比例',
        type: 'number',
        default: NATIONAL_TEAM_OF_INST_RATIO,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          '宽基 ETF 的机构持有人里，汇金 / 证金 / 梧桐树 / 国新等国家队占绝对大头，其余是险资 / 券商自营 / 联接基金等；0.8 是兼顾口径透明的粗估，可按定期报告披露校正。',
      },
    ],
  },
  apply: async (ctx) => {
    // 宿主能力一次性取齐后沿调用链注入 —— 单文件产物形态下没有 import 可用，
    // 所有宿主依赖只能从 ctx 上来（`BroadDeps` 就是这条依赖链的显式声明）
    const http = ctx.consume('app:http');
    const format = ctx.consume('app:format');
    const ui = ctx.consume('app:ui');
    if (!http || !format || !ui) {
      throw new Error('宿主未提供 app:http / app:format / app:ui 服务');
    }
    const deps: BroadDeps = { http, format, ui };

    // 建表 + 水合快照完成后才注册页面（页面首屏即可直接读库渲染）
    const repo = await createBroadRepo(ctx.db);

    // 能力对外公开：其他插件 consume('broad:repo') 即可读同一份快照
    ctx.provide('broad:repo', repo);

    ctx.menu.add({
      path: BROAD_MENU_PATH,
      title: BROAD_MENU_TITLE,
      icon: BROAD_MENU_ICON,
      component: BroadTrackView,
      props: { repo, deps, settings: ctx.settings },
    });

    ctx.logger.info('已注册「宽基跟踪」导航项与看板页面');
  },
};

/**
 * 打包用的默认导出
 *
 * 内置挂载走上面的具名导出，而**产物包**的安装链路读的是模块的默认导出
 * （`mod.default ?? mod.plugin`）—— 这里补一个 default，同一个定义就能同时满足两条链路。
 */
export default broadTrackPlugin;

declare module '../../host/types/plugin.types' {
  /** 本插件对外贡献的服务 */
  interface AppServiceMap {
    /** 宽基跟踪快照仓储（读快照渲染整页，不联网；由 dsh-broad-track 提供） */
    'broad:repo': BroadRepo;
  }
}
