// 多机位截图 + 运行时指标 + 逐组件 world box 采集
// 用法: VURL=http://127.0.0.1:5177/preview.html OUT=.img2threejs/renders/structural-pass node capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.env.VURL;
const outDir = process.env.OUT;
const port = Number(process.env.CDPPORT || 9333);
const mode = process.env.MODE || 'structural'; // structural | micro

fs.mkdirSync(outDir, { recursive: true });

// 浏览器由 bash 会话内联 spawn，此处仅 connect 到已有 CDP 端点
const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${port}`,
  defaultViewport: null,
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// 等待 harness 就绪
await page.waitForFunction(
  () => {
    const s = document.getElementById('status');
    return !!s && /ready|captured/.test(s.textContent || '');
  },
  { timeout: 90000 }
);

const info = await page.evaluate(() => window.__v800Info());
console.log('INFO tris=' + info.tris + ' calls=' + info.calls + ' box=' + JSON.stringify(info.box.map(v => Math.round(v*1000)/1000)));

// 逐组件 world box
const parts = await page.evaluate(() => window.__v800Parts());
fs.writeFileSync(path.join(outDir, 'parts.json'), JSON.stringify(parts, null, 1), 'utf8');
console.log('PARTS count=' + parts.length);

const angles = [
  { name: 'az000', az: 0, pitch: 8, dist: 9.0 },
  { name: 'az090', az: 90, pitch: 8, dist: 9.0 },
  { name: 'az180', az: 180, pitch: 8, dist: 9.0 },
  { name: 'az270', az: 270, pitch: 8, dist: 9.0 },
  { name: 'hero', az: 40, pitch: 12, dist: 8.4 },
  { name: 'top', az: 40, pitch: 42, dist: 9.5 },
];

for (const a of angles) {
  const dataUrl = await page.evaluate(
    (n, az, pi, d) => window.__v800Capture(n, az, pi, d, 0),
    a.name, a.az, a.pitch, a.dist
  );
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const file = path.join(outDir, `${a.name}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('SHOT ' + a.name + ' az=' + a.az + ' bytes=' + fs.statSync(file).size);
}

if (mode === 'micro' || mode === 'stripped4') {
  // stripped 素模证据（无贴图纯白 + 纯黑背景）
  for (const a of angles) {
    const dataUrl = await page.evaluate(
      (n, az, pi, d) => window.__v800Capture('stripped-' + n, az, pi, d, 0, true),
      a.name, a.az, a.pitch, a.dist
    );
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(outDir, `stripped-${a.name}.png`), Buffer.from(b64, 'base64'));
    console.log('SHOT stripped-' + a.name);
  }
}

fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n'), 'utf8');
console.log('CONSOLE_ERRORS=' + logs.filter(l => /\[error\]|\[pageerror\]/.test(l)).length);
if (logs.length) console.log(logs.slice(0, 20).join('\n'));

browser.disconnect();
console.log('DONE');
// stripped 四方位补充（供 segmentation 可靠的门禁用）
