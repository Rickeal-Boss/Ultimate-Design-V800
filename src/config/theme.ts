/**
 * 配色与材质参数（P3 调光版 · 调光）
 * 双拼色基准：上半香槟金 #C9A86B + 下半深棕 #3E2F23（公开报道资料）。
 *
 * 色彩空间纪律（本文件不产贴图，仅材质参数）：
 * - 颜色贴图 → THREE.SRGBColorSpace（在生成处设置）
 * - 数据贴图（凹凸/法线/粗糙度）→ THREE.NoColorSpace / LinearSRGBColorSpace
 * - 渲染器输出 → THREE.SRGBColorSpace（Renderer.ts 已确认，勿在此重复设置）
 */
import * as THREE from 'three';
import type { QualityTier } from './quality';

export const PALETTE = {
  /** 上半车体 · 香槟金（6C4B 工艺质感基准） */
  bodyUpper: 0xc9a86b,
  /** 下半车体 · 深棕 */
  bodyLower: 0x3e2f23,
  /** 镀铬件 */
  chrome: 0xe8e9ec,
  /** 深色金属 */
  darkMetal: 0x35342f,
  /** 黑漆 */
  blackPaint: 0x141414,
  /** 深色玻璃（低配档 transparent 分支用） */
  glass: 0x1a2228,
  /** 玻璃浅色调（transmission 分支的透射染色） */
  glassTint: 0xaebfc9,
  /** 橡胶 */
  rubber: 0x1c1c1e,
  /** 车灯底壳 */
  lampHousing: 0x26262a,
  /** 头灯发光 */
  headlight: 0xf5f8ff,
  /** 尾灯红 */
  taillight: 0xff2a1e,
  /** 刹车盘热辉光（brakeTemp 联动） */
  brakeDiscGlow: 0xff3a08,
  /** 中央交互灯带 */
  lightBar: 0x30c8ff,
  /** 木纹（胡桃木饰板基色，配 Canvas 木纹贴图） */
  wood: 0x6e4a2c,
  /** 内饰深棕真皮（墨阑棕） */
  leather: 0x4a3324,
  /** 内饰软触深色（仪表台/门板基底） */
  interiorDark: 0x1d1512,
  /** 水晶旋钮 */
  crystal: 0xcfe0ea,
  /** 星环散射体 · 暖白端 */
  starRingWarm: 0xffd9a0,
  /** 星环散射体 · 青色端 */
  starRingCool: 0x7fd8e8,
  /** 鸿蒙风 UI 底色 */
  screenBg: 0x0b1420
} as const;

export const MATERIAL = {
  /** 上半车漆：金属漆 + 清漆层（MeshPhysicalMaterial） */
  paint: {
    metalness: 0.68,
    roughness: 0.34,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.0
  },
  /** 下半车漆：同工艺，略哑光收一点反射 */
  paintLower: {
    metalness: 0.62,
    roughness: 0.38,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    envMapIntensity: 0.9
  },
  /** 镀铬饰条：必须接环境贴图（scene.environment） */
  chrome: { roughness: 0.15, metalness: 1.0, envMapIntensity: 1.25 },
  darkMetal: { roughness: 0.45, metalness: 0.85, envMapIntensity: 0.9 },
  /** 轮圈大饼样式金属漆 */
  rim: { roughness: 0.25, metalness: 0.9, envMapIntensity: 1.1 },
  /** 橡胶轮胎 */
  rubber: { roughness: 0.9, metalness: 0.0 },
  /** 玻璃 · 桌面/中配档：MeshPhysicalMaterial 透射（车内视角可看穿） */
  glassPhysical: {
    transmission: 0.92,
    roughness: 0.06,
    metalness: 0.0,
    thickness: 0.06,
    ior: 1.5,
    envMapIntensity: 1.0
  },
  /** 玻璃 · 低配档降级：transparent + opacity */
  glassSimple: {
    transparent: true,
    opacity: 0.45,
    roughness: 0.08,
    metalness: 0.1,
    depthWrite: false
  }
} as const;

/** 车漆：金属漆 + 清漆（clearcoat 层模拟 6C4B 双色涂装工艺光泽） */
export function makePaintMaterial(color: number, lower = false): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    ...(lower ? MATERIAL.paintLower : MATERIAL.paint)
  });
}

/**
 * 玻璃材质按质量档分支：
 * - high/medium：MeshPhysicalMaterial transmission（真实折射，车内视角可看穿）
 * - low：transparent + opacity 降级（省一次透射 pass）
 */
export function makeGlassMaterial(tier: QualityTier = 'high'): THREE.MeshPhysicalMaterial {
  if (tier === 'low') {
    return new THREE.MeshPhysicalMaterial({
      color: PALETTE.glass,
      ...MATERIAL.glassSimple,
      side: THREE.DoubleSide
    });
  }
  return new THREE.MeshPhysicalMaterial({
    color: PALETTE.glassTint,
    ...MATERIAL.glassPhysical,
    side: THREE.DoubleSide
  });
}
