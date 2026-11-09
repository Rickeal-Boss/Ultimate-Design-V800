import { build } from '../../node_modules/esbuild/lib/main.js';
const root = '<REPO_ROOT>';
try {
  await build({
    entryPoints: [root + '/.img2threejs/tools/r5_wheel_probe.ts'],
    bundle: true, platform: 'node', format: 'esm',
    outfile: root + '/.img2threejs/tools/r5_wheel_probe.mjs',
    logLevel: 'info', absWorkingDir: root
  });
} catch (e) {
  console.error('BUILD FAILED:', e.message?.slice(0, 500));
  process.exit(1);
}
