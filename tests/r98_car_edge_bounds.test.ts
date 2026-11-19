/**
 * R98 · 车缘不越可见面线护栏（用户诉求「建筑实际边界碰撞 / 避免穿模 / 去掉空气墙」）。
 *
 * R97 只把 arcadeHalfW 收到 10.0 当**车心**限（块区已按车缘净空标定），但御桥 / 城门 /
 * 空档 / 广场仍把 corridorHalfWidth 返回的**可见面线**直接当车心限 ⇒ 车缘越面线穿模：
 *   御桥 车缘 12.0+1.003=13.003 > 桥面 12.6
 *   城门 车缘 10.0+1.003=11.003 > 门墩内缘 10.0
 *   空档/广场 车缘 15.5+1.003=16.503 > 建筑前脸线 15.5
 *
 * R98 新增 corridorCenterHalfWidth(z)：块区保持 R97 车心限、其它段扣车半宽 (=1.003)。
 * R99 订正：块角 3m 过渡外端点由抽象面线 15.5 改为可见角塔基座内缘 14.9
 *（车心限 13.897），块心 10.0 及其它段不变。resolveBounds 第③步沿用该函数。
 *
 * 本文件钉：
 *   ① 桥 z=0 / 门洞 z=−358.5 / 空档 z=−600 / 广场 z=−1290 的车缘 ≤ 对应可见面线；
 *   ② 块心 z=−388.5 的车心限 = 殿身连续墙包络 13.997（R103 阶段二，车缘 15.0 贴大理石带）；
 *      块角 3m 过渡（R99）从基座 13.897 衔接到 dc≥3 的连续墙包络（殿身/前脸）；
 *   ③ resolveBounds 撞侧墙后 x 等于新车心限；
 *   ④ corridorHalfWidth / BOUNDS 逐位不变（CameraRig 与 r97 测试依赖）。
 *
 * 净空判据一律取真源 VEHICLE.widthM / r28Layout 常量，禁止写死车尺寸 / 面线。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  corridorCenterHalfWidth,
  corridorHalfWidth,
  resolveBounds
} from '../src/core/FreeDrive';
import { VEHICLE } from '../src/config/physics';
import { INNER, VIADUCT } from '../src/render/scene/r28Layout';

/** 车半宽真源（physics.ts，勿写死） */
const CAR_HALF_W = VEHICLE.widthM / 2; // 1.003

/** 殿前大理石带单侧宽（castleKit.ts:3156 box(0.5)）⇒ 内缘 15.0（R103 阶段二殿身连续墙） */
const MARBLE_BAND = 0.5;
const HALL_MARBLE_INNER = INNER.faceHalf - MARBLE_BAND; // 15.0
const HALL_ENVELOPE = HALL_MARBLE_INNER - CAR_HALF_W; // 13.997 殿身车心限
/** 建筑前脸 / 空档开放车心限 = cityOpenHalfW − 车半宽 = 14.497（R103 阶段二前脸连续墙包络） */
const OPEN_CAR_CENTER = BOUNDS.cityOpenHalfW - CAR_HALF_W;

/** 各段可见面线真源：桥面 / 门墩内缘 / 街侧建筑前脸线（勿写死） */
const FACE_LINE = {
  bridge: VIADUCT.totalHalf, // 12.6（含外侧墙的桥面总半宽）
  gate: BOUNDS.tunnelHalfW, // 10.0（门墩 x≥10 的内缘）
  open: INNER.faceHalf, // 15.5（街侧建筑前脸线）
  plaza: INNER.faceHalf // 15.5（广场两侧同样贴建筑前脸线）
} as const;

/** 车缘 = 车心限 + 车半宽 */
function carEdge(z: number): number {
  return corridorCenterHalfWidth(z) + CAR_HALF_W;
}

