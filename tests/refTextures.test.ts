/**
 * refTextures 单测（Node shim，无 DOM / 无网络）
 *
 * 覆盖 R15-2 的三条硬约束：
 *   1. 按**组件 id** 命中、同材质不同组件互不串图（cabin-interior 必须不被绗缝覆盖）；
 *   2. UV 由世界坐标重建并落在声明矩形内（不是线性 remap 既有图集 UV）；
 *   3. 各向异性 distortion ≤ 8x；加载失败时优雅降级（保持原贴图、不抛错）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  applyReferenceTextures,
  disposeReferenceTextures,
  getReferenceTextureReport,
  normalizeUVToRegion,
  computeUvAspect,
  _injectReferenceTexture,
  REF_IMAGE_IDS,
} from '../src/model/refTextures';

/** 造一个带 sculptComponent / sculptMaterial userData 的 mesh */
function makeMesh(
  componentId: string,
  materialId: string,
  size: [number, number, number]
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6b4437 });
  mat.userData.sculptMaterial = { id: materialId, color: '#6B4437' };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.sculptComponent = { id: componentId };
  mesh.name = `mesh_${componentId}`;
  return mesh;
}

function uvBounds(mesh: THREE.Mesh): [number, number, number, number] {
  const uv = mesh.geometry.getAttribute('uv');
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return [uMin, uMax, vMin, vMax];
}

function injectAll(): void {
  for (const id of REF_IMAGE_IDS) _injectReferenceTexture(id, new THREE.Texture());
}

beforeEach(() => {
  disposeReferenceTextures();
});
afterEach(() => {
  disposeReferenceTextures();
});

describe('normalizeUVToRegion（remapUVToRegion 语义）', () => {
  it('把越界 UV（负值 + 越界正值）bbox 归一压进目标区，且落点不越区', () => {
    const mesh = makeMesh('x', 'leather-warm', [1, 1, 1]);
    // 模拟 extrude/圆角基元的图集坐标：u∈[-0.5,0.5]、v∈[-0.5,1.0]
    const uv = mesh.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) - 0.5, uv.getY(i) * 1.5 - 0.5);
    }
    normalizeUVToRegion(mesh, 0.004, 0.496, 0.004, 0.996);
    const [uMin, uMax, vMin, vMax] = uvBounds(mesh);
    expect(uMin).toBeGreaterThanOrEqual(0.004 - 1e-6);
    expect(uMax).toBeLessThanOrEqual(0.496 + 1e-6);
    expect(vMin).toBeGreaterThanOrEqual(0.004 - 1e-6);
    expect(vMax).toBeLessThanOrEqual(0.996 + 1e-6);
    // 归一后应铺满目标区（不是缩成一点）
    expect(uMax - uMin).toBeGreaterThan(0.4);
    expect(vMax - vMin).toBeGreaterThan(0.9);
  });
});

