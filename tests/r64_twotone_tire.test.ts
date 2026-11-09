/**
 * R64 · P0-1 双色车身 / P0-2 黑胎 —— **运行时顶点色**护栏（R64-DECISION-4）
 *
 * 定案形态：`Uint8BufferAttribute(arr,3,true)`（normalized=true）加在**运行时内存
 * geometry、不写回 GLB 文件**；`material.vertexColors = true`。否决 onBeforeCompile
 * shader 注入（零 GLSL / 零 customProgramCacheKey / 零 uniform 同步）。
 *
 * 判据（审查线 v3.2 / A20-A23）：
 *  · L1 资产层 `--expect-color none` PASS（GLB 逐位不变、无 COLOR_0、UV 未重映射）；
 *  · L2 `--check-runtime` 才是契约证据：color `itemSize===3` / **`normalized===true`**
 *    / `count===position.count` / `vertexColors===true` / **只追加 color 未动 uv**；
 *  · 双色 `y0=0.222` + 过渡 `0.018` + `normal(|ny|<0.65)` 联合门控（防误染引擎盖），
 *    上部乘子 1.0 / 下部 0.09；仅 V800（R7 不启用）；
 *  · 黑胎逐顶点实算**每车 rmax** 归一 `r=hypot(y,z)/rmax∈[0,1]`，阈值 0.85、
 *    软过渡 0.02、外圈乘子 0.03 / 内圈 1.0；**禁用 GLB accessor.min/max**
 *    （v800 四轮元数据陈旧 +4.85%~9.82%）、禁用套 r7 分箱；
 *  · 顶点色写在 `ExternalShell.ts:2183-2198`（R47 rotateY(π) / R52 alignWheelAxleToX）
 *    **之后**、用**几何局部 position** 首建一次，不依赖运行时世界矩阵；
 *  · `USE_COLOR` 新 program 变体预热落在 `waitForShellGate` 回调内（Game.ts）。
 *
 * ⚠ 书面声明：本波 **未修改 uv attribute、未对四轮几何 UV bbox 重映射**，
 *   只**新增** color attribute。`#uvassert` 覆盖不到外部壳（材质无 sculptMaterial.id），
 *   全绿不是 UV 安全证据；审查线另跑 GLB 专项探针 L1/L2 独立核验。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  r64WriteTwoTone,
  r64WriteTireBands,
  r64WheelRmax,
  R64_PAINT_ON,
  R64_TIRE_ON
} from '../src/model/external/ExternalShell';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const game = src('src/core/Game.ts');
/** R64 全部新声明集中在文件末尾（避开既有护栏 slice/indexOf 锚点）。 */
const r64Module = shell.slice(shell.indexOf('export const R64_PAINT_ON'));

const mkGeo = (coords: number[], normals?: number[]): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
  if (normals) g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return g;
};
const mkMesh = (coords: number[]): THREE.Mesh => {
  const g = mkGeo(coords);
  // 故意塞入陈旧的 boundingBox（模拟 v800 GLB accessor.min/max 元数据偏小）
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(-0.03, -0.04, -0.04),
    new THREE.Vector3(0.03, 0.04, 0.04)
  );
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
};

