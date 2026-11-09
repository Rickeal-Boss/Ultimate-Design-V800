// R17a：esbuild 打包探针入口（shim + three + 双工厂）成单文件 mjs，供 node 直跑。
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['<REPO_ROOT>/.img2threejs/tools/r17_rev_probe_entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: '<REPO_ROOT>/verify/r17a/r17_rev_probe_bundle.mjs',
  logLevel: 'info',
  absWorkingDir: '<REPO_ROOT>',
});
console.log('BUILD OK');
