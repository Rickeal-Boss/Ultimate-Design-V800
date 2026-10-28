/**
 * R37-A · 城堡参考图对齐增量回归（灰石分区 / 引桥烛台壁灯 / 内庭拼花带）。
 *
 * 本文件只钉**本轮新增项自身的不变量**，预算红线（DC / visibleTri / fullVisibleTri）
 * 由 `tests/r32_budget.test.ts` 消费 R31_BUDGET 盯住，这里不复制数字。
 *
 * 三条必须钉死的纪律（都是本项目出过事的）：
 *  ① **禁止 distribution 字段**：castleKit 的重复体必须走显式 for 循环逐个
 *     `translate()`。生成器不读 `distribution`，写下去会被静默读空 ⇒ 全部实例落在
 *     局部原点、push 到桶里后全部叠在 (0,0,0)（历史事故：394 实例 / 75,648 面全毁）。
 *     ⇒ 断言「零个几何的包围盒中心落在原点附近」+「逐座 z 严格递减」。
 *  ② **变体 0 新贴图**：灰石变体必须复用 ashlar 图集（texKind='ashlar'），
 *     且运行时材质共享**同一张 Texture 实例**（不是 clone）。
 *  ③ **换桶不换量**：灰石分区是「把既有翼墙墙身从 inner-stone 档改挂 ashlar-grey
 *     外装档」⇒ tri 不变，只是材质语义换档。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { makeParapet, makeTowerGroup, setDetailLevel } from '../src/render/scene/castleKit';
import { STONE_VARIANTS } from '../src/render/scene/stoneTexture';

const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  setDetailLevel('high');
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
  setDetailLevel('high');
});

function centerOf(g: THREE.BufferGeometry): THREE.Vector3 {
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!.getCenter(new THREE.Vector3());
}

describe('R37-A 灰石分区（变体复用 ashlar 图集 ⇒ 0 新贴图）', () => {
  it('ashlar-grey 变体存在，且 texKind = ashlar', () => {
    const v = STONE_VARIANTS['ashlar-grey'];
    expect(v).toBeDefined();
    // 复用主体白石图集 ⇒ 不另起一套贴图（新 kind 会多产 2~3 张）
    expect(v.texKind).toBe('ashlar');
    // 与室内档 inner-stone 分家：外装要吃天光（env 更高）且更亮
    const inner = STONE_VARIANTS['inner-stone'];
    expect(v.env).toBeGreaterThan(inner.env);
    expect(v.color).not.toBe(inner.color);
    // 砌块形制一致（同一图集）⇒ 法线强度与金属度保持同档
    expect(v.normalScale).toBe(inner.normalScale);
    expect(v.metalness).toBe(inner.metalness);
  });

  it('灰石是「换档」不是「加料」：5 个变体齐全，未动既有 4 个变体的数值', () => {
    expect(Object.keys(STONE_VARIANTS)).toEqual([
      'inner-stone',
      'inner-wood',
      'gilded-aged',
      'pave-damp',
      'ashlar-grey'
    ]);
    // 既有四档逐位不动（换档只新增一档，不改写旧档）
    expect(STONE_VARIANTS['inner-stone'].color).toBe(0x8e979e);
    expect(STONE_VARIANTS['inner-wood'].color).toBe(0xab9a86);
    expect(STONE_VARIANTS['gilded-aged'].color).toBe(0xd2cec4);
    expect(STONE_VARIANTS['pave-damp'].color).toBe(0x8b9094);
  });
});

/**
 * 壁灯**空间识别带**（用于把「壁灯贡献的金件」从栏板上其它金件里精确挑出来）。
 *
 * 为什么需要它：`b.gold` 里还有压顶 / 金徽章 / 间歇金条 / 柱顶金箍环等既有件，
 * 直接 `b.gold.length > 48` 是**下界断言**（49 就过，真正的回归——比如少建 3 座——
 * 也能混过去）。故改为按**空间带**精确识别，再做**等量**断言。
 *
 * 取值依据（逐件核过 makeParapet 的 y/x）：
 *   · 壁灯金件 y ∈ {1.62 壁座, 1.68 曲臂, 1.83 烛杯, 1.88 蜡烛} ⇒ 带 y ∈ (1.5, 1.95)
 *   · 柱顶金箍环 y ≈ plinthH+postH+半高 = 0.5+1.52+0.07 ≈ 2.09 ⇒ **被 1.95 挡掉**
 *   · 金压顶 y ≈ h−capH/2 ≈ 2.51 ⇒ 也挡掉
 *   · 金徽章 y ≈ 0.5+emblemH/2 ≈ 1.15、间歇金条 y ≈ 0.81 ⇒ 都挡掉
 *   · 栏板中心线 x = totalHalf(12.6) − 0.36 = 12.24；壁灯 |x| ∈ {12.42, 12.55, 12.68}
 *     ⇒ 带 |x| > 12.30 把「正好在栏板线上的」箍环(12.24)/徽章(12.24) 挡掉
 */
