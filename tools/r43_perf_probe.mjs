/**
 * R43-P0C 「越快越掉帧」定量探针（连接已启动的 Edge，不改 src）
 *
 * 依赖：Edge 已由 PowerShell 用 --remote-debugging-port=<PORT> 启动（本脚本只 connect）。
 * 用法：
 *   node tools/r43_perf_probe.mjs challenge <tag> [hashExtra]
 *   node tools/r43_perf_probe.mjs ladder    <tag> [hashExtra] [--pin] [--step=4000] [--speeds=0,10,20,30,40,50]
 *   node tools/r43_perf_probe.mjs ladder    <tag> --w=640 --h=380      （分辨率 A/B，改变 viewport 即可）
 *
 * 产物：.qa/r43_perf/<tag>.json（逐帧原始数组，分析见 tools/r43_analyze.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = path.join(ROOT, '.qa/r43_perf');
fs.mkdirSync(OUT, { recursive: true });

const MODE = process.argv[2] || 'challenge';
const TAG = process.argv[3] || 'run';
const HASH_EXTRA = process.argv.slice(4).find((a) => !a.startsWith('--')) || '';
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => process.argv.includes(`--${k}`);

const PORT = Number(arg('port', '9500'));
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '760'));
const STEP_MS = Number(arg('step', '4000'));
const SPEEDS = arg('speeds', '0,10,20,30,40,50').split(',').map(Number);
const PIN = flag('pin');
const MAX_WALL_MS = Number(arg('maxwall', '240000'));
const BASE = `http://127.0.0.1:${arg('viteport', '5300')}/index.html`;
const HASH = ['#quality=high', 'gpufake=discrete', HASH_EXTRA].filter(Boolean).join('&').replace('#', '#');
const URL_FULL = `${BASE}${HASH}`;
const INSTRUMENT = fs.readFileSync(path.join(ROOT, 'tools/r43_instrument.js'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let browser;
  let page;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
    page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 300)));
    console.log('GOTO', URL_FULL);
    await page.goto(URL_FULL, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(
      () => window.__game && document.getElementById('loading') && document.getElementById('loading').classList.contains('done'),
      { timeout: 300000, polling: 200 }
    );
    await wait(800);

    const client = await page.createCDPSession();
    await client.send('Performance.enable').catch(() => {});
    const metricsOf = async () => {
      try {
        const { metrics } = await client.send('Performance.getMetrics');
        const o = {};
        for (const m of metrics) o[m.name] = m.value;
        return o;
      } catch { return {}; }
    };

    const inst = await page.evaluate(INSTRUMENT);
    console.log('INSTRUMENT', inst);
    if (String(inst).startsWith('NO_GAME')) throw new Error('no __game');
    if (MODE !== 'ladder' && MODE !== 'ablate' && MODE !== 'res') {
      // 低帧率补偿：SwiftShader 上 0.7s/帧 ⇒ 0.1s 上限会让一轮挑战跑 3.5 倍墙钟
      const mft = await page.evaluate(() => window.__r43.setMaxFrameTime(0.35));
      console.log('maxFrameTime=', mft);
    }
    const prewarmLog = logs.filter((l) => /\[R41\]/.test(l)).join('\n');
    if (prewarmLog) console.log('PREWARM:', prewarmLog.slice(0, 400));

    const m0 = await metricsOf();
    let meta = {};

    if (MODE === 'player') {
      // 真人路径（#autodrive 不可用于高速段：它一过 100km/h 就自动切刹车）：
      // 直接写滑条态 = 玩家把油门拉满 → 到 195km/h 切刹车 0.9 → 跑到停/撞。
      const brakeKmh = Number(arg('brakekmh', '195'));
      await page.evaluate(() => window.__r43.start());
      const t0 = Date.now();
      let braked = false;
      let last = '';
      while (Date.now() - t0 < MAX_WALL_MS) {
        const st = await page.evaluate((bk) => {
          const g = window.__game;
          const out = {
            phase: g.sm.phase,
            kmh: g.sm.speedKmh,
            z: g.car.root.position.z,
            n: window.__r43.n(),
            throttle: g.sliders.throttle
          };
          // Sliders.throttle/brake 是 getter（读 smooth*/key*）⇒ 必须写私有字段
          if (g.sm.phase === 'accel') {
            if (g.sm.speedKmh < bk) {
              g.sliders.throttleValue = 1;
            } else {
              g.sliders.throttleValue = 0;
              g.sliders.brakeValue = 0.9;
            }
          }
          return out;
        }, brakeKmh);
        const now = `${st.phase} kmh=${st.kmh.toFixed(0)} z=${st.z.toFixed(0)} n=${st.n}`;
        if (now !== last) { console.log('  ', now); last = now; }
        if (st.phase === 'brake' && !braked) { braked = true; console.log('  >>> BRAKE ENGAGED'); }
        if ((st.phase === 'stopped' || st.phase === 'crashed') && st.n > 30) {
          await wait(1500);
          break;
        }
        await wait(400);
      }
      meta = await page.evaluate(() => window.__r43.state());
    } else if (MODE === 'challenge') {
      await page.evaluate(() => window.__r43.start());
      const t0 = Date.now();
      let last = '';
      while (Date.now() - t0 < MAX_WALL_MS) {
        const st = await page.evaluate(() => window.__r43.state());
        const now = `${st.phase} spd=${st.speed.toFixed(1)} z=${st.z.toFixed(0)} n=${st.n}`;
        if (now !== last) { console.log('  ', now); last = now; }
        if ((st.phase === 'stopped' || st.phase === 'crashed') && st.n > 30) {
          await wait(1500);
          break;
        }
        await wait(500);
      }
      meta = await page.evaluate(() => window.__r43.state());
    } else if (MODE === 'ablate') {
      // 成本消去法：固定机位 + 固定速度，逐项关组件，看帧间隔下降多少 = 该项实测单价
      const steps = arg(
        'steps',
        'base,noshadow,nobloom,noblur,nocastle,noother,nosky,nofx,nocar,alloff,base'
      ).split(',');
      const spd = Number(arg('speed', '0'));
      const r0 = await page.evaluate((pin) => window.__r43.ladderEnter(pin), PIN);
      console.log('LADDER_ENTER(ablate)', r0, 'pin=', PIN, 'speed=', spd);
      await wait(800);
      const zPin = Number(arg('z', '-400'));
      await page.evaluate((a) => window.__r43.ladder(a[0], 0, a[1]), [spd, zPin]);
      let li = 0;
      const labels = [];
      for (const st of steps) {
        const ok = await page.evaluate((n) => window.__r43.ablate(n), st);
        li += 1;
        labels.push(`${li}=${st}`);
        await page.evaluate((n) => window.__r43.setLabel(n), li);
        await wait(STEP_MS);
        console.log(`  ABLATE ${st} -> ${ok} label=${li}`);
      }
      await page.evaluate(() => { window.__r43.ablate('base'); window.__r43.ladder(0); });
      meta = await page.evaluate(() => window.__r43.state());
      meta.labels = labels;
    } else if (MODE === 'res') {
      // 分辨率扫描：同一页面/同一位置/同一速度，只改 canvas 尺寸 ⇒ 纯填充率敏感度
      // （SwiftShader 软光栅：像素数是唯一变量；用于回答「光栅化瓶颈 or 提交/事件瓶颈」）
      const resList = arg('res', '1280x760,960x570,640x380,480x285,320x190').split(',');
      const spd = Number(arg('speed', '0'));
      const r0 = await page.evaluate((pin) => window.__r43.ladderEnter(pin), PIN);
      console.log('LADDER_ENTER(res)', r0, 'pin=', PIN);
      await wait(1000);
      await page.evaluate((s) => window.__r43.ladder(s, 0, -400), spd);
      let li = 1;
      for (const rs of resList) {
        const [rw, rh] = rs.split('x').map(Number);
        await page.setViewport({ width: rw, height: rh, deviceScaleFactor: 1 });
        await page.evaluate(() => window.__r43.resize());
        await page.evaluate((n) => window.__r43.setLabel(n), li);
        await wait(Number(arg('resstep', '4000')));
        console.log(`  RES ${rs} label=${li}`);
        li += 1;
      }
      meta = await page.evaluate(() => window.__r43.state());
      meta.resList = resList;
    } else {
      const r = await page.evaluate((pin) => window.__r43.ladderEnter(pin), PIN);
      console.log('LADDER_ENTER', r, 'pin=', PIN);
      await wait(1200);
      for (const v of SPEEDS) {
        try {
          const n0 = await page.evaluate((s) => window.__r43.ladder(s, 0, -400), v);
          console.log(`  SPEED ${v} m/s @frame ${n0}`);
        } catch (e) {
          console.log(`  SPEED ${v} FAILED: ${String(e).slice(0, 200)}`);
          break;
        }
        await wait(STEP_MS);
        console.log(`    -> n=${await page.evaluate(() => window.__r43.n()).catch(() => -1)}`);
      }
      // 最后一段归零（释放粒子/特效），再 dump
      await page.evaluate(() => window.__r43.ladder(0));
      await wait(600);
      meta = await page.evaluate(() => window.__r43.state());
    }

    const m1 = await metricsOf();
    const data = await page.evaluate(() => window.__r43.dump());
    const out = {
      meta: {
        mode: MODE,
        tag: TAG,
        url: URL_FULL,
        viewport: [W, H],
        stepMs: STEP_MS,
        speeds: SPEEDS,
        pin: PIN,
        endState: meta,
        cdpMetrics0: m0,
        cdpMetrics1: m1,
        taskDurationDelta: (m1.TaskDuration ?? 0) - (m0.TaskDuration ?? 0),
        scriptDurationDelta: (m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0),
        layoutDurationDelta: (m1.LayoutDuration ?? 0) - (m0.LayoutDuration ?? 0),
        jsHeapUsedEnd: m1.JSHeapUsedSize,
        logs: logs.slice(-30)
      },
      frames: data
    };
    const file = path.join(OUT, `${TAG}.json`);
    fs.writeFileSync(file, JSON.stringify(out));
    console.log('SAVED', file, `${(fs.statSync(file).size / 1e6).toFixed(2)} MB`, 'frames=', data.n);
    console.log('TASKDUR(s)', out.meta.taskDurationDelta.toFixed(3), 'SCRIPT(s)', out.meta.scriptDurationDelta.toFixed(3));
  } catch (e) {
    console.error('FAIL', String(e).slice(0, 1200));
    process.exitCode = 1;
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.disconnect(); } catch {}
  }
}
main();
