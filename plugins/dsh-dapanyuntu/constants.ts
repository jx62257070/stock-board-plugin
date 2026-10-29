/**
 * 插件 dsh-dapanyuntu（大盘云图）· 常量
 *
 * 第三方嵌入三常量自宿主 `src/common/constants/panorama.constants.ts` 复制
 * （插件禁 import 宿主 src/，宿主侧已随页面转插件分发删除，本文件是唯一事实源；
 * 其中 postMessage 信源另与宿主 `src-tauri/src/lib.rs` 的 HEATMAP_THEME_INIT_SCRIPT
 * 约定一致 —— **三端同步**：Rust 注入脚本 / 本常量，任一改动必须同步）。
 */

// ---------- 插件身份与路由 ----------

/** 插件 id（= 目录名 = manifest.id；同时是存储命名空间的一部分，定了不能改） */
export const DAPANYUNTU_PLUGIN_ID = 'dsh-dapanyuntu';

/** 插件展示名 */
export const DAPANYUNTU_PLUGIN_NAME = '大盘云图';

/** 插件版本（与 manifest.json 保持一致，构建脚本会校验） */
export const DAPANYUNTU_PLUGIN_VERSION = '1.0.0';

/** 页面路由路径（沿用宿主内置页的历史路径，老书签直达；宿主删自带页后由本插件接管） */
export const DAPANYUNTU_ROUTE_PATH = '/heatmap';

/** 路由页标题（路由 meta.title，顶栏与浏览器标题用） */
export const DAPANYUNTU_PAGE_TITLE = '大盘云图';

// ---------- 第三方嵌入 ----------

/** 大盘云图嵌入页 URL（dapanyuntu.com，A 股板块/个股树图；iframe 直嵌，
 * 2026-10-13 实测响应头无 X-Frame-Options / CSP frame-ancestors，可被嵌入） */
export const DAPANYUNTU_EMBED_URL = 'https://dapanyuntu.com/';

/** 大盘云图原站地址（提示条「访问原站」跳转用；当前与嵌入页同源） */
export const DAPANYUNTU_SITE_URL = 'https://dapanyuntu.com/';

/**
 * 大盘云图主题同步 postMessage 信源标识
 *
 * 宿主 ↔ iframe 双向消息都以 `source` 字段声明来源，接收方校验该值后才处理，
 * 防止同页其他 postMessage 误触发。协议细节与 Rust 注入脚本约定一致
 * （宿主 src-tauri/src/lib.rs 的 HEATMAP_THEME_INIT_SCRIPT，三端改动必须同步）。
 */
export const HEATMAP_THEME_MESSAGE_SOURCE = 'whf-stock-board';

// ---------- 界面文案 ----------

/** 提示条文案（声明第三方嵌入来源） */
export const DAPANYUNTU_NOTICE_TEXT =
  '本页为第三方站点「大盘云图」的嵌入展示（dapanyuntu.com），数据与交互均由原站提供';

/** 「访问原站」按钮文案 */
export const DAPANYUNTU_OPEN_SITE_LABEL = '访问原站';

/** iframe 无障碍标题 */
export const DAPANYUNTU_IFRAME_TITLE = '大盘云图';