const SCONCE_BAND = { xMin: 12.3, xMax: 13.5, zMin: -362, zMax: -290 };

/**
 * @param yMin/yMax 该**桶**的高度带（金件与焰不在同一高度，必须分开给）。
 *   ⚠ 数值按 R37 P2-6 把整组从 y=1.62 下移到 **y=1.30**（落中横梁）后重算，整体 −0.32：
 *   · gold 件 y ∈ (1.20, 1.65)：壁座 **1.30** / 曲臂 1.36 / 烛杯 1.51 / 蜡烛 1.56；
 *     排除金压顶 2.51、柱顶金箍环 2.09、金徽章 1.15、间歇金条 0.81。
 *   · flame 件 y ∈ (1.70, 2.10)：焰锥底 = y+0.4 = 1.70、锥心 = 底 + 0.42/2 ≈ **1.91**；
 *     排除 R32 桥栏火盆的焰（3.1+0.95+0.12+0.35 ≈ **4.52**，高得多）。
 *   x 带 (12.30, 13.50) 不变：栏板本体中心线 x=12.24（含压顶/箍环/徽章/中横梁）
 *   都被 12.30 挡掉；壁灯 |x| ∈ {12.42 壁座, 12.55 曲臂, 12.68 烛杯/蜡烛/焰}。
 */
function inSconceBand(g: THREE.BufferGeometry, yMin: number, yMax: number): boolean {
  const c = centerOf(g);
  const ax = Math.abs(c.x);
  return (
    ax > SCONCE_BAND.xMin &&
    ax < SCONCE_BAND.xMax &&
    c.y > yMin &&
    c.y < yMax &&
    c.z > SCONCE_BAND.zMin &&
    c.z < SCONCE_BAND.zMax
  );
}

/**
 * UV 密度 = `sqrt(Σ UV 三角面积 / Σ 世界三角面积)`。
 *
 * 为什么用**面积比**而不是直接读某个顶点的 du/dx：`planarUV` 按每个面的法线主轴
 * 挑投影平面，同一个 box 的 6 个面投影轴各不相同（还有三角剖分方向差异），
 * 逐面/逐轴读会踩到退化的那一轴。面积比是**旋转无关**的标量：
 *   UV = 世界坐标 / TILE  ⇒  每个面的 uvArea / posArea = (1/TILE)²
 *   ⇒ density = sqrt(uvArea/posArea) = **1/TILE**（与朝向无关）。
 * 于是「grey 与 ashlar 的 UV 密度比」= TILE_ashlar / TILE_grey，配错族时直接暴露。
 */
function uvDensity(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  let posArea = 0;
  let uvArea = 0;
  const a = new THREE.Vector3();
  const b2 = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i;
    const i1 = idx ? idx.getX(i + 1) : i + 1;
    const i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b2.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    posArea += b2.sub(a).cross(c.sub(a)).length() / 2;
    const u0 = uv.getX(i0), v0 = uv.getY(i0);
    const u1 = uv.getX(i1), v1 = uv.getY(i1);
    const u2 = uv.getX(i2), v2 = uv.getY(i2);
    uvArea += Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
  }
  if (posArea <= 0 || uvArea <= 0) return Number.NaN;
  return Math.sqrt(uvArea / posArea);
}

