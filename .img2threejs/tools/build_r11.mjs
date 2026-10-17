import { build } from '../../node_modules/esbuild/lib/main.js';
const root = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const name = process.argv[2];
if (!name) { console.error('usage: node build_r11.mjs <ts-base-name>'); process.exit(1); }
try {
  await build({ entryPoints: [root + '/.img2threejs/tools/' + name + '.ts'], bundle: true, platform: 'node', format: 'esm', outfile: root + '/.img2threejs/tools/' + name + '.mjs', logLevel: 'info', absWorkingDir: root });
} catch (e) {
  console.error('FAIL', String(e).slice(0, 400));
  process.exit(1);
}
console.log('BUILD_OK');
