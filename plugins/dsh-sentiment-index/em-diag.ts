/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 东财通道自检
 *
 * 背景（2026-11-06 王总反馈「东财接口一次都没成功过」）：发布版宿主未启用 devtools
 * feature（Cargo.toml 只有 tray-icon），em-bridge / scan 的 console 诊断**不可见** ——
 * 自检把链路拆成三段，各打一发真实轻量请求（fflow lmt=1 / clist pz=3，不动采集状态
 * 与落库），结果返回给页面渲染而不是写 console，让「哪一环断了」在产品内可读：
 * ① 桥就绪：iframe 创建 + 宿主注入脚本在东财页内执行 + ready 回传；
 * ② 桥内 JSONP ×2（push2his fflow 散户因子历史通道 / push2 clist 四档快照自积累通道）；
 * ③ app:http 直连（reqwest 指纹）：被 WAF 拒是已知行为，通过反而说明口径放宽。
 *
 * 本文件只做诊断编排，解析零逻辑 —— 结果是「给王总看的」，detail 直接写人话。
 */
import {
  EM_CLIST_FUND_URL_TEMPLATE,
  EM_FS_INDUSTRY,
  EM_FFLOW_URL_TEMPLATE,
  EM_REFERER,
} from './constants';
import { ensureEmBridgeWithDetail, fetchEmBridgeText, getEmBridgeDiagnostic } from './em-bridge';
import type { SentimentDeps } from './types';

/** 自检单步结果 */
export interface EmDiagStep {
  /** 步骤名 */
  label: string;
  /** true 通过 / false 失败 / null 跳过（前置步骤未过） */
  ok: boolean | null;
  /** 耗时（毫秒；跳过为 0） */
  elapsedMs: number;
  /** 可读结论（人话，不写行号） */
  detail: string;
}

/** 自检整体结果 */
export interface EmDiagResult {
  steps: readonly EmDiagStep[];
  /** 一句话结论（哪一环断了 / 全通） */
  summary: string;
}

/** 自检探测用的板块 secid（半导体 BK1036，与 fflow 前置探测同款） */
const DIAG_BOARD_SECID = '90.BK1036';

/** fflow 自检 URL（lmt=0 全量口径换成 lmt=1 轻量）
 * @returns 自检用 fflow URL
 */
const fflowDiagUrl = (): string =>
  EM_FFLOW_URL_TEMPLATE.replace('{secid}', encodeURIComponent(DIAG_BOARD_SECID)).replace(
    'lmt=0',
    'lmt=1',
  );

/** clist 四档快照自检 URL（只取 3 行行业板块）
 * @returns 自检用 clist URL
 */
const clistDiagUrl = (): string =>
  EM_CLIST_FUND_URL_TEMPLATE.replace('{pn}', '1').replace('{pz}', '3').replace('{fs}', EM_FS_INDUSTRY);

/**
 * 桥内 JSONP 实测一步（成功判定 = 回传非空文本）
 * @param label 步骤名
 * @param url 目标地址
 * @returns 步骤结果
 */
const bridgeJsonpStep = async (label: string, url: string): Promise<EmDiagStep> => {
  const startedAt = Date.now();
  const text = await fetchEmBridgeText(url);
  const elapsedMs = Date.now() - startedAt;
  const ok = text !== null && text.length > 0;
  return {
    label,
    ok,
    elapsedMs,
    detail: ok
      ? `返回 ${text.length} 字节，通道可用`
      : `失败：${getEmBridgeDiagnostic() || '空响应'}`,
  };
};

/**
 * 运行东财通道自检（真实轻量请求 ×3~4；只读诊断，不动任何采集状态）
 * @param deps 宿主能力集合
 * @returns 自检结果（含每步耗时与一句话结论）
 */
export const runEmChannelSelfTest = async (deps: SentimentDeps): Promise<EmDiagResult> => {
  const steps: EmDiagStep[] = [];

  // ① 桥就绪
  const bridge = await ensureEmBridgeWithDetail();
  steps.push({
    label: '① 桥就绪（iframe + 宿主注入脚本）',
    ok: bridge.ok,
    elapsedMs: bridge.elapsedMs,
    detail: bridge.ok
      ? '宿主注入脚本在东财 iframe 内执行，ready 正常回传'
      : bridge.loadFired
        ? 'iframe 已加载但未收到 ready —— 宿主未注入桥脚本（<4.32.0？）或脚本在页面内未执行'
        : 'iframe 未触发 load —— 东财页面加载被拦或网络不可达',
  });

  // ② 桥内 JSONP：push2his fflow（散户因子历史通道）
  const fflowUrl = fflowDiagUrl();
  steps.push(
    bridge.ok
      ? await bridgeJsonpStep('② 桥内 JSONP（push2his fflow 历史）', fflowUrl)
      : { label: '② 桥内 JSONP（push2his fflow 历史）', ok: null, elapsedMs: 0, detail: '桥未就绪，跳过' },
  );

  // ③ app:http 直连（reqwest 指纹回退通道）：被拒是已知行为（WAF 拦非浏览器指纹）
  {
    const startedAt = Date.now();
    try {
      const response = await deps.http.fetch(fflowUrl, { headers: { Referer: EM_REFERER } });
      const elapsedMs = Date.now() - startedAt;
      const bytes = response.ok ? (await response.text()).length : 0;
      steps.push({
        label: '③ app:http 直连（reqwest 回退）',
        ok: response.ok,
        elapsedMs,
        detail: response.ok
          ? `HTTP 200 返回 ${bytes} 字节 —— WAF 未拦 reqwest，回退通道当前可用`
          : `HTTP ${response.status} —— 回退通道不可用`,
      });
    } catch (error) {
      steps.push({
        label: '③ app:http 直连（reqwest 回退）',
        ok: false,
        elapsedMs: Date.now() - startedAt,
        detail: `连接层被拒：${error instanceof Error ? error.message : String(error)}（WAF 拦 reqwest 指纹，已知行为）`,
      });
    }
  }

  // ④ 桥内 JSONP：push2 clist 四档快照（散户因子自积累通道）
  steps.push(
    bridge.ok
      ? await bridgeJsonpStep('④ 桥内 JSONP（push2 四档快照）', clistDiagUrl())
      : { label: '④ 桥内 JSONP（push2 四档快照）', ok: null, elapsedMs: 0, detail: '桥未就绪，跳过' },
  );

  const jsonpSteps = [steps[1], steps[3]];
  let summary: string;
  if (bridge.ok === false) {
    summary =
      '结论：桥未就绪 —— 东财请求全部回退 app:http（大概率被 WAF 拒连），采集期东财数据全缺席。'
      + '宿主注入链路断了，请把本结果发给开发定位。';
  } else if (jsonpSteps.every((step) => step.ok === true)) {
    summary =
      '结论：桥链路全通 —— 散户因子两条通道都可用。若采集仍缺席东财数据，问题在采集编排，'
      + '请把本结果发给开发确认。';
  } else if (jsonpSteps.some((step) => step.ok === true)) {
    summary =
      '结论：桥部分可用 —— 一条通道正常一条失败，散户因子仍可逐日累积（缺席自动重分配）。'
      + '请把本结果发给开发确认。';
  } else {
    summary =
      '结论：桥就绪但 JSONP 全部失败 —— iframe 内请求被拦或上游拒绝。请把本结果发给开发定位。';
  }
  return { steps, summary };
};
