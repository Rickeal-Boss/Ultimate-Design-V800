/**
 * R163 · 撞击点精度（粒子发射点改用 wallContact 实际接触点）+ 全局环境光线物理重平衡。
 *
 * 背景：用户「继续改进撞击体验及全局环境光线以符合实际物理」。
 *   ① 撞击点精度：R159/R160 粒子用**车头固定点** `localToWorld(0,0.6,-2.7)`，侧擦/偏角撞
 *      时粒子落在车鼻而非真实接触处；R161 已暴露 `FreeDrive.wallContact{wallX,wallZ,nx,nz}`
 *      （step() 末尾 L1941-1976 快照、onEvent 派发 L1994 在其后 ⇒ 事件触发时即当前步），
 *      故改用实际接触点。nose-dive（撞墙车头下沉）已由 R126 撞墙注入 `impactPitchOscVel`
 *      实现（非本轮的缺失项，源契约钉住存在性）。
 *   ② 环境光线物理重平衡：暴风天光（云量 0.85）本应漫射，但旧值强锐主光 2.6 + 低环境
 *      0.34 + 人工 rim 1.05/fill 0.7 物理不自洽（风暴幕布+影棚打光）。重平衡为
 *      sun 2.6→1.5 / hemi 0.34→0.55 / rim 1.05→0.6 / fill 0.7→0.5 ⇒ 直射/环境比 7.6:1→2.7:1。
 *
 * 形态：environment.ts 无 window/DOM（纯常量，node 可直导）；FreeDrive 无 window/DOM
 * （r142/r161 已 node 实例化）⇒ 做真实运行时；Game.ts 顶层 await+window 无法 node 实例化
 * （r159/r161 同模式）⇒ 接线加源契约。
 *
 * 判据：
 *   ① environment.ts ACTIVE_ENV：sun.intensity=1.5 / hemi.intensity=0.55 /
 *      fill.intensity=0.5 / rim.intensity=0.6（物理重平衡值）+ 直射/环境比 2.7:1；
 *   ② Game.ts 源契约：`freeDrive?.wallContact` + `wc.wallX + wc.nx * 0.05`（撞击点精度）
 *      + nose-dive 注释（R126 已实现，不重复）；
 *   ③ FreeDrive.ts 源契约：撞墙 nose-dive 注入 `impactPitchOscVel += -FREE_BODY_IMPACT_OSC.pitchGain`
 *      （R126 存在性）+ `get wallContact`（R161 复用）；
 *   ④ FreeDrive 运行时（镜像 r161 御桥段贴 +X 墙）：wallContact 接触点 (wallX+nx*0.05)
 *      落墙面 x≈11.83（11.88-0.05），与车头固定点不同（撞击点精度生效）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVE_ENV } from '../src/config/environment';
import { FreeDrive, corridorCenterHalfWidth } from '../src/core/FreeDrive';

const DT = 1 / 120;
const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');
const freeDriveSrc = readFileSync(new URL('../src/core/FreeDrive.ts', import.meta.url), 'utf8');

describe('R163 ① 全局环境光线物理重平衡（暴风天光应漫射）', () => {
  // R167 已推进 fill/rim 收敛 + hemi 托底（fill 0.5→0.42 / rim 0.6→0.5 / hemi 0.55→0.6），
  // 此 R163 值钉随 R167 同步（sun 1.5 未动，直射/环境比 1.5/0.6≈2.5 仍 <3 阴天方向）。
  it('sun 2.6→1.5 / hemi 0.34→0.55→0.6 / fill 0.7→0.5→0.42 / rim 1.05→0.6→0.5', () => {
    expect(ACTIVE_ENV.sun.intensity).toBe(1.5);
    expect(ACTIVE_ENV.hemi.intensity).toBe(0.6);
    expect(ACTIVE_ENV.fill.intensity).toBe(0.42);
    expect(ACTIVE_ENV.rim.intensity).toBe(0.5);
  });

  it('直射/环境比从旧 7.6:1 降到 2.5:1（R167 收敛后，物理阴天漫射，非风暴+影棚）', () => {
    const ratio = ACTIVE_ENV.sun.intensity / ACTIVE_ENV.hemi.intensity;
    expect(ratio).toBeCloseTo(1.5 / 0.6, 5); // ≈2.5
    expect(ratio).toBeLessThan(3); // 物理方向：接近阴天
  });

  it('逆光构图/色温/云量保留（物理重平衡不改变场景风格）', () => {
    expect(ACTIVE_ENV.sun.elevationDeg).toBe(12); // 低角度逆光保留
    expect(ACTIVE_ENV.sun.azimuthDeg).toBe(195);
    expect(ACTIVE_ENV.sky.cloudAmount).toBe(0.85); // 暴风云量保留
  });
});

describe('R163 ② Game.ts 撞击点精度源契约', () => {
  it('onFreeEvent 用 FreeDrive.wallContact 实际接触点（wallX+nx*0.05）替代车头固定点', () => {
    expect(gameSrc).toContain('freeDrive?.wallContact');
    expect(gameSrc).toContain('wc.wallX + wc.nx * 0.05');
    expect(gameSrc).toContain('wc.wallZ + wc.nz * 0.05');
    // 仍保留车头固定点作未接触回退（R159/R160 原口径不删）
    expect(gameSrc).toContain('localToWorld(new THREE.Vector3(0, 0.6, -2.7))');
  });

  it('nose-dive 已有 R126（撞墙注入 impactPitchOscVel），不重复实现（注释注明）', () => {
    expect(gameSrc).toContain('nose-dive');
    expect(gameSrc).toContain('R126');
  });
});

describe('R163 ③ FreeDrive nose-dive 存在性源契约（R126，非本轮新增）', () => {
  it('撞墙帧注入 pitch 角速度（负=车头朝墙面点头）', () => {
    expect(freeDriveSrc).toContain('impactPitchOscVel += -FREE_BODY_IMPACT_OSC.pitchGain');
  });

  it('wallContact getter 存在（R161 复用，撞击点精度取数源）', () => {
    expect(freeDriveSrc).toContain('get wallContact');
    expect(freeDriveSrc).toContain('export interface FreeDriveWallContact');
  });
});

describe('R163 ④ FreeDrive 运行时接触点（撞击点精度生效）', () => {
  it('御桥段贴 +X 墙：接触点 (wallX+nx*0.05) 落墙面 x≈11.83，非车头固定点', () => {
    const IMPACT_Z = -250;
    const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
    const START_X = LIMIT - 0.5;
    const heading = Math.PI + Math.asin(0.3); // 斜擦 +X 墙且沿 +Z 滑（r142 判据② 同口径）
    const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
    fd.state.speed = 55.56;
    for (let i = 0; i < 400; i += 1) fd.step(DT);
    const wc = fd.wallContact;
    expect(wc.touching).toBe(true);
    expect(wc.kind).toBe('side');
    expect(wc.nx).toBe(-1); // +X 侧车，法线指向可行驶侧 = -X
    // R163 撞击点：沿可行驶侧偏移 0.05 防 z-fight ⇒ x = 11.88 + (-1)*0.05 = 11.83
    const hitX = wc.wallX + wc.nx * 0.05;
    expect(hitX).toBeCloseTo(11.88 - 0.05, 5);
    // 接触点 ≠ 车头固定点（撞击点精度确实改了点）
    const noseApproxX = fd.state.x; // 车心 x（车头在其前方，x 相同侧别）—— 接触点应贴墙
    expect(Math.abs(hitX - 11.83)).toBeLessThan(0.01);
    expect(Math.abs(noseApproxX - hitX)).toBeGreaterThan(0.5); // 车心远在墙面内侧 >0.5m
  });
});
