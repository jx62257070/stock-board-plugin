/**
 * 东财镜像域改道（自宿主 `api/eastmoney-reroute.ts` 移植，2026-09-18 实测口径）
 *
 * 背景：本机出口对 push2 系域名连通性反复变化，而 stock-sdk 的东财地址是
 * 硬编码常量，只能在 fetchImpl 收口处按路径改写。只对「push2delay 确实提供
 * 同构响应」的路径做域替换，其余原样透传，避免把「硬失败」静默变成「空数据」。
 *
 * ⚠️ `/api/qt/stock/fflow/`（资金流历史）不在清单内：push2delay 上只回当日 1 条，
 * 放进来只会退化成 1 天数据而不报错。
 */

/** 东财行情域（含数字镜像前缀，如 91.push2 / 33.push2his） */
const EASTMONEY_QUOTE_HOST = /^https?:\/\/(?:[0-9]+\.)?push2(?:his)?\.eastmoney\.com/i;

/** 改道目标域（SDK 镜像域之一，实测连通性最稳） */
const REROUTE_HOST = 'https://push2delay.eastmoney.com';

/** push2delay 确认「同参数同响应结构」的路径前缀（其余路径一律不做改道） */
const REROUTE_PATHS = [
  '/api/qt/clist/get',
  '/api/qt/ulist.np/get',
  '/api/qt/stock/get',
  '/api/qt/stock/trends2/get',
] as const;

/**
 * 把东财行情域上的可替代请求改写到 push2delay（参数与路径原样保留）
 *
 * 非目标域 / 非可替代路径一律原样返回，调用方无需分支。
 * @param url 上游请求地址
 * @returns 改道后的地址（无需改道时与原值相同）
 */
export const rerouteEastmoneyHost = (url: string): string => {
  if (!EASTMONEY_QUOTE_HOST.test(url)) {
    return url;
  }
  if (!REROUTE_PATHS.some((path) => url.includes(path))) {
    return url;
  }
  return url.replace(EASTMONEY_QUOTE_HOST, REROUTE_HOST);
};
