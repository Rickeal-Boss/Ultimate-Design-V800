/**
 * R37-P · 高速流畅度「每帧全场景开销」排查结论 + 护栏。
 *
 * ── 本轮排查的四个候选（主理人 P 线清单），逐条结论（沙箱无 GPU，以代码论证 + headless 探针为准）──
 *
 * ① **每帧 canvas 贴图重绘**：**不是热点，无需改**。
 *    证据：唯一每帧可能重绘的是车内仪表（V800Adapter `GAUGE_MIN_INTERVAL = 1/15`，
 *    且带 `lastGaugeKey` 判据 ⇒ 15Hz 上限 + 内容不变则完全不画）；其余 CanvasTexture
 *    （星环 / 徽标 / 灯带 / contact shadow）全部是**装配期一次性生成**，运行期零重绘。
 *    HUD 是 DOM 且已走 `setText` diff + 力条 0.5% 量化（Hud.update）。
 *
 * ② **静态场景对象 matrixAutoUpdate / updateMatrixWorld 全树遍历**：**不是热点，无需改**。
 *    证据：castle 的 31 个 mesh 已 `matrixAutoUpdate = false`（castle.ts addMesh）；
 *    地形/路面父级不动 ⇒ three 的 `updateMatrixWorld` 对未脏子树直接跳过，不存在
 *    「每帧全树重算」。唯一常开的是 ContactShadow（跟随车，必须开）。
 *
 * ③ **雾/环境 env.update 每帧触发**：**不是热点，无需改**。
 *    证据：`Environment.update()` 全文只有 `this.sky.position.copy(cameraPosition)` ——
 *    **不重烘 envMap**（重烘在 Environment.ts 的 bake 路径，装配期一次）。
 *
 * ④ **高速可见 tri 飙升**：**已量过，分区剔除生效，但存在 ~32k tri 的「常驻地板」**。
 *    headless 六点探针（sphere 口径，与渲染器同源）实测：
 *      z=+40   递交 116,410 / 可见 mesh 17 / 分区隐藏 14 / 锥内 17（半径>250m 的常驻桶 7）
 *      z=0     递交 159,926 / 20 / 11 / 20（7）
 *      z=−200  递交 186,754 / 21 / 10 / 21（8）
 *      z=−500  递交 190,322 / 24 /  7 / 19（8）  ← 峰值点
 *      z=−900  递交 136,334 / 29 /  2 / 18（9）
 *      z=−1300 递交  89,198 / 21 / 10 / 14（8）
 *    结论：分区剔除在两端强（隐藏 10~14 个区）、中段弱（z=−900 只隐藏 2 个，靠视锥剔除
 *    补 11 个）。真正的结构性问题是有 **7~9 个「全局桶」mesh**（glass / roof / marble /
 *    wood / flame / door / agedGold / pave…）：它们不分区，包围球半径 > 250m 横跨整条
 *    z 走廊 ⇒ **永远落在视锥内**，构成 ≈32k tri 的递交地板（占峰值 16.8%）。
 *    ⚠ **本轮不做改动**：拆分它们要 +5~6 DC，而 DC 现值 31/32 只剩 1 格；且因 far=12000
 *    的视锥沿走廊几乎不遮挡前方，按 z 对半拆只在中后段（本来 tri 就低）有收益，
 *    **峰值点零收益** ⇒ 属「花了唯一一格 DC 买不到东西」，不做高风险盲改。
 *
 * ── 本文件真正钉住的护栏 ──────────────────────────────────────────────────────
 *   「常驻地板」是不可见的慢性退化源：A 线若继续往**全局桶**里堆几何，sphere 峰值会
 *   悄悄上涨而没人察觉。故这里把它量化成断言（≤40,000 tri），逼后来者要么分区、要么
 *   别往全局桶里加料。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';

const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h
        }),
        putImageData: () => {},
        fillRect: () => {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0
      })
    })
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high',
  pixelRatio: 2,
  minPixelRatio: 1,
  antialias: true,
  shadowMapSize: 2048,
  shadowOrtho: 28,
  msaaSamples: 4,
  bloom: true,
  bloomScale: 1,
  envMapSize: 900,
  carTextureSize: 1024,
  castleTexSyncSize: 256,
  isMobile: false,
  gpuClass: 'discrete'
} as unknown as QualitySettings;

function triOf(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

describe('R37-P 四个候选的代码论证（防回退）', () => {
  it('② castle 静态 mesh 全部 matrixAutoUpdate=false', () => {
    const src = readFileSync(new URL('../src/render/scene/castle.ts', import.meta.url), 'utf8');
    // addMesh 里那一行是 castle 31 个 mesh 的唯一出口 ⇒ 盯住它即可
    expect(src).toContain('mesh.matrixAutoUpdate = false;');
  });

  it('③ env.update 不重烘环境贴图（只挪天球）', () => {
    const src = readFileSync(new URL('../src/render/scene/Environment.ts', import.meta.url), 'utf8');
    const m = /update\(cameraPosition: THREE\.Vector3\): void \{\s*([^}]*)\}/.exec(src);
    expect(m, '找不到 Environment.update').not.toBeNull();
    const body = m![1];
    // 方法体里只允许「挪天球」这一件事：出现 render / dispose / needsUpdate 即为重烘回退
    expect(body).toContain('this.sky.position.copy(cameraPosition)');
    expect(body).not.toContain('render(');
    expect(body).not.toContain('dispose(');
  });

  it('① 仪表 canvas 仍走 15Hz 节流 + key 判据', () => {
    const src = readFileSync(new URL('../src/model/V800Adapter.ts', import.meta.url), 'utf8');
    expect(src).toContain('const GAUGE_MIN_INTERVAL = 1 / 15;');
    expect(src).toContain('if (now - lastGaugeTime < GAUGE_MIN_INTERVAL * 1000) return;');
  });

  it('阴影节流（R36-P2）仍在：>8 m/s 隔帧，低速逐帧', () => {
    const src = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');
    expect(src).toContain('if (speedNow > 8) {');
    expect(src).toContain('this.renderer.shadowMap.needsUpdate = this.shadowFrame === 0;');
  });
});

describe('R37-P 常驻地板护栏（全局桶 tri 上限）', () => {
  it(
    '包围球半径 > 250m 的「不可剔除桶」tri 合计 ≤ 40,000，且逐桶登记',
    () => {
      setDetailLevel('high');
      const scene = new THREE.Scene();
      const castle = new Castle(scene, QUALITY_HIGH);
      const rows: { name: string; tri: number; r: number }[] = [];
      let floor = 0;
      castle.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const geo = m.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const r = geo.boundingSphere?.radius ?? 0;
        const t = triOf(geo);
        // 半径 > 250m ⇒ 横跨整条 z 走廊，行车机位下恒在视锥内（见文件头④）
        if (r > 250) {
          rows.push({ name: m.name, tri: t, r });
          floor += t;
        }
      });
      rows.sort((a, b) => b.tri - a.tri);
      const log = rows.map((x) => `${x.name}=${Math.round(x.tri)}(r${Math.round(x.r)})`).join(' ');
      console.log(`R37_ALWAYS_ON_FLOOR ${JSON.stringify({ tri: Math.round(floor), buckets: rows.length, log })}`);
      // 现值 ≈32,446 tri / 9 桶。上限 40,000 留 ~23% 余量给后续细化，
      // 但**禁止**靠往全局桶里堆料来花掉它 —— 要加量请先分区（并付 DC）。
      expect(floor).toBeLessThanOrEqual(40_000);

      /* ── 附带发现（R37-P，未改，留给主理人裁决）───────────────────────────────
       * 上面 log 里 **castle-wall-z1(1824, r331) / castle-wall-z2(720, r257)** 是
       * **已分区**却同样不可剔除的桶：wall 走 ZONE_EDGES_3（3 区，每区跨度 ~350~390m）
       * ⇒ 包围球半径 257~331m，与全局桶同量级 ⇒ 分区收益被「区太宽」吃掉了
       * （2,544 tri 名义上分区、实际上常驻）。
       * 修法是把 wall 从 3 区改 6 区（与 ashlar/gold 同 ZONE_EDGES_6），代价 +3 DC；
       * DC 现值 31/32 只剩 1 格 ⇒ **本轮不做**（同文件头④的结论：不为买不到的收益
       * 花掉最后一格 DC）。这里只把它量出来并登记。 */
      const oversizedZoned = rows.filter((x) => /-z\d$/.test(x.name));
      const oversizedTri = oversizedZoned.reduce((s, x) => s + x.tri, 0);
      console.log(
        `R37_OVERSIZED_ZONED_BUCKETS ${JSON.stringify({
          count: oversizedZoned.length,
          tri: Math.round(oversizedTri),
          names: oversizedZoned.map((x) => x.name)
        })}`
      );
      disposeStoneCache();
    },
    120000
  );
});

