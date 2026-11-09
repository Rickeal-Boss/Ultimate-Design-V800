import { build } from '../../node_modules/esbuild/lib/main.js';
const root = '<REPO_ROOT>';
try {
  await build({ entryPoints: [root + '/.img2threejs/tools/r8_low_probe.ts'], bundle: true, platform: 'node', format: 'esm', outfile: root + '/.img2threejs/tools/r8_low_probe.mjs', logLevel: 'info', absWorkingDir: root });
} catch (e) {
  console.error('FAIL', String(e).slice(0, 400));
  process.exit(1);
}
console.log('BUILD_OK');
