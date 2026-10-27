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
 *     · 治理趋势的「≥25% 降幅」两条改读 triBox（与其 bbox 基线登记口径一致），
 *       口径隔离约定写死在断言上方注释里，改一半就是假账。
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
  it('六点采样峰值 ≤ visibleTri，且中段相对治理前基线降幅 ≥25%', () => {
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
       * 治理有效性基线（**同树治理前**：R=750 无 LOD，必须落在被测几何的同一棵树上，
       * 否则「降幅」里混进 A 线几何漂移就成了假账 —— 这是本项目反复栽过的口径坑）。
       * 本常量由 C2 线 2026-10-25 二次 fresh 读数登记（castle high 393,630 tri）：
       *   −200 = 325,106 / −500 = 273,446，见 .qa/r32_tmp_audit/r32_policy_probe_fresh.log
       * （上一次登记是 384,470 tri 树上的 317,566 / 265,634，已作废。）
       *
       * ⚠ R33 C 线口径修正的**口径隔离约定**（重要，勿擅自把 .triBox 改回 .tri）：
       *   这两个常数是 **bbox 口径**登记值（当年 r32_policy_probe 用 intersectsBox 量的）。
       *   R33 把剔除口径统一到 sphere 之后，本指标一律继续读 **`triBox`** ——
       *   即「bbox 对 bbox」同源相比。理由（本项目第三次栽在混口径上，故写死在此）：
       *     · 若改用 sphere 读数去比 bbox 基线 = 「分子换大、分母不动」，那是**假严**：
       *       看着更保守，实则是拿两种口径相减，降幅数字失去物理意义，
       *       治理退波 8% 与口径差 22% 没人分得清（正是本文件三令五申的口径坑）；
       *     · visibleTri 那条**键**断言则必须用 sphere（与渲染器同源，真护栏）。
       *   ⇒ 两条各守各的口径，**互不混用**：趋势指标用 bbox（与其基线登记一致），
       *      递交量指标用 sphere（与渲染器一致）。
       * 波次末统一口径时**两条一起换**：先按新 sphere 口径重跑 `r32_policy_probe.mjs`
       *   （本轮已同步把该探针改成 sphere 口径），用新数重登记本常数，再把下面
       *   四处 `.triBox` 一起改回 `.tri`。只改一半 = 又造一组假账（禁止）。
       */
      const PRE_GOV_BASE = { '-200': 325_106, '-500': 273_446 } as const;
      const mid200 = samples.find((s) => s.z === -200)!;
      const mid500 = samples.find((s) => s.z === -500)!;
      expect(mid200.triBox, `中段 −200 相对同树治理前降幅不足 25%（基线 ${PRE_GOV_BASE['-200']}）`)
        .toBeLessThanOrEqual(PRE_GOV_BASE['-200'] * 0.75);
      expect(mid500.triBox, `中段 −500 相对同树治理前降幅不足 25%（基线 ${PRE_GOV_BASE['-500']}）`)
        .toBeLessThanOrEqual(PRE_GOV_BASE['-500'] * 0.75);
      // 交叉验证：相对 **R31 跨波次基线**（−200 283,550 / −500 290,378）同样需 ≥25%
      // —— 这条更严（−500 限 217,783）。R33 快照③ 实测 bbox 177,706 / 129,806
      //    （限 212,662 / 217,783）⇒ 通过且余量很大：A 线 R33 那轮回砍把中段砍掉
      //    近 40%，本条现在是**深睡状态**，它的用途是防治理退波，不是当下护栏。
      // 深段（−900/−1300）相对 R31 基线是**上升**的（A 线 +9,160 tri 落在深段永久可见
      // 区），故本文件只在含中段的点上卡采样，不在深段上卡。
      // 口径隔离见上注：本条同读 triBox（R31 基线也是 bbox 口径登记的）。
      const R31_BASE = { '-200': 283_550, '-500': 290_378 } as const;
      expect(mid200.triBox, '中段 −200 相对 R31 基线降幅不足 25%').toBeLessThanOrEqual(R31_BASE['-200'] * 0.75);
      expect(mid500.triBox, '中段 −500 相对 R31 基线降幅不足 25%').toBeLessThanOrEqual(R31_BASE['-500'] * 0.75);
      // 入口/终点 sanity：起点被 R=650 摘掉远区 ⇒ 应显著低于中段（同口径读 triBox）
      expect(samples[0].triBox).toBeLessThan(mid200.triBox);
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
