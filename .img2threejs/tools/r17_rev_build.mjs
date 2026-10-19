// R17a：esbuild 打包探针入口（shim + three + 双工厂）成单文件 mjs，供 node 直跑。
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/tools/r17_rev_probe_entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17a/r17_rev_probe_bundle.mjs',
  logLevel: 'info',
  absWorkingDir: 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800',
});
console.log('BUILD OK');
