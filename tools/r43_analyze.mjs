/**
 * R43-P0C 分析器（离线，纯读 .qa/r43_perf/*.json）
 *
 * 用法：
 *   node tools/r43_analyze.mjs challenge r43_chal_A [r43_chal_B r43_chal_C]   # 可多轮合并
 *   node tools/r43_analyze.mjs ladder r43_ladder_pin
 *   node tools/r43_analyze.mjs ablate r43_ablate
 *   node tools/r43_analyze.mjs res    r43_res_sweep
 *
 * 口径提醒：
 *  · 帧时用 **frameGap**（相邻两帧 qualityGovernor.update 入口的 wall 差），不用 dt
 *    （dt 被 Loop 的 maxFrameTime 钳制：挑战 0.1s / autodrive 0.35s，会削平长帧尾部）。
 *  · 「掉帧」= frameGap > 1.5×该桶中位数；「长帧」= > 2× 该桶中位数。用桶内相对判据，
 *    因为 SwiftShader 的绝对帧时是 CPU 软光栅（与真机 iGPU 无比例关系）。
 *  · 结构事件 = 本帧 prog/tex/geo 相对上一帧**增长**≥1，或 dpr 变化，或 zswap>0。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const DIR = path.join(ROOT, '.qa/r43_perf');
const MODE = process.argv[2];
const FILES = process.argv.slice(3);
const outLines = [];
const say = (...a) => { const s = a.join(' '); console.log(s); outLines.push(s); };

const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const qtl = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : NaN; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) : NaN; };
const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const pearson = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 8) return NaN;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
};

function load(tag) {
  const p = path.join(DIR, `${tag}.json`);
  if (!fs.existsSync(p)) throw new Error('missing ' + p);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const H = d.frames.head;
  const n = d.frames.n;
  const segs = d.frames.segs;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const seg = {};
    let js = 0;
    for (const k of segs) { const v = H['seg_' + k][i]; seg[k] = v; js += v; }
    rows.push({
      i,
      gap: H.frameGap[i],
      t: H.t[i],
      dt: H.dt[i],
      speed: H.speed[i],
      spdTarget: H.spdTarget[i],
      label: H.label[i],
      carZ: H.carZ[i],
      camZ: H.camZ[i],
      phase: H.phase[i],
      dpr: H.dpr[i],
      calls: H.calls[i],
      tris: H.tris[i],
      prog: H.prog[i],
      tex: H.tex[i],
      geo: H.geo[i],
      zones: H.zones[i],
      zhi: H.zhi[i],
      gate: H.gate[i],
      fxLive: H.fxLive[i],
      heap: H.heap[i],
      winW: H.winW[i],
      winH: H.winH[i],
      steps: H.steps ? H.steps[i] : 0,
      zEvents: H.zEvents ? H.zEvents[i] : 0,
      zswapN: H.zswapN ? H.zswapN[i] : 0,
      js,
      seg
    });
  }
  return { meta: d.meta, rows };
}

/** 逐帧结构事件标记（返回新数组，不污染原始行） */
function structural(rows) {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    b.dProg = b.prog - a.prog;
    b.dTex = b.tex - a.tex;
    b.dGeo = b.geo - a.geo;
    b.dDpr = Math.abs(b.dpr - a.dpr) > 1e-6 ? 1 : 0;
    b.dZones = b.zones - a.zones;
    // 「冷启动事件」= GPU 侧首次上传/编译/降档重建（R39-R42 三轮主攻的那类）
    b.uploadEvt = (b.dProg > 0 || b.dTex > 0 || b.dGeo > 0 || b.dDpr > 0) ? 1 : 0;
    // 「内容事件」= 城堡分区跨 550m 显隐闸门 / hi↔lo 换档（频率 ∝ 车速）
    b.znev = (b.zEvents || 0) + (b.zswapN || 0);
    b.structEvt = (b.uploadEvt || b.znev > 0) ? 1 : 0;
    b.gc = a.heap > 0 && b.heap > 0 && a.heap - b.heap > 1e6 ? 1 : 0;
  }
  if (rows.length) { rows[0].structEvt = 0; rows[0].gc = 0; rows[0].uploadEvt = 0; rows[0].znev = 0; }
  return rows;
}

