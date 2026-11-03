/**
 * R44 车模外观 QA 出图（headless Edge + vite dev server，同进程托管）
 *
 * 图组：两车 × 3 变体 × {前34 / 正侧 / 尾34 / cabin} → .qa/r44_car/
 * 附加：#r44ext=off A/B（程序化回退外观）一张。
 *
 * 断言（写进 report.json）：
 *  · window.__r44Shell[car].state === 'ready'（外部壳装载台账）
 *  · perfhud 标题（FPS / 整帧 calls / tris）
 *  · __v800EnvStats（城堡/环境 tri、dc 口径）
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = ROOT + '/.qa/r44_car';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 5200;        // vite dev server
const EDGE_PORT = 9472;   // headless Edge CDP（PS 先起，见 .qa/r44/r44_car_capture.ps1）

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(path, port = EDGE_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (res) => {
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
const save = (name, dataUrl) => {
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return f;
};

/* vite dev server 由本进程托管（r43 同款：独立进程在 Git Bash 下不可靠） */
import { createServer } from 'vite';
const vite = await createServer({
  root: ROOT, server: { port: PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error'
});
await vite.listen();
console.log('VITE_READY');

const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, protocolTimeout: 300000 });
const report = [];

async function capture(car, variant, view, tag) {
  const hash = `#noprewarm&quality=high&gpufake=discrete&perfhud&vehicle=${car}&paint=${variant}` +
    (view === 'cabin' ? '&view=cabin' : '');
  const page = await browser.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));
  await page.setViewport({ width: 1280, height: 800 });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html${hash}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let ready = null;
    for (let i = 0; i < 90; i += 1) {
      ready = await page.evaluate((carName) => {
        const done = !!document.getElementById('loading')?.classList.contains('done');
        const shell = window.__r44Shell ?? {};
        const carId = window.__game?.car?.profile?.id ?? carName;
        return {
          done,
          shellState: shell[carId]?.state,
          shell: { v800: shell.v800?.state, r7: shell.r7?.state },
          carPos: (window.__game?.car?.root?.position) ? { x: window.__game.car.root.position.x, y: window.__game.car.root.position.y, z: window.__game.car.root.position.z } : null
        };
      }, car).catch((e) => ({ err: String(e).slice(0, 120) }));
      // 硬条件：loading 完 **且** 外部壳台账离开 loading（ready=外壳已挂载；failed=回退态也出图）
      if (ready.done && (ready.shellState === 'ready' || ready.shellState === 'failed')) break;
      if (i % 5 === 0) console.log('WAIT', car, variant, i, JSON.stringify(ready));
      if (i === 89) { report.push({ car, variant, view, error: 'shell never settled', ready }); }
      await wait(1000);
    }
    if (!ready?.done) {
      report.push({ car, variant, view, error: 'scene not ready', logs: logs.slice(0, 5) });
      await page.close();
      return;
    }
    await wait(5000); // 阴影/后处理/轮挂载首帧稳定（外壳 IIFE 完成后材质上传）
    const status = await page.evaluate(() => {
      const shell = (window.__r44Shell ?? {});
      const car2 = window.__game?.car;
      const pos = car2?.root?.position;
      return {
        shellState: shell[car2?.profile?.id ?? ''] ?? shell,
        title: document.title,
        envStats: window.__v800EnvStats?.() ?? null,
        carPos: pos ? [pos.x, pos.y, pos.z] : null,
        variant: car2?.profile?.id
      };
    });
    const [cx, cy, cz] = status.carPos ?? [0, 0, 40];
    const p = (dx, dy, dz) => `${cx + dx},${cy + dy},${cz + dz}`;
    const hubPose = (tag) => {
      const h = { fl: [1, -1], fr: [-1, -1], rl: [1, 1], rr: [-1, 1] }[tag];
      const sx = window.__r44Shell[car].manifest?.scale ?? 4.5;
      // 轮心世界坐标 ≈ (∓hub.x×s, hub.y×s, ∓hub.z×s)（body rotY π）
      const wx = -h[0] * 0.205 * sx * (car === 'v800' ? 0.87 : 1) || 0;
      return null;
    };
    const eyeTarget = {
      front34: [p(3.6, 1.5, -6.4), p(0, 0.75, 0), 42],
      side: [p(7.4, 1.15, 0.01), p(0, 0.8, 0), 40],
      rear34: [p(-3.6, 1.6, 6.4), p(0, 0.75, 0), 42],
      cabin: [p(0.34, 1.32, 0.4), p(0.0, 1.0, -5), 72],
      wheel: [p(2.3, 0.65, -1.9), p(0.85, 0.41, -1.74), 40],
      roof: [p(1.9, 2.55, 2.6), p(0, 1.72, 0.35), 45]
    }[view.startsWith('wheel-') ? 'wheel' : view];
    if (view.startsWith('wheel-')) {
      // 归属消去：URL 带 hidebody/hidewheels 时分别隐藏壳体/外部轮
      await page.evaluate((vh) => {
        const g = window.__game;
        vh = vh || '';
        if (vh.includes('hidebody')) {
          g.car.body.traverse((o) => { if (o.name === 'body' && o.isMesh && o.userData?.r44External) o.visible = false; });
        }
        if (vh.includes('hidewheels')) {
          g.car.body.traverse((o) => { if (o.isMesh && o.geometry?.index?.count === 80844 * 3 + 1) return; });
          g.car.wheels.forEach((w) => w.spin.children.forEach((c) => { if (c.userData?.r44External) c.visible = false; }));
        }
      }, view);
    }
    if (view.startsWith('wheel-')) {
      // 按轮 tag 取实际 hub 世界坐标（读外壳 manifest + body 矩阵）
      const hubPose = await page.evaluate(async (t) => {
        const g = window.__game;
        const carId = g.car.profile?.id ?? 'v800';
        const manifest = await (await fetch(`/src/assets/cars/${carId}/manifest.json`)).json();
        const h = manifest.hubs[t];
        const THREEC = window.__THREE;
        let bodyMesh = null;
        g.car.body.traverse((o) => { if (o.name === 'body' && o.isMesh && o.userData?.r44External) bodyMesh = o; });
        if (!bodyMesh) return null;
        bodyMesh.updateWorldMatrix(true, false);
        const w = new THREEC.Vector3(h[0], h[1], h[2]);
        bodyMesh.localToWorld(w);
        return [w.x, w.y, w.z];
      }, view.slice(6));
      if (hubPose) {
        const [hx, hy, hz] = hubPose;
        const off = hz < 0 ? [-1, -1] : [-1, 1]; // 外侧 45° 上方 2m
        eyeTarget[0] = `${hx + off[0] * 1.5},${hy + 0.55},${hz + off[1] * 1.5}`;
        eyeTarget[1] = `${hx},${hy},${hz}`;
        eyeTarget[2] = 40;
      }
    }
    if (view === 'cabin') {
      // 内舱语义（与 Game selectView 同路径的手动等价）：外壳藏、前挡藏、遮挡克隆藏
      await page.evaluate(() => {
        const g = window.__game;
        g.paintShadow?.(true);
        for (const wm of g.windshieldMeshes ?? []) wm.visible = false;
        for (const om of g.cabinOccluderMaterials ?? []) om.visible = false;
      });
      await wait(300);
    }
    const data = await page.evaluate((et) => {
      const [eye, tgt, fov] = et;
      const nums = eye.split(',').concat(tgt.split(',')).map(Number);
      return window.__v800EnvShot('r44', ...nums, fov);
    }, eyeTarget);
    const f = save(`${car}-${variant}-${view}${tag}`, data);
    report.push({ car, variant, view, file: f, shell: status.shellState, title: status.title, envStats: status.envStats });
    console.log('SHOT', `${car}-${variant}-${view}`, JSON.stringify(status.shellState), status.title);
  } catch (e) {
    report.push({ car, variant, view, error: String(e).slice(0, 300), logs: logs.slice(0, 5) });
    console.log('ERR', car, variant, view, String(e).slice(0, 200));
  }
  await page.close();
}