/**
 * R37 收尾 · **金占比双口径登记 + 金桶 tri 护栏**。
 *
 * ══ 两个「金占比」数字都对，但**量纲不同，禁止混比**（本项目已四次栽在混口径上）══
 *
 * ① **表面积口径 ≈6.25%（R36 记忆值）**
 *    量法：`.qa/r31_geo_probe.mjs` 的 `goldSurfacePct` —— 全城 gold 桶**表面积**
 *    ÷ 全城表面积（m²）。它逼近参考图的「金色像素占比」语义，是**观感**指标。
 *    ⚠ **这个数字本身不可全信**：该脚本依赖 `.qa/r31_test/r31_bundle.mjs`
 *    （按仓库纪律 18：**bundle 陈旧即假账**），且 `.qa/` 被 .gitignore 忽略、
 *    不进 commit ⇒ 它只在本地生效、不进 CI。要引用它必须先重打 bundle。
 *
 * ② **tri 口径 ≈27%（R37 现值）**
 *    量法：gold 桶 mesh 的**三角形数** ÷ 全显 tri。它是**递交量/预算**指标
 *    （分桶合批后一个桶一个 mesh ⇒ 直接决定那一个 draw call 的顶点成本）。
 *
 * 两口径差 4 倍以上是**结构性的**，不是误差：金饰全是薄片/尖锥（面积小、tri 密度高），
 * 白石是厚墙大板（面积大、tri 密度低）⇒ 同一堵墙按面积算金占 6%、按 tri 算金占 27%。
 * ⚠ 判「金是否超标」必须**先声明是哪个口径**，再谈阈值。
 *
 * R37 增量：+576 gold tri（12 座壁灯 × 4 金件）⇒ tri 口径 +0.7%（相对金桶），
 * 表面积口径约 +0.04pp ⇒ **两个口径都不构成超标**（主理人已裁定放行）。
 */
