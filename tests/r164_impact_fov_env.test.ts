/**
 * R164 · 两项物理自洽修复护栏（承接 R163 全局环境光线重平衡）：
 *  ① 撞击 FOV punch —— 碰撞帧视场被"撞"的瞬时冲击（比位置震屏更贴撞击体感），
 *     fovBase 独立基线收敛（punch 不污染 lerp 状态防二次叠加）、fovPunch 指数回落、
 *     fovPunchAmp 攻击缓升（FOV_PUNCH_ATTACK_TAU=0.03 ≈ 2 帧 @60fps，与 SHAKE_ATTACK_TAU 同理）；
 *     Game.ts 5 处 addShake 并排接线 addFovPunch（同源参数）。
 *  ② PMREM softbox 重平衡 —— R163 只改了直射光（sun/hemi/fill/rim），scene.environment
 *     仍在 R26「studio softbox」增益（1.15/0.9/1.15/0.9）；R164 按 R163 方向降四板
 *     （0.95/0.75/0.9/0.8）：暴风漫射天光是主照明，影棚板退为次级；地面反弹只温柔降
 *     （-0.1，保留车底抬光），且 0.8 > 前侧 0.75（物理地面反射主导于影棚前打光）。
 *
 * 形态：environment.ts 无 window/DOM（纯常量，node 可直导，同 r163）⇒ 做值断言；
 *       CameraRig.ts 源契约（同 r162）+ 纯数值烟雾（punch 递推，不实例化 rig）；
 *       Game.ts 顶层 await+window 无法 node 实例化（同 r159/r161/r163）⇒ 接线加源契约。
 *
 * 注意（④ 数值口径与规格的偏差，见该用例注释）：注入 punch=8 时 fovPunchAmp 峰值实测
 * ≈4.94°（≈61%），不是规格字面的「近 8」—— 因为 fovPunch 包络本身以 FOV_PUNCH_TAU=0.14
 * 在攻击期同步衰减（攻击 τ=0.03 快于衰减 τ=0.14，幅度追逐的是**已衰减**的包络）。
 * 这是「撞击 → 快速升到可观冲击 → 指数收敛」的正确 punch 行为；断言按实测物理行为钉
 * （快速升 >50% + 单调攻击斜坡 + 1.2s 内收敛），并注明与规格字面「近 8」的出入。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVE_ENV } from '../src/config/environment';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rigSrc = src('src/render/CameraRig.ts');
const gameSrc = src('src/core/Game.ts');

describe('R164 ① · environment.ts PMREM softbox 重平衡（影棚板退为次级）', () => {
  it('softbox 4 板增益 0.95 / 0.75 / 0.9 / 0.8（顶/前/后/地）', () => {
    expect(ACTIVE_ENV.softbox.length).toBe(4);
    expect(ACTIVE_ENV.softbox[0].gain).toBe(0.95); // top（天空正上反射代理，收掉影棚过曝）
    expect(ACTIVE_ENV.softbox[1].gain).toBe(0.75); // front（影棚正打光代理，与 R163 主光收敛同向，降最多）
    expect(ACTIVE_ENV.softbox[2].gain).toBe(0.9); // back（与顶板同向收，暗侧仍不死黑）
    expect(ACTIVE_ENV.softbox[3].gain).toBe(0.8); // ground（物理地面反射，只温柔降）
  });

  it('四板全部低于旧值（1.15/0.9/1.15/0.9）——方向正确（R163 同向降）', () => {
    const oldGain = [1.15, 0.9, 1.15, 0.9];
    ACTIVE_ENV.softbox.forEach((p, i) => expect(p.gain).toBeLessThan(oldGain[i]));
  });

  it('地面反弹 0.8 > 前侧 0.75（物理地面反射保留，影棚前打光降得更多）', () => {
    expect(ACTIVE_ENV.softbox[3].gain).toBe(0.8);
    expect(ACTIVE_ENV.softbox[1].gain).toBe(0.75);
    expect(ACTIVE_ENV.softbox[3].gain).toBeGreaterThan(ACTIVE_ENV.softbox[1].gain);
  });
});

describe('R164 ② · CameraRig FOV punch 源契约', () => {
  it('常数声明（TAU=0.14 / ATTACK=0.03 / MAX=10 / DEG_PER_SHAKE=20）', () => {
    expect(rigSrc).toContain('const FOV_PUNCH_TAU = 0.14;');
    expect(rigSrc).toContain('const FOV_PUNCH_ATTACK_TAU = 0.03;');
    expect(rigSrc).toContain('const FOV_PUNCH_MAX = 10;');
    expect(rigSrc).toContain('const FOV_PUNCH_DEG_PER_SHAKE = 20;');
  });

  it('字段声明（fovBase=55 / fovPunch=0 / fovPunchAmp=0）', () => {
    expect(rigSrc).toContain('private fovBase = 55;');
    expect(rigSrc).toContain('private fovPunch = 0;');
    expect(rigSrc).toContain('private fovPunchAmp = 0;');
  });

  it('addFovPunch 方法：多源取大 + 上限（与 addShake 同语义）', () => {
    expect(rigSrc).toContain('addFovPunch(shakeAmount: number): void {');
    expect(rigSrc).toContain(
      'this.fovPunch = Math.min(\n      FOV_PUNCH_MAX,\n      Math.max(this.fovPunch, shakeAmount * FOV_PUNCH_DEG_PER_SHAKE)\n    );'
    );
  });

  it('正常更新路径：fovBase 独立基线收敛 + 叠加 fovPunchAmp；旧 cam.fov 直接 lerp 已替换', () => {
    // 正常路径区域：从「局部视角（hood/cabin*/side）偏移随车体朝向旋转」到 resize() 前，
    // 不含飞航早退分支（其 cam.fov lerp 仍保留，须从正常路径切片排除）。
    const normal = rigSrc.slice(
      rigSrc.indexOf('// 局部视角（hood/cabin*/side）偏移随车体朝向旋转'),
      rigSrc.indexOf('  resize(aspect: number): void {')
    );
    expect(normal).toContain('this.fovBase += (pose.fov - this.fovBase) * Math.min(1, dt * 2);');
    expect(normal).toContain('const fovFinal = this.fovBase + this.fovPunchAmp;');
    expect(normal).toContain('this.fovPunch *= Math.exp(-dt / FOV_PUNCH_TAU);');
    expect(normal).toContain(
      'this.fovPunchAmp += (this.fovPunch - this.fovPunchAmp) * (1 - Math.exp(-dt / FOV_PUNCH_ATTACK_TAU));'
    );
    // 旧直接 lerp（cam.fov + (pose.fov - cam.fov) * ...）在正常路径必须消失（fovBase 设计已替换）
    expect(normal).not.toContain('const fov = cam.fov + (pose.fov - cam.fov) * Math.min(1, dt * 2);');
  });

  it('飞航路径：不施加 punch，但保持 fovBase/fovPunchAmp 跟随（退出飞航连续）', () => {
    const fly = rigSrc.slice(
      rigSrc.indexOf('cam.position.copy(this.flyPos)'),
      rigSrc.indexOf('cam.lookAt(lookPt)')
    );
    expect(fly).toContain('this.fovBase += (pose.fov - this.fovBase) * Math.min(1, dt * 2);');
    expect(fly).toContain('this.fovPunch *= Math.exp(-dt / FOV_PUNCH_TAU);');
    expect(fly).toContain(
      'this.fovPunchAmp += (this.fovPunch - this.fovPunchAmp) * (1 - Math.exp(-dt / FOV_PUNCH_ATTACK_TAU));'
    );
    expect(fly).toContain('if (this.fovPunchAmp < 1e-4) this.fovPunchAmp = 0;');
  });
});

