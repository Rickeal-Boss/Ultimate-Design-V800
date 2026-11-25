/**
 * R162 落地审查 · 撞击 shake 攻击斜坡 逐帧探针（DEV vite，只读）
 *
 * 用 #autodrive&snapdrive 开一局（全油门→限速→刹车拉满 1.0→断裂→冗余→撞主殿），
 * 逐帧采样 __game.rig 的 shake / shakeAmp / camera.position 与车 speed，检测 crash 帧，
 * 导出 crash±10 帧的「包络 shake」与「施加幅度 shakeAmp」与相机位置增量，验证：
 *   - 撞帧（crash event 帧）shake 瞬跳满幅（0.5*crashN），但 shakeAmp 仍是**小值**；
 *   - 随后 ~3 帧 shakeAmp 逐步升到包络（攻击斜坡），不瞬跳；
 *   - 相机位置帧间增量随 shakeAmp 渐进（非撞帧满幅）。
 * 同时导出每帧 canvas 截图（碰撞前后 5 帧），供目检「两帧无过渡突兀」。
 *
 * 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/r46_capture.ps1 \
 *   -NodeScript r162_impact_probe.mjs -Tag r162_impact -EdgePort 9549
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
const EDGE_PORT = Number(argv.port || 9549);
const HTTP_PORT = Number(argv.httpport || 5249);
const W = 1280, H = 760;
const OUT = path.join(ROOT, '.qa', 'r162', 'impact');
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
  page.on('console', (m) => { if (/error|warn/i.test(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));

  const HASH = `#snapdrive&autodrive&quality=high&gpufake=discrete`;
  const URL = `http://127.0.0.1:${HTTP_PORT}/index.html${HASH}`;
  console.log('GOTO', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(
    () => window.__game && document.getElementById('loading')?.classList.contains('done'),
    { timeout: 300000, polling: 200 });
  await wait(1000);

  // SwiftShader 软渲帧率低：dt 被 Loop clamp 到 maxFrameTime。抬到 0.35 ⇒ 每帧游戏时间
  // 前进 0.35s，撞帧在更短真实时间内到达（与 r46_frame_probe 同口径，禁默认 0.1）。
  const mft = await page.evaluate(() => { window.__game.loop.maxFrameTime = 0.35; return window.__game.loop.maxFrameTime; });
  console.log('maxFrameTime=', mft);

  // 开始挑战（autodrive 需 startRun() 才进入 accel 段；否则停在 orbit/menu）
  await page.evaluate(() => window.__game.startRun());
  console.log('START_RUN called');

  // 注入逐帧采样器：读 __game.rig.shake / shakeAmp / camera.position / mode / speed.
  // 每帧压进 window.__frameRec（cap 40000），帧号 + 时间戳。采样走自己的 rAF 链
  // （在 game 的 rAF 之后注册 ⇒ 读到本帧更新后相机）。
  await page.evaluate(() => {
    const cap = 40000;
    window.__frameRec = { t: [], shake: [], amp: [], cx: [], cy: [], cz: [], mode: [], speed: [], n: 0, crashed: -1 };
    const rec = window.__frameRec;
    let f = 0;
    const step = () => {
      if (rec.n >= cap) return;
      const g = window.__game;
      const rig = g?.rig;
      const car = g?.car;
      const spd = (() => { try { return g?.sm?.vehicle?.speed ?? NaN; } catch { return NaN; } })();
      rec.t.push(performance.now());
      rec.shake.push(rig?.shake ?? NaN);
      rec.amp.push(rig?.shakeAmp ?? NaN);
      const p = rig?.camera?.position;
      rec.cx.push(p?.x ?? NaN); rec.cy.push(p?.y ?? NaN); rec.cz.push(p?.z ?? NaN);
      rec.mode.push(rig?.mode ?? '');
      rec.speed.push(spd);
      rec.n += 1;
      if (rig?.mode === 'crash' && rec.crashed < 0) rec.crashed = rec.n - 1;
      f += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // 等 crash 发生（撞主殿）。上限 240s。
  let crashedAt = -1;
  let lastPhase = '';
  for (let i = 0; i < 480; i++) {
    crashedAt = await page.evaluate(() => window.__frameRec?.crashed ?? -1);
    const ph = await page.evaluate(() => { try { return window.__game.sm.phase; } catch { return ''; } }).catch(() => '');
    if (ph !== lastPhase) { console.log('  phase=', ph); lastPhase = ph; }
    if (crashedAt >= 0) break;
    await wait(500);
  }
  console.log('CRASHED_AT', crashedAt);
  if (crashedAt < 0) { console.log('NO CRASH within window'); logs.forEach((l) => console.log(l)); }

  // 崩溃后再采 ~1s（让攻击斜坡 + 首波振荡完整）
  await wait(1200);

  // 导出 crash±12 帧原始数据；若未 crash，导出末 40 帧作诊断
  const rec = await page.evaluate(() => {
    const r = window.__frameRec;
    const lo = Math.max(0, r.crashed - 6);
    const hi = Math.min(r.n - 1, r.crashed + 12);
    const out = [];
    for (let i = lo; i <= hi; i++) {
      out.push({ f: i, t: r.t[i], shake: +r.shake[i].toFixed(4), amp: +r.amp[i].toFixed(4),
        cx: +r.cx[i].toFixed(3), cy: +r.cy[i].toFixed(3), cz: +r.cz[i].toFixed(3),
        mode: r.mode[i], speed: +r.speed[i].toFixed(2) });
    }
    // 若未 crash，追加末 40 帧诊断（看速度是否在累积）
    if (r.crashed < 0) {
      const dl = Math.max(0, r.n - 40);
      for (let i = dl; i < r.n; i++) {
        out.push({ f: i, t: r.t[i], shake: +r.shake[i].toFixed(4), amp: +r.amp[i].toFixed(4),
          cx: +r.cx[i].toFixed(3), cy: +r.cy[i].toFixed(3), cz: +r.cz[i].toFixed(3),
          mode: r.mode[i], speed: +r.speed[i].toFixed(2) });
      }
    }
    return { crashed: r.crashed, n: r.n, frames: out };
  });
  fs.writeFileSync(path.join(OUT, 'impact_frames.json'), JSON.stringify(rec, null, 1));

  // 撞帧后连拍 6 帧（视觉参考：冲击过渡是否突兀）——软渲 FPS 低，逐帧同步不可靠，
  // 仅作目检参考；攻击斜坡的硬证据在 impact_frames.json（shake 包络 vs shakeAmp）。
  const canvas = await page.$('canvas');
  for (let k = 0; k < 6; k += 1) {
    const file = path.join(OUT, `frame_after_${k}.png`);
    if (canvas) await canvas.screenshot({ path: file });
    await wait(120);
  }

  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    runAt: new Date().toISOString(), url: URL, crashedAt: rec.crashed, n: rec.n,
    note: 'R162 撞击 shake 攻击斜坡：shake=包络(瞬跳满幅) amp=施加幅度(攻击缓升)'
  }, null, 1));
  console.log('DUMPED', path.join(OUT, 'impact_frames.json'), 'n=', rec.n, 'crashed=', rec.crashed);
  logs.slice(-10).forEach((l) => console.log(l));
  await browser.disconnect();
  await vite.close();
}
main().catch((e) => { console.error('FAIL', String(e).slice(0, 600)); process.exitCode = 1; });
