/**
 * R162 落地审查 · 撞击 shake 攻击斜坡 注入探针（DEV vite，只读）
 *
 * 真实撞击（crash event）在 autodrive 下不触发（snapdrive 冗余刹停），free-drive 撞
 * 主殿导航成本高且 SwiftShader 下不可控。本探针用**同一注入机制**（CameraRig.addShake，
 * 撞帧 crash 事件即调 addShake(0.5*crashN)）在真实游戏循环里注入 0.45（满幅），
 * 逐帧采样 shake（包络）/ shakeAmp（施加幅度）/ camera 偏移，验证：
 *   - 注入帧：shake 瞬跳 0.45（包络满幅）但 shakeAmp **仍为小值**（≈0.15，非 0.45）；
 *   - 随后 ~3 帧 shakeAmp 逐步升到包络（攻击斜坡 τ=0.04 ⇒ 3 帧 @60fps）；
 *   - 相机偏移幅值 ∝ shakeAmp ⇒ 撞帧**不瞬跳**，渐进到位。
 * 逐帧导出 impact_frames.json + 相机偏移图数据。
 *
 * 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/r46_capture.ps1 \
 *   -NodeScript r162_shake_inject_probe.mjs -Tag r162_inject -EdgePort 9551
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const EDGE_PORT = Number(argv.port || 9551);
const HTTP_PORT = Number(argv.httpport || 5251);
const W = 1280, H = 760;
const OUT = path.join(ROOT, '.qa', 'r162', 'inject');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const rq = http.get({ host: '127.0.0.1', port: EDGE_PORT, path: p, timeout: 2500 }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('t')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 60; i++) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch { }
    await wait(500);
  }
  throw new Error('CDP not ready');
}

async function main() {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT,
    server: { port: HTTP_PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
  await vite.listen();
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/index.html`); if (r.ok) break; } catch { }
    await wait(300);
  }
  console.log('VITE_READY', HTTP_PORT);

  const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(),
    defaultViewport: null, protocolTimeout: 300000 });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (/error|warn/i.test(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`); });
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));

  const HASH = `#noprewarm&quality=high&gpufake=discrete&view=chase`;
  const URL = `http://127.0.0.1:${HTTP_PORT}/index.html${HASH}`;
  console.log('GOTO', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(
    () => window.__game && document.getElementById('loading')?.classList.contains('done'),
    { timeout: 300000, polling: 200 });
  await wait(1200);
  // 攻击斜坡 τ=0.04 是 60fps 设计口径（dt≈1/60 ⇒ 3 帧缓升）。SwiftShader 软渲 wall dt
  // ≈0.5s，Loop 把 dt 钳到 maxFrameTime。**钳到 1/60** ⇒ 每帧 dt=0.0167，让斜坡在帧序上
  // 展开（游戏呈慢动作，但 shake 攻击斜坡的**帧间演进**即设计口径，正是本审查要量的量）。
  await page.evaluate(() => { window.__game.loop.maxFrameTime = 1 / 60; });

  // 采样器：注入后每帧读 shake / shakeAmp / camera.position + mode
  const frames = await page.evaluate(async () => {
    const g = window.__game;
    const rig = g.rig;
    const rec = [];
    // 基线（注入前 3 帧）
    const base = [];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = rig.camera.position;
      base.push([p.x, p.y, p.z, rig.shake, rig.shakeAmp]);
    }
    // 注入满幅 0.45（= 撞帧 crash 事件同源 addShake；0.45 为 SHAKE_MAX 满幅）
    rig.addShake(0.45);
    const injected = { shake: rig.shake, amp: rig.shakeAmp };
    // 注入后 18 帧
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = rig.camera.position;
      rec.push({ i, shake: +rig.shake.toFixed(4), amp: +rig.shakeAmp.toFixed(4),
        cx: +p.x.toFixed(4), cy: +p.y.toFixed(4), cz: +p.z.toFixed(4),
        mode: rig.mode });
    }
    return { base: base.map((b) => ({ cx: +b[0].toFixed(4), cy: +b[1].toFixed(4), cz: +b[2].toFixed(4), shake: +b[3].toFixed(4), amp: +b[4].toFixed(4) })), injected, frames: rec };
  });

  const b0 = frames.base[frames.base.length - 1];
  // 相机偏移相对基线（shake 只作用于 x/y；z 不受 shake 影响 ⇒ 对照）
  const rows = frames.frames.map((f) => ({
    i: f.i, shake: f.shake, amp: f.amp, mode: f.mode,
    dx: +(f.cx - b0.cx).toFixed(4), dy: +(f.cy - b0.cy).toFixed(4), dz: +(f.cz - b0.cz).toFixed(4)
  }));
  fs.writeFileSync(path.join(OUT, 'inject_frames.json'), JSON.stringify({ url: URL, base: frames.base, injected: frames.injected, frames: rows }, null, 1));
  console.log('INJECTED', JSON.stringify(frames.injected));
  console.log('BASE', JSON.stringify(b0));
  rows.forEach((r) => console.log(`f${String(r.i).padStart(2)} shake=${r.shake} amp=${r.amp} dx=${r.dx} dy=${r.dy} dz=${r.dz}`));
  console.log('DUMPED', path.join(OUT, 'inject_frames.json'));
  logs.slice(-6).forEach((l) => console.log(l));
  await browser.disconnect();
  await vite.close();
}
main().catch((e) => { console.error('FAIL', String(e).slice(0, 600)); process.exitCode = 1; });