describe('R64 · 形态定案：顶点色而非 shader 注入', () => {
  it('五钩子齐备（默认 ON，=off 逐位回 R63）', () => {
    for (const k of ['r64paint', 'r64tire', 'r64brake', 'r64variant', 'r64lampdirty']) {
      expect(shell).toContain(`!r51HookOff('${k}')`);
      expect(shell).toMatch(new RegExp(`${k}=off`));
    }
    expect(R64_PAINT_ON).toBe(true);
    expect(R64_TIRE_ON).toBe(true);
    expect(r64Module).toContain("branch: 'vertex-color'");
  });

  it('★ 零 shader 注入：不含 onBeforeCompile 覆写 / customProgramCacheKey / GLSL', () => {
    // 用「赋值语句」而非「词」断言（注释里说明性提及不算）
    expect(r64Module).not.toMatch(/material\.onBeforeCompile\s*=/);
    expect(shell).not.toMatch(/\.customProgramCacheKey\s*=/);
    expect(shell).not.toContain('r64InstallPaintShader');
    expect(shell).not.toContain('r64InstallTireShader');
    expect(shell).not.toContain('r64SyncPaintUpper');
    expect(shell).not.toContain('new THREE.InstancedMesh');
    // A11：onBeforeCompile 保持默认（R51-B2 只在 !useProcPaint 脏贴图路径赋值）
    const rough = shell.slice(
      shell.indexOf('if (R51_ROUGH_ON) {'),
      shell.indexOf('const bodyMesh = bodyFound;')
    );
    expect(rough).toContain('if (useProcPaint)');
    expect(rough).toContain('material.onBeforeCompile = (shader) => {');
    // 不设 customProgramCacheKey ⇒ three 默认取 onBeforeCompile.toString()
    // （所有材质都是同一个默认空函数文本）⇒ body / 4 轮文本一致
    expect(r64Module).not.toMatch(/\.customProgramCacheKey\s*=/);
  });

  it('★ 只追加 color、未改 uv（书面声明 + 源码断言）', () => {
    expect(r64Module).toContain("setAttribute('color'");
    expect(r64Module).not.toContain("setAttribute('uv'");
    expect(r64Module).not.toContain('remapUV');
    // 未写回 GLB 资产文件（无 fs / 无 GLB 导出路径）
    expect(r64Module).not.toContain('writeFileSync');
    expect(r64Module).not.toContain('GLTFExporter');
  });

  it('★ Uint8BufferAttribute(arr,3,true)：normalized=true（A20 机器化判据）', () => {
    expect(r64Module).toContain('new THREE.Uint8BufferAttribute(arr, 3, true)');
    expect(r64Module).toContain('new Uint8Array(pos.count * 3)');
    expect(r64Module).not.toContain('Float32BufferAttribute(arr, 3'); // 误用会 L2 FAIL
    const g = mkGeo([0, 0.35, 0, 0, 0.1, 0]);
    r64WriteTwoTone(g);
    const c = g.getAttribute('color');
    expect(c.itemSize).toBe(3);
    expect(c.normalized).toBe(true);
    expect(c.count).toBe(g.getAttribute('position').count);
    expect(c.array instanceof Uint8Array).toBe(true);
  });

  it('开关是加载期求值；window.__r64Flags 机读，A/B 必须各自 reload', () => {
    expect(r64Module).toContain("evaluatedAt: 'module-load'");
    expect(r64Module).toContain('A/B requires reload');
  });
});

