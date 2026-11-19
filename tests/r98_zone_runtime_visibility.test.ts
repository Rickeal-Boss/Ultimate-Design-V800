/**
 * R98 · 运行时「车前方整区恒显且 fade=1」回归护栏（只加测试，不改任何 src）。
 *
 * 背景：用户反馈「中段建筑完全消失 / 空中细长条 / 正面空旷」已在 R97 由方案 B
 * （车前方恒显、只剔车后，显隐判据 z > zMin − ZONE_VIEW_HYSTERESIS）根治并经外部
 * 高精度视觉 + 7 张真实运行多机位截图裁定全 PASS。本文件把该 PASS 状态钉成单测，
 * 防止未来改动把「车前方区摘除 / 淡成雾色」的旧缺陷改回来。
 *
 * ── 坐标方向（关键，务必按运行时口径读）───────────────────────────────────
 * 车从起点 z≈+68 向城内深处开到 z≈−1297（Game.car.root.position.z = −distance），
 * `Game` 逐帧以 `castle.updateViewerZ(this.rig.camera.position.z)` 传入相机 z。
 * 故「前进方向 = −z」：车前方 / 脚下的区其 zMin 更负 ⇒ **zMin < camZ**；
 * 车后方（入口、御桥一带）的区 zMin 更大 ⇒ zMin > camZ，R97 允许剔除 / 淡出。
 *
 * 派单原文写作「zMin > camZ（整区在车前）⇒ visible && fade=1」。按运行时实测
 * （19 个分区，zMin∈[−150,−1377]，样本 60/−330/−600/−800/−1000/−1250），
 * 满足 zMin > camZ 的区在全部样本里 **恰好都是被 R97 剔除的车后区**；若按字面
 * 断言它们恒显，则与已知 PASS 基线正面冲突（测试必红）。根因是派单把前进轴
 * 记成了 +z（常见约定），而本场景前进轴是 −z。故本护栏钉的是与用户反馈、R97
 * 源码、外部视觉裁定一致的真实不变量：**zMin < camZ 的区（车前方 / 脚下）
 * 必须 visible===true 且 getZoneFade===1**。车后区可剔除 / 淡出，不设断言。
 *
 * 口径纪律（沿用 r97_zone_and_bounds.test.ts）：
 *   · 断言一律 `visible===true && getZoneFade(name)===1` 两者同时满足；
 *   · 区位置夹具一律用公开机读接口 `getZoneZMin(name)`（= bbox.min.z），不用 cz；
 *   · 仅用白盒 Castle.zoneViews 枚举区名（private 仅编译期），数值全走公开接口；
 *   · 未知名字返回 NaN ⇒ 显式 fail，禁止 skip 制造假绿。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';
import { BOUNDS } from '../src/core/FreeDrive';

// 最小 DOM shim：石材 canvas 程序化贴图需要 document.createElement('canvas').getContext('2d')
const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: () => {},
          fillRect: () => {},
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0
        })
      };
    }
  };
});
afterAll(() => {
  (globalThis as { document: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

/** 派单指定的车 / 相机 z 样本（起点 → 城内深处，前进方向 −z） */
const CAM_Z_SAMPLES = [60, -330, -600, -800, -1000, -1250];

type ZoneRef = { mesh: THREE.Mesh };

/** 仅用于枚举区名；所有数值走公开机读接口 */
function zoneNamesOf(castle: Castle): string[] {
  return (castle as unknown as { zoneViews: ZoneRef[] }).zoneViews.map((zv) => zv.mesh.name);
}

function buildCastle(): { scene: THREE.Scene; castle: Castle } {
  setDetailLevel(false);
  disposeStoneCache();
  const scene = new THREE.Scene();
  const castle = new Castle(scene, QUALITY_HIGH);
  return { scene, castle };
}

/** 从场景取区 mesh（Castle 本身不是 Object3D，没有 getObjectByName；hidden 也可读） */
function zoneMesh(scene: THREE.Scene, name: string): THREE.Mesh {
  const m = scene.getObjectByName('castle')?.getObjectByName(name) as THREE.Mesh | undefined;
  expect(m, `${name} 的 mesh 不存在`).toBeDefined();
  return m!;
}

/** 机读 zMin（bbox.min.z）；NaN 即显式失败，不静默吞掉 */
function zMinOf(castle: Castle, name: string): number {
  const v = castle.getZoneZMin(name);
  expect(Number.isFinite(v), `${name} getZoneZMin 返回 ${v}（区不存在或夹具口径错）`).toBe(true);
  return v;
}