const BUCKETS = [
  [0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 999]
];

function bucketTable(rows, label) {
  say('## ' + label + '（按车速分桶；帧时 = frameGap，相对判据）');
  say('| 速度桶 m/s | n | p50 ms | p95 ms | p99 ms | max ms | std ms | 掉帧率>1.5× | 长帧率>2× | JS合计 p50 | 未归属 p50 | calls | tris |');
  say('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const outCsv = ['bucket,n,p50,p95,p99,max,std,dropRate,longRate,js_p50,unattr_p50,calls,tris,meanSpeed'];
  for (const [lo, hi] of BUCKETS) {
    const g = rows.filter((r) => r.gap > 0 && r.speed >= lo && r.speed < hi);
    if (g.length < 5) { say(`| ${lo}-${hi === 999 ? '+' : hi} | ${g.length} | — 样本不足（<5）— |||||||||||`); continue; }
    const gaps = g.map((r) => r.gap);
    const m = med(gaps);
    const drop = g.filter((r) => r.gap > 1.5 * m).length / g.length;
    const long = g.filter((r) => r.gap > 2 * m).length / g.length;
    const js = g.map((r) => r.js);
    const un = g.map((r) => r.gap - r.js);
    say(`| ${lo}-${hi === 999 ? '+' : hi} | ${g.length} | ${f1(med(gaps), 0)} | ${f1(qtl(gaps, 0.95), 0)} | ${f1(qtl(gaps, 0.99), 0)} | ${f1(Math.max(...gaps), 0)} | ${f1(sd(gaps), 0)} | ${f1(drop * 100)}% | ${f1(long * 100)}% | ${f1(med(js), 1)} | ${f1(med(un), 0)} | ${f1(med(g.map((r) => r.calls)), 0)} | ${f1(med(g.map((r) => r.tris)), 0)} |`);
    outCsv.push([`${lo}-${hi === 999 ? '+' : hi}`, g.length, med(gaps).toFixed(1), qtl(gaps, .95).toFixed(1), qtl(gaps, .99).toFixed(1), Math.max(...gaps).toFixed(1), sd(gaps).toFixed(1), (drop * 100).toFixed(1), (long * 100).toFixed(1), med(js).toFixed(2), med(un).toFixed(1), med(g.map((r) => r.calls)).toFixed(0), med(g.map((r) => r.tris)).toFixed(0), mean(g.map((r) => r.speed)).toFixed(1)].join(','));
  }
  say('');
  return outCsv;
}

function segTable(rows) {
  say('## 子系统主线程 CPU 时间（ms/帧）与车速相关性');
  say('| 子系统 | p50 | p95 | max | 占比(JS合计) | 高桶(≥40m/s) p50 | 低桶(<20m/s) p50 | 增速(ms per m/s) | Pearson r |');
  say('|---|---|---|---|---|---|---|---|---|');
  const segs = Object.keys(rows[0].seg);
  const jsTot = med(rows.map((r) => r.js));
  const fast = rows.filter((r) => r.speed >= 40);
  const slow = rows.filter((r) => r.speed < 20);
  const outCsv = ['seg,p50,p95,max,share,fast_p50,slow_p50,slope_ms_per_ms,r'];
  const out = [];
  for (const k of segs) {
    const vals = rows.map((r) => r.seg[k]);
    if (Math.max(...vals) === 0) continue;
    const sp = rows.map((r) => r.speed);
    // 线性回归斜率（ms per (m/s)）
    const mx = mean(sp), my = mean(vals);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < vals.length; i++) { const dx = sp[i] - mx; sxy += dx * (vals[i] - my); sxx += dx * dx; }
    const slope = sxx > 0 ? sxy / sxx : NaN;
    const r = pearson(sp, vals);
    const fastP = fast.length ? med(fast.map((x) => x.seg[k])) : NaN;
    const slowP = slow.length ? med(slow.map((x) => x.seg[k])) : NaN;
    out.push({ k, p50: med(vals), fastP, slope, r });
    say(`| ${k} | ${f1(med(vals), 2)} | ${f1(qtl(vals, .95), 2)} | ${f1(Math.max(...vals), 2)} | ${f1((med(vals) / jsTot) * 100)}% | ${f1(fastP, 2)} | ${f1(slowP, 2)} | ${f1(slope, 4)} | ${f1(r, 2)} |`);
    outCsv.push([k, med(vals).toFixed(3), qtl(vals, .95).toFixed(3), Math.max(...vals).toFixed(3), ((med(vals) / jsTot) * 100).toFixed(1), fastP.toFixed(3), slowP.toFixed(3), slope.toFixed(5), r.toFixed(3)].join(','));
  }
  say('');
  out.sort((a, b) => b.slope - a.slope);
  say('按「随车速增速」排序：' + out.map((o) => `${o.k}(${f1(o.slope, 4)} ms/(m/s), r=${f1(o.r, 2)})`).join(' > '));
  say('');
  return outCsv;
}

