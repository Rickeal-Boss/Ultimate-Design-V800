/**
 * R43 落地审查 · 真实 GPU 出图（Edge headless + vite dev server）
 *
 * ⚠ Edge 起停必须与探针同处一次 node 调用（Git Bash / 直接 spawn → EACCES，历史踩坑）。
 *
 * 做四件事：
 *  1. 复现用户截图机位（桥面贴左栏板沿 −z，若干候选）
 *  2. **消去法**：逐类隐藏 ground / terrain-rock / terrain-skyline / castle-ashlar-z0* 出对照图
 *  3. **「只留天空」极限消去**：把全部场景 mesh 隐藏 ⇒ 帧里只剩天空球。
 *     这一步是「深棕墙」定罪的判决书：若该区域仍是同一个深棕，说明它根本没有材质、
 *     也不是光照暗面 —— 那段像素来自天空球的 **地平面以下底色 uGround = 0x4b4038**。
 *     （等价于洋红 MeshBasic 测试，且更彻底：连「有没有件在前面」都一并排除。）
 *  4. 逐图取像素值，与用户截图同点对账
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { decodePNG } from './r43_png.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = ROOT + '/.qa/r43_occlusion';
fs.mkdirSync(OUT, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9471;
const PROFILE = ROOT + '/.img2threejs/renders/.edge-r43occ';
const URL = 'http://127.0.0.1:5200/index.html#noprewarm&quality=high&gpufake=discrete';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const POSES = [
  { name: 'P1_deck_left_105', eye: [-10.5, 1.6, 40], tgt: [-4, 0.5, -300], fov: 62 },
  { name: 'P2_deck_left_1224', eye: [-12.24, 1.6, 40], tgt: [-6, 1, -300], fov: 62 },
  { name: 'P3_deck_left_high', eye: [-13.5, 2.2, 20], tgt: [-8, -2, -260], fov: 62 },
  { name: 'P4_r41_mirror_right', eye: [12.24, 1.6, 40], tgt: [6, 1, -300], fov: 62 },
  { name: 'P5_side_low', eye: [18, 1.2, -120], tgt: [0, -6, -260], fov: 55 }
];

const ALL_NAMES = [
  'ground', 'road', 'terrain-skyline', 'terrain-rock',
  'castle-pave-road', 'castle-pave-walk', 'castle-pave',
  'castle-ashlar-z0a', 'castle-ashlar-z0b', 'castle-ashlar-z1', 'castle-ashlar-z2', 'castle-ashlar-z3',
  'castle-ashlar-z4', 'castle-ashlar-z5',
  'castle-wall-z0', 'castle-gold-z0a', 'castle-gold-z0b', 'castle-gold-z1', 'castle-gold-z2',
  'castle-gold-z3', 'castle-gold-z4',
  'castle-dark-z1', 'castle-dark-z2', 'castle-dark-z3', 'castle-dark-z4',
  'castle-flame', 'castle-roof', 'castle-wood', 'castle-glass', 'castle-marble', 'castle-door',
  'castle-agedGold', 'castle-grey-z1'
];

const save = (name, dataUrl) => {
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return f;
};
const px = (file, xs) => {
  const { width: W, height: H, rgba } = decodePNG(fs.readFileSync(file));
  const at = (fx, fy) => {
    const x = Math.min(W - 1, Math.round(fx * W)), y = Math.min(H - 1, Math.round(fy * H));
    const o = (y * W + x) * 4;
    return '#' + [rgba[o], rgba[o + 1], rgba[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  return { W, H, str: xs.map(([fx, fy]) => `${fx},${fy}:${at(fx, fy)}`).join('  ') };
};

/* ⚠ 起停分离：node `spawn(msedge)` 在本机直接 EACCES（与 R41/R42 踩坑同因）。
 * Edge 由 PowerShell `Start-Process` 先起（见本轮报告的执行序列），本脚本只 connect。 */
const edge = null;

/* ⚠ 本机 http_proxy=127.0.0.1:5688 会劫持 node 的 fetch/undici（实测 fetch 全 fail、curl 502），
 * 但 node:http 与 ws 不走 env 代理 ⇒ 用 node:http 拿 webSocketDebuggerUrl 再连，绕开 fetch。 */
import http from 'node:http';
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 90; i += 1) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch { /* not up */ }
    await wait(400);
  }
  throw new Error('debugger unreachable');
}