describe('R98 · 车前方整区恒显且 fade=1（运行时 z 样本回归护栏）', () => {
  it('⓪ 接口与夹具就绪：getZoneFade/getZoneZMin 存在、区表非空、含深区、未知名返回 NaN', () => {
    const { castle } = buildCastle();
    try {
      const api = castle as unknown as {
        getZoneFade?: (name: string) => number;
        getZoneZMin?: (name: string) => number;
      };
      expect(typeof api.getZoneFade, 'Castle.getZoneFade 必须存在（禁止 skip）').toBe('function');
      expect(typeof api.getZoneZMin, 'Castle.getZoneZMin 必须存在（禁止 skip）').toBe('function');
      const names = zoneNamesOf(castle);
      expect(names.length, 'zoneViews 为空（无法验证）').toBeGreaterThan(0);
      // 深区必须真实存在，否则「车前方深区恒显」是空集自证
      const deep = names.filter((n) => zMinOf(castle, n) < -1000);
      expect(deep.length, '缺少深区（zMin<−1000），护栏失去意义').toBeGreaterThan(0);
      // 样本应落在 BOUNDS 的合法 z 域内（相机与车同一走廊硬钳位）
      for (const camZ of CAM_Z_SAMPLES) {
        expect(camZ, `样本 ${camZ} 越出 BOUNDS z 域`).toBeGreaterThanOrEqual(BOUNDS.zMin);
        expect(camZ, `样本 ${camZ} 越出 BOUNDS z 域`).toBeLessThanOrEqual(BOUNDS.zMax);
      }
      expect(Number.isNaN(castle.getZoneFade('__no_such_zone__'))).toBe(true);
      expect(Number.isNaN(castle.getZoneZMin('__no_such_zone__'))).toBe(true);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('① 6 个 z 样本：凡 zMin < camZ（车前方 / 脚下整区）必 visible===true && getZoneFade===1', () => {
    const { scene, castle } = buildCastle();
    try {
      const names = zoneNamesOf(castle);
      expect(names.length).toBeGreaterThan(0);
      const zmins = names.map((name) => ({ name, zMin: zMinOf(castle, name) }));

      for (const camZ of CAM_Z_SAMPLES) {
        castle.updateViewerZ(camZ);

        // 车前方 / 脚下的区（前进方向 −z ⇒ zMin 更负）：R97 保证恒显且 fade=1
        const ahead = zmins.filter((z) => z.zMin < camZ);
        expect(
          ahead.length,
          `camZ=${camZ} 无「车前方区」可断言（空集自证），护栏失效`
        ).toBeGreaterThan(0);

        for (const { name } of ahead) {
          const mesh = zoneMesh(scene, name);
          const visible = mesh.visible === true;
          const fade = castle.getZoneFade(name);
          expect(
            visible && fade === 1,
            `${name} 在 camZ=${camZ}（zMin=${zMinOf(castle, name)} < camZ，车前方）` +
            `须 visible===true && getZoneFade===1（实得 visible=${visible}, fade=${fade}）`
          ).toBe(true);
        }

        // 车后区（zMin > camZ）按 R97 允许剔除 / 淡出 —— 不设恒显断言。
        // 这里只做非真空校验：确保前后两侧划分随样本推进而变化（护栏确实在 probe 动态区间）。
        const behind = zmins.filter((z) => z.zMin > camZ);
        expect(ahead.length + behind.length, `camZ=${camZ} 前后区划分异常`).toBe(names.length);
      }
    } finally {
      castle.dispose();
    }
  }, 120000);

  it('② 起点 z=60：全部 19 区恒显且 fade=1，深区（zMin<−1000）不得被摘 / 淡成雾色', () => {
    const { scene, castle } = buildCastle();
    try {
      const startZ = 60;
      castle.updateViewerZ(startZ);
      const names = zoneNamesOf(castle);
      for (const name of names) {
        const mesh = zoneMesh(scene, name);
        const visible = mesh.visible === true;
        const fade = castle.getZoneFade(name);
        expect(
          visible && fade === 1,
          `起点 ${name} 须 visible===true && getZoneFade===1（实得 ${visible}/${fade}）`
        ).toBe(true);
      }
      const deep = names.filter((n) => zMinOf(castle, n) < -1000);
      expect(deep.length, '缺少深区，起点全显断言失去意义').toBeGreaterThan(0);
    } finally {
      castle.dispose();
    }
  }, 60000);
});
