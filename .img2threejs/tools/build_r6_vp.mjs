import { build } from '../../node_modules/esbuild/lib/main.js';
const root = '<REPO_ROOT>';
await build({ entryPoints: [root + '/.img2threejs/tools/r6_vert_probe.ts'], bundle: true, platform: 'node', format: 'esm', outfile: root + '/.img2threejs/tools/r6_vert_probe.mjs', logLevel: 'warning', absWorkingDir: root });
console.log('ok');