/* vite dev server 由本进程托管（`createServer` API）：
 * 本机 PowerShell `Start-Process` 起 node 会因 env 里 HTTPS_PROXY/https_proxy 大小写重复
 * 抛 ArgumentException；而 Bash 后台任务约 3 分钟被回收 ⇒ 独立进程托管不可靠。
 * 同进程内起 server 最稳，且退出时 close() 干净收尾。 */
import { createServer } from 'vite';
const vite = await createServer({
  root: ROOT, server: { port: 5200, host: '127.0.0.1', strictPort: true }, logLevel: 'error'
});
await vite.listen();
console.log('VITE_READY', vite.resolvedUrls?.local?.[0] ?? '');

let browser;
try {
  const wsUrl = await waitDbg(); await wait(600);
  browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null, protocolTimeout: 240000 });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 300)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate(() => ({
      shot: typeof window.__v800EnvShot,
      done: !!document.getElementById('loading')?.classList.contains('done'),
      canvas: !!document.querySelector('canvas'),
      gl: (() => { try { const c = document.querySelector('canvas'); const g = c && (c.getContext('webgl2') || c.getContext('webgl')); return g ? (g.getParameter(g.VERSION) || '').slice(0, 40) : null; } catch (e) { return 'ERR ' + e.message; } })()
    }));
    if (st.shot === 'function' && st.done) { console.log('SCENE READY @', i * 1.0, 's', JSON.stringify(st)); break; }
    if (i % 5 === 0) console.log('WAIT', i, JSON.stringify(st));
    if (i === 59) { console.log('--- console during wait ---'); console.log(logs.slice(-40).join('\n')); throw new Error('scene never ready'); }
    await wait(1000);
  }
  await wait(1000);

  const shot = async (pose, tag) => {
    const d = await page.evaluate((o) => window.__v800EnvShot(o.name, ...o.eye, ...o.tgt, o.fov), pose);
    return save(pose.name + tag, d);
  };

  const report = [];
  // ── 1. 候选机位（基线）
  for (const p of POSES) {
    await page.evaluate(() => window.__v800HideMat('', false));
    const f = await shot(p, '_ALL');
    report.push([p.name + '_ALL', px(f, [[0.15, 0.55], [0.3, 0.75], [0.45, 0.9], [0.75, 0.4], [0.9, 0.1]])]);
  }

  // ── 2. 定机位 P2 上做消去法
  const P2 = POSES[1];
  const HIDES = [
    ['ground'],
    ['terrain-rock'],
    ['terrain-skyline'],
    ['castle-ashlar-z0b', 'castle-ashlar-z0a', 'castle-gold-z0a', 'castle-gold-z0b'],
    ['ground', 'terrain-rock'] // 二者同隐：若仍深棕 ⇒ 不是地形
  ];
  for (const keys of HIDES) {
    await page.evaluate(() => window.__v800HideMat('', false));
    for (const k of keys) await page.evaluate((kk) => window.__v800HideMat(kk, true), k);
    const f = await shot(P2, '_HIDE_' + keys.join('+'));
    report.push([P2.name + '_HIDE_' + keys.join('+'), px(f, [[0.15, 0.55], [0.3, 0.75], [0.45, 0.9]])]);
  }

  // ── 3. 极限消去：全场景隐藏，只剩天空球
  await page.evaluate(() => window.__v800HideMat('', false));
  for (const k of ALL_NAMES) await page.evaluate((kk) => window.__v800HideMat(kk, true), k);
  const fSky = await shot(P2, '_SKY_ONLY');
  report.push([P2.name + '_SKY_ONLY', px(fSky, [[0.15, 0.55], [0.3, 0.75], [0.45, 0.9], [0.85, 0.5], [0.5, 0.05]])]);
  await page.evaluate(() => window.__v800HideMat('', false));

  console.log('--- 像素对账（归一化坐标 : 十六进制）---');
  for (const [n, r] of report) console.log(n.padEnd(46), r.str);
  console.log('--- console tail ---');
  console.log(logs.slice(-10).join('\n'));
  fs.writeFileSync(OUT + '/gpu_pixels.json', JSON.stringify(report, null, 1));
  console.log('DONE');
} catch (e) {
  console.error('CAPTURE_FAIL', String(e).slice(0, 800));
} finally {
  try { await browser?.disconnect(); } catch { /* ignore */ }
  try { await vite.close(); } catch { /* ignore */ }
}
