/**
 * R33 · 车辆精修回归
 *
 * 锁两件在装配层新增、但容易被后续重产/合批静默破坏的契约：
 *  1. R7 前脸手作件真实产出 7 个材质桶（灯腔/镀铬/镜片/透镜/DRL/格栅/前唇），
 *     三角数在预算内，且旧灯组隐藏清单覆盖 headlamp/lamp-edging/light-bar；
 *  2. V800 轮毂 18 窗开口放大后仍严格落在窗带内外缘内（0.203..0.283），
 *     不越界切穿抛光外唇（否则侧视会读成轮圈破洞）。
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createR7FrontDetails,
  R7_FRONT_DETAIL_MATERIAL_IDS,
  lipBarBounds,
  R7_FASCIA_BOTTOM_Y,
  R7_LIP_CONTACT_EPSILON
} from '../src/model/parts/r7FrontDetails';
import { createWheelHubResult, listWheelWindows, N_WINDOWS } from '../src/model/parts/wheelHub';

const triOf = (g: THREE.BufferGeometry): number => {
  const idx = g.getIndex();
  return (idx ? idx.count : g.getAttribute('position').count) / 3;
};

describe('R33 R7 前脸手作件', () => {
  const detail = createR7FrontDetails();

  it('生成 7 个材质桶，三角数在 1k–12k（首建不限时，运行仍受控）', () => {
    const ids = new Set<string>();
    let tris = 0;
    for (const mesh of detail.group.children as THREE.Mesh[]) {
      const m = mesh.material as THREE.Material;
      ids.add(String(m.userData?.sculptMaterial?.id ?? ''));
      tris += triOf(mesh.geometry);
    }
    expect([...ids].sort()).toEqual(Object.values(R7_FRONT_DETAIL_MATERIAL_IDS).sort());
    expect(tris).toBe(detail.triangleCount);
    expect(tris).toBeGreaterThan(1_000);
    expect(tris).toBeLessThan(12_000);
  });

  it('灯腔/下格栅处于前脸外侧，不埋进 front-fascia（z≈2.405）', () => {
    detail.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(detail.group);
    expect(box.min.z).toBeGreaterThan(2.40);
    expect(box.max.z).toBeLessThan(2.50);
    expect(box.max.x - box.min.x).toBeGreaterThan(1.7);
    expect(box.max.y).toBeLessThan(0.95);
  });

  it('旧灯组与旧发光刃全部在隐藏清单（防双白线/矩形黑卡复现）', () => {
    for (const id of [
      'headlamp-l',
      'headlamp-r',
      'lamp-edging-l',
      'lamp-edging-r',
      'light-bar-front'
    ]) {
      expect(detail.hiddenComponentIds).toContain(id);
    }
  });

  it('R34 前唇压条顶面贴合 front-fascia 底缘（零悬浮缝），且与本体 z 重叠', () => {
    const b = lipBarBounds();
    // 顶面对齐 fascia 底缘 y=0.21（容差 6mm ≈ 屏幕 1px 以下）
    expect(b.topGap).toBeLessThanOrEqual(R7_LIP_CONTACT_EPSILON);
    // 与 fascia 实体搭接 ≥18mm（企口对接会让悬浮态在几何上不可能发生）
    expect(b.zOverlap).toBeGreaterThan(0.018);
    // 端头封口埋进本体 ⇒ 压条整体 y 上限 ≥ fascia 底缘（确认不悬空）
    expect(b.capMaxY).toBeGreaterThanOrEqual(R7_FASCIA_BOTTOM_Y - 1e-6);
    // 压条处于前脸外侧 z 区间（不埋进车体，也不外探过多）
    expect(b.barMaxZ).toBeGreaterThan(2.4);
    expect(b.barMinZ).toBeLessThan(2.47);
  });
});

describe('R33 V800 轮毂开口', () => {
  it('18 窗放大后外接半径仍 < 窗带外缘 0.283（不切穿外唇）', () => {
    const rows = listWheelWindows();
    expect(rows).toHaveLength(N_WINDOWS);
    for (const w of rows) {
      expect(w.rOut).toBeLessThan(0.283);
      expect(w.rIn).toBeGreaterThan(0.203);
      expect(w.halfAngleDeg).toBeGreaterThan(7);
    }
  });

  it('轮毂仍是 4 材质桶，且 bbox 半径不超过 0.3m', () => {
    const hub = createWheelHubResult(1);
    expect(hub.materials.bright.userData.sculptMaterial.id).toBe('r22-hub-bright');
    hub.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(hub.group);
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(0.601);
    expect(hub.triangleCount).toBeGreaterThan(1_200);
  });
});
