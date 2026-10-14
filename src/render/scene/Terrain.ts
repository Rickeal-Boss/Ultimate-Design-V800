/**
 * 远山：两圈程序化 BufferGeometry（半径 2600/2200 各 220 段，正弦 + LCG 随机高度），
 * 顶点色按高度渐变（山脚灰 → 山腰褐 → 山顶亮）。
 * 移植原版 Sg 几何 + 方案 A4 顶点色改造。
 */
import * as THREE from 'three';
import { MeshBasicMaterial } from 'three';
import { makeLcg } from '../../util/math';

/** 高度 0→1 的三段渐变色（P3 调光：色相整体向黄昏雾色 0xB05C6A 收拢） */
function heightColor(h: number, out: THREE.Color): void {
  const low = new THREE.Color(0x745d64); // 山脚灰（偏暮色紫灰）
  const mid = new THREE.Color(0x84584e); // 山腰褐（偏霞光红褐）
  const top = new THREE.Color(0xe2a48c); // 山顶亮（霞光，降一点饱和避免与天争抢）
  if (h < 0.4) out.copy(low).lerp(mid, h / 0.4);
  else out.copy(mid).lerp(top, (h - 0.4) / 0.6);
}

export class Terrain {
  constructor(scene: THREE.Scene) {
    const group = new THREE.Group();
    for (const [radius, heightScale, seed] of [
      [2600, 260, 3813444],
      [2200, 170, 4864582]
    ] as const) {
      group.add(this.buildRing(radius, heightScale, seed));
    }
    scene.add(group);
  }

  private buildRing(radius: number, heightScale: number, seed: number): THREE.Mesh {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const random = makeLcg(seed);
    const color = new THREE.Color();
    const heights: number[] = [];

    // 环形轮廓高度（正弦叠加 + LCG 随机，闭合连续）
    for (let i = 0; i <= 220; i++) {
      const t = i / 220;
      heights.push(
        heightScale *
          (0.35 +
            0.35 * Math.abs(Math.sin(t * Math.PI * 7 + radius)) +
            0.2 * Math.abs(Math.sin(t * Math.PI * 23)) +
            0.15 * random())
      );
    }
    // 闭合接缝平滑：首尾混合
    heights[220] = heights[0];

    for (let i = 0; i <= 220; i++) {
      const angle = (i / 220) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const h = heights[i];
      positions.push(x, -10, z, x, h, z);
      heightColor(h / heightScale, color);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      if (i < 220) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return new THREE.Mesh(
      geo,
      new MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: true })
    );
  }
}