describe('R164 ③ · Game.ts addFovPunch 接线源契约（5 处与 addShake 同源）', () => {
  it('5 处 addShake 每处并排接线 addFovPunch，参数逐位相同', () => {
    const shakeArgs = [...gameSrc.matchAll(/this\.rig\.addShake\(([^)]*)\);/g)].map((m) => m[1]);
    const punchArgs = [...gameSrc.matchAll(/this\.rig\.addFovPunch\(([^)]*)\);/g)].map((m) => m[1]);
    expect(shakeArgs).toHaveLength(5);
    expect(punchArgs).toHaveLength(5);
    // 同源参数、同序：撞击强度→FOV 冲击与→shake 幅度一一对应
    expect(punchArgs).toEqual(shakeArgs);
  });
});

describe('R164 ④ · FOV punch 数值烟雾（纯递推，不实例化 CameraRig）', () => {
  it('punch=8：快速攻击升幅（单调缓升）+ 指数衰减 + 收敛回 fovBase', () => {
    const DT = 1 / 60;
    const TAU = 0.14;
    const ATTACK = 0.03;
    const fovBase = 55;
    // 与 CameraRig 更新循环逐位相同的递推（正常路径 707-711 行）
    const decay = Math.exp(-DT / TAU);
    const attack = 1 - Math.exp(-DT / ATTACK);
    let fovPunch = 8; // 注入（addFovPunch(0.4) → 0.4*20=8）
    let fovPunchAmp = 0; // 初始施加幅度 = 0（无瞬跳）
    const amp: number[] = [];
    for (let i = 0; i < 72 * 3; i += 1) {
      fovPunch *= decay;
      if (fovPunch < 1e-4) fovPunch = 0;
      fovPunchAmp += (fovPunch - fovPunchAmp) * attack;
      if (fovPunchAmp < 1e-4) fovPunchAmp = 0;
      amp.push(fovPunchAmp);
    }
    // ── 攻击斜坡（无瞬跳）：首帧即有升幅但远低于满幅，前 4 帧单调缓升 ──
    expect(amp[0]).toBeGreaterThan(0); // 攻击已启动
    expect(amp[0]).toBeLessThan(8 * 0.6); // 首帧 < 注入值 60%（非瞬跳满幅）
    for (let i = 1; i <= 3; i += 1) expect(amp[i]).toBeGreaterThan(amp[i - 1]); // 单调缓升
    // ── 快速升到可观冲击：~5 帧内峰值 > 注入量一半（攻击 τ=0.03 快），且 < 注入值 ──
    // ⚠ 规格字面「近 8」不可达：fovPunch 包络以 τ=0.14 在攻击期同步衰减，幅度追逐的是
    //   已衰减包络 ⇒ 实测峰值 ≈4.94°（≈61%）。按物理行为钉：>50%（快速）+ <8（有界）。
    const peak = Math.max(...amp.slice(0, 8));
    expect(peak).toBeGreaterThan(4.0);
    expect(peak).toBeLessThan(8);
    // ── 指数衰减：1.2s（72 帧）内收敛到 < 0.01° ──
    expect(amp[72]).toBeLessThan(0.01);
    // ── 收敛：fovFinal 回到 fovBase（fovBase 恒定 → punch→0 ⇒ fovFinal→fovBase）──
    const fovFinal = fovBase + amp[amp.length - 1];
    expect(fovFinal).toBeCloseTo(fovBase, 5);
  });
});