describe('R98 ① 车缘不越可见面线（桥 / 门 / 空档 / 广场）', () => {
  const cases: ReadonlyArray<{ name: string; z: number; face: number }> = [
    { name: '御桥', z: 0, face: FACE_LINE.bridge },
    { name: '城门洞', z: -358.5, face: FACE_LINE.gate },
    { name: '城内空档', z: -600, face: FACE_LINE.open },
    { name: '主殿广场', z: -1290, face: FACE_LINE.plaza }
  ];

  for (const { name, z, face } of cases) {
    it(`${name} z=${z}：车缘 ≤ 可见面线 ${face}`, () => {
      const edge = carEdge(z);
      expect(edge).toBeLessThanOrEqual(face + 1e-9);
    });
  }

  it('车心限 = 可见面线车心限 − 车半宽（逐位钉死收窄幅度）', () => {
    // 御桥 corridorHalfWidth=12.0 / 门洞=10.0 / 空档=15.5 / 广场=15.5
    expect(corridorCenterHalfWidth(0)).toBeCloseTo(12.0 - CAR_HALF_W, 12); // 10.997
    expect(corridorCenterHalfWidth(-358.5)).toBeCloseTo(10.0 - CAR_HALF_W, 12); // 8.997
    expect(corridorCenterHalfWidth(-600)).toBeCloseTo(15.5 - CAR_HALF_W, 12); // 14.497
    expect(corridorCenterHalfWidth(-1290)).toBeCloseTo(15.5 - CAR_HALF_W, 12); // 14.497
  });
});

describe('R98 ② 块区车心限（R103 阶段二：块心=连续墙包络 / 块角 R99 分离）', () => {
  it('块心 z=−388.5 车心限 = 殿身连续墙包络 13.997（车缘 15.0 贴大理石带）', () => {
    expect(CAR_HALF_W).toBeCloseTo(1.003, 12);
    // corridorHalfWidth 面线仍是抽象块心 10.0（CameraRig 依赖，逐位不变）
    expect(corridorHalfWidth(-388.5)).toBe(10.0);
    // 车心限改为殿身连续墙包络：殿前大理石带 15.0 − 车半宽（zr=0 ≤ 6.85 → 殿身）
    expect(corridorCenterHalfWidth(-388.5)).toBeCloseTo(HALL_ENVELOPE, 12);
    expect(carEdge(-388.5)).toBeCloseTo(HALL_MARBLE_INNER, 12); // 15.0 贴大理石带
  });

  it('块边界 3m 过渡（R99/R103）：角点车缘贴基座 14.9、dc≥3 回连续墙包络、corridorHalfWidth 不变', () => {
    // k=0 块 [-411.5, -365.5]：过渡区 −411.5..−408.5 / −368.5..−365.5。
    // 上边界 −365.5 与 gateBackZ 重合，按分段顺序归「城门带」，单独在下一例钉死。
    // R99：过渡外端点由抽象面线 15.5 改为可见角塔大理石基座内缘 14.9
    //   （castleKit.ts:3381 基座裙外扩 1.2 ⇒ INNER.faceHalf − 1.2/2），车心限 13.897。
    const CORNER_INNER = INNER.faceHalf - 1.2 / 2; // 14.9（真源推导，勿写死）
    const CORNER_CENTER = CORNER_INNER - CAR_HALF_W; // 13.897

    // dc=0 角点：车心限 13.897、车缘恰贴 14.9（R98 旧逻辑 15.5/16.503 嵌基座 1.6m）
    expect(corridorCenterHalfWidth(-411.5)).toBeCloseTo(CORNER_CENTER, 12);
    expect(carEdge(-411.5)).toBeCloseTo(CORNER_INNER, 12);
    expect(carEdge(-411.5)).toBeLessThanOrEqual(CORNER_INNER + 1e-9);

    // dc<3 角过渡中点（dc=1.5）：从基座 13.897 线性放宽到 dc=3 处的前脸包络 14.497
    //   下角 zr=23 → 前脸包络；(13.897+14.497)/2 = 14.197
    expect(corridorCenterHalfWidth(-410)).toBeCloseTo((CORNER_CENTER + OPEN_CAR_CENTER) / 2, 12);

    // dc≥3：回到块心连续墙包络（−408.5/−368.5 zr=20 > 6.85 → 前脸 14.497，非旧 10.0）
    expect(corridorCenterHalfWidth(-408.5)).toBeCloseTo(OPEN_CAR_CENTER, 12);
    expect(corridorCenterHalfWidth(-368.5)).toBeCloseTo(OPEN_CAR_CENTER, 12);
    expect(carEdge(-408.5)).toBeCloseTo(INNER.faceHalf, 12); // 15.5 贴前脸

    // 整段车缘始终不越可见建筑前脸线 15.5（角点贴基座 14.9、过渡/块心 ≤ 前脸 15.5）
    for (const z of [-411.5, -410, -409.5, -408.5, -368.5, -366.5]) {
      expect(carEdge(z)).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
    }

    // corridorHalfWidth 逐位不变：角点仍是抽象面线 15.5（CameraRig 依赖）
    expect(corridorHalfWidth(-411.5)).toBe(15.5);
    expect(corridorHalfWidth(-408.5)).toBe(10.0);
  });

  it('块上边界与 gateBackZ 重合点归城门带（车心限扣车半宽，门墩不穿模）', () => {
    // z = −365.5 = gateBackZ = k=0 块上边界。corridorHalfWidth 在此之前先命中城门带
    // (10.0)，corridorCenterHalfWidth 严格镜像该分段 ⇒ 扣车半宽，车缘 9.0 < 门墩内缘 10.0。
    expect(corridorHalfWidth(BOUNDS.gateBackZ)).toBe(10.0);
    expect(corridorCenterHalfWidth(BOUNDS.gateBackZ)).toBeCloseTo(10.0 - CAR_HALF_W, 12);
  });
});

