/**
 * R29 走廊探针 · 构建脚本（esbuild **JS API**，不用 CLI —— 本机 CLI exit 2 无输出）
 *
 *   node tools/r29_probe_build.mjs
 *   → tools/r29_probe_bundle.mjs
 */
import { build } from '../node_modules/esbuild/lib/main.js';

const root = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
try {
  await build({
    entryPoints: [root + '/tools/r29_probe_entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: root + '/tools/r29_probe_bundle.mjs',
    logLevel: 'warning',
    absWorkingDir: root
  });
} catch (e) {
  console.error('FAIL', String(e).slice(0, 2000));
  process.exit(1);
}
console.log('BUILD_OK');
