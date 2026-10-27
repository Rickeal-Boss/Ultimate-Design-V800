/**
 * R32 C-7 · 预算键真消费 + 三口径台账断言（B 线 P0「预算键零消费」的 R32 收口）。
 *
 * 与 `tests/r31_budget.test.ts` 的分工：r31 那份建两档 Castle 断言 tri/DC；
 * 本文件补三件 r31 没覆盖的事：
 *   ① **真消费 visibleTri**（r31 明确跳过它）—— 建 high 档 Castle，按 Game/CameraRig
 *      同机位模型（chase 相机 far=12000）在六个行车采样点做「分区距离显隐 + LOD +
 *      Frustum」剔除，断言峰值 ≤ R31_BUDGET.visibleTri（口径②，见 r31Budget 台账）；
 *   ② **键完整性**：9 键齐全为正 + 档位序关系（low < high）；
 *   ③ **三口径 + 剔除口径台账存在性**：r31Budget.ts 必须写清「全显 / zone-visible /
 *      渲染」三口径定义、「累计 vs 每帧 DC」判读警告（第八轮 N12），以及 R33 补的
 *      **sphere 剔除口径**（防注释被后人删掉后口径漂移 —— 本轮就是这么丢的 22%）。
 *   ④ **R33 F2 真消费 fullVisibleTri**：revealAllZones 全显后逐 mesh 求和 ≤ 键，
 *      并钉「遍历口径 == getCastleStats 账本口径」（几何漏挂/换档丢账的探针）。
 *
 * 波次末提醒：A 线（castleKit/castleDetail）并行铺量中，tri 快照会漂移 ——
 * visibleTri 断言按 200k（治理后实测峰值 180,626 ×1.10）设了 ~10% 余量；
 * 波次末由严把关按届时实测复测收紧（主理人令）。
 * ⚠ C2 线 2026-10-25 二次 fresh 读数：A 线又把城堡从 384,470 铺到 **393,630 tri**，
 *   六点新鲜值（z=+40/0/−200/−500/−900/−1300）：
 *     102,350 / 164,478 / 186,154 / **186,294** / 178,150 / 87,878
 *   ⇒ 本文件那条 ≤200,000 的断言余量已降到 **6.85%**（z=−500 峰值处）。
 *   A2 线再往中段可见区铺 ≈14k tri 就会红 —— 那是护栏在响，不是误报。
 *
 * ⚠⚠ R33 C 线口径修正（本轮最大改动，读完再动本文件）：
 *   上面那些 186,294 之类的数是 **bbox 口径**（`Frustum.intersectsBox`）量出来的，
 *   而 three.js 渲染器剔除走的是 **boundingSphere**（`Frustum.intersectsObject`
 *   → `intersectsSphere`）。球 ⊇ 盒 ⇒ 长条分区 mesh 在视锥临界带上被 bbox 漏计。
 *   R33 fresh 实测（2026-10-26 三份快照，A 线在途回砍，tri 390,498→380,994→300,450）：
 *     z=−500 处 sphere / bbox = 250,202/194,790、244,490/189,118、183,794/129,806
 *     ⇒ bbox 少记 55,412 / 55,372 / 53,988 tri = 真实递交量的 22.2%/22.6%/**29.4%**
 *       （比例随几何而变 ⇒ 不存在「bbox × 固定系数 = sphere」的换算，只能重测）；
 *     且**峰值点位置都变了**（bbox 峰值在 z=−200，sphere 峰值在 z=−500，三快照一致）
 *   ⇒ 按 bbox 峰值选出的「该砍 z0/z1/z2」是错的，真实超标发生在 **z3（−460~−760）**。
 *   ⇒ 本轮把 `visibleTriAt` 的剔除口径改成与渲染器同源（sphere），
 *     visibleTri 那条断言会**转红**（真实递交量本来就超了 200k）：
 *     · 不许为转绿砍几何（砍料归 A 线）；不许抬键（主理人裁决：>215k 回砍不抬键）；
 *     · ~~治理趋势的「≥25% 降幅」两条改读 triBox（与其 bbox 基线登记口径一致）~~
 *       ⚠ R36 波次末已到期切换（主理人裁决）：趋势断言四处常数整体切到 **sphere**
 *       口径（现值 sphere vs R32 sphere 快照 198,474@z=−200 / 250,202@z=−500），
 *       统一 ≥25% 目标作废（系 bbox 错口径产物），改分点真实目标 z=−500（峰值点）
 *       ≥20%、z=−200 ≥5%；triBox 仅留日志口径差对照，禁止回流断言。
 *   详因见 `visibleTriAt` 上方注释与 `src/render/scene/r31Budget.ts` 台账段。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';
import { R31_BUDGET } from '../src/render/scene/r31Budget';

// 最小 DOM shim：石材 canvas 程序化贴图需要 document.createElement('canvas').getContext('2d')
const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: () => {},
          fillRect: () => {},
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0
        })
      };
    }
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

function triOf(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** 六点行车采样（口径②）：距离显隐 + LOD + Frustum，与 .qa/r32_tmp_audit/r32_probe.mjs 同模型 */
const DRIVE_SAMPLES = [40, 0, -200, -500, -900, -1300] as const;