describe('R64 · P0-1 双色车身顶点色（仅 V800，几何局部系）', () => {
  it('参数与门控：y0=0.222 / 过渡 0.018 / 下部 0.09 / normal(|ny|<0.65)', () => {
    expect(r64Module).toContain("const R64_SPLIT_Y = r56HashNum('r64split') ?? 0.222;");
    expect(r64Module).toContain("const R64_SPLIT_BAND = r56HashNum('r64band') ?? 0.018;");
    expect(r64Module).toContain("const R64_LOWER_MUL = r56HashNum('r64lower') ?? 0.09;");
    expect(r64Module).toContain("const R64_GATE = r56HashNum('r64gate') ?? 1;");
    expect(r64Module).toContain('(0.65 - ny) / 0.35');
    expect(r64Module).toContain('Math.abs(nrm.getY(i))');
    // 扫参钩子
    for (const k of ['r64split', 'r64band', 'r64lower', 'r64gate']) {
      expect(shell).toContain(`r56HashNum('${k}')`);
    }
  });

  it('★ 运行时：上部 1.0 / 下部竖直面 0.09 / 下部朝上面**不被误染**（normal 门控）', () => {
    // 顶点顺序：① 上部朝上 ② 下部竖直侧面 ③ 下部朝上（引擎盖类）
    const g = mkGeo(
      [0, 0.35, 0, 0, 0.10, 0, 0, 0.10, 0],
      [0, 1, 0, 1, 0, 0, 0, 1, 0]
    );
    r64WriteTwoTone(g, 0.09);
    const c = g.getAttribute('color');
    // Uint8BufferAttribute(normalized=true) ⇒ getX() 已返回 0~1 归一化线性乘子
    expect(c.getX(0)).toBeCloseTo(1, 6);               // 上部 = 1
    expect(c.getX(1)).toBeCloseTo(0.09, 2);           // 下部竖直面 = 0.09
    expect(c.getX(2)).toBeCloseTo(1, 6);               // 下部朝上面保持 1（门控生效）
    // 三通道一致（灰度乘子，不写死棕色）
    for (const i of [0, 1, 2]) {
      expect(c.getY(i)).toBe(c.getX(i));
      expect(c.getZ(i)).toBe(c.getX(i));
    }
  });

  it('上下亮度差复算：线性乘子 0.09 ⇒ sRGB 上下差 ≥50', () => {
    const toLinear = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const toSrgb = (l: number) =>
      255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
    const upper = 197.9;
    const lower = toSrgb(toLinear(upper) * 0.09);
    expect(upper - lower).toBeGreaterThan(50);
  });

  it('★ 仅 V800 + useProcPaint + R64_PAINT_ON；R7 不启用；写入在 R47/R52 之后', () => {
    expect(shell).toContain("if (R64_PAINT_ON && useProcPaint && car === 'v800') {");
    expect(shell).toContain('r64WriteTwoTone(bodyMesh.geometry)');
    expect(shell).toContain('material.vertexColors = true');
    const rotAt = shell.indexOf('mesh.geometry.rotateY(Math.PI);');
    const writeAt = shell.indexOf('r64WriteTwoTone(bodyMesh.geometry)');
    expect(rotAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(rotAt); // :2183-2198 之后
  });

  it('坐标空间 = 几何局部 y（不依赖运行时世界矩阵 / 不受 body rotY(π) 影响）', () => {
    expect(r64Module).toContain('pos.getY(i)');
    expect(r64Module).not.toContain('getWorldPosition');
    expect(r64Module).not.toMatch(/modelMatrix\s*\*\s*vec4/); // 无世界坐标 GLSL
    expect(r64Module).toContain('几何局部系');
  });

  it('setVariant 无需 uniform 同步（顶点色是乘子，随 material.color 自动跟随）', () => {
    const sv = shell.slice(
      shell.indexOf('async setVariant'),
      shell.indexOf('setGlassOpaque(opaque: boolean): void {')
    );
    expect(sv).not.toContain('r64SyncPaintUpper');
    expect(sv).not.toContain('r64PaintUniforms');
    expect(sv).not.toMatch(/material\.vertexColors\s*=/); // 不重置顶点色契约
  });
});

describe('R64 · P0-2 黑胎半径分区顶点色（逐顶点每车 rmax 归一）', () => {
  it('参数：阈值 0.85 / 软过渡 0.02 / 外圈乘子 0.03 / 内圈 1.0', () => {
    expect(r64Module).toContain("const R64_TIRE_CUT = r56HashNum('r64tire') ?? 0.85;");
    expect(r64Module).toContain("const R64_TIRE_BAND = r56HashNum('r64tireband') ?? 0.02;");
    expect(r64Module).toContain("const R64_TIRE_OUTER = r56HashNum('r64tireouter') ?? 0.03;");
    expect(r64Module).toContain('const k = 1 - (1 - outerMul) * s;');
    for (const k of ['r64tire', 'r64tireband', 'r64tireouter']) {
      expect(shell).toContain(`r56HashNum('${k}')`);
    }
  });

  it('★ 运行时：内圈 1.0 / 外圈 0.03，三通道一致、normalized=true', () => {
    const g = mkGeo([
      0, 0.02, 0,     // r=0.02 / rmax=0.1 ⇒ 0.2（内圈）
      0, 0.095, 0,    // r=0.095 / rmax=0.1 ⇒ 0.95（外圈）
      0, 0.06, 0.06   // r≈0.0848 ⇒ 0.848（过渡带）
    ]);
    r64WriteTireBands(g, 0.1, 0.03);
    const c = g.getAttribute('color');
    expect(c.normalized).toBe(true);
    expect(c.itemSize).toBe(3);
    expect(c.count).toBe(3);
    expect(c.array instanceof Uint8Array).toBe(true);
    expect(c.getX(0)).toBeCloseTo(1, 6);
    expect(c.getX(1)).toBeCloseTo(0.03, 2);
    for (const i of [0, 1, 2]) {
      expect(c.getY(i)).toBe(c.getX(i));
      expect(c.getZ(i)).toBe(c.getX(i));
    }
    // 过渡带值介于内外之间（soft smoothstep 防硬环切）
    expect(c.getX(2)).toBeGreaterThan(0.03);
    expect(c.getX(2)).toBeLessThan(1);
  });

  it('★ r64WheelRmax 逐顶点重算：不受陈旧 boundingBox / accessor 元数据影响', () => {
    const meshes = {
      fl: mkMesh([0, 0.02, 0.03]),
      fr: mkMesh([0, 0.09, 0.04]),   // 超出陈旧 bbox 的 0.04 上界
      rl: mkMesh([0, 0.06, 0.06]),
      rr: mkMesh([0, 0.01, 0.01])
    };
    const got = r64WheelRmax(meshes);
    const want = Math.hypot(Math.fround(0.09), Math.fround(0.04));
    expect(got).toBeCloseTo(want, 12);
    expect(got).toBeGreaterThan(0.04);
    const fn = r64Module.slice(
      r64Module.indexOf('export function r64WheelRmax('),
      r64Module.indexOf('export function r64WriteTireBands(')
    );
    expect(fn).not.toContain('accessor');
    expect(fn).not.toContain('boundingBox');
    expect(fn).toContain('Math.hypot(pos.getY(i), pos.getZ(i))');
  });

  it('★ 顶点色用局部 hypot(y,z)/rmax（禁用世界坐标 / 禁用 R_model 套 r7 分箱）', () => {
    expect(r64Module).toContain('Math.hypot(pos.getY(i), pos.getZ(i)) / R');
    expect(r64Module).toContain('const R = Math.max(rmax, 1e-5)');
    expect(r64Module).not.toContain('wheelRadius / scale');
    expect(r64Module).not.toContain('R_model');       // 不套 r7 的 R_model/rOverR_bins 口径
    expect(r64Module).not.toContain('getWorldPosition');
  });

  it('★ 4 个 wheel geometry 全部一致加 color，共享 1 个材质；注入在 R47/R52 之后', () => {
    expect(shell).toContain('if (R64_TIRE_ON && R62_WHEEL_ON && wheelAlloyMat && hasWheelSplit) {');
    expect(shell).toContain('for (const mesh of Object.values(wheelMeshes)) {');
    expect(shell).toContain('r64WriteTireBands(mesh.geometry, r64Rmax);');
    expect(shell).toContain('wheelAlloyMat.vertexColors = true');
    const rotAt = shell.indexOf('mesh.geometry.rotateY(Math.PI);');
    const writeAt = shell.indexOf('r64WriteTireBands(mesh.geometry, r64Rmax);');
    expect(writeAt).toBeGreaterThan(rotAt);
    expect(shell).toContain('userData as { r64Rmax?: number }'); // QA 机读每车 rmax
  });

  it('空几何/无 position 时 rmax=0，r64WriteTireBands 有 1e-5 下限防除零', () => {
    const empty = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    expect(r64WheelRmax({ fl: empty })).toBe(0);
    expect(r64Module).toContain('Math.max(rmax, 1e-5)');
    expect(() => r64WriteTireBands(new THREE.BufferGeometry(), 0)).not.toThrow();
  });
});

describe('R64 · USE_COLOR 变体预热（A10 / R15）', () => {
  it('★ 预热补在 waitForShellGate 回调内、按材质实例遍历全部 r44External', () => {
    expect(game).toContain('if (this.sideWarmEnabled) this.prewarmShellProgramVariants();');
    expect(game).toContain('const r64ShellMats = new Set<THREE.Material>();');
    expect(game).toContain('r64ShellMats.add(mat)');
    expect(game).toContain('if (r64ShellMats.size > 0) {');
    expect(game).toContain('this.renderer.compile(this.scene, this.rig.camera);');
    // 仍在 prewarmShellProgramVariants 内（loading 屏内），不是构造期 prewarmGpu
    const fn = game.slice(
      game.indexOf('private prewarmShellProgramVariants(): void {'),
      game.indexOf('private prewarmShellProgramVariants(): void {') + 3200
    );
    expect(fn.indexOf('r64ShellMats')).toBeGreaterThan(
      fn.indexOf('const bodyMat = found.mat;')
    );
  });

  it('不改 hash.includes(noprewarm) 入口守卫语义', () => {
    expect(game).toContain(
      "if (!import.meta.env.DEV || !window.location.hash.includes('noprewarm')) this.prewarmGpu();"
    );
    for (const k of ['r64paint', 'r64tire', 'r64brake', 'r64variant', 'r64lampdirty']) {
      expect(k).not.toContain('noprewarm');
    }
  });
});
