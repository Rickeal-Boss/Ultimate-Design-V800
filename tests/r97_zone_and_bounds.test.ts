/**
 * R97 · 「中段建筑一段完全消失」根治回归测试（方案 B：车前方恒显，只剔车后）。
 * 文件名按主理人收口红线由 r97_city_visible.test.ts 改为 r97_zone_and_bounds.test.ts。
 *
 * 定罪回顾（probe-city + 主理人交叉确认）：
 *   `castle.ts` 旧 `updateViewerZ` / `updateFades` 按**区心距** `|cz−z| < ZONE_VIEW_RANGE(550)`
 *   整区摘除 + 距离淡入。俯视/远距机位相机 z 远离所有区心 ⇒ 成片深区被摘，只剩常驻
 *   Terrain 大平面（用户看到「细长路条 + 空米色」）。R96 加密街区（keep=10）无效，
 *   因为新块全落在被剔除的深区。
 *
 * R97 新语义（本文件钉死四个回归点 + ⓪机读接口存在性）：
 *   ⓪ `Castle.getZoneFade` / `getZoneZMin` 必须存在，缺失**显式 fail、禁止 skip**；
 *   ① 起点 z=+68 所有区 visible=true **且 getZoneFade(name)===1**（fade 不联动 = 假绿）；
 *   ② 车驶出某区后端（z ≤ zMin − ZONE_VIEW_HYSTERESIS）后该区 visible=false；
 *   ③ 倒车 z 回升后该区重新 visible=true 且 fade=1；
 *   ④ 车在自己所在区内（含最深处 zMin+ε）该区恒 visible 且 fade=1（防「cz 摘脚下区」回归）。
 *
 * 口径纪律（主理人收口红线）：
 *   · 断言一律写 `visible===true && getZoneFade(name)===1` **两者同时满足**；
 *   · 区位置夹具一律用 `getZoneZMin(name)`（= bbox.min.z），**不得各自用 cz**；
 *   · 远档 LOD 仍按 cz 的 20m 滞回换档，与显隐两回事，本文件不触碰。
 * 仅用白盒 `Castle.zoneViews` **枚举区名**（private 仅编译期），所有数值走公开机读接口，
 * 避免依赖渲染管线 —— 与 r32_budget / r32_zone 的黑盒口径互补。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';

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
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

/** 仅用于枚举区名（zoneViews 条目在运行时可读；数值一律走 getZoneFade/getZoneZMin） */
type ZoneRef = { mesh: THREE.Mesh };

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

/** 从场景取区 mesh（Castle 本身不是 Object3D，没有 getObjectByName） */
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