/**
 * ⚠ R33 C 线口径修正（**根因记录，勿回退成 bbox**）—— 改前本函数用
 * `geometry.boundingBox` + `Frustum.intersectsBox` 判 zone-visible。
 *
 * 根因：three.js 渲染器剔除走的是另一条路。
 *   `WebGLRenderer.projectObject` ⇒ `_frustum.intersectsObject(object)` ⇒ 取
 *   **`geometry.boundingSphere`**（null 则 `computeBoundingSphere()`）再
 *   `.applyMatrix4(object.matrixWorld)` ⇒ `Frustum.intersectsSphere(...)`。
 *   也就是说**渲染器从不看 boundingBox**（bbox 只归 LOD/分区/射线等别家逻辑用）。
 *
 * 差异不是精度瑕疵，而是**系统性单向漏计（只可能少算、不可能多算）**：
 *   包围球以盒心为心、取到最远顶点的距离为半径 ⇒ 球 ⊇ 盒 恒成立；
 *   本场景 castle 分区 mesh 是**沿 z 的长条**（单区 z 跨度 300~400m，x/y 只有几十米），
 *   球半径被 z 方向大幅撑大，于是处在视锥**临界带**（左右/上下侧面附近的掠射区）的
 *   长条 mesh 会出现「盒判定在外、球判定在内」—— 渲染器实际递交了它们，
 *   bbox 口径却把这份 tri 记成了 0。
 * 实测（high 档，六点 z=−500 处，sphere vs bbox）：漏计 22%~29%（随几何而变，
 *   三份快照见 r31Budget.ts 台账与 .qa/r32_tmp_audit/r32_probe.mjs 双份登记）。
 *   bbox 口径下本文件那条 ≤200,000 的断言长期是**绿**的 —— 那不是达标，
 *   是量法失真（自我安慰式达标）。
 *
 * 治理结论：测试口径必须与渲染器同源（sphere），否则 visibleTri 键失去护栏意义。
 * 代价：改后本条断言一度转红（真实递交量 244,490 > 200,000）——
 *   **不许**为转绿砍几何（砍料归 A 线）、**不许**抬键（主理人裁决：>215k 回砍不抬键）。
 *   A 线随后照新口径改砍 z2/z3 ⇒ 峰值降到 183,794 ⇒ 断言**自然转绿**（键全程未动）。
 *   记住这次路径：红 → A 线砍 → 绿，**不是** 红 → 抬键 → 绿。
 */
