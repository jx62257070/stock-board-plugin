/**
 * 官方插件的 Tailwind 类名清单：抽取与落盘（Node 侧，被打包脚本共享）
 *
 * **为什么需要它**：Tailwind 在构建期只扫描宿主源码。官方插件改成 zip 产物包分发之后，
 * 它们的 `.vue` 已经不在宿主的 `src/` 下 —— 类名能否出现在产物 CSS 里，一度全靠
 * 「宿主别处也用了同一个类」。这份清单把巧合变成保证：宿主的
 * `src/common/assets/styles/theme.css` 用 `@source './plugin-classes.txt'` 把它纳入扫描，
 * 于是这些类无论宿主自己用不用，产物 CSS 里都会生成。
 *
 * 约定：清单在**宿主仓库**里入库（它本身不是构建产物），本仓库打包后写回宿主；
 * 宿主不可达（没配 `--host`）时只抽取不落盘，靠 `pnpm sync:host` 之外的一次手工同步兜底。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 清单文件路径（相对**宿主**仓库根，入库）
 *
 * 宿主 v4.21.0 把样式目录从 `src/assets/styles/` 迁到了 `src/common/assets/styles/`
 * （`src/common` + `src/pc` + `src/mobile` 新结构）。这里按新结构写死；
 * 老结构已随版本删除，不必再兼容。
 */
export const CLASS_ALLOWLIST_RELATIVE = path.join('src', 'common', 'assets', 'styles', 'plugin-classes.txt');

/** 长得像 Tailwind 工具类的 token（含 `sm:` / `min-[900px]:` / `@3xl:` 变体前缀与 `[11px]` 任意值；主体允许 `@` 开头 —— Tailwind 4 的 `@container` 容器声明类） */
const CLASS_LIKE = /^(?:[a-z@][a-z0-9-]*(?:\[[^\]]+\])?:)*[a-z@][a-z0-9/.-]*(?:\[[^\]]+\])?$/;

/**
 * 转义成 CSS 选择器里那样的类名（`text-[10px]` → `text-\[10px\]`）
 * @param className 类名
 * @returns 转义结果
 */
const escapeForCss = (className) => className.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

/**
 * 读宿主已构建出的产物 CSS，造一个「这个类在宿主样式里是否存在」的判定器
 *
 * 只用来给 `flex` / `grid` / `truncate` 这类**不带 `-`** 的单字工具类放行：
 * 产物里抽到的孤零零一个单词（`primary` / `span`）多半是三元表达式里误捞的字符串，
 * 而真正的单字工具类此刻一定已经在宿主 CSS 里。
 * @param hostRoot 宿主仓库根目录
 * @returns 判定器（类名 → 是否存在）；没找到产物 CSS 时恒为 false
 */
export const readHostCssClassProbe = (hostRoot) => {
  const dir = path.join(hostRoot, 'dist', 'assets');
  if (!fs.existsSync(dir)) return () => false;
  const file = fs.readdirSync(dir).find((name) => /^(?:index|main)-.+-[a-z0-9]+\.css$/i.test(name));
  if (!file) return () => false;
  const css = fs.readFileSync(path.join(dir, file), 'utf8');
  return (className) => css.includes(`.${escapeForCss(className)}`);
};

/**
 * 是不是该收进清单：必须是类名字面量，且排掉上面说的那种被误捞出来的单词
 *
 * `@` 前缀的 token 无条件放行 —— 那是 Tailwind 4 容器查询家族
 * （`@container` / `@sm:` 等），单词形态但绝不可能是一般标识符。
 * @param token 候选 token
 * @param isKnownClass 该类是否已存在于宿主 CSS
 * @returns 是否保留
 */
const keepToken = (token, isKnownClass) =>
  token.length > 1 && CLASS_LIKE.test(token)
  && (token.startsWith('@') || isKnownClass(token) || /[-:[]/.test(token));

/**
 * 从插件产物源码里抽出所有类名
 *
 * 产物是 SFC 编译后的 render 函数，类名只会出现在两处形态：
 * `class: "a b c"`（静态串，含 `_hoisted_*` 常量）与 `:class` 的数组 / 对象 / 三元表达式。
 * @param code 产物源码
 * @param isKnownClass 该类是否已存在于宿主 CSS（用来放行 `flex` 这种不带 `-` 的单字工具类）
 * @returns 类名集合
 */
export const collectArtifactClasses = (code, isKnownClass = () => false) => {
  // v-if 编译占位注释（createCommentVNode("v-if", true)）常与 :class 绑定同行，
  // 不先剔除会被下面「取到行尾再抽字符串」的分支误收为类名
  const source = code.replaceAll(/createCommentVNode\("v-if"[^)]*\)/g, '');
  const classes = new Set();
  /**
   * 把一段文本按空白 / 引号切碎后收类名
   * @param text 待切分的文本
   */
  const absorb = (text) => {
    for (const token of text.split(/[\s"'`]+/)) {
      if (keepToken(token, isKnownClass)) classes.add(token);
    }
  };
  // 1. class: "a b c" 直接字符串（含 _hoisted_* 常量）
  for (const match of source.matchAll(/\bclass\s*:\s*(['"`])([\s\S]*?)\1/g)) absorb(match[2]);
  // 2. :class 的数组 / 对象 / 三元表达式：取到行尾再抽里面的字符串
  for (const match of source.matchAll(/\bclass\s*:\s*([^\n]*)/g)) {
    for (const inner of match[1].matchAll(/(['"`])([\s\S]*?)\1/g)) absorb(inner[2]);
  }
  // 3. 全文扫「@ 开头或含 / 的类形 token」（兜底 1/2 的盲区）
  //    动态绑定的结果类常被赋给自定义属性（如 fillClass: isPast ? "bg-primary" : … "bg-primary/70"），
  //    不在 class: 前缀行上，1/2 都捞不到。这类类形极窄（@ 容器家族 / 变体透明度、任意值），
  //    全文扫描会捎带少量形似的非类 token（如 URL 路径段 api/qt/clist）——
  //    Tailwind 对不认识的候选不生成 CSS，白名单多几行噪音无害；漏真类才是事故。
  for (const match of source.matchAll(/[A-Za-z@][A-Za-z0-9/.[@\]-]*/g)) {
    const token = match[0];
    if ((token.startsWith('@') || token.includes('/')) && keepToken(token, isKnownClass)) {
      classes.add(token);
    }
  }
  return classes;
};

/**
 * 读回现有清单（新打包的类和它取并集，保证「打包一个不会抹掉另一个」）
 * @param hostRoot 宿主仓库根目录
 * @returns 现有类名集合
 */
export const readExistingAllowlist = (hostRoot) => {
  const file = path.join(hostRoot, CLASS_ALLOWLIST_RELATIVE);
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
};

/**
 * 把类名清单写进宿主的 `src/common/assets/styles/plugin-classes.txt`
 * @param hostRoot 宿主仓库根目录
 * @param classes 完整类名集合（已含历史）
 */
export const writeClassAllowlist = (hostRoot, classes) => {
  const file = path.join(hostRoot, CLASS_ALLOWLIST_RELATIVE);
  const body = [
    '# 官方插件用到的 Tailwind 类名 —— 由 tauri-plugin 的 scripts/build-plugins.mjs 自动生成，勿手改',
    '# 插件源码不在宿主的 src/ 下（独立仓库 + zip 产物包分发），Tailwind 扫不到它们；',
    '# 靠这份清单经 theme.css 的 @source 进入产物 CSS。详见宿主 AGENTS.md「第三方插件的样式边界」。',
    '',
    [...classes].sort().join('\n'),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
};
