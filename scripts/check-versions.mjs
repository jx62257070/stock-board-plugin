// 全插件「manifest version vs plugin.ts version」一致性检查
//
// 2026-10-28 踩坑：broad-track 升 1.2.13 时只改了 manifest.json，plugin.ts 里
// 导出的 version 常量还是 1.2.11，CI 打包校验直接拦截。两处版本号是手工维护的
// 重复字段，靠这个检查在本地提交时就拦下。
import fs from 'node:fs';
import path from 'node:path';

const root = 'plugins';
let bad = 0;
for (const d of fs.readdirSync(root)) {
  const dir = path.join(root, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const pt = fs.readFileSync(path.join(dir, 'plugin.ts'), 'utf8');
  const m = pt.match(/version:\s*'([^']+)'/);
  const code = m ? m[1] : '(none)';
  const ok = mf.version === code;
  if (!ok) bad += 1;
  console.error(
    d.padEnd(20),
    `manifest=${mf.version}`.padEnd(18),
    `code=${code}`.padEnd(14),
    ok ? 'OK' : '*** MISMATCH ***',
  );
}
console.error(bad === 0 ? 'ALL OK' : `${bad} mismatches`);
process.exit(bad === 0 ? 0 : 1);