describe('R37-A 灰石砌块 UV 密度（P2-1：box 图集族必须跟着桶一起配）', () => {
  it('★ grey 桶与 ashlar 桶的 UV 密度比 === 1.0（砌块尺度不许差一倍）', () => {
    const b = makeTowerGroup();
    expect(b.grey.length).toBeGreaterThan(0);
    expect(b.ashlar.length).toBeGreaterThan(0);
    // 取每个桶里 UV 密度最稳的那一件（box 件；棱柱/`spire` 也是同 TILE 但混入曲面，
    // 故按「密度最接近中位数」的方式取，避免个别构件的三角剖分噪声）
    const med = (arr: THREE.BufferGeometry[]): number => {
      const ds = arr.map(uvDensity).filter((d) => Number.isFinite(d)).sort((x, y) => x - y);
      expect(ds.length).toBeGreaterThan(0);
      return ds[Math.floor(ds.length / 2)];
    };
    const dGrey = med(b.grey);
    const dAshlar = med(b.ashlar);
    const ratio = dGrey / dAshlar;
    console.log(
      `R37_UV_DENSITY ${JSON.stringify({ grey: Number(dGrey.toFixed(6)), ashlar: Number(dAshlar.toFixed(6)), ratio: Number(ratio.toFixed(6)) })}`
    );
    // ① 核心判据：比值 1.0（配错 box('wall') 时会是 0.5 —— TILE 2.4 vs 1.2 差了 2 倍）
    expect(ratio).toBeCloseTo(1.0, 3);
    // ② 两者都应等于 1/TILE_ashlar = 1/1.2（把判据钉到绝对尺度上，不只钉相对比值）
    expect(dGrey).toBeCloseTo(1 / 1.2, 3);
    expect(dAshlar).toBeCloseTo(1 / 1.2, 3);
  });
});