function structTable(rows) {
  say('## 结构事件帧 vs 长帧');
  const mAll = med(rows.map((r) => r.gap).filter((x) => x > 0));
  const long = rows.filter((r) => r.gap > 2 * mAll && r.gap > 0);
  const evt = rows.filter((r) => r.structEvt);
  const longEvt = long.filter((r) => r.structEvt);
  say(`- 全样本 ${rows.length} 帧，中位帧时 ${f1(mAll, 0)}ms`);
  say(`- 结构事件帧 ${evt.length} 帧（${f1((evt.length / rows.length) * 100)}%），长帧 ${long.length} 帧`);
  say(`- **长帧中命中结构事件的比例：${f1((longEvt.length / Math.max(1, long.length)) * 100)}%**（${longEvt.length}/${long.length}）`);
  say(`- 结构事件帧帧时中位 ${f1(med(evt.map((r) => r.gap)), 0)}ms vs 非事件帧 ${f1(med(rows.filter((r) => !r.structEvt).map((r) => r.gap)), 0)}ms`);
  const kinds = { prog: 0, tex: 0, geo: 0, dpr: 0, zoneVis: 0, tierSwap: 0 };
  for (const r of evt) {
    if (r.dProg > 0) kinds.prog++; if (r.dTex > 0) kinds.tex++; if (r.dGeo > 0) kinds.geo++;
    if (r.dDpr) kinds.dpr++; if (r.zEvents > 0) kinds.zoneVis++; if (r.zswapN > 0) kinds.tierSwap++;
  }
  say('- 事件类型计数：' + JSON.stringify(kinds));
  say(`- **冷启动类**（prog/tex/geo/dpr 阶跃）帧数 = ${rows.filter((r) => r.uploadEvt).length} / ${rows.length}`);
  say('');
  // 分桶：每秒事件数（按 wall 时间）
  say('| 速度桶 | 帧数 | 内容事件/秒 | 冷启动事件/帧 | 长帧 | 长帧含事件占比 | GC/秒 |');
  say('|---|---|---|---|---|---|---|');
  const csv = ['bucket,frames,zEvtPerSec,uploadPerFrame,long,longEvtPct,gcPerSec'];
  for (const [lo, hi] of BUCKETS) {
    const g = rows.filter((r) => r.gap > 0 && r.speed >= lo && r.speed < hi);
    if (g.length < 5) { say(`| ${lo}-${hi === 999 ? '+' : hi} | ${g.length} | 样本不足 |`); continue; }
    const wall = g.reduce((s, r) => s + r.gap, 0) / 1000;
    const zsum = g.reduce((s, r) => s + (r.znev || 0), 0);
    const up = g.filter((r) => r.uploadEvt).length;
    const l = g.filter((r) => r.gap > 2 * med(g.map((x) => x.gap)));
    const le = l.filter((r) => r.structEvt).length;
    const gc = g.filter((r) => r.gc).length;
    say(`| ${lo}-${hi === 999 ? '+' : hi} | ${g.length} | ${f1(zsum / wall, 2)} | ${f1(up / g.length, 3)} | ${l.length} | ${f1((le / Math.max(1, l.length)) * 100)}% | ${f1(gc / wall, 2)} |`);
    csv.push([`${lo}-${hi === 999 ? '+' : hi}`, g.length, (zsum / wall).toFixed(3), (up / g.length).toFixed(3), l.length, ((le / Math.max(1, l.length)) * 100).toFixed(1), (gc / wall).toFixed(3)].join(','));
  }
  say('');
  return csv;
}