describe('applyReferenceTextures', () => {
  it('按组件 id 命中：座椅拿菱格、门板拿素皮，同材质 cabin-interior 不被串图', () => {
    const root = new THREE.Group();
    const seat = makeMesh('seat-driver', 'leather-warm', [0.52, 0.13, 0.5]);
    const door = makeMesh('door-panel-fl', 'leather-warm', [0.07, 0.62, 1.15]);
    const cabin = makeMesh('cabin-interior', 'leather-warm', [1.72, 1.5, 4.2]);
    const dash = makeMesh('dash-upper', 'leather-dark', [1.78, 0.17, 0.46]);
    root.add(seat, door, cabin, dash);
    const cabinMat = cabin.material as THREE.MeshStandardMaterial;

    injectAll();
    const ids = applyReferenceTextures(root, { tier: 'high' });

    // 返回值 = 实际承载参考图的材质 id 列表
    expect(ids).toEqual(['leather-dark', 'leather-warm']);

    // 座椅 / 门板拿到各自的图，且是两份独立克隆（合批后不会互相串）
    const seatMat = seat.material as THREE.MeshStandardMaterial;
    const doorMat = door.material as THREE.MeshStandardMaterial;
    expect(seatMat).not.toBe(doorMat);
    expect(seatMat.map).toBeTruthy();
    expect(doorMat.map).toBeTruthy();
    expect(seatMat.map).not.toBe(doorMat.map);
    expect(seatMat.userData.refTexture.image).toBe('seat-quilt');
    expect(doorMat.userData.refTexture.image).toBe('leather-plain');

    // 同材质但不在规则里的 cabin-interior：材质对象与 map 都不动
    expect(cabin.material).toBe(cabinMat);
    expect(cabinMat.map).toBeNull();

    // 仪表台（leather-dark）独立命中
    const dashMat = dash.material as THREE.MeshStandardMaterial;
    expect(dashMat.userData.refTexture.image).toBe('leather-plain');
    expect(dashMat.map).toBeTruthy();
  });

  it('UV 由世界坐标重建：落在声明矩形内、平铺次数 ≥1、各向异性 ≤ 8x', () => {
    const root = new THREE.Group();
    const seat = makeMesh('seat-driver', 'leather-warm', [0.52, 0.13, 0.5]);
    const door = makeMesh('door-panel-fl', 'leather-warm', [0.07, 0.62, 1.15]);
    const screen = makeMesh('tri-screen', 'screen-ui', [1.66, 0.315, 0.006]);
    root.add(seat, door, screen);

    injectAll();
    applyReferenceTextures(root, { tier: 'high' });

    // 盒投影（三联屏：平面卡，必须整幅 UI 平铺一次）：UV 落在 [0,nU]×[0,nV] 内
    for (const mesh of [screen]) {
      const [uMin, uMax, vMin, vMax] = uvBounds(mesh);
      expect(uMin).toBeGreaterThanOrEqual(-1e-6);
      expect(vMin).toBeGreaterThanOrEqual(-1e-6);
      expect(uMax).toBeGreaterThanOrEqual(1);
      expect(vMax).toBeGreaterThanOrEqual(1);
      // 归一化后必须真的铺开（u/v 跨度 ≥ 1 个平铺单元）
      expect(Math.max(uMax - uMin, vMax - vMin)).toBeGreaterThanOrEqual(1);
    }
    // 三平面（座椅 / 门板）：世界锚定连续 UV，允许负值（RepeatWrapping 环绕无痕，
    // 相邻件的纹样相位连续）—— 只要跨度 ≥1 个平铺单元、无 NaN 即合格
    for (const mesh of [seat, door]) {
      const [uMin, uMax, vMin, vMax] = uvBounds(mesh);
      expect(Number.isFinite(uMin)).toBe(true);
      expect(Number.isFinite(vMax)).toBe(true);
      expect(Math.max(uMax - uMin, vMax - vMin)).toBeGreaterThanOrEqual(1);
    }

    const report = getReferenceTextureReport();
    expect(report.length).toBeGreaterThan(0);
    for (const r of report) {
      for (const m of r.meshes) {
        // R12b 硬红线：>8x 判死
        expect(m.distortion).toBeLessThanOrEqual(8);
        expect(m.repeat[0]).toBeGreaterThanOrEqual(1);
        expect(m.repeat[1]).toBeGreaterThanOrEqual(1);
        // 无 NaN（三平面允许负值：世界锚定 + RepeatWrapping 环绕）
        expect(Number.isFinite(m.uvRange[0])).toBe(true);
        expect(Number.isFinite(m.uvRange[3])).toBe(true);
      }
    }
    // 三联屏应被切成多段 UI（1.66m 宽 / 0.45m 单元 / 图幅 2:1）
    const tri = report
      .find((r) => r.image === 'screen-cockpit')
      ?.meshes.find((m) => m.componentId === 'tri-screen');
    expect(tri).toBeTruthy();
    expect(tri!.repeat[0]).toBeGreaterThanOrEqual(2);
  });

  it('computeUvAspect：三平面重建后逐三角形各向同性', () => {
    const root = new THREE.Group();
    const seat = makeMesh('seat-rear-l-back', 'leather-warm', [0.54, 0.66, 0.1]);
    root.add(seat);
    injectAll();
    applyReferenceTextures(root, { tier: 'high' });
    const rep = computeUvAspect(seat, 1); // seat-quilt 图幅 1:1
    expect(rep.triangles).toBeGreaterThan(0);
    expect(rep.maxAspect).toBeLessThanOrEqual(8);
    expect(rep.over8).toBe(0);
  });

  it('优雅降级：贴图加载失败时保持原贴图、不抛错、不黑屏', () => {
    const root = new THREE.Group();
    const seat = makeMesh('seat-driver', 'leather-warm', [0.52, 0.13, 0.5]);
    const door = makeMesh('door-panel-fl', 'leather-warm', [0.07, 0.62, 1.15]);
    root.add(seat, door);
    const seatMat0 = seat.material as THREE.MeshStandardMaterial;

    for (const id of REF_IMAGE_IDS) {
      _injectReferenceTexture(id, id === 'seat-quilt' ? null : new THREE.Texture());
    }
    expect(() => applyReferenceTextures(root, { tier: 'high' })).not.toThrow();

    // 失败的那一档：材质被换成了克隆（UV 已重建）但 map 保持原值（null）→ 不黑屏
    const seatMat = seat.material as THREE.MeshStandardMaterial;
    expect(seatMat).not.toBe(seatMat0);
    expect(seatMat.map).toBeNull();
    // 成功那一档不受影响
    const doorMat = door.material as THREE.MeshStandardMaterial;
    expect(doorMat.map).toBeTruthy();

    const failed = getReferenceTextureReport().find((r) => r.image === 'seat-quilt');
    expect(failed?.status).toBe('failed');
    expect(failed?.materialIds.length).toBe(0);
  });

  it('低档：seat-cushion 规则不启用（回退程序化贴图）', () => {
    const root = new THREE.Group();
    const head = makeMesh('seat-driver-headrest', 'leather-warm', [0.26, 0.15, 0.1]);
    root.add(head);
    injectAll();
    const ids = applyReferenceTextures(root, { tier: 'low' });
    expect(ids).toEqual([]);
    const rep = getReferenceTextureReport().find((r) => r.image === 'seat-cushion');
    expect(rep?.status).toBe('skipped-tier');
  });
});
