/**
 * 同步宿主契约快照：`host/` ← 主 app（默认 `../whf-stock-board`）的 `src/`
 *
 * 用法：
 * ```bash
 * node scripts/sync-host-contract.mjs                    # 用默认宿主路径
 * node scripts/sync-host-contract.mjs --host D:\project\whf-stock-board
 * ```
 *
 * **为什么需要它**：插件源码要写 `PluginDefinition` / `FormatService` / `PLUGIN_LOG_PREFIX`
 * 这些宿主类型与常量，而本仓库是独立仓库 —— 不能 `import` 主 app 的 `src/`（那就不是独立仓库了）。
 * 于是把宿主源码里「被插件用到的那一小撮」拷到 `host/` 快照。
 *
 * **路径映射（2026-10-16，宿主重构出 src/common | pc | mobile 后引入）**：
 * 宿主 `src/common/**` 与 `src/pc/**` 统一**剥掉首层目录**落位 ——
 * `src/common/types/plugin.types.ts` → `host/types/plugin.types.ts`、
 * `src/pc/plugins/watch-widget/constants.ts` → `host/plugins/watch-widget/constants.ts`。
 * 快照布局因此与重构前一致，插件源码的 `../../host/types/...` 引用**零改动**。
 * 代价是跨边界（common ⇄ pc）的相对 import 在快照里不再成立，所以拷贝时把
 * 内容里的项目内相对 import **按映射重算**（先解析到 src 侧真实目标，再从
 * 映射后的落位重算相对路径）；闭包解析仍按宿主原始路径进行，不受影响。
 *
 * 从种子文件出发做**闭包**：被相对引用到的文件也一并拷进来。
 * 宿主改了契约 → 跑一次 `pnpm sync:host` → 类型层立刻暴露不兼容点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = path.join(ROOT, 'host');

/**
 * 解析 `--host <路径>`；没给就用默认的上级同名仓库
 * @returns 宿主仓库根目录
 */
const resolveHostRoot = () => {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--host');
  const fromFlag = flag >= 0 ? args[flag + 1] : undefined;
  const candidate = fromFlag ?? process.env.WHF_HOST_APP ?? path.resolve(ROOT, '..', 'whf-stock-board');
  const hostRoot = path.resolve(candidate);
  if (!fs.existsSync(path.join(hostRoot, 'src'))) {
    throw new Error(`宿主目录里没有 src/：${hostRoot}（用 --host <路径> 指定主 app 仓库根）`);
  }
  return hostRoot;
};

/** 相对 import / export 的来源（只关心项目内相对路径，裸包名不处理） */
const RELATIVE_SPECIFIER = /from\s+['"](\.[^'"]*)['"]/g;
/** `export … from '…'` 与 `import type … from '…'` 同理 */
const RELATIVE_EXPORT = /export\s+(?:\*|type)?\s*\{[^}]*\}\s*from\s+['"](\.[^'"]*)['"]/g;

/**
 * 宿主 src 相对路径 → 快照相对路径：剥掉首层的 `common/` 与 `pc/`
 * （快照布局 = 重构前宿主 src 的扁平结构；mobile 不进契约，无需映射）
 * @param rel 宿主 src 下的相对路径（posix）
 * @returns 快照下的相对路径（posix）
 */
