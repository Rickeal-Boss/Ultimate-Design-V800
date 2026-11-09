/**
 * R64 · P0-3 制动件 + 4 setter 幂等护栏（R64-DECISION-4 / 方案 C）
 *
 * 裁决：**否决 InstancedMesh / 不合批 / 不逐帧重算矩阵**。8 个 mesh 是
 * `matrixAutoUpdate=false` 静态矩阵（零每帧成本）、R63 挂载单位 /
 * double-translation 刚修好 ⇒ 改造风险 >> 6 DC 收益。定案：
 *   8 个 DoubleSide → FrontSide（省一半背面光栅化）
 *   + 8 份材质/几何 → 2 份共享（盘 1 / 卡钳 1，按 car 分键、账本去重 length=2）。
 * **DC 不变**（8 个独立 mesh 仍是 8 个 draw call）——禁止写成「合批降 DC」。
 * `r62BuildBrakeSet` / `mountExternalBrake` 函数体字面量与 R63 挂载矩阵语义
 * 一字不动；既有护栏一个字不动。
 *
 * 达标判据：DC 不增（允许 ΔDC=0，禁止 >0）+ 材质实例 ≤2 + 8 件全 FrontSide
 * + 每帧无新增矩阵上传。**A3 反向判据：制动件 mesh 数仍 = 8，实测 ΔDC=−6
 * 反而是打回信号**（说明被合批/隐藏）。
 *
 * 灯热路径按实测降级：`setHeadlights` 只写标量、真正每帧材质写在 `update()`
 * 且 `r48_lamp.test.ts:19-67` 钉死、three 每帧无条件上传 emissive uniform
 * ⇒ **只给 4 个 setter 加幂等 early-return，不动 update() 里 19 处公式**。
 * 收益 ≈ 0，**不得包装成帧时优化**（R18 表述纪律）。本波流畅度真实收益
 * 只有「制动件 FrontSide 光栅化减半 + 材质实例 8→2」。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  R64_BRAKE_ON,
  R64_LAMP_DIRTY_ON
} from '../src/model/external/ExternalShell';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const v800 = src('src/model/V800Adapter.ts');
const r7 = src('src/model/R7Adapter.ts');
const game = src('src/core/Game.ts');

const brakeBlock = (): string => {
  const gate = shell.indexOf('if (R64_BRAKE_ON && R62_WHEEL_ON && hasWheelSplit) {');
  return shell.slice(gate, shell.indexOf('bodyMesh.scale.setScalar(manifest.scale);', gate));
};

describe('R64 · P0-3 制动件：8 mesh / DC 不变 / FrontSide / 2 共享材质', () => {
  it('R64_BRAKE_ON 开关存在，#r64brake=off 逐位回 R63', () => {
    expect(shell).toContain("export const R64_BRAKE_ON = !r51HookOff('r64brake');");
    expect(shell).toMatch(/r64brake=off/);
    expect(R64_BRAKE_ON).toBe(true);
  });

  it('★ DC 不变声明 + 否决 InstancedMesh / 合批（A3 反向判据：mesh 数仍 = 8）', () => {
    expect(shell).toContain('DC 不变');
    expect(shell).not.toContain('new THREE.InstancedMesh');
    expect(shell).not.toContain('instanceMatrix');
    expect(shell).not.toContain('computeBoundingSphere()');
    // 4 轮循环仍在（原式，护栏钉死）⇒ 8 mesh 对象一个不少
    expect(shell).toContain('const brakes: Record<string, WheelBrakeSet> = {};');
    expect(shell).toContain('if (R62_WHEEL_ON && hasWheelSplit) {');
    expect(shell).toContain('r62BuildBrakeSet(car, manifest.wheelRadius, r62BrakeMats, r62BrakeGeos)');
    expect(shell).toContain('      brakes,');
  });

  it('★ 8 件全 FrontSide，且 side 改动包在 if (R64_BRAKE_ON) 内保回滚', () => {
    const block = brakeBlock();
    expect(block).toContain('const sharedMats: THREE.Material[] = [');
    expect(block).toContain('for (const m of sharedMats) m.side = THREE.FrontSide;');
    expect(block).toContain('b.disc.material = sharedMats[0];');
    expect(block).toContain('b.caliper.geometry = sharedGeos[1];');
    // off 态 ⇒ 不进块 ⇒ 8×DoubleSide 原状（原式仍在 r62BuildBrakeSet 函数体）
    expect(shell).toContain('side: THREE.DoubleSide');
  });

  it('★ 账本去重后 length = 2/车（A4 抓手）+ wheelAlloyMat 单独释放不误 dispose', () => {
    const block = brakeBlock();
    expect(block).toContain('const keepM = new Set<THREE.Material>(sharedMats);');
    expect(block).toContain('const keepG = new Set<THREE.BufferGeometry>(sharedGeos);');
    expect(block).toContain('if (m !== wheelAlloyMat) m.dispose();');
    expect(block).toContain('r62BrakeMats.splice(i, 1);');
    expect(block).toContain('g.dispose(); r62BrakeGeos.splice(i, 1);');
    expect(block).not.toContain('keepM.add(wheelAlloyMat)'); // wheelAlloy 不在制动件账本里
    expect(shell).toContain('wheelAlloyMat?.dispose();');    // dispose() 末尾单独释放
    // 单独释放行放在 lampAtlasTex?.dispose() 之后 ⇒ 不进 r62 dispose slice
    const clean = shell.slice(
      shell.indexOf('for (const m of r61SideMats) m.dispose();'),
      shell.indexOf('lampAtlasTex?.dispose();')
    );
    expect(clean).toContain('for (const m of r62BrakeMats) m.dispose();');
    expect(clean).toContain('for (const g of r62BrakeGeos) g.dispose();');
    expect(clean).not.toContain('wheelAlloyMat?.dispose();');
  });

  it('★ 共享材质按 car 分键缓存（两车不串色，A7）', () => {
    const block = brakeBlock();
    expect(block).toContain('天然按 car');
    expect(block).toContain('R62_CALIPER[car]');
    expect(shell).toContain('const R62_CALIPER: Record<ExternalCarId, number> = { r7: 0xb0202a, v800:');
    // 共享实例取自本次 loadExternalShell(car,...) 闭包内新建的 brakes.fl ⇒ 不跨车
    expect(block).toContain('const firstSet = brakes.fl;');
  });

  it('★ 原式 r62BuildBrakeSet 一字不动（r62/r63 护栏 slice 锚点）', () => {
    const fn = shell.slice(
      shell.indexOf('export function r62BuildBrakeSet('),
      shell.indexOf('export function mountExternalBrake(')
    );
    expect(fn).toContain('const discMerged = mergeSafe(discGeos);');
    expect(fn).toContain('new THREE.CylinderGeometry');
    expect(fn).toContain('rotateZ(Math.PI / 2)');
    expect(fn).toContain('R62_BRAKE_DISC.color');
    expect(fn).toContain('R62_CALIPER[car]');
    expect(fn).toContain('new THREE.BoxGeometry(calH, calW, calD)');
    expect(fn).toContain('new THREE.ExtrudeGeometry(');
    expect(fn).toContain('outMats.push(discMat, calMat);');
    expect(fn).toContain('outGeos.push(discMerged, calGeo);');
    expect(fn).toContain('caliper.name = `r62-caliper-${car}`;');
    expect(fn).toContain('disc.castShadow = false;');
    expect(fn).toContain('caliper.castShadow = false;');
    expect(fn).toContain('side: THREE.DoubleSide');
  });

  it('★ R63 挂载矩阵语义一字不动（盘随 spin 自转 / 卡钳静止 / 静态矩阵）', () => {
    const fn = shell.slice(
      shell.indexOf('export function mountExternalBrake('),
      shell.indexOf('/* ══════════════════════════════════════════════════════════════════════════\n * R49-A2')
    );
    expect(fn).toContain('const hubWorld = spin.getWorldPosition(new THREE.Vector3());');
    expect(fn).toContain('const hubLocal = new THREE.Matrix4().makeTranslation(');
    expect(fn).toContain('spin.add(brake.disc)');
    expect(fn).toContain('const discLocal = new THREE.Matrix4().copy(spinWorld).invert().multiply(hubLocal)');
    expect(fn).toContain('const parent = spin.parent');
    expect(fn).toContain('parent.add(brake.caliper)');
    expect(fn).toContain('const calLocal = new THREE.Matrix4().copy(parentWorld).invert().multiply(hubLocal)');
    expect(fn).not.toMatch(/makeScale\(scaleFactor/);
    expect(fn).not.toMatch(/const calLocal = new THREE\.Matrix4\(\)\.copy\(parentWorld\)\.invert\(\)\.multiply\(spinWorld\)/);
    expect(fn).toContain('matrixAutoUpdate = false');
  });

  it('两 Adapter 的 mountExternalBrake 调用行逐字保留（r62 Adapter 接线断言）', () => {
    for (const ad of [v800, r7]) {
      expect(ad).toContain('mountExternalBrake,');
      expect(ad).toContain('const brake = shell.brakes[tag]');
      expect(ad).toContain('if (brake) mountExternalBrake(hubModel, best.spin, brake, shell.manifest.scale)');
    }
  });

  it('制动件改动未改 UV / 未新增挂件（零新增 mesh ⇒ 无需 r44External 打标）', () => {
    const block = brakeBlock();
    expect(block).not.toContain("setAttribute('uv'");
    expect(block).not.toContain("setAttribute('color'");
    expect(block).not.toContain('.add(');
    expect(shell).not.toContain('new THREE.InstancedMesh');
  });
});

describe('R64 · 灯热路径：4 个 setter 幂等，update() 公式一字不动', () => {
  it('R64_LAMP_DIRTY_ON 开关存在，#r64lampdirty=off 逐位回 R63', () => {
    expect(shell).toContain("export const R64_LAMP_DIRTY_ON = !r51HookOff('r64lampdirty');");
    expect(shell).toMatch(/r64lampdirty=off/);
    expect(R64_LAMP_DIRTY_ON).toBe(true);
  });

  it('★ 只 import R64_LAMP_DIRTY_ON，两 Adapter 不含 r64WriteEI / 不改 update()', () => {
    for (const ad of [v800, r7]) {
      expect(ad).toContain('R64_LAMP_DIRTY_ON,');
      expect(ad).not.toContain('r64WriteEI');
    }
    expect(shell).not.toContain('r64WriteEI');
    // update() 原式逐字保留
    expect(v800).toContain('if (tailMat) tailMat.emissiveIntensity = brakeLevel + snapGain;');
    expect(v800).toContain('if (headMat) headMat.emissiveIntensity = headLevel;');
    expect(v800).toContain('if (tailFieldMat) tailFieldMat.emissiveIntensity = brakeLevel + snapGain;');
    expect(v800).toContain('if (markMat) markMat.emissiveIntensity = markBase *');
    expect(r7).toContain('for (const mat of tailMatTargets) mat.emissiveIntensity = ei;');
    expect(r7).toContain('for (const mat of headMats) mat.emissiveIntensity = headLevel;');
    expect(r7).toContain('if (caliperMat) caliperMat.emissiveIntensity = heat * 1.1;');
  });

  it('★ 4 个 setter 均有「赋值前比较、相等则跳过」early-return（A25 源码断言）', () => {
    for (const ad of [v800, r7]) {
      expect(ad).toContain('if (R64_LAMP_DIRTY_ON && brakeTarget === next) return;');
      expect(ad).toContain('brakeTarget = next;');
      expect(ad).toContain('if (R64_LAMP_DIRTY_ON && headTarget === next) return;');
      expect(ad).toContain('headTarget = next;');
      // 不改变 damp/headTarget 联动语义
      expect(ad).toContain('headLevel = damp(headLevel, headTarget, 14, dt);');
    }
    expect(v800).toContain('const next = intensity;');
    expect(r7).toContain('const next = clamp01(intensity);');
    expect(v800).toContain('const next = on ? HEAD_BASE : 0.15;');
    expect(r7).toContain('const next = on ? headBaseIntensity : HEAD_DIM_INTENSITY;');
  });

  it('★ r48_lamp.test.ts 钉死的 extRear/extFront 公式段原式逐字不动', () => {
    for (const ad of [v800, r7]) {
      expect(ad).toContain('0.30 + (brakeLevel');
      expect(ad).toContain('* 0.85');
      expect(ad).toContain('0.16 + (brakeLevel');
      expect(ad).toContain('* 0.34');
      expect(ad).toContain('R51_TAIL_EI_MAX');
      expect(ad).toContain('if (R51_TAIL_ON) {');
      expect(ad).toContain('if (R51_LAMP_ON) {');
      expect(ad).toContain('extRear.emissiveIntensity = R48_LAMP_TONE');
    }
    expect(v800).toContain('0.12 + (headLevel / HEAD_BASE) * 0.78');
    expect(v800).toContain(': 0.12 + headLevel * 0.9; // R47 原状');
    expect(v800).toContain('extFront.emissiveIntensity = R48_LAMP_TONE');
    expect(r7).toContain('0.30 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.85');
  });

  it('Game.ts 每帧调用点未改（setHeadlights / setBrakeLights 仍在 :1556/:1549）', () => {
    expect(game).toContain('this.car.setHeadlights(this.sm.phase !== \'menu\');');
    expect(game).toContain('this.car.setBrakeLights(');
    expect(game).not.toContain('r64WriteEI');
  });

  it('表述纪律（R18）：收益 ≈ 0，不得包装成帧时优化（impl-notes 书面声明）', () => {
    expect(v800).toContain('收益 ≈ 0');
    expect(v800).toContain('不宣称帧时优化');
    const notes = src('.qa/r64/impl-notes.md');
    expect(notes).toContain('收益 ≈ 0');
    expect(notes).toContain('不得包装成帧时优化');
    expect(notes).toContain('three 每帧无条件上传 emissive uniform');
    expect(notes).toContain('制动件 FrontSide 光栅化减半');
    expect(notes).toContain('材质实例 8→2');
  });
});