describe('R97 · 车前方恒显（方案 B）显隐 + fade 契约', () => {
  it('⓪ 机读接口存在性：getZoneFade / getZoneZMin 缺失必须显式 fail（禁止 skip）', () => {
    const { castle } = buildCastle();
    try {
      const api = castle as unknown as {
        getZoneFade?: (name: string) => number;
        getZoneZMin?: (name: string) => number;
      };
      expect(typeof api.getZoneFade, 'R97 门禁 C：Castle.getZoneFade 必须存在（禁止 skip）').toBe('function');
      expect(typeof api.getZoneZMin, 'R97 夹具：Castle.getZoneZMin 必须存在（禁止 skip）').toBe('function');
      // 未知名字必须返回 NaN，让上层断言显式 fail，而不是返回 1 制造假绿
      expect(Number.isNaN(castle.getZoneFade('__no_such_zone__'))).toBe(true);
      expect(Number.isNaN(castle.getZoneZMin('__no_such_zone__'))).toBe(true);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('① 起点 z=+68：所有区 visible===true && getZoneFade(name)===1（深区不再被摘/淡成雾）', () => {
    const { scene, castle } = buildCastle();
    try {
      castle.updateViewerZ(68);
      const names = zoneNamesOf(castle);
      expect(names.length, 'zoneViews 为空（无法验证）').toBeGreaterThan(0);
      // 深区必须真实存在（否则「全显」断言是空集自证）—— zMin < −1000 的塔冠/深街区
      const deep = names.filter((n) => zMinOf(castle, n) < -1000);
      expect(deep.length, '缺少深区（zMin<−1000），起点全显断言失去意义').toBeGreaterThan(0);
      for (const name of names) {
        const mesh = zoneMesh(scene, name);
        const visible = mesh.visible === true;
        const fade = castle.getZoneFade(name);
        expect(
          visible && fade === 1,
          `${name} 起点须 visible===true && getZoneFade===1（实得 visible=${visible}, fade=${fade}）`
        ).toBe(true);
      }
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('② 车驶出区后端（z ≤ zMin − H）后该区 visible=false', () => {
    const { scene, castle } = buildCastle();
    try {
      const names = zoneNamesOf(castle);
      // 取最靠前（zMin 最大）的入口区：车往城内开时最先被甩到身后
      const zMinByName = names.map((n) => ({ name: n, zMin: zMinOf(castle, n) }));
      const front = zMinByName.reduce((a, b) => (a.zMin >= b.zMin ? a : b));
      castle.updateViewerZ(68);
      expect(zoneMesh(scene, front.name).visible).toBe(true);
      // 越过该区后端再退 5m（>H=20 的滞回带）
      castle.updateViewerZ(front.zMin - 25);
      expect(zoneMesh(scene, front.name).visible, `${front.name} 车已驶出其后端应剔除`).toBe(false);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('③ 倒车 z 回升后该区重新 visible=true 且 getZoneFade(name)===1', () => {
    const { scene, castle } = buildCastle();
    try {
      const names = zoneNamesOf(castle);
      const zMinByName = names.map((n) => ({ name: n, zMin: zMinOf(castle, n) }));
      const front = zMinByName.reduce((a, b) => (a.zMin >= b.zMin ? a : b));
      castle.updateViewerZ(front.zMin - 25);
      expect(zoneMesh(scene, front.name).visible).toBe(false);
      // 倒车回到区后端之前 ⇒ 自动重新纳入，且 fade 必须回 1（否则隐形假绿）
      castle.updateViewerZ(front.zMin + 50);
      const visible = zoneMesh(scene, front.name).visible === true;
      const fade = castle.getZoneFade(front.name);
      expect(
        visible && fade === 1,
        `${front.name} 倒车须 visible===true && getZoneFade===1（实得 ${visible}/${fade}）`
      ).toBe(true);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('④ 车在自己所在区内（含最深处 zMin+ε）该区恒 visible===true && getZoneFade(name)===1', () => {
    const { scene, castle } = buildCastle();
    try {
      const names = zoneNamesOf(castle);
      for (const name of names) {
        // 贴着区后端内侧 1m —— 旧 cz 判据最易误剔的位置（车在区内却按「远离区心」摘掉）
        const zMin = zMinOf(castle, name);
        castle.updateViewerZ(zMin + 1);
        const visible = zoneMesh(scene, name).visible === true;
        const fade = castle.getZoneFade(name);
        expect(
          visible && fade === 1,
          `${name} 车在区内(z=zMin+1)须 visible===true && getZoneFade===1（实得 ${visible}/${fade}）`
        ).toBe(true);
      }
      // 洞1的具体坐标钉死：z2（bbox≈[−760,−460]）车在 z=−700 时脚下区必须可见
      const z2 = names.filter((n) => {
        const zMin = zMinOf(castle, n);
        return zMin <= -700 && zMin > -800;
      });
      if (z2.length > 0) {
        castle.updateViewerZ(-700);
        for (const name of z2) {
          const visible = zoneMesh(scene, name).visible === true;
          const fade = castle.getZoneFade(name);
          expect(
            visible && fade === 1,
            `${name} 车在 z=−700（z2 区内）须 visible===true && getZoneFade===1（实得 ${visible}/${fade}）`
          ).toBe(true);
        }
      }
    } finally {
      castle.dispose();
    }
  }, 60000);
});
