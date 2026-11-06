/**
 * 插件 dsh-sentiment-index（散户情绪指数）· 东财 JSONP 桥传输层
 *
 * 背景（2026-10-31 实测）：东财 push2 系 WAF 按「浏览器 TLS 指纹 + 东财域 Referer」
 * 双条件放行 —— 宿主 `app:http`（Rust reqwest）的指纹被连接层拒连，直接打
 * push2his / push2 / push2delay 全灭；而 WebView（Chromium 指纹）内、以
 * eastmoney.com 页面为 Referer 的 JSONP 请求畅通。宿主 4.32.0 起向东财域注入桥
 * 脚本（`EM_JSONP_BRIDGE_INIT_SCRIPT`，协议见宿主 PLUGIN_API.md §5.5.1；信源常量
 * 与 Rust 侧严格同步）：本层懒创建一个隐藏 iframe 加载东财轻量页，桥在该页面内
 * 代发 `<script cb=…>` JSONP 并 postMessage 回传 —— 回传 text 是 payload 的 JSON
 * 字符串，与 http 通道的 `response.text()` 完全同构，**解析层零改动**。
 *
 * 生命周期：懒创建（首次请求时），空闲 `EM_BRIDGE_IDLE_MS` 自动拆除（THS 段等
 * 非桥请求的间隙不会误拆——超时远大于段内间隔；期间新请求自动重建，建不起来即
 * 回退 `app:http`）。扫描结束无需显式清理；`disposeEmBridge()` 保留给需要立即
 * 回收的场景（并发拆除也安全：在途请求回退、后续自动重建，不会崩）。
 */
import {
  EM_BRIDGE_IDLE_MS,
  EM_BRIDGE_IFRAME_TITLE,
  EM_BRIDGE_IFRAME_URL,
  EM_BRIDGE_READY_TIMEOUT_MS,
  EM_BRIDGE_ROUTE_HOSTS,
  EM_BRIDGE_SOURCE,
  EM_JSONP_TIMEOUT_MS,
  SENTIMENT_PLUGIN_ID,
} from './constants';

/** 桥在途请求的 pending 表项 */
interface BridgePending {
  /** 成功回传（text = payload 的 JSON 字符串） */
  resolve: (text: string) => void;
  /** 超时 / 桥回传失败 / 被拆除 */
  reject: (error: Error) => void;
  /** 单请求超时定时器句柄 */
  timer: ReturnType<typeof setTimeout>;
}

/** 隐藏 iframe（懒创建后常驻到 dispose） */
let activeIframe: HTMLIFrameElement | null = null;
/** 与 iframe 生命周期一致的全局 message 监听（拆除时移除） */
let activeHandler: ((event: MessageEvent) => void) | null = null;
/** 桥是否已就绪（收到 em-bridge-ready） */
let ready = false;
/** ensure 的进行中 Promise（防并发重复建桥） */
let ensuring: Promise<boolean> | null = null;
/** 请求序号（桥内 id） */
let seq = 0;
/** 在途请求表（id → pending） */
const pending = new Map<string, BridgePending>();

/** 最近一次桥诊断事件（空串 = 桥工作正常；采集结果透出用，扫描开始时重置） */
let lastDiagnostic = '';

/** 桥空闲自动拆除定时器（每次桥活动重置） */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** 重置空闲拆除倒计时（每次建桥 / 每次请求都算活动） */
const bumpIdleTimer = (): void => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => disposeEmBridge(), EM_BRIDGE_IDLE_MS);
};

/**
 * 读取最近一次桥诊断事件（空串 = 桥全程正常）
 * @returns 诊断文本
 */
export const getEmBridgeDiagnostic = (): string => lastDiagnostic;

/** 重置桥诊断（每轮采集开始时调用，避免读到上轮的陈旧信息） */
export const resetEmBridgeDiagnostic = (): void => {
  lastDiagnostic = '';
};

/**
 * 判断一个 URL 是否应走桥通道（东财行情域三兄弟；push2ex 池子不在其列）
 * @param url 目标地址
 * @returns 是否桥通道
 */
export const isEmBridgeUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return EM_BRIDGE_ROUTE_HOSTS.includes(host);
  } catch {
    return false;
  }
};

/**
 * 拆除桥：移除 iframe 与监听、拒绝在途请求（拒绝信息会被调用方当作
 * 「桥失败」回退 http，不外抛）
 */
export const disposeEmBridge = (): void => {
  ready = false;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (activeHandler) {
    window.removeEventListener('message', activeHandler);
    activeHandler = null;
  }
  if (activeIframe) {
    activeIframe.remove();
    activeIframe = null;
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('东财 JSONP 桥已拆除（在途请求作废，回退 app:http）'));
  }
  pending.clear();
  ensuring = null;
};

/**
 * 全局 message 处理（只认当前 iframe 的 source + 信源常量，其余一律忽略）
 * @param event 浏览器 message 事件
 */