describe('R37-A 引桥烛台壁灯（显式循环 · 防全实例塌到原点）', () => {
  /** 栏板壁灯每座 4 件 gold（壁座/曲臂/烛杯/蜡烛）+ 1 件 flame（焰） */
  const PER_LAMP_GOLD = 4;
  /** 每侧盏数（= castleKit R37_SCONCE.perSide；**不许用 src 常量自证**，写死字面量） */
  const PER_SIDE = 6;

  it('12 座（6 盏/侧）：gold 48 件 + flame 12 件，逐座 z 严格递减', () => {
    const b = makeParapet();
    // flame 桶里既有 R32 桥栏火盆（7 盏/侧 = 14），壁灯再 +12 ⇒ 26
    expect(b.flame.length).toBe(14 + 12);
    // 取壁灯的焰（后 12 件：火盆先 push，壁灯后 push）
    const sconceFlames = b.flame.slice(-12);
    // ① 左右成对：push 顺序是「for i { for side }」⇒ 相邻两件同 z、x 对称
    const byZ = new Map<string, number[]>();
    for (const g of sconceFlames) {
      const c = centerOf(g);
      const key = c.z.toFixed(3);
      byZ.set(key, [...(byZ.get(key) ?? []), c.x]);
    }
    expect(byZ.size).toBe(6); // 6 个 z 站 × 2 侧
    for (const [, xs] of byZ) {
      expect(xs.length).toBe(2);
      expect(xs[0]).toBeCloseTo(-xs[1], 6); // 关于桥轴对称
    }
    // ② 6 个站的 z **严格递增**（城门 → 北端）⇒ 是「沿桥低频布置」，不是塌在一处
    const zs = [...byZ.keys()].map(Number).sort((a, b2) => a - b2);
    for (let i = 1; i < zs.length; i += 1) {
      expect(zs[i], `站 #${i}`).toBeGreaterThan(zs[i - 1]);
    }
    // ③ 站距 = R37_SCONCE.spacing（10.5m）⇒ 低频节奏，不是每根栏杆柱一盏
    for (let i = 1; i < zs.length; i += 1) {
      expect(zs[i] - zs[i - 1]).toBeCloseTo(10.5, 6);
    }
  });

  it('★ 零个几何塌在局部原点（distribution 静默失效的历史事故护栏）', () => {
    const b = makeParapet();
    const all = [...b.ashlar, ...b.wall, ...b.gold, ...b.dark, ...b.flame];
    expect(all.length).toBeGreaterThan(0);
    let atOrigin = 0;
    for (const g of all) {
      const c = centerOf(g);
      // 壁灯/瓶柱/徽章都是**显式 translate** 到世界位的，任何一个留在局部原点
      // 都意味着「位置没写」或「distribution 字段被读空」
      if (Math.abs(c.x) < 1e-6 && Math.abs(c.z) < 1e-6) atOrigin += 1;
    }
    // 通长构件（基座梁/横梁/压顶/低栏板）的**中心**确实在 x=0 —— 但它们的 z 中心
    // 是桥段中点（≠0）⇒ 仍不会被这条判据判为「塌原点」。真正塌原点的是 x=z=0。
    expect(atOrigin).toBe(0);
  });

  it('壁灯贴在栏板外壁、落在栏杆高度带内、且在御桥 z 段内', () => {
    const b = makeParapet();
    const sconceFlames = b.flame.slice(-12);
    for (const g of sconceFlames) {
      const c = centerOf(g);
      // 栏板中心线 = VIADUCT.totalHalf(12.6) − 0.36 = 12.24，壁灯再外挪 0.18 + 曲臂
      // 挑出 0.26 ⇒ |x| ≈ 12.68。
      // ⚠ 这里刻意**不写 16.8**：R29 把桥面从 totalHalf 16.72 收窄到 12.6 后，
      // makeParapet 里那句「// 16.36」注释一直是过期读数（R37-A 已订正为 12.24）。
      // 真正的判据是下面这条**功能**约束，不是坐标绝对值：
      //   · |x| > 12.0 ⇒ 壁灯在**可行驶走廊之外**（FreeDrive BOUNDS.bridgeHalfW = 12.0），
      //     不会挡在车道上；
      //   · |x| < 14 ⇒ 仍在桥面/栏板尺度内，没飘到桥外的空中。
      expect(Math.abs(c.x), `焰 x=${c.x}`).toBeGreaterThan(12.0);
      expect(Math.abs(c.x), `焰 x=${c.x}`).toBeLessThan(14);
      // y：壁座落中横梁 1.30，焰心 = 1.30+0.4+0.21 ≈ 1.91 ⇒ 落在 1.7~2.1 带
      expect(c.y, `焰 y=${c.y}`).toBeGreaterThan(1.7);
      expect(c.y, `焰 y=${c.y}`).toBeLessThan(2.1);
      // z：**必须仍在御桥段**（城门脸 **−351.5** 以北）。写成 zStart − i·spacing 会让
      // 第 2~6 座落到 −360..−402（城门之后的城内段，壁灯会浮在街屋里面）⇒ 这条就是护栏。
      expect(c.z, `焰 z=${c.z}`).toBeGreaterThan(-362);
      expect(c.z, `焰 z=${c.z}`).toBeLessThan(-290);
    }
  });

  it('壁灯金件数**精确等于** 12 座 × 4 件 = 48（等量关系，非下界）', () => {
    const b = makeParapet();
    // ⚠ 旧判据 `b.gold.length > 12*4` 是**下界 + 同义反复**：
    //   ① `>` 让"少建 3 座"（45 件 + 其它金件充足）也能过；
    //   ② `expect(PER_LAMP_GOLD).toBe(4)` 是本地常量自证，与 src 无关。
    // 现改为：按空间带精确挑出壁灯金件，断言 **等量** 关系。
    const sconceGold = b.gold.filter((g) => inSconceBand(g, 1.2, 1.65));
    const sconceFlame = b.flame.filter((g) => inSconceBand(g, 1.7, 2.1));
    const lamps = PER_SIDE * 2; // 6 盏/侧 × 2 侧 = 12 座
    console.log(
      `R37_SCONCE ${JSON.stringify({ goldTotal: b.gold.length, flameTotal: b.flame.length, sconceGold: sconceGold.length, sconceFlame: sconceFlame.length, lamps, perLamp: sconceGold.length / lamps })}`
    );
    // ① 等量：壁灯金件 === 座数 × 每座件数（不是 ">"）
    expect(sconceGold.length).toBe(lamps * PER_LAMP_GOLD);
    expect(sconceGold.length).toBe(48);
    // ② 每座 4 件是**从实物除出来的**，不是本地常量自证
    expect(sconceGold.length / lamps).toBe(PER_LAMP_GOLD);
    // ③ 识别带必须"吃得干净"：壁灯金件不可能比 gold 总量还多（带选错就会爆）
    expect(sconceGold.length).toBeLessThan(b.gold.length);
    // ④ 交叉验证：flame 桶里按同一空间带挑出的壁灯焰也正好 12 件
    //    ⇒ 两个独立桶（gold / flame）各自数出同一个座数 ⇒ 不会出现
    //    「金件建了但焰没建」（或反之）这种半截回归。
    expect(sconceFlame.length).toBe(lamps);
  });

  /**
   * ★ R37 P2-6 · 「壁座背后真有实面」硬判据。
   *
   * 缺陷类型（本轮实物缺陷）：壁座挂在 y=1.62，而那一带栏板**只有离散瓶柱**
   * （柱距 1.63 / zLen 0.26），通长构件 0 件 ⇒ 12 座里 10 座背后是空的，能透出路面。
   *
   * 判据为什么是**双轴咬合 ≥0.08m** 而不是"AABB 相交"：
   *   低栏板外表面只到 x=12.41，而壁座 x 区间是 [12.37,12.47] ⇒ 相交只有 0.04m
   *   （壁座厚 0.1 ⇒ 60% 外挑）。AABB 相交会 PASS，但物理上只是薄搭边、观感仍像浮着。
   *   故要求 **x 与 y 两个方向的重叠量都 ≥0.08m**。
   *
   * 通长构件的识别不写死坐标（避免和源码常量漂移）：直接从 makeParapet 的几何里
   * 取 z 向跨长 > 50m 的件，就地算它们的 AABB。
   */
  it('★ 12/12 座壁座与**通长构件**双轴咬合各 ≥0.08m（钉死"悬空/薄搭边"缺陷）', () => {
    const b = makeParapet();
    const box3 = (g: THREE.BufferGeometry): THREE.Box3 => {
      if (!g.boundingBox) g.computeBoundingBox();
      return g.boundingBox!;
    };
    // ① 通长构件 = 沿 z 跨长 > 50m 的栏板件（基座/低栏板/中横梁/压顶…）
    const LONG_MIN_Z = 50;
    const longParts = [...b.ashlar, ...b.gold]
      .map(box3)
      .filter((bb) => bb.max.z - bb.min.z > LONG_MIN_Z);
    expect(longParts.length, '应有多条通长构件').toBeGreaterThanOrEqual(4);

    // ② 壁座 = 高度带内 y 跨度 > 0.3 的金件（壁座 0.34；蜡烛 0.24 被挡掉）
    const plates = b.gold.filter((g) => {
      if (!inSconceBand(g, 1.2, 1.65)) return false;
      const bb = box3(g);
      return bb.max.y - bb.min.y > 0.3;
    });
    expect(plates.length, '壁座应正好 12 个').toBe(12);

    // ③ 逐座求与任一通长构件的双轴重叠
    const MIN_BITE = 0.08;
    const rows: string[] = [];
    let ok = 0;
    for (const p of plates) {
      const pb = box3(p);
      let best = { dx: 0, dy: 0, which: '-' };
      for (const lb of longParts) {
        const dx = Math.min(pb.max.x, lb.max.x) - Math.max(pb.min.x, lb.min.x);
        const dy = Math.min(pb.max.y, lb.max.y) - Math.max(pb.min.y, lb.min.y);
        if (dx <= 0 || dy <= 0) continue;
        if (Math.min(dx, dy) > Math.min(best.dx, best.dy)) {
          best = {
            dx,
            dy,
            which: `y[${lb.min.y.toFixed(2)},${lb.max.y.toFixed(2)}]`
          };
        }
      }
      const pass = best.dx >= MIN_BITE && best.dy >= MIN_BITE;
      if (pass) ok += 1;
      rows.push(
        `y=${pb.min.y.toFixed(2)}~${pb.max.y.toFixed(2)} → ${best.which} dx=${best.dx.toFixed(3)} dy=${best.dy.toFixed(3)} ${pass ? 'OK' : 'FAIL'}`
      );
    }
    console.log(`R37_SCONCE_BITE ${JSON.stringify({ ok, total: plates.length, minBite: MIN_BITE })}`);
    for (const r of rows) console.log(`  ${r}`);
    // ④ 硬判据：12/12 全部满足双轴咬合
    expect(ok, `壁座背后无实面（双轴咬合 <${MIN_BITE}m）的有 ${plates.length - ok} 座`).toBe(plates.length);
  });

  it('壁座 y 必须落在**中横梁实心带**内（把"悬空"这个缺陷类型钉在数值上）', () => {
    const b = makeParapet();
    const box3 = (g: THREE.BufferGeometry): THREE.Box3 => {
      if (!g.boundingBox) g.computeBoundingBox();
      return g.boundingBox!;
    };
    // 中横梁：z 跨 > 50m 且 y 区间落在 1.2~1.4 的 ashlar 通长件
    const rails = b.ashlar.map(box3).filter((bb) => bb.max.z - bb.min.z > 50 && bb.min.y > 1.15 && bb.max.y < 1.45);
    expect(rails.length, '应能找到中横梁').toBeGreaterThanOrEqual(1);
    const rail = rails[0];
    const plates = b.gold.filter((g) => {
      if (!inSconceBand(g, 1.2, 1.65)) return false;
      const bb = box3(g);
      return bb.max.y - bb.min.y > 0.3;
    });
    for (const p of plates) {
      const pb = box3(p);
      // 壁座中心 y 必须在中横梁带内 ⇒ 壁座是被梁"托/嵌"住的，不是悬在柱间
      const cy = (pb.min.y + pb.max.y) / 2;
      expect(cy, `壁座中心 y=${cy}`).toBeGreaterThanOrEqual(rail.min.y);
      expect(cy, `壁座中心 y=${cy}`).toBeLessThanOrEqual(rail.max.y);
    }
  });
});
