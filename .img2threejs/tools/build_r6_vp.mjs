import { build } from '../../node_modules/esbuild/lib/main.js';
const root = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
await build({ entryPoints: [root + '/.img2threejs/tools/r6_vert_probe.ts'], bundle: true, platform: 'node', format: 'esm', outfile: root + '/.img2threejs/tools/r6_vert_probe.mjs', logLevel: 'warning', absWorkingDir: root });
console.log('ok');
