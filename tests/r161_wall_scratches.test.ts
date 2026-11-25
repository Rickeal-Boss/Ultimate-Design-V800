/**
 * R161 擦墙划痕：墙面 InstancedMesh 池 + FreeDrive 只读接触快照 + Game 逐帧铺痕接线。
 *
 * 形态：fx/index.ts 无 window/DOM 链（r159 已直接 node 实例化 FxSystems），FreeDrive 无
 * window/DOM（r142 已直接 node 实例化），故做**真实运行时单测**；Game.ts 顶层 await +
 * window 依赖无法 node 实例化（r159/r44_frame 同模式），接线另加**源契约**。
 *
 * 判据：
 *   ① WallScratches.emit 抬升 count + 绕墙面法线定向（quad 默认法线 +Z → (nx,0,nz)，
 *      θ=atan2(nx,nz)，读 instanceMatrix 元素 0/2/8）；
 *   ② WallScratches.clear 复位 visible=false（R51-B 空池零 DC 状态机）；
 *   ③ FxSystems.emitWallScratch 透传（找 scene 内 0.62×0.3 直立墙痕 InstancedMesh）；
 *   ④ FreeDrive 源契约：FreeDriveWallContact 接口 + wallContact getter（只读，无 setter）
 *      + wallContactSnap 私有快照 + 五字段；
 *   ⑤ FreeDrive 运行时：御桥段贴 +X 墙刮擦（r142 判据② 同口径）后 wallContact
 *      touching=true、kind='side'、nx=-1（指向可行驶侧）、wallX≈WALL_SURF_BRIDGE=11.88、
 *      strength>0；
 *   ⑥ Game.ts 源契约：frameFree 逐帧读 fd.wallContact → fx.emitWallScratch，
 *      wallTravel 节流 + R161_SCRATCH_GATE_MS 门控 + 0.04 防 z-fight 偏移 + 0.55 腰高。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FxSystems, WallScratches } from '../src/fx';
import { FreeDrive, corridorCenterHalfWidth } from '../src/core/FreeDrive';

const DT = 1 / 120;
const freeDriveSrc = readFileSync(new URL('../src/core/FreeDrive.ts', import.meta.url), 'utf8');
const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');
const freeBodySrc = readFileSync(new URL('../src/config/freeBodyFeel.ts', import.meta.url), 'utf8');

describe('R161 WallScratches 运行时（镜像 SkidMarks 池/渐隐/定向）', () => {
  it('emit 抬升 count 且绕墙面法线定向（quad 法线 +Z → (nx,0,nz)）', () => {
    const ws = new WallScratches(8);
    const mesh = ws.object as THREE.InstancedMesh;
    // R51-B 空池零 DC（count=0 + visible=false）
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    // 御桥段 +X 侧：墙面法线指向可行驶侧 = -X
    ws.emit(new THREE.Vector3(11.84, 0.55, -250), new THREE.Vector3(-1, 0, 0));
    expect(mesh.count).toBe(1);
    expect(mesh.visible).toBe(true);
    const e = mesh.instanceMatrix.array as Float32Array;
    // θ=atan2(nx,nz)=atan2(-1,0)=-π/2：cosθ=0、sinθ=-1
    // 绕 Y 旋转列主序：elements[0]=cosθ、elements[2]=-sinθ、elements[8]=sinθ、elements[10]=cosθ
    expect(Math.abs(e[0] - 0)).toBeLessThan(1e-5); // cosθ
    expect(Math.abs(e[8] - -1)).toBeLessThan(1e-5); // sinθ = nx
    expect(Math.abs(e[2] - 1)).toBeLessThan(1e-5); // -sinθ
    ws.dispose();
  });

  it('emit 后 count 随池回绕保持 ≤ 池容量', () => {
    const ws = new WallScratches(3);
    const mesh = ws.object as THREE.InstancedMesh;
    for (let i = 0; i < 5; i++) ws.emit(new THREE.Vector3(i, 0.55, -250), new THREE.Vector3(-1, 0, 0));
    expect(mesh.count).toBe(3); // 回绕后恒为池容量
    ws.dispose();
  });

  it('clear 复位 visible=false（R51-B 空池零 DC 状态机）', () => {
    const ws = new WallScratches(8);
    ws.emit(new THREE.Vector3(11.84, 0.55, -250), new THREE.Vector3(-1, 0, 0));
    ws.update(0.016);
    const mesh = ws.object as THREE.InstancedMesh;
    expect(mesh.visible).toBe(true);
    ws.clear();
    ws.update(0.016);
    expect(mesh.visible).toBe(false);
    ws.dispose();
  });
});

describe('R161 FxSystems.emitWallScratch 透传', () => {
  it('emitWallScratch(point, normal) 激活墙面 InstancedMesh（0.62×0.3 直立）', () => {
    const scene = new THREE.Scene();
    const fx = new FxSystems(scene, 'high');
    // 定位墙痕 InstancedMesh：MultiplyBlending + PlaneGeometry 0.62×0.3（直立，非 skid 0.3×0.62 平躺）
    const wall = scene.children.find(
      (c) =>
        (c as THREE.InstancedMesh).isInstancedMesh &&
        ((c as THREE.InstancedMesh).geometry as THREE.PlaneGeometry).parameters?.width === 0.62 &&
        ((c as THREE.InstancedMesh).geometry as THREE.PlaneGeometry).parameters?.height === 0.3
    ) as THREE.InstancedMesh;
    expect(wall).toBeDefined();
    expect(wall.visible).toBe(false);
    expect(wall.count).toBe(0);
    fx.emitWallScratch(new THREE.Vector3(11.84, 0.55, -250), new THREE.Vector3(-1, 0, 0));
    expect(wall.count).toBe(1);
    expect(wall.visible).toBe(true);
    fx.clear();
    fx.update(0.016, {
      carRoot: new THREE.Object3D(),
      brakeIntensity: 0,
      speedMs: 0,
      braking: false
    });
    expect(wall.visible).toBe(false);
    fx.dispose();
  });
});

describe('R161 FreeDrive 源契约（只读接触快照）', () => {
  it('FreeDriveWallContact 接口 + wallContact getter（只读，无 setter）+ 私有快照字段', () => {
    expect(freeDriveSrc).toContain('export interface FreeDriveWallContact');
    for (const field of ['touching', 'kind', 'nx', 'nz', 'wallX', 'wallZ', 'strength']) {
      expect(freeDriveSrc).toContain(field);
    }
    expect(freeDriveSrc).toContain('get wallContact');
    expect(freeDriveSrc).toContain('wallContactSnap');
    expect(freeDriveSrc).not.toContain('set wallContact'); // 只读透传
  });
});

describe('R161 FreeDrive 运行时（御桥段贴 +X 墙刮擦）', () => {
  it('贴墙刮擦后 wallContact touching + kind=side + nx=-1 + wallX≈11.88（Step0 dump 面）', () => {
    const IMPACT_Z = -250; // 御桥段 z∈[-351.5,70]
    const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
    const START_X = LIMIT - 0.5;
    const heading = Math.PI + Math.asin(0.3); // 斜擦 +X 墙且沿 +Z 滑（r142 判据② 同口径）
    const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
    fd.state.speed = 55.56; // 200 km/h 冲进墙
    for (let i = 0; i < 400; i += 1) fd.step(DT); // 撞墙 + 刮到贴墙稳态
    const wc = fd.wallContact;
    expect(wc.touching).toBe(true);
    expect(wc.kind).toBe('side');
    expect(wc.nx).toBe(-1); // +X 侧车，法线指向可行驶侧 = -X
    expect(wc.nz).toBe(0);
    expect(Math.abs(wc.wallX - 11.88)).toBeLessThan(0.1); // Step0 dump 御桥栏板内表面
    expect(wc.wallZ).toBeCloseTo(fd.state.z, 0); // 接触墙点 z = 车心 z
    expect(wc.strength).toBeGreaterThan(0); // 贴墙维持刮擦强度
    expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 仍贴墙
  });

  it('未接触（中线自由驾驶）时 wallContact touching=false / kind=null', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -330, heading: 0 } });
    fd.state.speed = 20;
    fd.press('KeyW', true);
    for (let i = 0; i < 600; i += 1) fd.step(DT); // 5s 中线南行
    const wc = fd.wallContact;
    expect(wc.touching).toBe(false);
    expect(wc.kind).toBeNull();
    expect(wc.strength).toBe(0);
  });
});

describe('R161 Game.ts 接线源契约（frameFree 逐帧铺痕）', () => {
  it('frameFree 读 fd.wallContact → fx.emitWallScratch + wallTravel 节流 + 门控', () => {
    expect(gameSrc).toContain('fd.wallContact');
    expect(gameSrc).toContain('emitWallScratch');
    expect(gameSrc).toContain('wallTravel');
    expect(gameSrc).toContain('lastWallTouch');
    expect(gameSrc).toContain('0.04'); // 向可行驶侧偏移（防 z-fight）
    expect(gameSrc).toContain('0.55'); // 腰高（车侧划痕高度）
  });

  it('R161_SCRATCH_GATE_MS 门控常量（freeBodyFeel.ts，注明口径）', () => {
    expect(freeBodySrc).toContain('R161_SCRATCH_GATE_MS');
    expect(freeBodySrc).toContain('R161_SCRATCH_STEP_M');
  });
});