function visibleTriAt(
  scene: THREE.Scene,
  castle: Castle,
  carZ: number
): { tri: number; dc: number; triBox: number; dcBox: number } {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 12000);
  cam.position.set(1.6, 2.2, carZ + 8.2);
  cam.lookAt(0, 1, carZ - 6);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  castle.updateViewerZ(cam.position.z);
  let tri = 0;
  let dc = 0;
  let triBox = 0;
  let dcBox = 0;
  scene.getObjectByName('castle')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    // 与渲染器同口径（见上注）：boundingSphere（缺则现算）+ intersectsSphere。
    // 本测试里 castle 组与其父级 Scene 均为单位矩阵（castle.ts 未设 group.position，
    // 测试也不调 updateMatrixWorld）⇒ 局部球即世界球，与渲染器等价。
    // ⚠ 必须读**当前挂载档**的 geometry：updateViewerZ 换档后 mesh.geometry 已换对象，
    //   球与 tri 都要跟着换（拿建档时的旧球量远档 geometry 会再犯一次口径分家）。
    const geo = m.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (geo.boundingSphere && frustum.intersectsSphere(geo.boundingSphere)) {
      tri += triOf(geo);
      dc += 1;
    }
    // ── 旧 bbox 口径：**仅作台账对照**，不参与任何断言 ──
    // 留它是为了每次跑测试都能顺手登记「sphere vs bbox」的口径差（本轮实测约 +22%），
    // 免得后人不信「bbox 口径漏了多少」，也免得口径差随时间悄悄变化而无人察觉。
    // ⚠ 严禁把 triBox 接回断言（那正是本轮修掉的失真源）。
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (geo.boundingBox && frustum.intersectsBox(geo.boundingBox)) {
      triBox += triOf(geo);
      dcBox += 1;
    }
  });
  return { tri, dc, triBox, dcBox };
}

describe('R31_BUDGET 键完整性（R32 C-2 台账维护态）', () => {
  it('9 键齐全且均为正', () => {
    const keys: (keyof typeof R31_BUDGET)[] = [
      'castleTriHigh', 'castleTriLow', 'castleDc', 'frameTri', 'frameDc', 'castleTexCount', 'castleTexMB', 'visibleTri',
      // R33 F2 新增：全显口径（revealAllZones 后逐 mesh 求和）的护栏键。
      // 每加一个键就必须同步进本表 —— 否则又造一个「只被注释引用、无人断言消费」的
      // 幽灵键（R30 P0 审出的老毛病）。
      'fullVisibleTri'
    ];
    for (const k of keys) {
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 缺失`).toBeDefined();
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 非正`).toBeGreaterThan(0);
    }
  });

  it('档位序关系：low < high；DC/帧红线量级 sanity', () => {
    expect(R31_BUDGET.castleTriLow).toBeLessThan(R31_BUDGET.castleTriHigh);
    // frameTri 必须容得下「车 + zone-visible castle + terrain + road」粗估（口径②不是①）
    expect(R31_BUDGET.frameTri).toBeGreaterThan(R31_BUDGET.visibleTri + R31_BUDGET.castleTriLow * 0.5);
    expect(R31_BUDGET.castleDc).toBeGreaterThanOrEqual(20); // 分区合批后的设计值 28 的量级
    expect(R31_BUDGET.frameDc).toBeGreaterThan(0);
  });
});

describe('R32 C-2 · 三口径台账注释存在性', () => {
  it('r31Budget.ts 写清三口径定义 + 累计/每帧 DC 判读警告', () => {
    const src = readFileSync(new URL('../src/render/scene/r31Budget.ts', import.meta.url), 'utf8');
    // 三个口径的定义锚点
    expect(src).toContain('全显');
    expect(src).toContain('zone-visible');
    expect(src).toContain('渲染（frame）');
    // 判读警告锚点（历次误判都源于混比，注释删了就会复发）
    expect(src).toContain('累计 vs 每帧 DC');
    expect(src).toContain('transmission');
    // 量法锚点
    expect(src).toContain('getCastleStats');
    expect(src).toContain('renderer.info.render');
    // R33 C 线补钉：**剔除口径**锚点。
    // 这三行是 R33 那次「bbox 口径漏计 22%」的根因记录。删掉它们 = 后人可以
    // 悄悄把 visibleTriAt 改回 intersectsBox，于是 visibleTri 键又变成自我安慰式达标
    // （绿着超标）。故把口径写进台账并由本断言盯住（与 N12 三口径注释同一治法）。
    expect(src, 'r31Budget.ts 台账丢了 sphere 剔除口径说明').toContain('boundingSphere');
    expect(src).toContain('intersectsSphere');
    expect(src).toContain('intersectsBox');
  });
});