const mapRel = (rel) => rel.replace(/^(common|pc)\//, '');

/**
 * 解析一条相对 import 指向的真实文件（按宿主 src 下的相对路径）
 *
 * 注意 `.types` / `.constants` 这类「点号不是扩展名」的文件名 —— `path.extname('types/notify.types')`
 * 会返回 `.types`，所以不能靠扩展名判断，得**逐个候选试存在性**。
 * @param hostSrc 宿主 src 目录
 * @param fromDir 引用方所在目录（相对 src）
 * @param spec import 里写的相对路径
 * @returns 解析到的文件（相对 src）；都找不到时返回 null
 */
const resolveSpecifier = (hostSrc, fromDir, spec) => {
  // 全程用 posix 分隔符表示「相对 src 的路径」：`constants/plugin.constants.ts` 与
  // `constants\plugin.constants.ts` 是同一个文件，混用会在闭包里变成两条。
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [base, `${base}.ts`, `${base}.vue`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (fs.existsSync(toAbsolute(hostSrc, candidate))) return candidate;
  }
  return null;
};

/**
 * 「相对 src 的 posix 路径」→ 磁盘绝对路径
 * @param root 根目录（宿主 src 或快照 host/）
 * @param rel 相对路径（posix）
 * @returns 绝对路径
 */
const toAbsolute = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * 重算一条相对 import：宿主侧解析到真实目标后，按快照映射落位重新计算相对路径
 * @param hostSrc 宿主 src 目录
 * @param relOriginal 引用方在宿主 src 下的相对路径（posix）
 * @param spec import 里写的相对路径
 * @returns 重算后的相对路径；解析不到目标时返回 null（保留原样，由类型检查兜底）
 */
const remapSpecifier = (hostSrc, relOriginal, spec) => {
  const resolved = resolveSpecifier(hostSrc, path.posix.dirname(relOriginal), spec);
  if (!resolved) return null;
  const fromMapped = path.posix.dirname(mapRel(relOriginal));
  const toMapped = mapRel(resolved);
  const rebased = path.posix.relative(fromMapped, toMapped);
  return rebased.startsWith('.') ? rebased : `./${rebased}`;
};

/**
 * 拷贝前改写内容里的项目内相对 import（common ⇄ pc 跨边界的引用在快照里
 * 不再成立，必须按映射重算；裸包名与解析不到的目标原样保留）
 * @param content 宿主文件原文
 * @param relOriginal 引用方在宿主 src 下的相对路径（posix）
 * @param hostSrc 宿主 src 目录
 * @returns 改写后的内容
 */
const rewriteImports = (content, relOriginal, hostSrc) =>
  content
    .replace(RELATIVE_SPECIFIER, (match, spec) => {
      const remapped = remapSpecifier(hostSrc, relOriginal, spec);
      return remapped === null ? match : match.replace(spec, remapped);
    })
    .replace(RELATIVE_EXPORT, (match, spec) => {
      const remapped = remapSpecifier(hostSrc, relOriginal, spec);
      return remapped === null ? match : match.replace(spec, remapped);
    });

/**
 * 从一个种子文件出发，收集闭包内的所有文件（按宿主 src 下的相对路径）
 * @param hostSrc 宿主 src 目录
 * @param seeds 种子（相对 src 的路径，如 `common/types/plugin.types.ts`）
 * @returns 闭包文件清单（相对 src 的路径）
 */
const collectClosure = (hostSrc, seeds) => {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const absolute = toAbsolute(hostSrc, rel);
    if (!fs.existsSync(absolute)) {
      process.stdout.write(`  ！ 跳过不存在的引用：${rel}\n`);
      continue;
    }
    seen.add(rel);
    const code = fs.readFileSync(absolute, 'utf8');
    const specs = [
      ...[...code.matchAll(RELATIVE_SPECIFIER)].map((m) => m[1]),
      ...[...code.matchAll(RELATIVE_EXPORT)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const resolved = resolveSpecifier(hostSrc, path.posix.dirname(rel), spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
};

/**
 * 同步一份宿主契约快照
 */
const main = () => {
  const hostRoot = resolveHostRoot();
  const hostSrc = path.join(hostRoot, 'src');
  process.stdout.write(`宿主：${hostRoot}\n`);

  // 种子 = 插件会直接引用的宿主类型 / 常量入口（不必列全，闭包会自动带出依赖）。
  // 路径是 2026-10-16 重构后的 src 相对路径（common/ | pc/ 前缀，落位时被 mapRel 剥掉）
  const seeds = [
    'common/types/plugin.types.ts',
    'common/types/notify.types.ts',
    'common/types/stock-quote.types.ts',
    'common/types/table.types.ts',
    'common/types/watch-widget.types.ts',
    'common/constants/plugin.constants.ts',
    'common/constants/trend.constants.ts',
    'common/constants/watch-widget.constants.ts',
    // 市场资讯服务的源选项常量（成交额 / 新闻源 / 热榜平台的合法值与默认值）
    'common/constants/market-data.constants.ts',
    // 小组件窗口两端共享的「事件协议」常量：渲染端在宿主 src/pc/plugins/watch-widget/，
    // 插件产物经本快照引用同一份事实源，label / 事件名写岔一边窗口就静默失联
    'pc/plugins/watch-widget/constants.ts',
  ];
  const files = collectClosure(hostSrc, seeds);

  // 先清掉旧快照里不再属于闭包的文件，避免留下幽灵引用（比较按映射后的落位）
  // 豁免清单：非闭包成员但要常驻的支撑文件（persistedstate-shim.d.ts 的 side-effect
  // import 负责 pinia persist 选项的类型扩展，见该文件头注释）
  const PRUNE_EXEMPT = new Set(['persistedstate-shim.d.ts']);
  const previous = [];
  if (fs.existsSync(HOST_DIR)) {
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (rel !== 'README.md' && !PRUNE_EXEMPT.has(rel)) previous.push(rel);
      }
    };
    walk(HOST_DIR, '');
  }
  const next = new Set(files.map(mapRel));
  const stale = [];
  for (const rel of previous) {
    if (next.has(rel)) continue;
    try {
      fs.rmSync(toAbsolute(HOST_DIR, rel), { force: true });
    } catch {
      // 安全层可能把删除劫持成回收站删除并抛错：留到下面的提示里让人手工清
    }
    if (fs.existsSync(toAbsolute(HOST_DIR, rel))) stale.push(rel);
    else process.stdout.write(`  − 移除 ${rel}\n`);
  }

  let copied = 0;
  for (const rel of files) {
    const from = toAbsolute(hostSrc, rel);
    const to = toAbsolute(HOST_DIR, mapRel(rel));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const content = rewriteImports(fs.readFileSync(from, 'utf8'), rel, hostSrc);
    if (fs.existsSync(to) && fs.readFileSync(to, 'utf8') === content) continue;
    fs.writeFileSync(to, content, 'utf8');
    copied += 1;
  }
  if (stale.length > 0) {
    process.stdout.write(
      `  ！ 以下 ${stale.length} 个旧快照文件删不掉（安全层拦截），请手工删除：${stale.join(', ')}\n`,
    );
  }

  fs.writeFileSync(
    path.join(HOST_DIR, 'README.md'),
    [
      '# host —— 宿主契约快照（自动生成，勿手改）',
      '',
      '由 `node scripts/sync-host-contract.mjs` 从主 app（`../whf-stock-board`）的 `src/` 拷贝而来，',
      '`src/common/**` 与 `src/pc/**` 剥掉首层目录落位（快照布局 = 宿主重构前的扁平结构），',
      '内容里项目内相对 import 已按映射重算，快照内部自洽。',
      '',
      '插件源码只引用这里的东西：`../../host/types/plugin.types`、`../../host/constants/plugin.constants` …',
      '宿主改了契约 → 跑一次 `pnpm sync:host` → 类型层立刻暴露不兼容点。',
      '',
      `当前快照文件数：${files.length}`,
      '',
    ].join('\n'),
    'utf8',
  );

  process.stdout.write(
    files.map((file) => `  · ${mapRel(file)}`).join('\n') + '\n',
  );
  process.stdout.write(
    `✓ 宿主契约快照：${files.length} 个文件（本次写入 ${copied} 个）→ host/\n`
    + '插件源码里的引用前缀是 `../../host/`（相对 `plugins/<id>/`）。\n',
  );
};

main();
