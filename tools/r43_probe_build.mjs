/** R43 探针打包（esbuild JS API —— 本机 CLI exit 2 无输出，沿用 r29/r38 做法） */
import { build } from '../node_modules/esbuild/lib/main.js';

const root = '<REPO_ROOT>';
try {
  await build({
    entryPoints: [root + '/tools/r43_probe_entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: root + '/tools/r43_probe_bundle.mjs',
    logLevel: 'warning',
    // vite 注入的 import.meta.env 在 node 里不存在 → 显式 define（DEV=false 走产线分支）
    define: { 'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production' }) },
    absWorkingDir: root
  });
} catch (e) {
  console.error('FAIL', String(e).slice(0, 2000));
  process.exit(1);
}
console.log('BUILD_OK');