describe('R32 C-5 · zone-visible 治理（真消费 R31_BUDGET.visibleTri）', () => {
  it('六点采样峰值 ≤ visibleTri，且中段相对 R32 sphere 快照降幅分点达标（−500 ≥20% / −200 ≥5%）', () => {
    setDetailLevel(false);
    disposeStoneCache();
    const scene = new THREE.Scene();
    const castle = new Castle(scene, QUALITY_HIGH);
    try {
      const stats = castle.getCastleStats();
      // 装配期口径不受运行时态污染（三口径台账①的前提）
      expect(stats.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriHigh);
      expect(stats.dc).toBeLessThanOrEqual(R31_BUDGET.castleDc);

      const samples = DRIVE_SAMPLES.map((z) => ({ z, ...visibleTriAt(scene, castle, z) }));
      // 六点双口径读数落盘锚（与 r32_probe.mjs 的 R32_RESULT 同形，便于跨工具比对 / 后人复测）
      console.log(
        'R33_SAMPLES ' +
          JSON.stringify(
            samples.map((s) => ({
              carZ: s.z,
              sphereTri: Math.round(s.tri),
              sphereDc: s.dc,
              boxTri: Math.round(s.triBox),
              boxDc: s.dcBox
            }))
          )
      );
      console.log(
        'R33_PEAK_SAMPLES ' +
          JSON.stringify({
            peakSphereTri: Math.round(Math.max(...samples.map((s) => s.tri))),
            peakBoxTri: Math.round(Math.max(...samples.map((s) => s.triBox))),
            visibleTriKey: R31_BUDGET.visibleTri
          })
      );
      for (const s of samples) {
        expect(s.tri, `carZ=${s.z} 可见 tri ${Math.round(s.tri)} 超 visibleTri ${R31_BUDGET.visibleTri}`)
          .toBeLessThanOrEqual(R31_BUDGET.visibleTri);
      }
      /**
       * 治理有效性趋势断言（**R36 波次末口径切换 · 主理人裁决落地**，读完再动本段）。
       *
       * 裁决正文与理由（台账 r31Budget.ts 第⑤条「波次末把降幅常数切到 sphere、
       * 四处一起换」到期执行；四处 = 探针口径 / 两基线 / 断言 / 台账，其中基线值
       * 由主理人直接裁定为 R32 sphere 快照，探针重跑步骤被该快照取代）：
       *   ① **错口径纠偏**：旧「≥25% 降幅」统一目标是 **bbox 错口径的产物**——
       *      bbox 在峰值点（z=−500）系统性漏计 22%~29%（三快照实测），且两口径
       *      峰值点位置不同（bbox 峰值在 z=−200、sphere 峰值在 z=−500），按 bbox
       *      判降幅既量错分子又瞄错治理目标。按 sphere 真实口径，R32→R35 实际
       *      降幅只有 −10.5%（z=−200）/ −26.6%（z=−500），统一 25% 在 z=−200
       *      永远不可达。⇒ 统一 ≥25% 目标**作废**，趋势断言四处常数整体切到
       *      **sphere 口径**（同源对比：现值 sphere vs R32 sphere 快照）。
       *   ② **同源基准**：R32 sphere 快照 **198,474 @ z=−200 / 250,202 @ z=−500**
       *      （r31Budget.ts 台账「R33 C 线 fresh 读数」快照① sphere 六点登记值）。
       *      分点真实目标：**z=−500（峰值点）≥20%、z=−200 ≥5%**。
       *   ③ **硬约束地位声明**：峰值点绝对红线 `visibleTri ≤ 200,000`（上方键断言）
       *      才是硬约束；本趋势指标是治理有效性的参考护栏，不与键争硬约束地位。
       *   ④ **禁令**：禁止回退 bbox 断言口径（triBox 仅留日志对照，不许进断言）；
       *      禁止再抬任何绝对预算键（visibleTri 200k / fullVisibleTri 480k /
       *      castleDc 32 等一概不动）。新阈值若实测不达标 ⇒ 停下回传读数等裁决，
       *      不自行改数。
       *   旧口径留档（作废，勿复活）：PRE_GOV_BASE bbox {325,106 / 273,446} 与
       *   R31_BASE bbox {283,550 / 290,378} 的「×0.75 统一 25%」四断言组整体退役；
       *   R31 跨波次交叉验证随统一 25% 一并退役（其基线是 bbox 登记、无 sphere
       *   同源值，主理人裁决的同源基准唯一 = R32 sphere 快照）。
       */
      const R32_SPHERE_BASE = { '-200': 198_474, '-500': 250_202 } as const;
      // 分点真实目标：z=−200 降幅 ≥5%（保留 ≤95%）、z=−500 峰值点 ≥20%（保留 ≤80%）
      const TREND_KEEP = { '-200': 0.95, '-500': 0.8 } as const;
      const mid200 = samples.find((s) => s.z === -200)!;
      const mid500 = samples.find((s) => s.z === -500)!;
      expect(mid200.tri, `中段 −200 相对 R32 sphere 快照降幅不足 5%（基线 ${R32_SPHERE_BASE['-200']}，现值 ${Math.round(mid200.tri)}）`)
        .toBeLessThanOrEqual(R32_SPHERE_BASE['-200'] * TREND_KEEP['-200']);
      expect(mid500.tri, `中段 −500 相对 R32 sphere 快照降幅不足 20%（基线 ${R32_SPHERE_BASE['-500']}，现值 ${Math.round(mid500.tri)}）`)
        .toBeLessThanOrEqual(R32_SPHERE_BASE['-500'] * TREND_KEEP['-500']);
      // 入口/终点 sanity：起点被 R=650 摘掉远区 ⇒ 应显著低于中段（sphere 口径）
      expect(samples[0].tri).toBeLessThan(mid200.tri);
    } finally {
      castle.dispose();
    }
  }, 60000);
});

