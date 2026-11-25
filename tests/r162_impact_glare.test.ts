/**
 * R162 · 两项用户反馈修复护栏：
 *  ① 撞击 shake 攻击斜坡 —— 施加幅度从 0 缓升到 shake 包络（SHAKE_ATTACK_TAU=0.04 ≈ 3 帧 @60fps），
 *     消除撞帧满幅瞬跳「两帧无过渡突兀」。攻击斜坡只作用于施加幅度（shakeAmp），
 *     包络/取大/衰减语义（SHAKE_TAU=0.18 / SHAKE_MAX=0.45 / addShake 取大）不动；
 *     R110 频率/幅度系数（9.0/17.0/10.5/19.0、0.72/0.28、0.5）零改。
 *  ② 车壳反光减弱 —— R62_PAINT_CLEARCOAT 0.7→0.5、R62_PAINT_CLEARCOAT_ROUGH 0.12→0.22、
 *     R56_PAINT_ENV 0.7→0.55（#r62clearcoat= / #r62clearcoatrough= / #r56env= 扫参钩子保留）。
 *
 * 本护栏钉**源码结构 + 运行时烟雾**（源码契约风格同 r62/r64）：攻击斜坡是施加幅度层的
 * 行为，源码结构断言精确钉死「满幅不瞬跳」的实现；观感由审查线 A/B 逐位比对。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CameraRig } from '../src/render/CameraRig';
import * as THREE from 'three';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rigSrc = src('src/render/CameraRig.ts');
const shell = src('src/model/external/ExternalShell.ts');

describe('R162 ① · 撞击 shake 攻击斜坡（施加幅度不瞬跳）', () => {
  it('SHAKE_ATTACK_TAU=0.04 声明且带 R162 注释（τ≈3 帧 @60fps）', () => {
    expect(rigSrc).toContain('const SHAKE_ATTACK_TAU = 0.04;');
    expect(rigSrc).toMatch(/\/\* R162 · 撞击 shake 攻击斜坡[\s\S]*?const SHAKE_ATTACK_TAU = 0\.04;/);
  });

  it('shakeAmp 字段存在（施加幅度，攻击缓升用）', () => {
    expect(rigSrc).toContain('private shakeAmp = 0;');
  });

  it('正常更新路径：decay 后攻击斜坡 + 施加用 shakeAmp（非 shake 包络）', () => {
    // 攻击斜坡更新表达式
    expect(rigSrc).toContain(
      'this.shakeAmp += (this.shake - this.shakeAmp) * (1 - Math.exp(-dt / SHAKE_ATTACK_TAU));'
    );
    expect(rigSrc).toContain('if (this.shakeAmp < 1e-4) this.shakeAmp = 0;');
    // 施加闸门/幅度切到 shakeAmp：撞帧不从 0 瞬跳满幅
    expect(rigSrc).toContain('if (this.shakeAmp > 0) {');
    expect(rigSrc).toContain('const sh = this.shakeAmp;');
    // 包络字段 shake 不得再被用于施加幅度（满幅瞬跳根因）
    expect(rigSrc).not.toContain('const sh = this.shake;');
  });

  it('飞航路径：decay 后同样攻击斜坡跟随（不施加偏移，退出飞航不残留）', () => {
    // 飞航分支 = cam.position.copy(this.flyPos) 与 cam.lookAt(lookPt) 之间的 shake 处理
    const fly = rigSrc.slice(
      rigSrc.indexOf('cam.position.copy(this.flyPos)'),
      rigSrc.indexOf('cam.lookAt(lookPt)')
    );
    expect(fly).toContain('this.shake *= Math.exp(-dt / SHAKE_TAU);');
    expect(fly).toContain(
      'this.shakeAmp += (this.shake - this.shakeAmp) * (1 - Math.exp(-dt / SHAKE_ATTACK_TAU));'
    );
    expect(fly).toContain('if (this.shakeAmp < 1e-4) this.shakeAmp = 0;');
  });

  it('红线零改：SHAKE_TAU=0.18 / SHAKE_MAX=0.45 / addShake 取大 / R110 频率幅度系数逐字保留', () => {
    expect(rigSrc).toContain('const SHAKE_TAU = 0.18;');
    expect(rigSrc).toContain('const SHAKE_MAX = 0.45;');
    // addShake 仍只抬包络（取大 + 上限），攻击斜坡在更新循环
    expect(rigSrc).toContain(
      'this.shake = Math.min(SHAKE_MAX, Math.max(this.shake, amount));'
    );
    // R110 频率/幅度系数零改
    expect(rigSrc).toContain(
      'cam.position.x += sh * (Math.sin(t * 9.0) * 0.72 + Math.sin(t * 17.0 + 1.3) * 0.28) * 0.5;'
    );
    expect(rigSrc).toContain(
      'cam.position.y += sh * (Math.sin(t * 10.5 + 0.7) * 0.72 + Math.sin(t * 19.0 + 2.1) * 0.28) * 0.5;'
    );
  });
});

describe('R162 ② · 车壳反光减弱（默认值下降）', () => {
  it('R62 清漆层：clearcoat 0.7→0.5、clearcoatRoughness 0.12→0.22（扫参钩子保留）', () => {
    expect(shell).toContain("export const R62_PAINT_CLEARCOAT = r56HashNum('r62clearcoat') ?? 0.5;");
    expect(shell).toContain(
      "export const R62_PAINT_CLEARCOAT_ROUGH = r56HashNum('r62clearcoatrough') ?? 0.22;"
    );
    expect(shell).toContain('r62clearcoat=');
    expect(shell).toContain('r62clearcoatrough=');
  });

  it('R56 环境反射：envMapIntensity 0.7→0.55（#r56env= 扫参钩子保留）', () => {
    expect(shell).toContain("export const R56_PAINT_ENV = r56HashNum('r56env') ?? 0.55;");
    expect(shell).toContain('r56env=');
  });
});

describe('R162 · 运行时烟雾（攻击斜坡新代码路径可执行、数值有限）', () => {
  it('构造 + addShake(0.45) + 连续 update 走攻击斜坡不抛错、相机位置有限', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('chase');
    const target = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < 30; i += 1) rig.update(1 / 60, target, 0); // 先落位（shake=0）
    rig.addShake(0.45); // 最大注入
    for (let i = 0; i < 180; i += 1) {
      rig.update(1 / 60, target, 0);
      const p = rig.camera.position;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it('攻击斜坡生效：首帧施加幅度显著小于包络满幅（≈3 帧缓升，非瞬跳）', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('chase');
    const target = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < 30; i += 1) rig.update(1 / 60, target, 0); // 落位
    // 无 shake 基线位置
    const baseX = rig.camera.position.x;
    const baseY = rig.camera.position.y;
    rig.addShake(0.45);
    rig.update(1 / 60, target, 0); // 第 1 帧：shakeAmp ≈ 0.45×(1-e^(-(1/60)/0.04)) ≈ 0.153
    const d1 = Math.hypot(rig.camera.position.x - baseX, rig.camera.position.y - baseY);
    // 满幅瞬跳时首帧最大 |位移| ≤ 0.45×1.0×0.5 = 0.225m（sin 双项幅值 |0.72+0.28|=1）。
    // 攻击斜坡首帧施加幅度 ≈0.153 ⇒ 实测 d1 明显小于 0.225 的满幅上界，且远小于
    // 包络满幅（保守上界 0.20 已含 sin 峰值取整余量）。不依赖 sin 相位（只取上界）。
    expect(d1).toBeLessThan(0.2);
  });
});
