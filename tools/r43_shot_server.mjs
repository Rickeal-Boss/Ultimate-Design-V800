/** R43 QA 存图服务：preview.ts 用 #cam= 机位钩子把 canvas 的 PNG POST 过来落盘。
 *  纯 dev 工具，不参与构建。用法:
 *    node tools/r43_shot_server.mjs [--port 5399] [--dir .qa/r43_car/shots]
 *  页面端: http://127.0.0.1:5273/preview.html?v=<nonce>#assembled&cam=225,6,9.2&shot=name
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '5399'));
const DIR = arg('dir', '.qa/r43_car/shots');
fs.mkdirSync(DIR, { recursive: true });

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST,OPTIONS'
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/note') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const name = (url.searchParams.get('name') || 'note').replace(/[^\w.-]/g, '_');
      const f = path.join(DIR, `${name}.txt`);
      fs.writeFileSync(f, Buffer.concat(chunks));
      console.log(`NOTE ${f} ${fs.statSync(f).size} bytes`);
      res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
    });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/shot') {
    res.writeHead(404).end('r43 shot server');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_');
    const body = Buffer.concat(chunks).toString('utf8');
    const b64 = body.replace(/^data:image\/png;base64,/, '');
    const f = path.join(DIR, `${name}.png`);
    try {
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      const n = fs.statSync(f).size;
      console.log(`SAVED ${f} ${n} bytes`);
      res.writeHead(200, { 'access-control-allow-origin': '*' }).end(`ok ${n}`);
    } catch (e) {
      console.log(`FAIL ${f} ${String(e)}`);
      res.writeHead(500, { 'access-control-allow-origin': '*' }).end('fail');
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`r43 shot server on 127.0.0.1:${PORT} → ${DIR}`));