describe('R33 F2 · 全显口径（revealAllZones 后逐 mesh 求和）', () => {
  /**
   * 全显 = 剔除失效/QA 自由机位时的**最坏每帧递交量**（台账口径①）。
   * 与 `getCastleStats()` 的差别不在量、在**路径**：账本是装配期累加，本条走场景遍历
   * 读「当前挂载档 geometry」的 tri —— 两条路径一旦分家，就是几何漏挂 / 换档后
   * tri 账没跟上，故本条同时钉死「遍历 == 账本」（同源不变量）。
   */
  it('全显 tri ≤ fullVisibleTri，且遍历口径 == 装配期账本口径', () => {
    setDetailLevel(false);
    disposeStoneCache();
    const scene = new THREE.Scene();
    const castle = new Castle(scene, QUALITY_HIGH);
    try {
      // QA 自由机位态：全区分显 + 全部回近档（远档 LOD 不进本口径，见台账①）
      castle.revealAllZones();
      let full = 0;
      let meshes = 0;
      scene.getObjectByName('castle')?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible) return;
        full += triOf(m.geometry);
        meshes += 1;
      });
      const stats = castle.getCastleStats();
      console.log(
        'R33_FULLVISIBLE ' +
          JSON.stringify({
            tri: Math.round(full),
            meshes,
            statsTris: stats.tris,
            statsDc: stats.dc,
            key: R31_BUDGET.fullVisibleTri
          })
      );
      // 全显态下不应还有隐藏 mesh ⇒ 遍历 mesh 数 == 装配期 dc 账本
      expect(meshes, '全显态仍存在隐藏 mesh（revealAllZones 没盖全）').toBe(stats.dc);
      // 同源不变量：逐 mesh 求和 == 装配期 tri 账本（几何漏挂/重复挂 ⇒ 这里先分家）
      expect(full, '遍历口径与 getCastleStats 账本分家（几何漏挂或换档后 tri 账没跟上）').toBe(stats.tris);
      expect(full, `全显 tri ${Math.round(full)} 超 fullVisibleTri ${R31_BUDGET.fullVisibleTri}`)
        .toBeLessThanOrEqual(R31_BUDGET.fullVisibleTri);
    } finally {
      castle.dispose();
    }
  }, 60000);
});
