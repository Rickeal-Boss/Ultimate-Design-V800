import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createWheelArchLiner, ARCH_LINER, WHEEL_ARCH_LINER_MATERIAL_ID } from '../src/model/parts/wheelArchLiner';
import { WHEEL_HUB_CENTERS } from '../src/model/parts/wheelHub';

/**
 * R65 · 轮拱内衬封看穿 + 机盖机位回归网。
 *
 * 病根（用户 11-10 截图）：①R7 无轮拱内衬 + 衬板仅 100° 顶弧 ⇒ 从轮辐条间隙斜视穿到
 * 舱内座椅；②机盖机位 local z 符号反（-1.45 落座舱顶下）⇒ 顶棚悬挂入画。
 * 本护栏钉：衬板几何契约（180°/半径带/不碰胎）+ R7 接线 + 机盖机位常量。
 * 只读已入库 src/ 源码（禁读 .qa/ ⇒ CI ubuntu ENOENT，R64-fix 铁律）。
 */

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** 衬板几何：半径带落在轮胎(0.382/0.383)与拱(0.452)之间，210° 宽弧（中心偏后）。 */
describe('R65 轮拱内衬几何契约', () => {
  it('spanDeg=210 + centerDeg=95（R65-G：多盖拱口前后斜下象限，封死侧向看穿）', () => {
    expect(ARCH_LINER.spanDeg).toBe(210);
    expect(ARCH_LINER.centerDeg).toBe(95);
  });

  it.each([1, -1] as const)('side=%i 半径带 ∈ [rIn,rOut] 且不穿拱顶', (side) => {
    const g = createWheelArchLiner(side);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBeGreaterThan(0);
    let minR = Infinity;
    let maxR = -Infinity;
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = Math.hypot(y, z);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      maxY = Math.max(maxY, y);
      minY = Math.min(minY, y);
    }
    // 半径带严格落在轮胎外缘与拱内缘之间的余量带（不碰胎、不穿拱）
    expect(minR).toBeGreaterThanOrEqual(ARCH_LINER.rIn - 1e-6);
    expect(maxR).toBeLessThanOrEqual(ARCH_LINER.rOut + 1e-6);
    expect(ARCH_LINER.rIn).toBeGreaterThan(0.383); // > R7/V800 轮胎半径
    expect(ARCH_LINER.rOut).toBeLessThan(0.452); // < 拱开口半径
    // 拱顶最高点落在 [rIn,rOut] 拱顶带内（离散采样用区间非 closeTo）
    expect(maxY).toBeGreaterThanOrEqual(ARCH_LINER.rIn - 1e-6);
    expect(maxY).toBeLessThanOrEqual(ARCH_LINER.rOut + 1e-6);
    // 210° 宽弧端点可落到轮心下（≥ -rOut，藏进拱腔暗处/胎后，不外凸不穿地过深）
    expect(minY).toBeGreaterThanOrEqual(-ARCH_LINER.rOut - 1e-6);
  });

  it('材质 id = 哑光黑轮拱语义（双车共享）', () => {
    expect(WHEEL_ARCH_LINER_MATERIAL_ID).toBe('r22-arch-liner');
  });
});

/** R7 此前无衬板 ⇒ 舱内座椅从轮拱看穿。护栏钉接线存在。 */
describe('R65 R7 轮拱内衬接线', () => {
  const src = readSrc('model/R7Adapter.ts');

  it('R7Adapter 引入衬板件 + 轮心表', () => {
    expect(src).toContain("from './parts/wheelArchLiner'");
    expect(src).toContain('WHEEL_ARCH_LINER_MATERIAL_ID');
    expect(src).toContain('WHEEL_HUB_CENTERS');
  });

  it('四角全铺（fl/fr/rl/rr）—— R7 座舱看穿前后轮拱同病', () => {
    expect(src).toContain("'fl', 'fr', 'rl', 'rr'");
    expect(src).toContain('createWheelArchLiner(');
  });

  it('轮心表覆盖四角且 y=0.382（与衬板半径带同源）', () => {
    for (const c of ['fl', 'fr', 'rl', 'rr'] as const) {
      expect(WHEEL_HUB_CENTERS[c].y).toBeCloseTo(0.382, 3);
    }
  });
});

/** 机盖机位 R65 前移到机盖正上方（车头 +Z）。护栏钉常量。 */
describe('R65 机盖机位（hood）前移', () => {
  it('CameraRig hood 默认 offset 贴机盖面+前移到前缘（y1.15/z2.0，机盖铺满下半）', () => {
    const src = readSrc('render/CameraRig.ts');
    expect(src).toMatch(/HOOD_Y = HOOD_POSE_OVERRIDE\?\.y \?\? 1\.15/);
    expect(src).toMatch(/HOOD_Z = HOOD_POSE_OVERRIDE\?\.z \?\? 2\.0/);
    // R65-F 机位（1.55/1.4）保留为 #hoodcam=off 回滚态
    expect(src).toContain('hoodcam=off');
    expect(src).toContain('1.55, z: 1.4');
  });

  it('hood cam 扫参钩子 #hoodcam=y,z,ly 存在（真机 A/B）', () => {
    const src = readSrc('render/CameraRig.ts');
    expect(src).toContain('hoodcam=');
  });
});

/** 镀铬贯穿刃贴灯腔下缘（旧 y0.733 悬浮）。护栏钉位置。 */
describe('R65 R7 贯穿镀铬刃贴灯下缘', () => {
  it('刃 y=0.752 与灯腔下缘(0.758)咬合，不再悬浮', () => {
    const src = readSrc('model/parts/r7FrontDetails.ts');
    // 正向钉新位置（0.752 刃 + 0.742 暗缝）；不反向查 0.733（该数字在文件他处出现）
    expect(src).toMatch(/g\.translate\(0, 0\.752, Z_FACE \+ 0\.007\)/);
    expect(src).toMatch(/seam\.translate\(0, 0\.742, Z_FACE \+ 0\.004\)/);
  });
});