// ── 图组：2 车 × 3 变体 × 4 视图（closeups 模式跳过）──
const onlyCloseups2 = process.argv[2] === 'closeups';
if (!onlyCloseups2) {
  for (const car of ['v800', 'r7']) {
    const variants = car === 'v800' ? ['white', 'black', 'gold'] : ['white', 'purple', 'green'];
    for (const variant of variants) {
      for (const view of ['front34', 'side', 'rear34', 'cabin']) {
        await capture(car, variant, view, '');
      }
    }
  }
}
// A/B：程序化回退外观（外部壳停用）
await capture('v800', 'white', 'front34', '-noshell');
// 二次打回：轮拱 3/4 特写（2m 机位）× 4 轮 + 车顶特写（白变体）
const onlyCloseups = process.argv[2] === 'closeups';
if (!onlyCloseups) {
  for (const car of ['v800', 'r7']) {
    await capture(car, 'white', 'roof', '-closeup');
  }
}
if (onlyCloseups || !process.argv[2]) {
  for (const car of ['v800', 'r7']) {
    for (const t of ['fl', 'fr', 'rl', 'rr']) {
      await capture(car, 'white', `wheel-${t}`, '-closeup');
    }
  }
}

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log('REPORT ->', `${OUT}/report.json`);
await browser.disconnect();
await vite.close();
