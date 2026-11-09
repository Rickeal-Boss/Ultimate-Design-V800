import { build } from '../../node_modules/esbuild/lib/main.js';
const root = '<REPO_ROOT>';
await build({
  entryPoints: [root + '/.img2threejs/tools/a2_probe_entry.ts'],
  bundle: true, platform: 'node', format: 'esm',
  outfile: root + '/.img2threejs/tools/a2_probe_bundle_r5.mjs',
  logLevel: 'warning', absWorkingDir: root
});
console.log('ok');