function groupTable(rows, keyFn, title, keyName) {
  say('## ' + title);
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (k === undefined || k === null) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  say(`| ${keyName} | n | gap p50 | gap p90 | gap min | JS p50 | render p50 | 未归属 p50 | calls | tris | zones | zhi |`);
  say('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const csv = [`${keyName},n,gap_p50,gap_p90,gap_min,js_p50,render_p50,unattr_p50,calls,tris,zones,zhi`];
  for (const k of keys) {
    const g = groups.get(k).filter((r) => r.gap > 0);
    if (!g.length) continue;
    const gaps = g.map((r) => r.gap);
    say(`| ${k} | ${g.length} | ${f1(med(gaps), 0)} | ${f1(qtl(gaps, .9), 0)} | ${f1(Math.min(...gaps), 0)} | ${f1(med(g.map((r) => r.js)), 1)} | ${f1(med(g.map((r) => r.seg.render)), 1)} | ${f1(med(g.map((r) => r.gap - r.js)), 0)} | ${f1(med(g.map((r) => r.calls)), 0)} | ${f1(med(g.map((r) => r.tris)), 0)} | ${f1(med(g.map((r) => r.zones)), 0)} | ${f1(med(g.map((r) => r.zhi)), 0)} |`);
    csv.push([k, g.length, med(gaps).toFixed(1), qtl(gaps, .9).toFixed(1), Math.min(...gaps).toFixed(1), med(g.map((r) => r.js)).toFixed(2), med(g.map((r) => r.seg.render)).toFixed(2), med(g.map((r) => r.gap - r.js)).toFixed(1), med(g.map((r) => r.calls)).toFixed(0), med(g.map((r) => r.tris)).toFixed(0), med(g.map((r) => r.zones)).toFixed(0), med(g.map((r) => r.zhi)).toFixed(0)].join(','));
  }
  say('');
  return csv;
}

function save(name, lines) { fs.writeFileSync(path.join(DIR, name), lines.join('\n') + '\n'); }

// ── main ────────────────────────────────────────────────────────────────
const loaded = FILES.map((t) => ({ tag: t, ...load(t) }));
const allRows = loaded.flatMap((L) => L.rows.map((r) => ({ ...r, seg: { ...r.seg }, file: L.tag })));
say(`# R43-P0C 分析 · mode=${MODE} · files=${FILES.join(',')} · frames=${allRows.length}`);
say('');
for (const L of loaded) say(`- ${L.tag}: frames=${L.rows.length} viewport=${L.rows[0]?.winW}x${L.rows[0]?.winH} taskDur=${f1(L.meta.taskDurationDelta, 2)}s scriptDur=${f1(L.meta.scriptDurationDelta, 3)}s heapEnd=${L.meta.jsHeapUsedEnd}`);
say('');
const rows = structural(allRows.filter((r) => r.gap > 0 || r.i === 0));

if (MODE === 'challenge') {
  const csv1 = bucketTable(rows, '车速分桶（挑战路径全流程）');
  const csv2 = segTable(rows);
  const csv3 = structTable(rows);
  // 结构事件 vs 车速（每 10 m/s）
  save('csv_challenge_buckets.csv', csv1);
  save('csv_challenge_segs.csv', csv2);
  save('csv_challenge_struct.csv', csv3);
  // 位置（carZ）分桶，用于剥离「位置=内容量」影响
  const csv4 = groupTable(rows, (r) => Math.round(r.carZ / 200) * 200, '位置分桶（carZ 每 200m；判「内容量 vs 车速」）', 'carZ档');
  save('csv_challenge_pos.csv', csv4);
  // 只在「直线高速段」内比较位置固定、速度不同：按 speed 与 tris 双因子
  say('## 双因子：同一 tris 档内按车速分桶（剥离内容量）');
  say('| tris 档 | 速度桶 | n | gap p50 | gap p90 | JS p50 |');
  say('|---|---|---|---|---|---|');
  const triBins = new Map();
  for (const r of rows) { const k = Math.round(r.tris / 50000) * 50000; if (!triBins.has(k)) triBins.set(k, []); triBins.get(k).push(r); }
  for (const k of [...triBins.keys()].sort((a, b) => a - b)) {
    const g = triBins.get(k);
    for (const [lo, hi] of [[0, 20], [20, 40], [40, 999]]) {
      const gg = g.filter((r) => r.speed >= lo && r.speed < hi).map((r) => r.gap);
      if (gg.length < 4) continue;
      say(`| ${k} | ${lo}-${hi === 999 ? '+' : hi} | ${gg.length} | ${f1(med(gg), 0)} | ${f1(qtl(gg, .9), 0)} | ${f1(med(g.filter((r) => r.speed >= lo && r.speed < hi).map((r) => r.js)), 1)} |`);
    }
  }
  say('');
} else if (MODE === 'ladder') {
  const csv = groupTable(rows, (r) => r.spdTarget, '速度阶梯（钉位=同一内容量；非钉位=真实位移）', '目标速度 m/s');
  save('csv_ladder.csv', csv);
  segTable(rows.filter((r) => r.spdTarget >= 0));
} else if (MODE === 'ablate' || MODE === 'res') {
  const labels = loaded[0].meta.endState?.labels ?? [];
  const map = new Map();
  for (const l of labels) { const [id, name] = l.split('='); map.set(Number(id), name); }
  const csv = groupTable(rows, (r) => { const n = map.get(r.label); return n === undefined ? undefined : `${r.label}:${n}`; }, MODE === 'res' ? '分辨率扫描' : '成本消去法', 'label');
  save(`csv_${MODE}.csv`, csv);
  // 相对基线
  const base = rows.filter((r) => map.get(r.label) === 'base' || map.get(r.label) === undefined);
  if (MODE === 'ablate' && base.length) {
    const bm = med(base.slice(1).map((r) => r.gap));
    say(`基线（base 标签，${base.length - 1} 帧，中位 ${f1(bm, 0)}ms）逐项削减量：`);
    const ids = [...new Set(rows.map((r) => r.label))].sort((a, b) => a - b);
    for (const id of ids) {
      const nm = map.get(id) || String(id);
      if (nm === 'base') continue;
      const g = rows.filter((r) => r.label === id && r.gap > 0);
      if (!g.length) continue;
      const m = med(g.map((r) => r.gap));
      say(`  - ${nm}: ${f1(m, 0)}ms ⇒ 削减 ${f1(bm - m, 0)}ms（${f1(((bm - m) / bm) * 100)}%）`);
    }
  }
  if (MODE === 'res') {
    // 线性拟合 gap ≈ a + b·px
    const pts = [];
    const labels2 = [...new Set(rows.map((r) => r.label))].sort((a, b) => a - b);
    for (const id of labels2) {
      const g = rows.filter((r) => r.label === id && r.gap > 0);
      if (g.length < 2) continue;
      pts.push({ px: g[0].winW * g[0].winH, gap: med(g.map((r) => r.gap)), n: g.length, w: g[0].winW, h: g[0].winH });
    }
    const mx = mean(pts.map((p) => p.px)), my = mean(pts.map((p) => p.gap));
    let sxy = 0, sxx = 0;
    for (const p of pts) { sxy += (p.px - mx) * (p.gap - my); sxx += (p.px - mx) ** 2; }
    const b = sxy / sxx, a = my - b * mx;
    say(`分辨率拟合：gap ≈ ${f1(a, 0)}ms + ${f1(b * 1000, 4)}ms/kpx（斜率）；r=` + f1(pearson(pts.map((p) => p.px), pts.map((p) => p.gap)), 3));
    say('点位：' + pts.map((p) => `${p.w}x${p.h}=${(p.px / 1000).toFixed(0)}kpx→${p.gap.toFixed(0)}ms(n=${p.n})`).join(', '));
  }
}
say('');
save(`report_${MODE}_${FILES.join('+')}.txt`, outLines);
console.log('WROTE', path.join(DIR, `report_${MODE}_${FILES.join('+')}.txt`));
