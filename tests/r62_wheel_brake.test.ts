/**
 * R62 · 轮毂制动独立 + 车漆金属化护栏
 *
 * 背景（R62-P0 开发单，主理人已取证）：
 *  P0-1 根因：ExternalShell 原把车漆 material 赋给四轮外部 GLB mesh ⇒ 轮 GLB（一体 lathe、
 *       无内置材质）整块读作车身色，无黑胎/刹车盘/红卡钳。R62 改赋专用 wheel-alloy 材质
 *       （按 car 分支）+ 每轮新增打孔刹车盘（随轮自转）+ 卡钳（挂非自转父，静止）。
 *  P0-2：R60 程序化车漆平涂无金属闪，R62 叠加 clearcoat 清漆层 + 色度/金属度上调贴官图。
 *
 * 本护栏钉结构不变量（源码结构，非建模渲染）；真实观感由 Phase 3 审查线 A/B 逐位比对。
 * 双回滚：`#r62wheel=off` 逐位回 R61（四轮赋车漆 + 不建制动件）；`#r62paint=off` 逐位回 R60。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const v800 = src('src/model/V800Adapter.ts');
const r7 = src('src/model/R7Adapter.ts');

const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

describe('R62-P0-1 · 开关与双回滚', () => {
  it('R62_WHEEL_ON 开关存在，#r62wheel=off 逐位回滚', () => {
    expect(shell).toContain("export const R62_WHEEL_ON = !r51HookOff('r62wheel');");
    expect(shell).toMatch(/r62wheel=off/);
  });

  it('R62_PAINT_ON 开关存在，#r62paint=off 逐位回滚', () => {
    expect(shell).toContain("export const R62_PAINT_ON = !r51HookOff('r62paint');");
    expect(shell).toMatch(/r62paint=off/);
  });
});

describe('R62-P0-1 · 轮毂材质独立（修「整轮=车身同色」）', () => {
  it('四轮 mesh 改赋 wheel-alloy 材质，不再是车漆 material', () => {
    const loop = slice(shell, 'for (const mesh of Object.values(wheelMeshes)) {\n      mesh.material',
      'mesh.castShadow = !proxyMode');
    expect(loop).toContain('wheelAlloyMat');
    expect(loop).toContain('? wheelAlloyMat : material'); // off 回滚分支保留车漆 material
    // 旧的车漆直赋（= R61 根因）不得再作为默认路径
    expect(loop).not.toMatch(/^(\s*)mesh\.material = material;\s*$/m);
  });

  it('wheel-alloy 材质按 car 分支（R7 近黑 / V800 银色涡轮盘面）', () => {
    const table = slice(shell, 'const R62_WHEEL_ALLOY', 'const R62_BRAKE_DISC');
    expect(table).toContain('r7:');
    expect(table).toContain('v800:');
    expect(table).toMatch(/r7:\s*\{\s*color:\s*0x[0-9a-f]+,\s*metalness:\s*[\d.]+,\s*roughness:\s*[\d.]+\s*\}/);
    expect(table).toMatch(/v800:\s*\{\s*color:\s*0x[0-9a-f]+,\s*metalness:\s*[\d.]+,\s*roughness:\s*[\d.]+\s*\}/);
    // R7 近黑：metalness 中低、roughness 中；V800 银：高金属度
    expect(table).toMatch(/v800:\s*\{[^}]*metalness:\s*0\.8/);
  });

  it('wheel-alloy 材质入 dispose 账本（防泄漏）', () => {
    expect(shell).toContain('r62BrakeMats.push(wheelAlloyMat)');
    const clean = slice(shell, 'for (const m of r61SideMats) m.dispose();', 'lampAtlasTex?.dispose();');
    expect(clean).toContain('for (const m of r62BrakeMats) m.dispose();');
    expect(clean).toContain('for (const g of r62BrakeGeos) g.dispose();');
  });
});

describe('R62-P0-1 · 刹车盘 + 卡钳新增几何', () => {
  it('r62BuildBrakeSet 定义：盘(银灰金属) + 卡钳(按 car 分支色)，mergeSafe 按材质分桶', () => {
    expect(shell).toMatch(/export function r62BuildBrakeSet\(/);
    const fn = slice(shell, 'export function r62BuildBrakeSet(', 'export function mountExternalBrake(');
    expect(fn).toContain('const discMerged = mergeSafe(discGeos);'); // 盘按材质分桶合并
    expect(fn).toContain('R62_BRAKE_DISC.color');                   // 盘银灰金属
    expect(fn).toContain('R62_CALIPER[car]');                        // 卡钳按 car 分支色
    expect(fn).toContain('new THREE.CylinderGeometry');              // 打孔盘=圆柱
    expect(fn).toMatch(/rotateZ\(Math\.PI \/ 2\)/);                  // 柱轴转到车轴 X
    expect(fn).toContain('outMats.push(discMat, calMat);');
    expect(fn).toContain('outGeos.push(discMerged, calGeo);');
  });

  it('卡钳 R7 红（语义 caliper-red #B0202A），V800 暗灰低调', () => {
    expect(shell).toMatch(/const R62_CALIPER: Record<ExternalCarId, number> = \{ r7: 0xb0202a, v800: 0x[0-9a-f]+ \}/);
    expect(shell).toMatch(/r7: 0xb0202a/); // R7 红卡钳
  });

  it('盘随轮自转（挂 spin）+ 卡钳不转（挂 spin 的非自转父）', () => {
    expect(shell).toMatch(/export function mountExternalBrake\(/);
    const fn = slice(shell, 'export function mountExternalBrake(', '/* ══════════════════════════════════════════════════════════════════════════\n * R49-A2 · 阴影投影代理');
    // 盘 → spin.add
    expect(fn).toContain('spin.add(brake.disc)');
    expect(fn).toMatch(/const discLocal = new THREE\.Matrix4\(\)\.copy\(spinWorld\)\.invert\(\)\.multiply\(hubLocal\)/);
    // 卡钳 → spin.parent（非自转）
    expect(fn).toContain('const parent = spin.parent');
    expect(fn).toContain('parent.add(brake.caliper)');
    // R63-P1-A 修正：原断言钉的是 `parentWorld⁻¹ × spinWorld × hubLocal`，该式把 hub 平移
    // 多乘一次 spinWorld ⇒ 卡钳漂到 `hubWorld + R_spin·hubWorld`（=「红块悬空在后轮旁」根因）。
    // 正确式为 `parentWorld⁻¹ × T(hubWorld)`（卡钳静止于轮心）。本护栏随之更正。
    expect(fn).toMatch(/const calLocal = new THREE\.Matrix4\(\)\.copy\(parentWorld\)\.invert\(\)\.multiply\(hubLocal\)/);
  });

  it('handle 暴露 brakes，构建按 R62_WHEEL_ON 门控（off ⇒ brakes 留空 = 回 R61）', () => {
    expect(shell).toContain('readonly brakes: Readonly<Record<string, WheelBrakeSet>>;');
    const build = slice(shell, 'const brakes: Record<string, WheelBrakeSet> = {};', 'bodyMesh.scale.setScalar(manifest.scale);');
    expect(build).toMatch(/if \(R62_WHEEL_ON && hasWheelSplit\)/);
    expect(build).toContain('r62BuildBrakeSet(car, manifest.wheelRadius, r62BrakeMats, r62BrakeGeos)');
    expect(shell).toContain('      brakes,');
  });

  it('两 Adapter 接线：mountExternalBrake 在 mountExternalWheel 之后按 tag 挂载', () => {
    for (const [name, ad] of [['V800Adapter', v800], ['R7Adapter', r7]] as const) {
      expect(ad).toContain('mountExternalBrake,');
      const mount = slice(ad, 'mountExternalWheel(shell.bodyMesh, hubModel, best.spin, shell.wheelMeshes[tag], shell.manifest.scale);',
        'console.error(`[R44] 外部轮');
      expect(mount).toContain('const brake = shell.brakes[tag]');
      expect(mount).toContain('if (brake) mountExternalBrake(hubModel, best.spin, brake, shell.manifest.scale)');
    }
  });
});

describe('R62-P0-2 · 车漆金属化（只动材质，不动几何）', () => {
  it('程序化车漆叠加 clearcoat 清漆层（默认 0.7 / rough 0.12，可 #r62clearcoat= 扫参）', () => {
    expect(shell).toContain("export const R62_PAINT_CLEARCOAT = r56HashNum('r62clearcoat') ?? 0.7;");
    expect(shell).toContain("export const R62_PAINT_CLEARCOAT_ROUGH = r56HashNum('r62clearcoatrough') ?? 0.12;");
    const proc = slice(shell, 'if (R62_PAINT_ON) {', 'material.needsUpdate = true;');
    expect(proc).toContain('material.clearcoat = R62_PAINT_CLEARCOAT');
    expect(proc).toContain('material.clearcoatRoughness = R62_PAINT_CLEARCOAT_ROUGH');
  });

  it('色度/金属度按变体上调（chroma/metal 乘子，white 例外保持暖白）', () => {
    const table = slice(shell, 'const R62_PROC_PAINT_TWEAK', 'export const R62_PAINT_CLEARCOAT');
    for (const v of ['white', 'black', 'gold', 'purple', 'green']) {
      expect(table).toContain(`${v}:`);
    }
    expect(table).toMatch(/white:\s*\{\s*chroma:\s*1\.0,\s*metal:\s*1\.0\s*\}/); // white 不动
    // 叠加在 useProcPaint 分支：color 按线性比例缩放 + metalness 上调
    const proc = slice(shell, 'if (R62_PAINT_ON) {', 'material.clearcoat = R62_PAINT_CLEARCOAT');
    expect(proc).toContain('R62_PROC_PAINT_TWEAK[variant]');
    expect(proc).toContain('c.r * tw.chroma');
    expect(proc).toContain('procPaint.metalness * tw.metal');
  });

  it('只动材质不动几何：tweak 仅在 useProcPaint 分支，R59 脏贴图路径构造体字面量逐位保留', () => {
    // R60 程序化分支仍逐字含 color.setHex / metalness / roughness 落表（回滚基线）
    const base = slice(shell, 'if (procPaint) {\n        material.color.setHex(procPaint.color);',
      'if (R62_PAINT_ON) {');
    expect(base).toContain('material.color.setHex(procPaint.color)');
    expect(base).toContain('material.metalness = procPaint.metalness');
    expect(base).toContain('material.roughness = procPaint.roughness');
    // R59 脏贴图路径构造体字面量不变（r60 护栏依赖）
    expect(shell).toContain('roughnessMap: mrTex, // G 通道');
    expect(shell).toContain('metalnessMap: mrTex, // B 通道');
    expect(shell).toContain('roughness: 1,');
  });
});
