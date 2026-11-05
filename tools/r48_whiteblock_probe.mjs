/**
 * R48 白块消去法：逐项隐藏候选 mesh 出图，定位 R7 尾灯纯白矩形块的来源。
 * 用法：tools/r46_capture.ps1 -NodeScript r48_whiteblock_probe.mjs -EdgePort 9514 \
 *        -NodeArgs '--car=r7 --port=9514 --httpport=5219'
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const CAR = String(argv.car || 'r7');
const EDGE_PORT = Number(argv.port || 9503);
const HTTP_PORT = Number(argv.httpport || 5213);

function httpJson(p, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2500 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createServer } = await import('vite');
  const v = await createServer({ root: ROOT,
    server: { port: HTTP_PORT, host: '127.0.0.1', strictPort: true,
      watch: { ignored: ['**/dist/**', '**/.qa/**', '**/verify/**', '**/node_modules/**',
        '**/.img2threejs/**', '**/tools/**', '**/src/assets/**'] } },
    logLevel: 'error' });
  await v.listen();
  const ver = await httpJson('/json/version', EDGE_PORT);
  const browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/index.html#vehicle=${CAR}&paint=white&view=rear34&r44ext=on`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate((c) => ({
      done: !!document.getElementById('loading')?.classList.contains('done'),
      shell: window.__r44Shell?.[c]?.state ?? null, hasGame: !!window.__game
    }), CAR).catch(() => ({ err: 1 }));
    if (st.done && (st.shell === 'ready' || st.shell === 'failed')) break;
    await wait(1000);
  }
  await wait(7000);
  await page.evaluate(() => {
    const m = document.getElementById('menu'); if (m) m.style.display = 'none';
  });

  const out = path.join(ROOT, 'verify/r46/after');
  // ⚠ 必须用 __v800EnvShot 指定 rear34 相机：#view=rear34 不在 Game 的 QA 已知机位表，
  // 直接 page.screenshot() 只会拍到默认车头机位（首次消去法即因此作废）。
  const shoot = async (name) => {
    const data = await page.evaluate(() =>
      window.__v800EnvShot?.('r48elim', -3.6, 1.6, 6.4, 0, 0.75, 0, 42) ?? null);
    if (!data) { console.log('ENV_SHOT_MISSING ' + name); return; }
    const f = path.join(out, 'r48cover_' + name + '.png');
    fs.writeFileSync(f, Buffer.from(
      String(data).replace(/^data:image\/(png|jpeg);base64,/, ''), 'base64'));
    console.log('SHOT r48cover_' + name + '.png');
  };
  // 记录原始可见态，便于逐项恢复
  await page.evaluate(() => {
    const g = window.__game;
    window.__r48Saved = [];
    g.car.root.traverse((o) => { if (o.isMesh) window.__r48Saved.push([o, o.visible]); });
  });
  const hide = async (pred) => {
    const n = await page.evaluate((p) => {
      const rx = new RegExp(p, 'i'); let n = 0;
      for (const [o] of window.__r48Saved) {
        if (rx.test(o.name || '')) { o.visible = false; n++; }
      }
      return n;
    }, pred);
    await wait(400);
    return n;
  };
  const restore = async () => {
    await page.evaluate(() => { for (const [o, vis] of window.__r48Saved) o.visible = vis; });
    await wait(400);
  };

  await shoot('00_base');
  console.log('HIDE lamp_rear* =', await hide('^lamp_rear'));
  await shoot('01_no_lampRear');
  await restore();
  console.log('HIDE body =', await hide('^body$'));
  await shoot('02_no_body');
  await restore();
  console.log('HIDE lamp_front =', await hide('^lamp_front'));
  await shoot('03_no_lampFront');
  await restore();
  console.log('HIDE all ext =', await page.evaluate(() => {
    let n = 0;
    for (const [o] of window.__r48Saved) {
      if (o.userData?.r44External === true) { o.visible = false; n++; }
    }
    return n;
  }));
  await wait(400);
  await shoot('04_no_external');

  await page.close();
  await browser.disconnect();
  await v.close();
}
main().catch((e) => { console.error('PROBE_FAIL', e); process.exitCode = 1; });