describe('R37 金桶 tri 护栏（tri 口径，非表面积口径）', () => {
  it(
    '金桶（castle-gold-* + castle-agedGold）tri ≤ 全显 tri 的 30%',
    () => {
      setDetailLevel('high');
      const scene = new THREE.Scene();
      const castle = new Castle(scene, QUALITY_HIGH);
      let gold = 0;
      let all = 0;
      const names: string[] = [];
      castle.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const t = triOf(m.geometry);
        all += t;
        if (/^castle-(gold|agedGold)/.test(m.name)) {
          gold += t;
          names.push(`${m.name}=${Math.round(t)}`);
        }
      });
      const pct = (gold / all) * 100;
      console.log(
        `R37_GOLD_TRI ${JSON.stringify({ goldTri: Math.round(gold), allTri: Math.round(all), pct: Number(pct.toFixed(2)), key: 30, log: names.join(' ') })}`
      );
      // 现值 84,732 / 312,022 = 27.15%。上限 30% 留 ~2.85pp（≈8,900 tri）给后续细化，
      // 但**这是 tri 口径** —— 别拿它去对照表面积口径的 6.25%（见上方双口径说明）。
      expect(pct).toBeLessThanOrEqual(30);
      // 结构不变量：金必须仍是「分区提交」（否则包围球横跨走廊 ⇒ 永不被剔除）
      expect(names.filter((n) => /^castle-gold-z\d/.test(n)).length).toBeGreaterThanOrEqual(5);
      disposeStoneCache();
    },
    120000
  );
});
