/**
 * R43 遮挡定罪探针入口 —— 把 Game.ts:314-320 的四个场景构造原样搬进 node：
 *   new Environment? 不需要（天空/PMREM 只影响光照观感，不影响几何归因）
 *   new Road(scene, aniso) / new Terrain(scene) / new Castle(scene, quality)
 *
 * 由 tools/r43_probe_build.mjs 用 esbuild JS API 打成 tools/r43_probe_bundle.mjs。
 */
import * as THREE from 'three';
import { Road } from '../src/render/scene/Road';
import { Terrain } from '../src/render/scene/Terrain';
import { Castle } from '../src/render/scene/castle';
import { createQualitySettings } from '../src/config/quality';
import * as Layout from '../src/render/scene/r28Layout';
import { ACTIVE_ENV } from '../src/config/environment';

/** 画一个可选开关：`GORGE_HALF_OVERRIDE` 走 Layout 的单例导出无法改（as const），
 *  故 A/B 由 .mjs 侧的 slab 过滤 + 这里返回的 half 数字自己算，不改真源。 */
export function buildEnv(): {
  scene: any;
  castle: any;
  quality: any;
} {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(ACTIVE_ENV.fog.color, ACTIVE_ENV.fog.density);
  const quality = createQualitySettings('high');
  new Road(scene, 8);
  new Terrain(scene);
  const castle = new Castle(scene, quality);
  scene.updateMatrixWorld(true);
  return { scene, castle, quality };
}

export { THREE, Layout, ACTIVE_ENV };