describe('R98 ③ resolveBounds 撞侧墙后 x = 新车心限', () => {
  /** 朝 +X 墙开（heading=−π/2 ⇒ forward.x=+1 ⇒ fn>0 ⇒ kind='side'） */
  const headingToPlusX = -Math.PI / 2;

  const cases: ReadonlyArray<{ name: string; z: number }> = [
    { name: '御桥', z: 0 },
    { name: '城门洞', z: -358.5 },
    { name: '城内空档', z: -600 },
    { name: '主殿广场', z: -1290 }
  ];

  for (const { name, z } of cases) {
    it(`${name} z=${z}：+x 撞墙后 x = 车心限`, () => {
      const limit = corridorCenterHalfWidth(z);
      const r = resolveBounds(limit + 5, z, headingToPlusX, 10);
      expect(r.x).toBeCloseTo(limit, 12);
      expect(r.kind).toBe('side');
      // 车缘仍不越面线
      expect(r.x + CAR_HALF_W).toBeLessThanOrEqual(carEdge(z) + 1e-9);
    });

    it(`${name} z=${z}：−x 撞墙后 x = −车心限`, () => {
      const limit = corridorCenterHalfWidth(z);
      // 朝 −X 墙开（heading=+π/2 ⇒ forward.x=−1）
      const r = resolveBounds(-(limit + 5), z, Math.PI / 2, 10);
      expect(r.x).toBeCloseTo(-limit, 12);
      expect(r.kind).toBe('side');
    });
  }

  it('块心撞侧墙后 x = 殿身连续墙包络 13.997（块区不再钉 10.0）', () => {
    const r = resolveBounds(20, -388.5, headingToPlusX, 10);
    expect(r.x).toBeCloseTo(HALL_ENVELOPE, 12);
    expect(r.kind).toBe('side');
  });
});

describe('R98 ④ 既有口径逐位不变（CameraRig / r97 测试依赖）', () => {
  it('corridorHalfWidth 分段值不变：12 / 10 / 10 / 15.5 / 15.5', () => {
    expect(corridorHalfWidth(0)).toBe(12.0);
    expect(corridorHalfWidth(-358.5)).toBe(10.0);
    expect(corridorHalfWidth(-388.5)).toBe(10.0);
    expect(corridorHalfWidth(-600)).toBe(15.5);
    expect(corridorHalfWidth(-1290)).toBe(15.5);
  });

  it('BOUNDS 关键常量不变', () => {
    expect(BOUNDS.bridgeHalfW).toBe(12.0);
    expect(BOUNDS.tunnelHalfW).toBe(10.0);
    expect(BOUNDS.arcadeHalfW).toBe(10.0);
    expect(BOUNDS.cityOpenHalfW).toBe(15.5);
    expect(BOUNDS.plazaHalfW).toBe(15.5);
    expect(BOUNDS.zMin).toBe(-1297);
    expect(BOUNDS.zMax).toBe(70);
    expect(BOUNDS.hallZ).toBe(-1297.5);
  });
});