const handleMessage = (event: MessageEvent): void => {
  if (!activeIframe || event.source !== activeIframe.contentWindow) return;
  const data = event.data as
    | { source?: unknown; type?: unknown; id?: unknown; ok?: unknown; text?: unknown; error?: unknown }
    | null;
  if (!data || data.source !== EM_BRIDGE_SOURCE) return;
  if (data.type === 'em-bridge-ready') {
    ready = true;
    return;
  }
  if (data.type !== 'em-jsonp-result') return;
  const id = typeof data.id === 'string' ? data.id : '';
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (data.ok === true && typeof data.text === 'string') {
    entry.resolve(data.text);
  } else {
    entry.reject(new Error(typeof data.error === 'string' && data.error ? data.error : '东财桥请求失败'));
  }
};

/**
 * 确保桥就绪（懒创建；进行中的创建过程全局共享，不会重复建桥）
 * @returns 是否就绪（false = 宿主未注入 / 等待超时，调用方回退 http）
 */
const ensureEmBridge = async (): Promise<boolean> => {
  if (ready && activeIframe) return true;
  if (ensuring) return ensuring;
  ensuring = new Promise<boolean>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.src = EM_BRIDGE_IFRAME_URL;
    iframe.title = EM_BRIDGE_IFRAME_TITLE;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    // 0×0 绝对定位而非 display:none：两者都能触发加载，前者在个别内核上更稳
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.position = 'absolute';
    const timer = setTimeout(() => {
      // 宿主未注入时不会有 ready：超时清场并判不可用（可诊断性日志——devtools 可见）
      console.warn(
        `[plugin] ${SENTIMENT_PLUGIN_ID} 东财桥就绪超时（${EM_BRIDGE_READY_TIMEOUT_MS}ms）：`
        + '宿主未注入桥脚本（<4.32.0？）或 iframe 文档加载失败，本轮东财请求回退 app:http',
      );
      disposeEmBridge();
      resolve(false);
    }, EM_BRIDGE_READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const wasReady = ready;
      handleMessage(event);
      if (!wasReady && ready) {
        clearTimeout(timer);
        bumpIdleTimer();
        resolve(true);
      }
    };
    // 诊断：iframe 文档加载完成却迟迟无 ready ≈ 宿主没注入桥脚本（版本过旧）
    iframe.addEventListener('load', () => {
      setTimeout(() => {
        if (!ready) {
          console.warn(
            `[plugin] ${SENTIMENT_PLUGIN_ID} 东财桥 iframe 已加载但未收到 ready ——`
            + '宿主未注入桥脚本（<4.32.0？）或加载的是错误页',
          );
        }
      }, 3000);
    });
    // 先挂监听再挂 iframe：bridge-ready 早于 load 事件发出，不能丢
    activeIframe = iframe;
    activeHandler = onMessage;
    window.addEventListener('message', onMessage);
    (document.body ?? document.documentElement).appendChild(iframe);
  });
  return ensuring;
};

/**
 * 经桥代发一次 JSONP 请求
 * @param url 目标地址（须为 https://*.eastmoney.com/api/…，桥内还有一层白名单校验）
 * @returns payload 的 JSON 字符串（与 http 通道的 response.text() 同构）
 * @throws 桥未就绪 / 回传失败 / 超时（调用方应回退 app:http）
 */
const requestViaBridge = async (url: string): Promise<string> => {
  if (!ready || !activeIframe?.contentWindow) {
    throw new Error('东财 JSONP 桥未就绪');
  }
  bumpIdleTimer();
  seq += 1;
  const id = `req${seq}`;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`东财桥 JSONP 超时（${EM_JSONP_TIMEOUT_MS}ms）`));
    }, EM_JSONP_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    activeIframe?.contentWindow?.postMessage(
      { source: EM_BRIDGE_SOURCE, type: 'em-jsonp', id, url },
      '*',
    );
  });
};

/**
 * 经桥取东财 API 文本：桥未就绪（含创建失败）或请求失败时返回 null，
 * 由调用方回退 app:http —— 本层不重试（重试语义归上层 fetchText 的 http 链路）
 * @param url 目标地址
 * @returns payload 的 JSON 字符串；桥不可用为 null
 */
export const fetchEmBridgeText = async (url: string): Promise<string | null> => {
  if (!isEmBridgeUrl(url)) return null;
  if (!(await ensureEmBridge())) {
    lastDiagnostic = '桥未就绪（iframe 未加载或宿主未注入桥脚本）';
    return null;
  }
  try {
    const text = await requestViaBridge(url);
    lastDiagnostic = '';
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastDiagnostic = `桥请求失败：${message}`;
    console.warn('[plugin] dsh-sentiment-index 东财桥请求失败，回退 app:http', error);
    return null;
  }
};
