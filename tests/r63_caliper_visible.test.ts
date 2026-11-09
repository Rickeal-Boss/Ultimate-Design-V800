/**
 * R63-P1-A · R7 红卡钳醒目化 + 制动件挂载单位修复 护栏（耿键码）
 *
 * 背景（本波开发单）：
 *  ① 挂载单位 bug（R62 遗留，本波根因）：`r62BuildBrakeSet` 用 `wheelRadius`（**世界米**）构建
 *     制动件几何，而轮毂 GLB 是**模型单位**。旧 `mountExternalBrake` 用
 *     `T(hubModel)·S(scaleFactor)` ⇒ 世界米几何被再放大 ~4.3×（R7 scale=4.323）并错位到 1/4.3 处，
 *     盘世界 bbox 实测 2.17m、填满轮拱 = 挡住红卡钳的真因（视觉预研误判为「轮拱内衬」）。
 *  ② 卡钳 double-translation bug（R62 遗留）：`calLocal = parentWorld⁻¹ × spinWorld × hubLocal`
 *     多乘一次 spinWorld ⇒ 卡钳漂到 `hubWorld + R_spin·hubWorld`（=「红块悬空在后轮旁」）。
 *  ③ 卡钳形态：R62 的 BoxGeometry 实心矩形 ⇒ R63 改环抱盘缘的弧形壳（部分圆环挤出），仅 R7。
 *
 * 本护栏钉源码结构不变量（非建模渲染）；真实观感由审查线目检 + 像素门。
 * 回滚：`#r63caliper=off` 逐位回 R62（弧壳→小盒、盘半径回 0.66、卡钳角/径向失效）；
 *       `#r62wheel=off` 仍逐位回 R61（不建制动件）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');

const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

describe('R63-P1-A · 开关与回滚', () => {
  it('R63_CALIPER_ON 开关存在，默认 off（实验分支）#r63caliper=on 启用、=off 逐位回滚', () => {
    // 主理人裁决（2026-11-09 落地审查）：胎外红弧目检打回（读作卡在胎后缘红片，非透辐条卡钳），
    // 沿用 R51 B1-b/c 实验盖板先例默认下线；挂载单位修复独立于本开关、恒生效。
    expect(shell).toContain("export const R63_CALIPER_ON = r51HookOn('r63caliper');");
    expect(shell).toMatch(/r63caliper=on/);
  });

  it('弧壳卡钳可调参（r63calang/r63calro/r63calri/r63calax/r63calspan/r63discr）', () => {
    expect(shell).toMatch(/export const R63_CAL_ANG = r56HashNum\('r63calang'\)/);
    expect(shell).toMatch(/export const R63_CAL_OUTER = r56HashNum\('r63calro'\)/);
    expect(shell).toMatch(/export const R63_CAL_INNER = r56HashNum\('r63calri'\)/);
    expect(shell).toMatch(/export const R63_CAL_AXIAL = r56HashNum\('r63calax'\)/);
    expect(shell).toMatch(/export const R63_CAL_SPAN = r56HashNum\('r63calspan'\)/);
    expect(shell).toMatch(/export const R63_CAL_DISC_R = r56HashNum\('r63discr'\)/);
  });
});

describe('R63-P1-A · R7 环抱弧壳卡钳（消 BoxGeometry 实心块）', () => {
  it('r62BuildBrakeSet：R7+R63_CALIPER_ON 走弧壳(ExtrudeGeometry 部分圆环)，否则走 R62 小盒', () => {
    expect(shell).toMatch(/export function r62BuildBrakeSet\(/);
    const fn = slice(shell, 'export function r62BuildBrakeSet(', 'export function mountExternalBrake(');
    // R7 醒目化分支门控（仅 r7 且开关开）
    expect(fn).toContain("const r63On = car === 'r7' && R63_CALIPER_ON;");
    // 弧壳 = 部分圆环挤出（ExtrudeGeometry + THREE.Shape 环向扫掠），非 BoxGeometry 实心块
    expect(fn).toContain('new THREE.ExtrudeGeometry(');
    expect(fn).toContain('new THREE.Shape()');
    // 环抱盘缘：内半径 < 盘缘、外半径 >1.0R（露到胎外才可见，轮 GLB 是实心盘）
    expect(fn).toContain('const ri = R * R63_CAL_INNER;');
    expect(fn).toContain('const ro = R * R63_CAL_OUTER;');
    // shape(X,Y)→hub(Y,Z)、挤出 Z→hub X（车轴）
    expect(fn).toContain('new THREE.Matrix4().makeBasis(');
    // 回滚分支保留 R62 BoxGeometry 小盒（V800 恒走此）
    expect(fn).toContain('new THREE.BoxGeometry(calH, calW, calD)');
    // R62 护栏依赖的收口不变
    expect(fn).toContain('outMats.push(discMat, calMat);');
    expect(fn).toContain('outGeos.push(discMerged, calGeo);');
  });

  it('R7 盘半径按开关分支（on=0.72R 略加大 / off=0.66R 回 R62），盘仍为打孔圆柱', () => {
    const fn = slice(shell, 'export function r62BuildBrakeSet(', 'export function mountExternalBrake(');
    expect(fn).toContain('const discR = R * (r63On ? R63_CAL_DISC_R : 0.66);');
    expect(fn).toContain('new THREE.CylinderGeometry(discR, discR, discT, 40, 1, false);');
    expect(fn).toMatch(/rotateZ\(Math\.PI \/ 2\)/);
  });

  it('卡钳材质仍按 car 分支色（R7 红 0xb0202a / V800 暗灰），弧壳与小盒共用', () => {
    const fn = slice(shell, 'export function r62BuildBrakeSet(', 'export function mountExternalBrake(');
    expect(fn).toContain('color: R62_CALIPER[car]');
    // 卡钳命名/阴影语义不变（退出 shadow pass）
    expect(fn).toContain("caliper.name = `r62-caliper-${car}`;");
    expect(fn).toContain('caliper.castShadow = false;');
    expect(fn).toContain('caliper.receiveShadow = false;');
    expect(fn).toContain('disc.castShadow = false;');
  });
});

describe('R63-P1-A · 挂载单位修复（巨盘错位 + 卡钳 double-translation 根因）', () => {
  it('mountExternalBrake 用世界 hub（spin.getWorldPosition）、不再乘 scaleFactor', () => {
    expect(shell).toMatch(/export function mountExternalBrake\(/);
    const fn = slice(shell, 'export function mountExternalBrake(', '/* ══════════════════════════════════════════════════════════════════════════\n * R49-A2 · 阴影投影代理');
    // 世界 hub = spin 世界位（mountExternalWheel 已迁）；不乘 scaleFactor（几何已世界米）
    expect(fn).toContain('const hubWorld = spin.getWorldPosition(new THREE.Vector3());');
    expect(fn).toContain('const hubLocal = new THREE.Matrix4().makeTranslation(hubWorld.x, hubWorld.y, hubWorld.z);');
    expect(fn).not.toMatch(/makeScale\(scaleFactor/); // 旧 S(scaleFactor) 放大路径已除
    // 盘挂 spin（随自转、hub 居中）
    expect(fn).toContain('spin.add(brake.disc)');
    expect(fn).toMatch(/const discLocal = new THREE\.Matrix4\(\)\.copy\(spinWorld\)\.invert\(\)\.multiply\(hubLocal\)/);
    // 卡钳挂 spin.parent（静止于轮心）——已修 double-translation（不再多乘 spinWorld）
    expect(fn).toContain('const parent = spin.parent');
    expect(fn).toContain('parent.add(brake.caliper)');
    expect(fn).toMatch(/const calLocal = new THREE\.Matrix4\(\)\.copy\(parentWorld\)\.invert\(\)\.multiply\(hubLocal\)/);
    expect(fn).not.toMatch(/const calLocal = new THREE\.Matrix4\(\)\.copy\(parentWorld\)\.invert\(\)\.multiply\(spinWorld\)/); // 旧 double-translation 式已除
  });
});
