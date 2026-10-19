import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// R9 平滑焊接：ExtrudeGeometry 非索引 + 逐面法线 = 全平面着色（积木棱角感）。
// 先删法线 → mergeVertices 按「位置+UV」等值焊接（UV 不同处天然保留硬边，
// 端面/侧壁的真实折痕不受影响）→ 重算顶点法线得到平滑过渡。
function weldSmooth(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  const welded = mergeVertices(geo, 1e-4);
  welded.computeVertexNormals();
  return welded;
}

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

interface ExtrudeShaping {
  space?: 'side' | 'front';
  /** front 空间必填：组件 spec position，把 shape 局部坐标平移到车体框架 */
  nodeOffset?: [number, number, number];
  tumblehome?: { yBase: number; yTop: number; topScale: number };
  planTaperNose?: { zFrom: number; zTo: number; amount: number; yGate?: number; yFade?: number };
  planTaperTail?: { zFrom: number; zTo: number; amount: number; yGate?: number; yFade?: number };
  waistBulge?: { yCenter: number; ySpan: number; amount: number };
}

function extrudeSmooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// 车身壳体顶点级整形（座舱内倾 / 俯视前后收窄 / 腰部外鼓）。
// 全部是逐顶点函数：tumblehome 依赖 world y、收窄依赖 world z，轮廓点本身沿长度分布，
// steps:1 也成立，不增面数。side 约定（rotY(∓90°) 侧视轮廓件，节点 p.x=depth/2、p.y=p.z=0）：
// shape(x,y,z) → world(x = depth/2 − z, y, z)。front 约定（无旋转端面件）：shape 即 world。
function applyExtrudeShaping(geo: THREE.BufferGeometry, depth: number, shaping: ExtrudeShaping | undefined): void {
  if (!shaping) return;
  const th = shaping.tumblehome;
  const nose = shaping.planTaperNose;
  const tail = shaping.planTaperTail;
  const waist = shaping.waistBulge;
  if (!th && !nose && !tail && !waist) return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const side = (shaping.space ?? 'side') === 'side';
  const off = shaping.nodeOffset ?? [0, 0, 0];
  const gate = (g: number | undefined, f: number | undefined): number => {
    if (g === undefined) return 1;
    const fade = f ?? 0.12;
    return 1 - extrudeSmooth01((wy - (g - fade)) / (2 * fade));
  };
  let wy = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const sx = pos.getX(i);
    const sy = pos.getY(i);
    const sz = pos.getZ(i);
    let wx: number;
    let wz: number;
    if (side) { wx = depth / 2 - sz; wy = sy; wz = sx; }
    else { wx = sx; wy = sy + off[1]; wz = sz + off[2]; }
    let m = 1;
    if (th) {
      const t = extrudeSmooth01((wy - th.yBase) / (th.yTop - th.yBase));
      m *= 1 - (1 - th.topScale) * t;
    }
    if (nose) {
      const t = extrudeSmooth01((wz - nose.zFrom) / (nose.zTo - nose.zFrom));
      m *= 1 - nose.amount * t * gate(nose.yGate, nose.yFade);
    }
    if (tail) {
      const t = extrudeSmooth01((wz - tail.zFrom) / (tail.zTo - tail.zFrom));
      m *= 1 - tail.amount * t * gate(tail.yGate, tail.yFade);
    }
    if (waist) {
      const d = (wy - waist.yCenter) / waist.ySpan;
      m *= 1 + waist.amount * Math.exp(-d * d);
    }
    wx *= m;
    if (side) pos.setXYZ(i, sx, wy, depth / 2 - wx);
    else pos.setXYZ(i, wx, wy - off[1], wz - off[2]);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

// bevel 语义（R6 骨架波）：bevel.size + 负 bevel.offset → 中段保持原轮廓、
// 两端端面内缩 size（车身最宽线留在中段，端面圆角收进）；keepWidth：depth 内缩
// 2×thickness 并 translate 回 [0, depth]，节点定位约定不变。
function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[]; bevel?: { thickness: number; size: number; offset?: number; segments?: number }; shaping?: ExtrudeShaping }): THREE.BufferGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  const bevel = profile.bevel;
  if (bevel && bevel.thickness > 0) {
    const bt = bevel.thickness;
    const depth = profile.depth - 2 * bt;
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: bt,
      bevelSize: bevel.size,
      bevelOffset: bevel.offset ?? 0,
      bevelSegments: bevel.segments ?? 3,
    });
    geo.translate(0, 0, bt);
    applyExtrudeShaping(geo, profile.depth, profile.shaping);
    return weldSmooth(geo);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
  applyExtrudeShaping(geo, profile.depth, profile.shaping);
  return weldSmooth(geo);
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Luxeed R7
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createLuxeedR7Model(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Luxeed R7";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["paint-green"] = createSculptMaterial(
    "paint-green",
    {"id": "paint-green", "name": "墨绿金属漆（车身）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1D5C50", "color": "#1D5C50", "albedo": {"base": "#1D5C50", "secondary": "#123F38", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.18, "metalness": 0.55, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [{"id": "paint-green-deep", "zone": "shadow-side", "baseColor": "#123F38", "note": "背光面加深，参考图左前 3/4 侧面暗部"}], "shaderNotes": ["墨绿金属漆：clearcoat 1.0 / roughness 0.18 / metalness 0.55，掠射角出墨绿→青绿 flop；iridescence 0.15 供云母片微光"], "notes": "", "envMapIntensity": 1.05, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "clearcoat": 1.0, "clearcoatRoughness": 0.08, "iridescence": 0.15},
    options
  );
  materialMap["paint-black"] = createSculptMaterial(
    "paint-black",
    {"id": "paint-black", "name": "曜黑饰件（窗框/后视镜支臂）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#0E1012", "color": "#0E1012", "albedo": {"base": "#0E1012", "secondary": "#1A1D20", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.28, "metalness": 0.45, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "clearcoat": 0.8, "clearcoatRoughness": 0.12},
    options
  );
  materialMap["chrome"] = createSculptMaterial(
    "chrome",
    {"id": "chrome", "name": "镀铬饰件", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#E8E9EC", "color": "#E8E9EC", "albedo": {"base": "#E8E9EC", "secondary": "#E8E9EC", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.12, "metalness": 1.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["抛光镀铬，必须有 envMap 反射；窗框/门槛饰条/前贯穿饰条"], "notes": "", "envMapIntensity": 1.2, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["glass-dark"] = createSculptMaterial(
    "glass-dark",
    {"id": "glass-dark", "name": "深色隐私玻璃", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#141A22", "color": "#141A22", "albedo": {"base": "#141A22", "secondary": "#2A323C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.05, "metalness": 0.22, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["R12 铁律：玻璃走 transparent alpha（metal 0.22 Fresnel），不走 transmission —— 透射 pass 整场景重绘是整帧 DC 翻倍的根因"], "notes": "侧窗/后挡/天幕统一此材质；适配层 high 档保持 opacity 0.62，medium/low 提到 0.72", "envMapIntensity": 1.15, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "opacity": 0.62, "transparent": true},
    options
  );
  materialMap["glass-clear"] = createSculptMaterial(
    "glass-clear",
    {"id": "glass-clear", "name": "前挡玻璃", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#8A939C", "color": "#8A939C", "albedo": {"base": "#8A939C", "secondary": "#8A939C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.04, "metalness": 0.05, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "opacity": 0.42, "transparent": true},
    options
  );
  materialMap["tire"] = createSculptMaterial(
    "tire",
    {"id": "tire", "name": "轮胎橡胶", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#141414", "color": "#141414", "albedo": {"base": "#141414", "secondary": "#141414", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.92, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "rubber", "textureless": {"declared": true, "evidence": ["胎面在本视角无可辨花纹细节；胎侧字环由适配层 Canvas 提供（品牌中性）"]}},
    options
  );
  materialMap["wheel-alloy"] = createSculptMaterial(
    "wheel-alloy",
    {"id": "wheel-alloy", "name": "黑色轮圈（21 寸双十辐）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#191A1C", "color": "#191A1C", "albedo": {"base": "#191A1C", "secondary": "#2B2D30", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.32, "metalness": 0.85, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["哑光黑漆轮圈 + 机加工亮边：roughness 0.32/ metalness 0.85，靠 envMap 出金属冷调"], "notes": "", "envMapIntensity": 0.9, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["housing-dark"] = createSculptMaterial(
    "housing-dark",
    {"id": "housing-dark", "name": "灯腔暗底", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#14171A", "color": "#14171A", "albedo": {"base": "#14171A", "secondary": "#14171A", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.28, "metalness": 0.7, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["matte-black"] = createSculptMaterial(
    "matte-black",
    {"id": "matte-black", "name": "哑光黑（轮眉/下包围/扩散器）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#121316", "color": "#121316", "albedo": {"base": "#121316", "secondary": "#121316", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.78, "metalness": 0.08, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "plastic", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["screen-ui"] = createSculptMaterial(
    "screen-ui",
    {"id": "screen-ui", "name": "中控/后排屏 UI 材质", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#0A0C10", "color": "#0A0C10", "albedo": {"base": "#0A0C10", "secondary": "#0A0C10", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.1, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["屏幕内容由适配层 Canvas 贴图提供"]}, "emissive": "#9FB6C8", "emissiveIntensity": 1.25},
    options
  );
  materialMap["gauge-ui"] = createSculptMaterial(
    "gauge-ui",
    {"id": "gauge-ui", "name": "仪表屏动态材质", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#060A08", "color": "#060A08", "albedo": {"base": "#060A08", "secondary": "#060A08", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.1, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["仪表内容由适配层每帧刷新的 10.25\" Canvas 提供"]}, "emissive": "#7FD8A8", "emissiveIntensity": 1.35},
    options
  );
  materialMap["lamp-white"] = createSculptMaterial(
    "lamp-white",
    {"id": "lamp-white", "name": "白光 emissive（日行灯带）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#FFFFFF", "color": "#FFFFFF", "albedo": {"base": "#FFFFFF", "secondary": "#FFFFFF", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.3, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "emissive": "#FFFFFF", "emissiveIntensity": 2.4},
    options
  );
  materialMap["lamp-head"] = createSculptMaterial(
    "lamp-head",
    {"id": "lamp-head", "name": "大灯投影镜芯", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#EAF2FF", "color": "#EAF2FF", "albedo": {"base": "#EAF2FF", "secondary": "#EAF2FF", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.18, "metalness": 0.1, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "emissive": "#EAF2FF", "emissiveIntensity": 2.1},
    options
  );
  materialMap["lamp-red"] = createSculptMaterial(
    "lamp-red",
    {"id": "lamp-red", "name": "尾灯红光", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B51F2C", "color": "#B51F2C", "albedo": {"base": "#B51F2C", "secondary": "#B51F2C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.25, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["贯穿尾灯 + 反光条共用；适配层 setBrakeLights 改 emissiveIntensity"], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "emissive": "#E03040", "emissiveIntensity": 2.0},
    options
  );
  materialMap["plate"] = createSculptMaterial(
    "plate",
    {"id": "plate", "name": "牌照板", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1A1D22", "color": "#1A1D22", "albedo": {"base": "#1A1D22", "secondary": "#1A1D22", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.42, "metalness": 0.1, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "plastic", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["plate-mark"] = createSculptMaterial(
    "plate-mark",
    {"id": "plate-mark", "name": "字标/铭牌发光字", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C9CED6", "color": "#C9CED6", "albedo": {"base": "#C9CED6", "secondary": "#C9CED6", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.35, "metalness": 0.15, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["LUXEED / 智界R7 / 奇瑞汽车 字样由适配层 Canvas 贴图绘制（仅文字性引用，非官方）"]}, "emissive": "#C9CED6", "emissiveIntensity": 0.85},
    options
  );
  materialMap["leather-plum"] = createSculptMaterial(
    "leather-plum",
    {"id": "leather-plum", "name": "紫灰真皮（仪表台上/门板上沿）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#6E5A72", "color": "#6E5A72", "albedo": {"base": "#6E5A72", "secondary": "#574A5C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.62, "metalness": 0.02, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["紫灰 Nappa：sheen 免用（无贴图时靠 roughness 0.62 + 低金属度出绒感）"], "notes": "", "envMapIntensity": 1.0, "materialClass": "fabric", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["leather-ivory"] = createSculptMaterial(
    "leather-ivory",
    {"id": "leather-ivory", "name": "米白真皮（仪表台下/座椅/门板）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#EDE6DA", "color": "#EDE6DA", "albedo": {"base": "#EDE6DA", "secondary": "#D8CEBF", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.6, "metalness": 0.02, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "fabric", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["leather-charcoal"] = createSculptMaterial(
    "leather-charcoal",
    {"id": "leather-charcoal", "name": "深灰内饰件（中岛/座椅侧翼）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#2A2A30", "color": "#2A2A30", "albedo": {"base": "#2A2A30", "secondary": "#2A2A30", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.66, "metalness": 0.03, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "fabric", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["suede-ivory"] = createSculptMaterial(
    "suede-ivory",
    {"id": "suede-ivory", "name": "米白麂皮顶棚", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#EFEAE0", "color": "#EFEAE0", "albedo": {"base": "#EFEAE0", "secondary": "#EFEAE0", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.88, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "fabric", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["carpet"] = createSculptMaterial(
    "carpet",
    {"id": "carpet", "name": "地毯", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#2A2A2E", "color": "#2A2A2E", "albedo": {"base": "#2A2A2E", "secondary": "#2A2A2E", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.95, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "fabric", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["speaker-lattice"] = createSculptMaterial(
    "speaker-lattice",
    {"id": "speaker-lattice", "name": "网罩扬声器面", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D9D2C6", "color": "#D9D2C6", "albedo": {"base": "#D9D2C6", "secondary": "#D9D2C6", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.7, "metalness": 0.05, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "plastic", "textureless": {"declared": true, "evidence": ["网格由适配层 Canvas 点阵图集提供（参考图后排门板白色网罩）"]}},
    options
  );
  materialMap["ambient"] = createSculptMaterial(
    "ambient",
    {"id": "ambient", "name": "氛围灯带（冷白）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#7FA0C8", "color": "#7FA0C8", "albedo": {"base": "#7FA0C8", "secondary": "#7FA0C8", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.3, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "glass", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}, "emissive": "#8FB4DC", "emissiveIntensity": 1.1},
    options
  );
  materialMap["bronze-dark"] = createSculptMaterial(
    "bronze-dark",
    {"id": "bronze-dark", "name": "暗铜色饰条（出风口/按键）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#6B5B45", "color": "#6B5B45", "albedo": {"base": "#6B5B45", "secondary": "#6B5B45", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.3, "metalness": 0.9, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["caliper-red"] = createSculptMaterial(
    "caliper-red",
    {"id": "caliper-red", "name": "红色刹车卡钳", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B0202A", "color": "#B0202A", "albedo": {"base": "#B0202A", "secondary": "#8C1A22", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.35, "metalness": 0.2, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );
  materialMap["pedal-metal"] = createSculptMaterial(
    "pedal-metal",
    {"id": "pedal-metal", "name": "踏板铝合金", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#8E9298", "color": "#8E9298", "albedo": {"base": "#8E9298", "secondary": "#8E9298", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06}, "textureResolution": null, "textureProjection": null, "surfaceFrequencyBands": null, "roughness": 0.28, "metalness": 0.95, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": [], "notes": "", "envMapIntensity": 1.0, "materialClass": "metal", "textureless": {"declared": true, "evidence": ["该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "\u667a\u754c R7 \u6574\u8f66__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "智界 R7 整车", "level": "macro", "role": "body", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "整车为组装体根节点，子件各自独立成型", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.981, "height": 1.634, "depth": 4.956, "units": "meters", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.981, 1.634, 4.956]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side", "img-r7-front", "img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.981, 1.634, 4.956);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "\u667a\u754c R7 \u6574\u8f66";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "智界 R7 整车", "level": "macro", "role": "body", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "整车为组装体根节点，子件各自独立成型", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.981, "height": 1.634, "depth": 4.956, "units": "meters", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.981, 1.634, 4.956]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side", "img-r7-front", "img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_body_lower_1 = makeAttachmentEndpoint(null);
  const node_body_lower_1 = new THREE.Group();
  node_body_lower_1.name = "\u8f66\u8eab\u4e0b\u534a\u58f3\u4f53__pivot";
  node_body_lower_1.scale.set(1, 1, 1);
  if (endpoint_body_lower_1) {
    node_body_lower_1.position.copy(endpoint_body_lower_1.start);
    node_body_lower_1.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_body_lower_1.position.set(0.965, 0.0, 0.0);
    node_body_lower_1.rotation.set(0.0, -1.5708, 0.0);
  }
  node_body_lower_1.userData.sculptComponent = {"id": "body-lower", "name": "车身下半壳体", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "连续侧视轮廓单壳挤出，一次性表达机盖肩线/腰线/轮拱开口/尾臀线", "geometryDescriptor": {"profile2D": {"points": [[2.3, 0.18], [2.36, 0.196], [2.4, 0.29], [2.412, 0.44], [2.404, 0.62], [2.384, 0.762], [2.348, 0.88], [2.298, 0.93], [2.15, 0.975], [1.7, 1.008], [1.1, 1.042], [0.86, 1.074], [0.3, 1.089], [-0.9, 1.093], [-1.6, 1.091], [-2.05, 1.076], [-2.28, 1.048], [-2.38, 1.0], [-2.42, 0.93], [-2.42, 0.56], [-2.4, 0.44], [-2.355, 0.33], [-2.3, 0.255], [-2.23, 0.2], [-2.15, 0.18], [-1.86312, 0.18], [-1.86312, 0.18], [-1.90873, 0.32197], [-1.90407, 0.47102], [-1.84967, 0.60986], [-1.75185, 0.72241], [-1.62194, 0.79562], [-1.475, 0.821], [-1.32806, 0.79562], [-1.19815, 0.72241], [-1.10033, 0.60986], [-1.04593, 0.47102], [-1.04127, 0.32197], [-1.08688, 0.18], [-1.08688, 0.18], [1.08688, 0.18], [1.08688, 0.18], [1.04127, 0.32197], [1.04593, 0.47102], [1.10033, 0.60986], [1.19815, 0.72241], [1.32806, 0.79562], [1.475, 0.821], [1.62194, 0.79562], [1.75185, 0.72241], [1.84967, 0.60986], [1.90407, 0.47102], [1.90873, 0.32197], [1.86312, 0.18], [1.86312, 0.18], [2.23, 0.18]], "depth": 1.93, "bevel": {"thickness": 0.006, "size": 0.02, "offset": -0.02, "segments": 3}, "shaping": {"space": "side", "waistBulge": {"yCenter": 0.55, "ySpan": 0.5, "amount": 0.022}, "tumblehome": {"yBase": 0.8, "yTop": 1.1, "topScale": 0.98}, "planTaperNose": {"zFrom": 1.6, "zTo": 2.41, "amount": 0.03, "yGate": 1.12}, "planTaperTail": {"zFrom": -1.8, "zTo": -2.42, "amount": 0.03, "yGate": 1.12}}}, "topologyIntent": "lofted side-profile shell with true wheel-arch cutouts", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.93, "height": 0.93, "depth": 4.83, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.965, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-beltline-rise", "name": "腰线后扬", "kind": "contour", "note": "腰线 y 1.074@z0.86 → 1.093@z-0.9 → 1.076@z-2.05，后段微扬"}, {"id": "d-arch-cladding", "name": "轮拱真开口", "kind": "hole", "note": "前后轮拱按 r0.438 上半圆开挖，脚点落 y0.18 底边；开口边缘即车身钣金断面，无额外包边件（R17 用户要求去除）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side", "img-r7-rear"], "details": ["d-beltline-rise", "d-arch-cladding"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_body_lower_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_body_lower_1);
  nodes["body-lower"] = node_body_lower_1;
  const mesh_body_lower_1Geometry = endpoint_body_lower_1
    ? new THREE.CylinderGeometry(endpoint_body_lower_1.endRadius, endpoint_body_lower_1.baseRadius, endpoint_body_lower_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[2.3, 0.18], [2.36, 0.196], [2.4, 0.29], [2.412, 0.44], [2.404, 0.62], [2.384, 0.762], [2.348, 0.88], [2.298, 0.93], [2.15, 0.975], [1.7, 1.008], [1.1, 1.042], [0.86, 1.074], [0.3, 1.089], [-0.9, 1.093], [-1.6, 1.091], [-2.05, 1.076], [-2.28, 1.048], [-2.38, 1.0], [-2.42, 0.93], [-2.42, 0.56], [-2.4, 0.44], [-2.355, 0.33], [-2.3, 0.255], [-2.23, 0.2], [-2.15, 0.18], [-1.86312, 0.18], [-1.86312, 0.18], [-1.90873, 0.32197], [-1.90407, 0.47102], [-1.84967, 0.60986], [-1.75185, 0.72241], [-1.62194, 0.79562], [-1.475, 0.821], [-1.32806, 0.79562], [-1.19815, 0.72241], [-1.10033, 0.60986], [-1.04593, 0.47102], [-1.04127, 0.32197], [-1.08688, 0.18], [-1.08688, 0.18], [1.08688, 0.18], [1.08688, 0.18], [1.04127, 0.32197], [1.04593, 0.47102], [1.10033, 0.60986], [1.19815, 0.72241], [1.32806, 0.79562], [1.475, 0.821], [1.62194, 0.79562], [1.75185, 0.72241], [1.84967, 0.60986], [1.90407, 0.47102], [1.90873, 0.32197], [1.86312, 0.18], [1.86312, 0.18], [2.23, 0.18]], "depth": 1.93, "bevel": {"thickness": 0.006, "size": 0.02, "offset": -0.02, "segments": 3}, "shaping": {"space": "side", "waistBulge": {"yCenter": 0.55, "ySpan": 0.5, "amount": 0.022}, "tumblehome": {"yBase": 0.8, "yTop": 1.1, "topScale": 0.98}, "planTaperNose": {"zFrom": 1.6, "zTo": 2.41, "amount": 0.03, "yGate": 1.12}, "planTaperTail": {"zFrom": -1.8, "zTo": -2.42, "amount": 0.03, "yGate": 1.12}}});
  if (!endpoint_body_lower_1) {
    mesh_body_lower_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_lower_1 = new THREE.Mesh(
    mesh_body_lower_1Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_lower_1.name = "\u8f66\u8eab\u4e0b\u534a\u58f3\u4f53";
  if (endpoint_body_lower_1) {
    mesh_body_lower_1.position.copy(endpoint_body_lower_1.midpoint);
    mesh_body_lower_1.quaternion.copy(endpoint_body_lower_1.quaternion);
  }
  mesh_body_lower_1.castShadow = options.castShadow ?? true;
  mesh_body_lower_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_lower_1.userData.sculptComponent = {"id": "body-lower", "name": "车身下半壳体", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "连续侧视轮廓单壳挤出，一次性表达机盖肩线/腰线/轮拱开口/尾臀线", "geometryDescriptor": {"profile2D": {"points": [[2.3, 0.18], [2.36, 0.196], [2.4, 0.29], [2.412, 0.44], [2.404, 0.62], [2.384, 0.762], [2.348, 0.88], [2.298, 0.93], [2.15, 0.975], [1.7, 1.008], [1.1, 1.042], [0.86, 1.074], [0.3, 1.089], [-0.9, 1.093], [-1.6, 1.091], [-2.05, 1.076], [-2.28, 1.048], [-2.38, 1.0], [-2.42, 0.93], [-2.42, 0.56], [-2.4, 0.44], [-2.355, 0.33], [-2.3, 0.255], [-2.23, 0.2], [-2.15, 0.18], [-1.86312, 0.18], [-1.86312, 0.18], [-1.90873, 0.32197], [-1.90407, 0.47102], [-1.84967, 0.60986], [-1.75185, 0.72241], [-1.62194, 0.79562], [-1.475, 0.821], [-1.32806, 0.79562], [-1.19815, 0.72241], [-1.10033, 0.60986], [-1.04593, 0.47102], [-1.04127, 0.32197], [-1.08688, 0.18], [-1.08688, 0.18], [1.08688, 0.18], [1.08688, 0.18], [1.04127, 0.32197], [1.04593, 0.47102], [1.10033, 0.60986], [1.19815, 0.72241], [1.32806, 0.79562], [1.475, 0.821], [1.62194, 0.79562], [1.75185, 0.72241], [1.84967, 0.60986], [1.90407, 0.47102], [1.90873, 0.32197], [1.86312, 0.18], [1.86312, 0.18], [2.23, 0.18]], "depth": 1.93, "bevel": {"thickness": 0.006, "size": 0.02, "offset": -0.02, "segments": 3}, "shaping": {"space": "side", "waistBulge": {"yCenter": 0.55, "ySpan": 0.5, "amount": 0.022}, "tumblehome": {"yBase": 0.8, "yTop": 1.1, "topScale": 0.98}, "planTaperNose": {"zFrom": 1.6, "zTo": 2.41, "amount": 0.03, "yGate": 1.12}, "planTaperTail": {"zFrom": -1.8, "zTo": -2.42, "amount": 0.03, "yGate": 1.12}}}, "topologyIntent": "lofted side-profile shell with true wheel-arch cutouts", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.93, "height": 0.93, "depth": 4.83, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.965, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-beltline-rise", "name": "腰线后扬", "kind": "contour", "note": "腰线 y 1.074@z0.86 → 1.093@z-0.9 → 1.076@z-2.05，后段微扬"}, {"id": "d-arch-cladding", "name": "轮拱真开口", "kind": "hole", "note": "前后轮拱按 r0.438 上半圆开挖，脚点落 y0.18 底边；开口边缘即车身钣金断面，无额外包边件（R17 用户要求去除）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side", "img-r7-rear"], "details": ["d-beltline-rise", "d-arch-cladding"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_body_lower_1.add(mesh_body_lower_1);
  meshes["body-lower"] = mesh_body_lower_1;
  colliders["body-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_body_lower_1);

  const endpoint_hood_2 = makeAttachmentEndpoint(null);
  const node_hood_2 = new THREE.Group();
  node_hood_2.name = "\u673a\u76d6\u677f__pivot";
  node_hood_2.scale.set(1, 1, 1);
  if (endpoint_hood_2) {
    node_hood_2.position.copy(endpoint_hood_2.start);
    node_hood_2.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_hood_2.position.set(0.71, 0.0, 0.0);
    node_hood_2.rotation.set(0.0, -1.5708, 0.0);
  }
  node_hood_2.userData.sculptComponent = {"id": "hood", "name": "机盖板", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视薄楔板挤出，机盖前倾 3.4°，两端 20mm 收边", "geometryDescriptor": {"profile2D": {"points": [[1.02, 1.004], [1.58, 0.976], [2.06, 0.936], [2.3, 0.9], [2.36, 0.905], [2.372, 0.952], [2.33, 0.962], [2.1, 0.988], [1.6, 1.022], [1.02, 1.048]], "depth": 1.42, "bevel": {"thickness": 0.006, "size": 0.014, "offset": -0.014, "segments": 2}}, "topologyIntent": "hood panel slab following the nose-to-cowl fall", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.014, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.42, "height": 0.15, "depth": 1.39, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.71, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-hood-cutline", "name": "机盖分缝", "kind": "seam", "note": "机盖后缘 y1.048 与风挡下沿留 8mm 分缝"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": ["d-hood-cutline"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_hood_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_hood_2);
  nodes["hood"] = node_hood_2;
  const mesh_hood_2Geometry = endpoint_hood_2
    ? new THREE.CylinderGeometry(endpoint_hood_2.endRadius, endpoint_hood_2.baseRadius, endpoint_hood_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[1.02, 1.004], [1.58, 0.976], [2.06, 0.936], [2.3, 0.9], [2.36, 0.905], [2.372, 0.952], [2.33, 0.962], [2.1, 0.988], [1.6, 1.022], [1.02, 1.048]], "depth": 1.42, "bevel": {"thickness": 0.006, "size": 0.014, "offset": -0.014, "segments": 2}});
  if (!endpoint_hood_2) {
    mesh_hood_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hood_2 = new THREE.Mesh(
    mesh_hood_2Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hood_2.name = "\u673a\u76d6\u677f";
  if (endpoint_hood_2) {
    mesh_hood_2.position.copy(endpoint_hood_2.midpoint);
    mesh_hood_2.quaternion.copy(endpoint_hood_2.quaternion);
  }
  mesh_hood_2.castShadow = options.castShadow ?? true;
  mesh_hood_2.receiveShadow = options.receiveShadow ?? true;
  mesh_hood_2.userData.sculptComponent = {"id": "hood", "name": "机盖板", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视薄楔板挤出，机盖前倾 3.4°，两端 20mm 收边", "geometryDescriptor": {"profile2D": {"points": [[1.02, 1.004], [1.58, 0.976], [2.06, 0.936], [2.3, 0.9], [2.36, 0.905], [2.372, 0.952], [2.33, 0.962], [2.1, 0.988], [1.6, 1.022], [1.02, 1.048]], "depth": 1.42, "bevel": {"thickness": 0.006, "size": 0.014, "offset": -0.014, "segments": 2}}, "topologyIntent": "hood panel slab following the nose-to-cowl fall", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.014, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.42, "height": 0.15, "depth": 1.39, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.71, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-hood-cutline", "name": "机盖分缝", "kind": "seam", "note": "机盖后缘 y1.048 与风挡下沿留 8mm 分缝"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": ["d-hood-cutline"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_hood_2.add(mesh_hood_2);
  meshes["hood"] = mesh_hood_2;
  colliders["hood"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_hood_2);

  const endpoint_front_fascia_3 = makeAttachmentEndpoint(null);
  const node_front_fascia_3 = new THREE.Group();
  node_front_fascia_3.name = "\u524d\u8138\u4e3b\u4f53\uff08\u4fdd\u9669\u6760\u7f69\uff09__pivot";
  node_front_fascia_3.scale.set(1, 1, 1);
  if (endpoint_front_fascia_3) {
    node_front_fascia_3.position.copy(endpoint_front_fascia_3.start);
    node_front_fascia_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_fascia_3.position.set(0.0, 0.64, 2.398);
    node_front_fascia_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_fascia_3.userData.sculptComponent = {"id": "front-fascia", "name": "前脸主体（保险杠罩）", "level": "meso", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "正视圆角矩形沿 +Z 挤出的保险杠罩，与车身前缘 2.412 齐平", "geometryDescriptor": {"profile2D": {"points": [[0.83, -0.43], [0.86827, -0.42239], [0.90071, -0.40071], [0.92239, -0.36827], [0.93, -0.33], [0.93, 0.33], [0.92239, 0.36827], [0.90071, 0.40071], [0.86827, 0.42239], [0.83, 0.43], [-0.83, 0.43], [-0.86827, 0.42239], [-0.90071, 0.40071], [-0.92239, 0.36827], [-0.93, 0.33], [-0.93, -0.33], [-0.92239, -0.36827], [-0.90071, -0.40071], [-0.86827, -0.42239], [-0.83, -0.43]], "depth": 0.08, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "rounded-rect bumper cover extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 0.86, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.64, 2.398], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-front-blade", "name": "贯穿镀铬饰条", "kind": "linework", "note": "y0.86 全宽 1.72 的镀铬横条，与两侧大灯灯带同高"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-front-blade"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_front_fascia_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_fascia_3);
  nodes["front-fascia"] = node_front_fascia_3;
  const mesh_front_fascia_3Geometry = endpoint_front_fascia_3
    ? new THREE.CylinderGeometry(endpoint_front_fascia_3.endRadius, endpoint_front_fascia_3.baseRadius, endpoint_front_fascia_3.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.83, -0.43], [0.86827, -0.42239], [0.90071, -0.40071], [0.92239, -0.36827], [0.93, -0.33], [0.93, 0.33], [0.92239, 0.36827], [0.90071, 0.40071], [0.86827, 0.42239], [0.83, 0.43], [-0.83, 0.43], [-0.86827, 0.42239], [-0.90071, 0.40071], [-0.92239, 0.36827], [-0.93, 0.33], [-0.93, -0.33], [-0.92239, -0.36827], [-0.90071, -0.40071], [-0.86827, -0.42239], [-0.83, -0.43]], "depth": 0.08, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}});
  if (!endpoint_front_fascia_3) {
    mesh_front_fascia_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_front_fascia_3 = new THREE.Mesh(
    mesh_front_fascia_3Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_fascia_3.name = "\u524d\u8138\u4e3b\u4f53\uff08\u4fdd\u9669\u6760\u7f69\uff09";
  if (endpoint_front_fascia_3) {
    mesh_front_fascia_3.position.copy(endpoint_front_fascia_3.midpoint);
    mesh_front_fascia_3.quaternion.copy(endpoint_front_fascia_3.quaternion);
  }
  mesh_front_fascia_3.castShadow = options.castShadow ?? true;
  mesh_front_fascia_3.receiveShadow = options.receiveShadow ?? true;
  mesh_front_fascia_3.userData.sculptComponent = {"id": "front-fascia", "name": "前脸主体（保险杠罩）", "level": "meso", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "正视圆角矩形沿 +Z 挤出的保险杠罩，与车身前缘 2.412 齐平", "geometryDescriptor": {"profile2D": {"points": [[0.83, -0.43], [0.86827, -0.42239], [0.90071, -0.40071], [0.92239, -0.36827], [0.93, -0.33], [0.93, 0.33], [0.92239, 0.36827], [0.90071, 0.40071], [0.86827, 0.42239], [0.83, 0.43], [-0.83, 0.43], [-0.86827, 0.42239], [-0.90071, 0.40071], [-0.92239, 0.36827], [-0.93, 0.33], [-0.93, -0.33], [-0.92239, -0.36827], [-0.90071, -0.40071], [-0.86827, -0.42239], [-0.83, -0.43]], "depth": 0.08, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "rounded-rect bumper cover extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 0.86, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.64, 2.398], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-front-blade", "name": "贯穿镀铬饰条", "kind": "linework", "note": "y0.86 全宽 1.72 的镀铬横条，与两侧大灯灯带同高"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-front-blade"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_front_fascia_3.add(mesh_front_fascia_3);
  meshes["front-fascia"] = mesh_front_fascia_3;
  colliders["front-fascia"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_fascia_3);

  const endpoint_headlamp_l_4 = makeAttachmentEndpoint(null);
  const node_headlamp_l_4 = new THREE.Group();
  node_headlamp_l_4.name = "C \u5f62\u5927\u706f\u603b\u6210\uff08\u5de6\uff09__pivot";
  node_headlamp_l_4.scale.set(1, 1, 1);
  if (endpoint_headlamp_l_4) {
    node_headlamp_l_4.position.copy(endpoint_headlamp_l_4.start);
    node_headlamp_l_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_l_4.position.set(0.635, 0.862, 2.436);
    node_headlamp_l_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_l_4.userData.sculptComponent = {"id": "headlamp-l", "name": "C 形大灯总成（左）", "level": "meso", "role": "lamp", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "灯罩为细长楔形轮廓挤出，内端收窄以贴合贯穿饰条", "geometryDescriptor": {"profile2D": {"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "tapered lamp housing extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.135, "depth": 0.055, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.635, 0.862, 2.436], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-headlamp-c"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_l_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_l_4);
  nodes["headlamp-l"] = node_headlamp_l_4;
  const mesh_headlamp_l_4Geometry = endpoint_headlamp_l_4
    ? new THREE.CylinderGeometry(endpoint_headlamp_l_4.endRadius, endpoint_headlamp_l_4.baseRadius, endpoint_headlamp_l_4.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_headlamp_l_4) {
    mesh_headlamp_l_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_headlamp_l_4 = new THREE.Mesh(
    mesh_headlamp_l_4Geometry,
    materialMap["housing-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_l_4.name = "C \u5f62\u5927\u706f\u603b\u6210\uff08\u5de6\uff09";
  if (endpoint_headlamp_l_4) {
    mesh_headlamp_l_4.position.copy(endpoint_headlamp_l_4.midpoint);
    mesh_headlamp_l_4.quaternion.copy(endpoint_headlamp_l_4.quaternion);
  }
  mesh_headlamp_l_4.castShadow = options.castShadow ?? true;
  mesh_headlamp_l_4.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_l_4.userData.sculptComponent = {"id": "headlamp-l", "name": "C 形大灯总成（左）", "level": "meso", "role": "lamp", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "灯罩为细长楔形轮廓挤出，内端收窄以贴合贯穿饰条", "geometryDescriptor": {"profile2D": {"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "tapered lamp housing extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.135, "depth": 0.055, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.635, 0.862, 2.436], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-headlamp-c"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_l_4.add(mesh_headlamp_l_4);
  meshes["headlamp-l"] = mesh_headlamp_l_4;
  colliders["headlamp-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_l_4);

  const endpoint_drl_strip_l_5 = makeAttachmentEndpoint(null);
  const node_drl_strip_l_5 = new THREE.Group();
  node_drl_strip_l_5.name = "\u65e5\u884c\u706f\u5e26\uff08\u5de6\uff09__pivot";
  node_drl_strip_l_5.scale.set(1, 1, 1);
  if (endpoint_drl_strip_l_5) {
    node_drl_strip_l_5.position.copy(endpoint_drl_strip_l_5.start);
    node_drl_strip_l_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_drl_strip_l_5.position.set(0.64, 0.792, 2.452);
    node_drl_strip_l_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_drl_strip_l_5.userData.sculptComponent = {"id": "drl-strip-l", "name": "日行灯带（左）", "level": "micro", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.4, "height": 0.013, "depth": 0.016, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.64, 0.792, 2.452], "rotation": [0, 0, 0], "scale": [0.4, 0.013, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-drl-l", "name": "下沿细长光带", "kind": "emissive", "note": "大灯下沿 0.40m 白光带，与贯穿饰条一起构成本车前脸识别点"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_drl_strip_l_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_drl_strip_l_5);
  nodes["drl-strip-l"] = node_drl_strip_l_5;
  const mesh_drl_strip_l_5Geometry = endpoint_drl_strip_l_5
    ? new THREE.CylinderGeometry(endpoint_drl_strip_l_5.endRadius, endpoint_drl_strip_l_5.baseRadius, endpoint_drl_strip_l_5.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_drl_strip_l_5) {
    mesh_drl_strip_l_5Geometry.scale(0.4, 0.013, 0.016);
  }
  const mesh_drl_strip_l_5 = new THREE.Mesh(
    mesh_drl_strip_l_5Geometry,
    materialMap["lamp-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_drl_strip_l_5.name = "\u65e5\u884c\u706f\u5e26\uff08\u5de6\uff09";
  if (endpoint_drl_strip_l_5) {
    mesh_drl_strip_l_5.position.copy(endpoint_drl_strip_l_5.midpoint);
    mesh_drl_strip_l_5.quaternion.copy(endpoint_drl_strip_l_5.quaternion);
  }
  mesh_drl_strip_l_5.castShadow = options.castShadow ?? true;
  mesh_drl_strip_l_5.receiveShadow = options.receiveShadow ?? true;
  mesh_drl_strip_l_5.userData.sculptComponent = {"id": "drl-strip-l", "name": "日行灯带（左）", "level": "micro", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.4, "height": 0.013, "depth": 0.016, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.64, 0.792, 2.452], "rotation": [0, 0, 0], "scale": [0.4, 0.013, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-drl-l", "name": "下沿细长光带", "kind": "emissive", "note": "大灯下沿 0.40m 白光带，与贯穿饰条一起构成本车前脸识别点"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_drl_strip_l_5.add(mesh_drl_strip_l_5);
  meshes["drl-strip-l"] = mesh_drl_strip_l_5;
  colliders["drl-strip-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_drl_strip_l_5);

  const endpoint_headlamp_projector_1_l_6 = makeAttachmentEndpoint(null);
  const node_headlamp_projector_1_l_6 = new THREE.Group();
  node_headlamp_projector_1_l_6.name = "\u5927\u706f\u6295\u5f71\u955c\u82af1\uff08\u5de6\uff09__pivot";
  node_headlamp_projector_1_l_6.scale.set(1, 1, 1);
  if (endpoint_headlamp_projector_1_l_6) {
    node_headlamp_projector_1_l_6.position.copy(endpoint_headlamp_projector_1_l_6.start);
    node_headlamp_projector_1_l_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_projector_1_l_6.position.set(0.52, 0.872, 2.462);
    node_headlamp_projector_1_l_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_projector_1_l_6.userData.sculptComponent = {"id": "headlamp-projector-1-l", "name": "大灯投影镜芯1（左）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.52, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-l", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_1_l_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_projector_1_l_6);
  nodes["headlamp-projector-1-l"] = node_headlamp_projector_1_l_6;
  const mesh_headlamp_projector_1_l_6Geometry = endpoint_headlamp_projector_1_l_6
    ? new THREE.CylinderGeometry(endpoint_headlamp_projector_1_l_6.endRadius, endpoint_headlamp_projector_1_l_6.baseRadius, endpoint_headlamp_projector_1_l_6.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headlamp_projector_1_l_6) {
    mesh_headlamp_projector_1_l_6Geometry.scale(0.062, 0.048, 0.026);
  }
  const mesh_headlamp_projector_1_l_6 = new THREE.Mesh(
    mesh_headlamp_projector_1_l_6Geometry,
    materialMap["lamp-head"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_projector_1_l_6.name = "\u5927\u706f\u6295\u5f71\u955c\u82af1\uff08\u5de6\uff09";
  if (endpoint_headlamp_projector_1_l_6) {
    mesh_headlamp_projector_1_l_6.position.copy(endpoint_headlamp_projector_1_l_6.midpoint);
    mesh_headlamp_projector_1_l_6.quaternion.copy(endpoint_headlamp_projector_1_l_6.quaternion);
  }
  mesh_headlamp_projector_1_l_6.castShadow = options.castShadow ?? true;
  mesh_headlamp_projector_1_l_6.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_projector_1_l_6.userData.sculptComponent = {"id": "headlamp-projector-1-l", "name": "大灯投影镜芯1（左）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.52, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-l", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_1_l_6.add(mesh_headlamp_projector_1_l_6);
  meshes["headlamp-projector-1-l"] = mesh_headlamp_projector_1_l_6;
  colliders["headlamp-projector-1-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_projector_1_l_6);

  const endpoint_headlamp_projector_2_l_7 = makeAttachmentEndpoint(null);
  const node_headlamp_projector_2_l_7 = new THREE.Group();
  node_headlamp_projector_2_l_7.name = "\u5927\u706f\u6295\u5f71\u955c\u82af2\uff08\u5de6\uff09__pivot";
  node_headlamp_projector_2_l_7.scale.set(1, 1, 1);
  if (endpoint_headlamp_projector_2_l_7) {
    node_headlamp_projector_2_l_7.position.copy(endpoint_headlamp_projector_2_l_7.start);
    node_headlamp_projector_2_l_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_projector_2_l_7.position.set(0.608, 0.872, 2.462);
    node_headlamp_projector_2_l_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_projector_2_l_7.userData.sculptComponent = {"id": "headlamp-projector-2-l", "name": "大灯投影镜芯2（左）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.608, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-l", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_2_l_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_projector_2_l_7);
  nodes["headlamp-projector-2-l"] = node_headlamp_projector_2_l_7;
  const mesh_headlamp_projector_2_l_7Geometry = endpoint_headlamp_projector_2_l_7
    ? new THREE.CylinderGeometry(endpoint_headlamp_projector_2_l_7.endRadius, endpoint_headlamp_projector_2_l_7.baseRadius, endpoint_headlamp_projector_2_l_7.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headlamp_projector_2_l_7) {
    mesh_headlamp_projector_2_l_7Geometry.scale(0.062, 0.048, 0.026);
  }
  const mesh_headlamp_projector_2_l_7 = new THREE.Mesh(
    mesh_headlamp_projector_2_l_7Geometry,
    materialMap["lamp-head"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_projector_2_l_7.name = "\u5927\u706f\u6295\u5f71\u955c\u82af2\uff08\u5de6\uff09";
  if (endpoint_headlamp_projector_2_l_7) {
    mesh_headlamp_projector_2_l_7.position.copy(endpoint_headlamp_projector_2_l_7.midpoint);
    mesh_headlamp_projector_2_l_7.quaternion.copy(endpoint_headlamp_projector_2_l_7.quaternion);
  }
  mesh_headlamp_projector_2_l_7.castShadow = options.castShadow ?? true;
  mesh_headlamp_projector_2_l_7.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_projector_2_l_7.userData.sculptComponent = {"id": "headlamp-projector-2-l", "name": "大灯投影镜芯2（左）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.608, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-l", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_2_l_7.add(mesh_headlamp_projector_2_l_7);
  meshes["headlamp-projector-2-l"] = mesh_headlamp_projector_2_l_7;
  colliders["headlamp-projector-2-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_projector_2_l_7);

  const endpoint_headlamp_r_8 = makeAttachmentEndpoint(null);
  const node_headlamp_r_8 = new THREE.Group();
  node_headlamp_r_8.name = "C \u5f62\u5927\u706f\u603b\u6210\uff08\u53f3\uff09__pivot";
  node_headlamp_r_8.scale.set(1, 1, 1);
  if (endpoint_headlamp_r_8) {
    node_headlamp_r_8.position.copy(endpoint_headlamp_r_8.start);
    node_headlamp_r_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_r_8.position.set(-0.635, 0.862, 2.436);
    node_headlamp_r_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_r_8.userData.sculptComponent = {"id": "headlamp-r", "name": "C 形大灯总成（右）", "level": "meso", "role": "lamp", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "灯罩为细长楔形轮廓挤出，内端收窄以贴合贯穿饰条", "geometryDescriptor": {"profile2D": {"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "tapered lamp housing extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.135, "depth": 0.055, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.635, 0.862, 2.436], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-headlamp-c"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_r_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_r_8);
  nodes["headlamp-r"] = node_headlamp_r_8;
  const mesh_headlamp_r_8Geometry = endpoint_headlamp_r_8
    ? new THREE.CylinderGeometry(endpoint_headlamp_r_8.endRadius, endpoint_headlamp_r_8.baseRadius, endpoint_headlamp_r_8.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_headlamp_r_8) {
    mesh_headlamp_r_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_headlamp_r_8 = new THREE.Mesh(
    mesh_headlamp_r_8Geometry,
    materialMap["housing-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_r_8.name = "C \u5f62\u5927\u706f\u603b\u6210\uff08\u53f3\uff09";
  if (endpoint_headlamp_r_8) {
    mesh_headlamp_r_8.position.copy(endpoint_headlamp_r_8.midpoint);
    mesh_headlamp_r_8.quaternion.copy(endpoint_headlamp_r_8.quaternion);
  }
  mesh_headlamp_r_8.castShadow = options.castShadow ?? true;
  mesh_headlamp_r_8.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_r_8.userData.sculptComponent = {"id": "headlamp-r", "name": "C 形大灯总成（右）", "level": "meso", "role": "lamp", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "灯罩为细长楔形轮廓挤出，内端收窄以贴合贯穿饰条", "geometryDescriptor": {"profile2D": {"points": [[-0.2, -0.055], [-0.04, -0.062], [0.205, -0.04], [0.22, 0.02], [0.15, 0.048], [-0.06, 0.03], [-0.215, -0.03]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "tapered lamp housing extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.135, "depth": 0.055, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.635, 0.862, 2.436], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-headlamp-c"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_r_8.add(mesh_headlamp_r_8);
  meshes["headlamp-r"] = mesh_headlamp_r_8;
  colliders["headlamp-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_r_8);

  const endpoint_drl_strip_r_9 = makeAttachmentEndpoint(null);
  const node_drl_strip_r_9 = new THREE.Group();
  node_drl_strip_r_9.name = "\u65e5\u884c\u706f\u5e26\uff08\u53f3\uff09__pivot";
  node_drl_strip_r_9.scale.set(1, 1, 1);
  if (endpoint_drl_strip_r_9) {
    node_drl_strip_r_9.position.copy(endpoint_drl_strip_r_9.start);
    node_drl_strip_r_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_drl_strip_r_9.position.set(-0.64, 0.792, 2.452);
    node_drl_strip_r_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_drl_strip_r_9.userData.sculptComponent = {"id": "drl-strip-r", "name": "日行灯带（右）", "level": "micro", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.4, "height": 0.013, "depth": 0.016, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.64, 0.792, 2.452], "rotation": [0, 0, 0], "scale": [0.4, 0.013, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-drl-r", "name": "下沿细长光带", "kind": "emissive", "note": "大灯下沿 0.40m 白光带，与贯穿饰条一起构成本车前脸识别点"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_drl_strip_r_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_drl_strip_r_9);
  nodes["drl-strip-r"] = node_drl_strip_r_9;
  const mesh_drl_strip_r_9Geometry = endpoint_drl_strip_r_9
    ? new THREE.CylinderGeometry(endpoint_drl_strip_r_9.endRadius, endpoint_drl_strip_r_9.baseRadius, endpoint_drl_strip_r_9.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_drl_strip_r_9) {
    mesh_drl_strip_r_9Geometry.scale(0.4, 0.013, 0.016);
  }
  const mesh_drl_strip_r_9 = new THREE.Mesh(
    mesh_drl_strip_r_9Geometry,
    materialMap["lamp-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_drl_strip_r_9.name = "\u65e5\u884c\u706f\u5e26\uff08\u53f3\uff09";
  if (endpoint_drl_strip_r_9) {
    mesh_drl_strip_r_9.position.copy(endpoint_drl_strip_r_9.midpoint);
    mesh_drl_strip_r_9.quaternion.copy(endpoint_drl_strip_r_9.quaternion);
  }
  mesh_drl_strip_r_9.castShadow = options.castShadow ?? true;
  mesh_drl_strip_r_9.receiveShadow = options.receiveShadow ?? true;
  mesh_drl_strip_r_9.userData.sculptComponent = {"id": "drl-strip-r", "name": "日行灯带（右）", "level": "micro", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.4, "height": 0.013, "depth": 0.016, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.64, 0.792, 2.452], "rotation": [0, 0, 0], "scale": [0.4, 0.013, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-drl-r", "name": "下沿细长光带", "kind": "emissive", "note": "大灯下沿 0.40m 白光带，与贯穿饰条一起构成本车前脸识别点"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_drl_strip_r_9.add(mesh_drl_strip_r_9);
  meshes["drl-strip-r"] = mesh_drl_strip_r_9;
  colliders["drl-strip-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_drl_strip_r_9);

  const endpoint_headlamp_projector_1_r_10 = makeAttachmentEndpoint(null);
  const node_headlamp_projector_1_r_10 = new THREE.Group();
  node_headlamp_projector_1_r_10.name = "\u5927\u706f\u6295\u5f71\u955c\u82af1\uff08\u53f3\uff09__pivot";
  node_headlamp_projector_1_r_10.scale.set(1, 1, 1);
  if (endpoint_headlamp_projector_1_r_10) {
    node_headlamp_projector_1_r_10.position.copy(endpoint_headlamp_projector_1_r_10.start);
    node_headlamp_projector_1_r_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_projector_1_r_10.position.set(-0.52, 0.872, 2.462);
    node_headlamp_projector_1_r_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_projector_1_r_10.userData.sculptComponent = {"id": "headlamp-projector-1-r", "name": "大灯投影镜芯1（右）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.52, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-r", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_1_r_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_projector_1_r_10);
  nodes["headlamp-projector-1-r"] = node_headlamp_projector_1_r_10;
  const mesh_headlamp_projector_1_r_10Geometry = endpoint_headlamp_projector_1_r_10
    ? new THREE.CylinderGeometry(endpoint_headlamp_projector_1_r_10.endRadius, endpoint_headlamp_projector_1_r_10.baseRadius, endpoint_headlamp_projector_1_r_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headlamp_projector_1_r_10) {
    mesh_headlamp_projector_1_r_10Geometry.scale(0.062, 0.048, 0.026);
  }
  const mesh_headlamp_projector_1_r_10 = new THREE.Mesh(
    mesh_headlamp_projector_1_r_10Geometry,
    materialMap["lamp-head"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_projector_1_r_10.name = "\u5927\u706f\u6295\u5f71\u955c\u82af1\uff08\u53f3\uff09";
  if (endpoint_headlamp_projector_1_r_10) {
    mesh_headlamp_projector_1_r_10.position.copy(endpoint_headlamp_projector_1_r_10.midpoint);
    mesh_headlamp_projector_1_r_10.quaternion.copy(endpoint_headlamp_projector_1_r_10.quaternion);
  }
  mesh_headlamp_projector_1_r_10.castShadow = options.castShadow ?? true;
  mesh_headlamp_projector_1_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_projector_1_r_10.userData.sculptComponent = {"id": "headlamp-projector-1-r", "name": "大灯投影镜芯1（右）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.52, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-r", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_1_r_10.add(mesh_headlamp_projector_1_r_10);
  meshes["headlamp-projector-1-r"] = mesh_headlamp_projector_1_r_10;
  colliders["headlamp-projector-1-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_projector_1_r_10);

  const endpoint_headlamp_projector_2_r_11 = makeAttachmentEndpoint(null);
  const node_headlamp_projector_2_r_11 = new THREE.Group();
  node_headlamp_projector_2_r_11.name = "\u5927\u706f\u6295\u5f71\u955c\u82af2\uff08\u53f3\uff09__pivot";
  node_headlamp_projector_2_r_11.scale.set(1, 1, 1);
  if (endpoint_headlamp_projector_2_r_11) {
    node_headlamp_projector_2_r_11.position.copy(endpoint_headlamp_projector_2_r_11.start);
    node_headlamp_projector_2_r_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_projector_2_r_11.position.set(-0.608, 0.872, 2.462);
    node_headlamp_projector_2_r_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_projector_2_r_11.userData.sculptComponent = {"id": "headlamp-projector-2-r", "name": "大灯投影镜芯2（右）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.608, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-r", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_2_r_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_headlamp_projector_2_r_11);
  nodes["headlamp-projector-2-r"] = node_headlamp_projector_2_r_11;
  const mesh_headlamp_projector_2_r_11Geometry = endpoint_headlamp_projector_2_r_11
    ? new THREE.CylinderGeometry(endpoint_headlamp_projector_2_r_11.endRadius, endpoint_headlamp_projector_2_r_11.baseRadius, endpoint_headlamp_projector_2_r_11.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headlamp_projector_2_r_11) {
    mesh_headlamp_projector_2_r_11Geometry.scale(0.062, 0.048, 0.026);
  }
  const mesh_headlamp_projector_2_r_11 = new THREE.Mesh(
    mesh_headlamp_projector_2_r_11Geometry,
    materialMap["lamp-head"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_projector_2_r_11.name = "\u5927\u706f\u6295\u5f71\u955c\u82af2\uff08\u53f3\uff09";
  if (endpoint_headlamp_projector_2_r_11) {
    mesh_headlamp_projector_2_r_11.position.copy(endpoint_headlamp_projector_2_r_11.midpoint);
    mesh_headlamp_projector_2_r_11.quaternion.copy(endpoint_headlamp_projector_2_r_11.quaternion);
  }
  mesh_headlamp_projector_2_r_11.castShadow = options.castShadow ?? true;
  mesh_headlamp_projector_2_r_11.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_projector_2_r_11.userData.sculptComponent = {"id": "headlamp-projector-2-r", "name": "大灯投影镜芯2（右）", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.062, "height": 0.048, "depth": 0.026, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.608, 0.872, 2.462], "rotation": [0, 0, 0], "scale": [0.062, 0.048, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-head", "materialLayers": ["lamp-head"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-projector-r", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel", "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-projector-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 242, 255, 1.0)", "secondaryAlbedo": "rgba(234, 242, 255, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_headlamp_projector_2_r_11.add(mesh_headlamp_projector_2_r_11);
  meshes["headlamp-projector-2-r"] = mesh_headlamp_projector_2_r_11;
  colliders["headlamp-projector-2-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_projector_2_r_11);

  const endpoint_light_bar_front_12 = makeAttachmentEndpoint(null);
  const node_light_bar_front_12 = new THREE.Group();
  node_light_bar_front_12.name = "\u524d\u8d2f\u7a7f\u9970\u6761\uff08\u9540\u94ec\u6a2a\u5411\uff09__pivot";
  node_light_bar_front_12.scale.set(1, 1, 1);
  if (endpoint_light_bar_front_12) {
    node_light_bar_front_12.position.copy(endpoint_light_bar_front_12.start);
    node_light_bar_front_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_light_bar_front_12.position.set(0.0, 0.852, 2.454);
    node_light_bar_front_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_light_bar_front_12.userData.sculptComponent = {"id": "light-bar-front", "name": "前贯穿饰条（镀铬横向）", "level": "meso", "role": "trim", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.74, "height": 0.024, "depth": 0.02, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0.852, 2.454], "rotation": [0, 0, 0], "scale": [1.74, 0.024, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-full-width-blade", "name": "全宽镀铬横条", "kind": "linework", "note": "左右大灯之间一条通长镀铬饰条，参考正前视图最亮的一根横线"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": ["d-full-width-blade"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_light_bar_front_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_light_bar_front_12);
  nodes["light-bar-front"] = node_light_bar_front_12;
  const mesh_light_bar_front_12Geometry = endpoint_light_bar_front_12
    ? new THREE.CylinderGeometry(endpoint_light_bar_front_12.endRadius, endpoint_light_bar_front_12.baseRadius, endpoint_light_bar_front_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_light_bar_front_12) {
    mesh_light_bar_front_12Geometry.scale(1.74, 0.024, 0.02);
  }
  const mesh_light_bar_front_12 = new THREE.Mesh(
    mesh_light_bar_front_12Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_light_bar_front_12.name = "\u524d\u8d2f\u7a7f\u9970\u6761\uff08\u9540\u94ec\u6a2a\u5411\uff09";
  if (endpoint_light_bar_front_12) {
    mesh_light_bar_front_12.position.copy(endpoint_light_bar_front_12.midpoint);
    mesh_light_bar_front_12.quaternion.copy(endpoint_light_bar_front_12.quaternion);
  }
  mesh_light_bar_front_12.castShadow = options.castShadow ?? true;
  mesh_light_bar_front_12.receiveShadow = options.receiveShadow ?? true;
  mesh_light_bar_front_12.userData.sculptComponent = {"id": "light-bar-front", "name": "前贯穿饰条（镀铬横向）", "level": "meso", "role": "trim", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.74, "height": 0.024, "depth": 0.02, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0.852, 2.454], "rotation": [0, 0, 0], "scale": [1.74, 0.024, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-full-width-blade", "name": "全宽镀铬横条", "kind": "linework", "note": "左右大灯之间一条通长镀铬饰条，参考正前视图最亮的一根横线"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": ["d-full-width-blade"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_light_bar_front_12.add(mesh_light_bar_front_12);
  meshes["light-bar-front"] = mesh_light_bar_front_12;
  colliders["light-bar-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_light_bar_front_12);

  const endpoint_logo_shield_13 = makeAttachmentEndpoint(null);
  const node_logo_shield_13 = new THREE.Group();
  node_logo_shield_13.name = "\u8f66\u5934\u76fe\u5f62\u8f66\u6807\u5ea7__pivot";
  node_logo_shield_13.scale.set(1, 1, 1);
  if (endpoint_logo_shield_13) {
    node_logo_shield_13.position.copy(endpoint_logo_shield_13.start);
    node_logo_shield_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_logo_shield_13.position.set(0.0, 0.905, 2.462);
    node_logo_shield_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_logo_shield_13.userData.sculptComponent = {"id": "logo-shield", "name": "车头盾形车标座", "level": "micro", "role": "badge", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "盾形薄浮雕板，外轮廓 6 点 CCW", "geometryDescriptor": {"profile2D": {"points": [[-0.029, -0.012], [0.0, -0.049], [0.029, -0.012], [0.029, 0.049], [-0.029, 0.049]], "depth": 0.014, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "shield badge relief", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.058, "height": 0.098, "depth": 0.014, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.905, 2.462], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-shield-badge", "name": "盾形车标", "kind": "bevel", "note": "宽 5.8cm 高 9.8cm 的盾形座，内部菱格由适配层贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-shield-badge"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_logo_shield_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_logo_shield_13);
  nodes["logo-shield"] = node_logo_shield_13;
  const mesh_logo_shield_13Geometry = endpoint_logo_shield_13
    ? new THREE.CylinderGeometry(endpoint_logo_shield_13.endRadius, endpoint_logo_shield_13.baseRadius, endpoint_logo_shield_13.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.029, -0.012], [0.0, -0.049], [0.029, -0.012], [0.029, 0.049], [-0.029, 0.049]], "depth": 0.014, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_logo_shield_13) {
    mesh_logo_shield_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_logo_shield_13 = new THREE.Mesh(
    mesh_logo_shield_13Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_logo_shield_13.name = "\u8f66\u5934\u76fe\u5f62\u8f66\u6807\u5ea7";
  if (endpoint_logo_shield_13) {
    mesh_logo_shield_13.position.copy(endpoint_logo_shield_13.midpoint);
    mesh_logo_shield_13.quaternion.copy(endpoint_logo_shield_13.quaternion);
  }
  mesh_logo_shield_13.castShadow = options.castShadow ?? true;
  mesh_logo_shield_13.receiveShadow = options.receiveShadow ?? true;
  mesh_logo_shield_13.userData.sculptComponent = {"id": "logo-shield", "name": "车头盾形车标座", "level": "micro", "role": "badge", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "盾形薄浮雕板，外轮廓 6 点 CCW", "geometryDescriptor": {"profile2D": {"points": [[-0.029, -0.012], [0.0, -0.049], [0.029, -0.012], [0.029, 0.049], [-0.029, 0.049]], "depth": 0.014, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "shield badge relief", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.058, "height": 0.098, "depth": 0.014, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.905, 2.462], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-shield-badge", "name": "盾形车标", "kind": "bevel", "note": "宽 5.8cm 高 9.8cm 的盾形座，内部菱格由适配层贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-shield-badge"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_logo_shield_13.add(mesh_logo_shield_13);
  meshes["logo-shield"] = mesh_logo_shield_13;
  colliders["logo-shield"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_logo_shield_13);

  const endpoint_front_intake_14 = makeAttachmentEndpoint(null);
  const node_front_intake_14 = new THREE.Group();
  node_front_intake_14.name = "\u4e09\u6bb5\u5f0f\u4e0b\u8fdb\u6c14\u53e3__pivot";
  node_front_intake_14.scale.set(1, 1, 1);
  if (endpoint_front_intake_14) {
    node_front_intake_14.position.copy(endpoint_front_intake_14.start);
    node_front_intake_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_intake_14.position.set(0.0, 0.5, 2.428);
    node_front_intake_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_intake_14.userData.sculptComponent = {"id": "front-intake", "name": "三段式下进气口", "level": "meso", "role": "grille", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形沿 +Z 挤出 55mm 的黑色进气框", "geometryDescriptor": {"profile2D": {"points": [[0.61, -0.115], [0.62913, -0.11119], [0.64536, -0.10036], [0.65619, -0.08413], [0.66, -0.065], [0.66, 0.065], [0.65619, 0.08413], [0.64536, 0.10036], [0.62913, 0.11119], [0.61, 0.115], [-0.61, 0.115], [-0.62913, 0.11119], [-0.64536, 0.10036], [-0.65619, 0.08413], [-0.66, 0.065], [-0.66, -0.065], [-0.65619, -0.08413], [-0.64536, -0.10036], [-0.62913, -0.11119], [-0.61, -0.115]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "lower intake frame", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.32, "height": 0.23, "depth": 0.055, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.5, 2.428], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-intake-three-part", "name": "三段式进气分隔", "kind": "groove", "note": "中部横梁 + 两侧竖向鳍片把进气口切成三段；R17 收窄至 23cm 高并上移，为下方牌照位让位"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-intake-three-part"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_intake_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_intake_14);
  nodes["front-intake"] = node_front_intake_14;
  const mesh_front_intake_14Geometry = endpoint_front_intake_14
    ? new THREE.CylinderGeometry(endpoint_front_intake_14.endRadius, endpoint_front_intake_14.baseRadius, endpoint_front_intake_14.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.61, -0.115], [0.62913, -0.11119], [0.64536, -0.10036], [0.65619, -0.08413], [0.66, -0.065], [0.66, 0.065], [0.65619, 0.08413], [0.64536, 0.10036], [0.62913, 0.11119], [0.61, 0.115], [-0.61, 0.115], [-0.62913, 0.11119], [-0.64536, 0.10036], [-0.65619, 0.08413], [-0.66, 0.065], [-0.66, -0.065], [-0.65619, -0.08413], [-0.64536, -0.10036], [-0.62913, -0.11119], [-0.61, -0.115]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}});
  if (!endpoint_front_intake_14) {
    mesh_front_intake_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_front_intake_14 = new THREE.Mesh(
    mesh_front_intake_14Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_intake_14.name = "\u4e09\u6bb5\u5f0f\u4e0b\u8fdb\u6c14\u53e3";
  if (endpoint_front_intake_14) {
    mesh_front_intake_14.position.copy(endpoint_front_intake_14.midpoint);
    mesh_front_intake_14.quaternion.copy(endpoint_front_intake_14.quaternion);
  }
  mesh_front_intake_14.castShadow = options.castShadow ?? true;
  mesh_front_intake_14.receiveShadow = options.receiveShadow ?? true;
  mesh_front_intake_14.userData.sculptComponent = {"id": "front-intake", "name": "三段式下进气口", "level": "meso", "role": "grille", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形沿 +Z 挤出 55mm 的黑色进气框", "geometryDescriptor": {"profile2D": {"points": [[0.61, -0.115], [0.62913, -0.11119], [0.64536, -0.10036], [0.65619, -0.08413], [0.66, -0.065], [0.66, 0.065], [0.65619, 0.08413], [0.64536, 0.10036], [0.62913, 0.11119], [0.61, 0.115], [-0.61, 0.115], [-0.62913, 0.11119], [-0.64536, 0.10036], [-0.65619, 0.08413], [-0.66, 0.065], [-0.66, -0.065], [-0.65619, -0.08413], [-0.64536, -0.10036], [-0.62913, -0.11119], [-0.61, -0.115]], "depth": 0.055, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "lower intake frame", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.32, "height": 0.23, "depth": 0.055, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.5, 2.428], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-intake-three-part", "name": "三段式进气分隔", "kind": "groove", "note": "中部横梁 + 两侧竖向鳍片把进气口切成三段；R17 收窄至 23cm 高并上移，为下方牌照位让位"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-intake-three-part"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_intake_14.add(mesh_front_intake_14);
  meshes["front-intake"] = mesh_front_intake_14;
  colliders["front-intake"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_intake_14);

  const endpoint_duct_l_15 = makeAttachmentEndpoint(null);
  const node_duct_l_15 = new THREE.Group();
  node_duct_l_15.name = "\u4fa7\u5bfc\u6d41\u53e3\uff08\u5de6\uff09__pivot";
  node_duct_l_15.scale.set(1, 1, 1);
  if (endpoint_duct_l_15) {
    node_duct_l_15.position.copy(endpoint_duct_l_15.start);
    node_duct_l_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_duct_l_15.position.set(0.845, 0.6, 2.43);
    node_duct_l_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_duct_l_15.userData.sculptComponent = {"id": "duct-l", "name": "侧导流口（左）", "level": "meso", "role": "grille", "importance": 0.8, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖向圆角长孔沿 +Z 挤出的侧导流槽", "geometryDescriptor": {"profile2D": {"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "air curtain duct", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.13, "height": 0.3, "depth": 0.05, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.845, 0.6, 2.43], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_duct_l_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_duct_l_15);
  nodes["duct-l"] = node_duct_l_15;
  const mesh_duct_l_15Geometry = endpoint_duct_l_15
    ? new THREE.CylinderGeometry(endpoint_duct_l_15.endRadius, endpoint_duct_l_15.baseRadius, endpoint_duct_l_15.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_duct_l_15) {
    mesh_duct_l_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_duct_l_15 = new THREE.Mesh(
    mesh_duct_l_15Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_duct_l_15.name = "\u4fa7\u5bfc\u6d41\u53e3\uff08\u5de6\uff09";
  if (endpoint_duct_l_15) {
    mesh_duct_l_15.position.copy(endpoint_duct_l_15.midpoint);
    mesh_duct_l_15.quaternion.copy(endpoint_duct_l_15.quaternion);
  }
  mesh_duct_l_15.castShadow = options.castShadow ?? true;
  mesh_duct_l_15.receiveShadow = options.receiveShadow ?? true;
  mesh_duct_l_15.userData.sculptComponent = {"id": "duct-l", "name": "侧导流口（左）", "level": "meso", "role": "grille", "importance": 0.8, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖向圆角长孔沿 +Z 挤出的侧导流槽", "geometryDescriptor": {"profile2D": {"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "air curtain duct", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.13, "height": 0.3, "depth": 0.05, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.845, 0.6, 2.43], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_duct_l_15.add(mesh_duct_l_15);
  meshes["duct-l"] = mesh_duct_l_15;
  colliders["duct-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_duct_l_15);

  const endpoint_duct_r_16 = makeAttachmentEndpoint(null);
  const node_duct_r_16 = new THREE.Group();
  node_duct_r_16.name = "\u4fa7\u5bfc\u6d41\u53e3\uff08\u53f3\uff09__pivot";
  node_duct_r_16.scale.set(1, 1, 1);
  if (endpoint_duct_r_16) {
    node_duct_r_16.position.copy(endpoint_duct_r_16.start);
    node_duct_r_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_duct_r_16.position.set(-0.845, 0.6, 2.43);
    node_duct_r_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_duct_r_16.userData.sculptComponent = {"id": "duct-r", "name": "侧导流口（右）", "level": "meso", "role": "grille", "importance": 0.8, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖向圆角长孔沿 +Z 挤出的侧导流槽", "geometryDescriptor": {"profile2D": {"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "air curtain duct", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.13, "height": 0.3, "depth": 0.05, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.845, 0.6, 2.43], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_duct_r_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_duct_r_16);
  nodes["duct-r"] = node_duct_r_16;
  const mesh_duct_r_16Geometry = endpoint_duct_r_16
    ? new THREE.CylinderGeometry(endpoint_duct_r_16.endRadius, endpoint_duct_r_16.baseRadius, endpoint_duct_r_16.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_duct_r_16) {
    mesh_duct_r_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_duct_r_16 = new THREE.Mesh(
    mesh_duct_r_16Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_duct_r_16.name = "\u4fa7\u5bfc\u6d41\u53e3\uff08\u53f3\uff09";
  if (endpoint_duct_r_16) {
    mesh_duct_r_16.position.copy(endpoint_duct_r_16.midpoint);
    mesh_duct_r_16.quaternion.copy(endpoint_duct_r_16.quaternion);
  }
  mesh_duct_r_16.castShadow = options.castShadow ?? true;
  mesh_duct_r_16.receiveShadow = options.receiveShadow ?? true;
  mesh_duct_r_16.userData.sculptComponent = {"id": "duct-r", "name": "侧导流口（右）", "level": "meso", "role": "grille", "importance": 0.8, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖向圆角长孔沿 +Z 挤出的侧导流槽", "geometryDescriptor": {"profile2D": {"points": [[0.02, -0.15], [0.03722, -0.14657], [0.05182, -0.13682], [0.06157, -0.12222], [0.065, -0.105], [0.065, 0.105], [0.06157, 0.12222], [0.05182, 0.13682], [0.03722, 0.14657], [0.02, 0.15], [-0.02, 0.15], [-0.03722, 0.14657], [-0.05182, 0.13682], [-0.06157, 0.12222], [-0.065, 0.105], [-0.065, -0.105], [-0.06157, -0.12222], [-0.05182, -0.13682], [-0.03722, -0.14657], [-0.02, -0.15]], "depth": 0.05, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "air curtain duct", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.13, "height": 0.3, "depth": 0.05, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.845, 0.6, 2.43], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_duct_r_16.add(mesh_duct_r_16);
  meshes["duct-r"] = mesh_duct_r_16;
  colliders["duct-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_duct_r_16);

  const endpoint_front_plate_17 = makeAttachmentEndpoint(null);
  const node_front_plate_17 = new THREE.Group();
  node_front_plate_17.name = "\u524d\u724c\u7167\u677f\uff08\u667a\u754c R7\uff09__pivot";
  node_front_plate_17.scale.set(1, 1, 1);
  if (endpoint_front_plate_17) {
    node_front_plate_17.position.copy(endpoint_front_plate_17.start);
    node_front_plate_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_plate_17.position.set(0.0, 0.295, 2.47);
    node_front_plate_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_plate_17.userData.sculptComponent = {"id": "front-plate", "name": "前牌照板（智界 R7）", "level": "micro", "role": "badge", "importance": 0.7, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.13, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.295, 2.47], "rotation": [0, 0, 0], "scale": [0.44, 0.13, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate", "materialLayers": ["plate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-plate-text", "name": "牌照字样", "kind": "decal", "note": "「智界 R7」由适配层 Canvas 绘制；R17 复位至下进气口下方（原位置被进气口实体掩埋）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-plate-text"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 29, 34, 1.0)", "secondaryAlbedo": "rgba(26, 29, 34, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_plate_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_plate_17);
  nodes["front-plate"] = node_front_plate_17;
  const mesh_front_plate_17Geometry = endpoint_front_plate_17
    ? new THREE.CylinderGeometry(endpoint_front_plate_17.endRadius, endpoint_front_plate_17.baseRadius, endpoint_front_plate_17.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_front_plate_17) {
    mesh_front_plate_17Geometry.scale(0.44, 0.13, 0.004);
  }
  const mesh_front_plate_17 = new THREE.Mesh(
    mesh_front_plate_17Geometry,
    materialMap["plate"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_plate_17.name = "\u524d\u724c\u7167\u677f\uff08\u667a\u754c R7\uff09";
  if (endpoint_front_plate_17) {
    mesh_front_plate_17.position.copy(endpoint_front_plate_17.midpoint);
    mesh_front_plate_17.quaternion.copy(endpoint_front_plate_17.quaternion);
  }
  mesh_front_plate_17.castShadow = options.castShadow ?? true;
  mesh_front_plate_17.receiveShadow = options.receiveShadow ?? true;
  mesh_front_plate_17.userData.sculptComponent = {"id": "front-plate", "name": "前牌照板（智界 R7）", "level": "micro", "role": "badge", "importance": 0.7, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.44, "height": 0.13, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.295, 2.47], "rotation": [0, 0, 0], "scale": [0.44, 0.13, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate", "materialLayers": ["plate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-plate-text", "name": "牌照字样", "kind": "decal", "note": "「智界 R7」由适配层 Canvas 绘制；R17 复位至下进气口下方（原位置被进气口实体掩埋）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": ["d-plate-text"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 29, 34, 1.0)", "secondaryAlbedo": "rgba(26, 29, 34, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_plate_17.add(mesh_front_plate_17);
  meshes["front-plate"] = mesh_front_plate_17;
  colliders["front-plate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_plate_17);

  const endpoint_front_lip_18 = makeAttachmentEndpoint(null);
  const node_front_lip_18 = new THREE.Group();
  node_front_lip_18.name = "\u524d\u5507\u4e0b\u6270\u6d41__pivot";
  node_front_lip_18.scale.set(1, 1, 1);
  if (endpoint_front_lip_18) {
    node_front_lip_18.position.copy(endpoint_front_lip_18.start);
    node_front_lip_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_lip_18.position.set(0.0, 0.175, 2.41);
    node_front_lip_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_lip_18.userData.sculptComponent = {"id": "front-lip", "name": "前唇下扰流", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "横贯前保下沿的黑色唇板", "geometryDescriptor": {"profile2D": {"points": [[0.8255, -0.025], [0.83488, -0.02314], [0.84282, -0.01782], [0.84814, -0.00988], [0.85, -0.0005], [0.85, 0.0005], [0.84814, 0.00988], [0.84282, 0.01782], [0.83488, 0.02314], [0.8255, 0.025], [-0.8255, 0.025], [-0.83488, 0.02314], [-0.84282, 0.01782], [-0.84814, 0.00988], [-0.85, 0.0005], [-0.85, -0.0005], [-0.84814, -0.00988], [-0.84282, -0.01782], [-0.83488, -0.02314], [-0.8255, -0.025]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "front lip blade", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.7, "height": 0.05, "depth": 0.07, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.175, 2.41], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_lip_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_lip_18);
  nodes["front-lip"] = node_front_lip_18;
  const mesh_front_lip_18Geometry = endpoint_front_lip_18
    ? new THREE.CylinderGeometry(endpoint_front_lip_18.endRadius, endpoint_front_lip_18.baseRadius, endpoint_front_lip_18.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.8255, -0.025], [0.83488, -0.02314], [0.84282, -0.01782], [0.84814, -0.00988], [0.85, -0.0005], [0.85, 0.0005], [0.84814, 0.00988], [0.84282, 0.01782], [0.83488, 0.02314], [0.8255, 0.025], [-0.8255, 0.025], [-0.83488, 0.02314], [-0.84282, 0.01782], [-0.84814, 0.00988], [-0.85, 0.0005], [-0.85, -0.0005], [-0.84814, -0.00988], [-0.84282, -0.01782], [-0.83488, -0.02314], [-0.8255, -0.025]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_front_lip_18) {
    mesh_front_lip_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_front_lip_18 = new THREE.Mesh(
    mesh_front_lip_18Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_lip_18.name = "\u524d\u5507\u4e0b\u6270\u6d41";
  if (endpoint_front_lip_18) {
    mesh_front_lip_18.position.copy(endpoint_front_lip_18.midpoint);
    mesh_front_lip_18.quaternion.copy(endpoint_front_lip_18.quaternion);
  }
  mesh_front_lip_18.castShadow = options.castShadow ?? true;
  mesh_front_lip_18.receiveShadow = options.receiveShadow ?? true;
  mesh_front_lip_18.userData.sculptComponent = {"id": "front-lip", "name": "前唇下扰流", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "横贯前保下沿的黑色唇板", "geometryDescriptor": {"profile2D": {"points": [[0.8255, -0.025], [0.83488, -0.02314], [0.84282, -0.01782], [0.84814, -0.00988], [0.85, -0.0005], [0.85, 0.0005], [0.84814, 0.00988], [0.84282, 0.01782], [0.83488, 0.02314], [0.8255, 0.025], [-0.8255, 0.025], [-0.83488, 0.02314], [-0.84282, 0.01782], [-0.84814, 0.00988], [-0.85, 0.0005], [-0.85, -0.0005], [-0.84814, -0.00988], [-0.84282, -0.01782], [-0.83488, -0.02314], [-0.8255, -0.025]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "front lip blade", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.7, "height": 0.05, "depth": 0.07, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.175, 2.41], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_front_lip_18.add(mesh_front_lip_18);
  meshes["front-lip"] = mesh_front_lip_18;
  colliders["front-lip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_lip_18);

  const endpoint_tailgate_19 = makeAttachmentEndpoint(null);
  const node_tailgate_19 = new THREE.Group();
  node_tailgate_19.name = "\u5c3e\u95e8\u677f__pivot";
  node_tailgate_19.scale.set(1, 1, 1);
  if (endpoint_tailgate_19) {
    node_tailgate_19.position.copy(endpoint_tailgate_19.start);
    node_tailgate_19.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_tailgate_19.position.set(0.0, 0.905, -2.4);
    node_tailgate_19.rotation.set(0.0, 3.14159, 0.0);
  }
  node_tailgate_19.userData.sculptComponent = {"id": "tailgate", "name": "尾门板", "level": "meso", "role": "body", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "车尾正视圆角矩形，rotY(π) 后向 -Z 挤出 78mm 至 z=-2.478", "geometryDescriptor": {"profile2D": {"points": [[0.78, -0.3], [0.81061, -0.29391], [0.83657, -0.27657], [0.85391, -0.25061], [0.86, -0.22], [0.86, 0.22], [0.85391, 0.25061], [0.83657, 0.27657], [0.81061, 0.29391], [0.78, 0.3], [-0.78, 0.3], [-0.81061, 0.29391], [-0.83657, 0.27657], [-0.85391, 0.25061], [-0.86, 0.22], [-0.86, -0.22], [-0.85391, -0.25061], [-0.83657, -0.27657], [-0.81061, -0.29391], [-0.78, -0.3]], "depth": 0.078, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "tailgate panel extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.72, "height": 0.6, "depth": 0.078, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.905, -2.4], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-shoulder", "name": "尾部肩线折面", "kind": "contour", "note": "尾门左右肩部各一道 r0.08 折面，参考正后图的两道竖向反光棱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-shoulder"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tailgate_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tailgate_19);
  nodes["tailgate"] = node_tailgate_19;
  const mesh_tailgate_19Geometry = endpoint_tailgate_19
    ? new THREE.CylinderGeometry(endpoint_tailgate_19.endRadius, endpoint_tailgate_19.baseRadius, endpoint_tailgate_19.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.78, -0.3], [0.81061, -0.29391], [0.83657, -0.27657], [0.85391, -0.25061], [0.86, -0.22], [0.86, 0.22], [0.85391, 0.25061], [0.83657, 0.27657], [0.81061, 0.29391], [0.78, 0.3], [-0.78, 0.3], [-0.81061, 0.29391], [-0.83657, 0.27657], [-0.85391, 0.25061], [-0.86, 0.22], [-0.86, -0.22], [-0.85391, -0.25061], [-0.83657, -0.27657], [-0.81061, -0.29391], [-0.78, -0.3]], "depth": 0.078, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}});
  if (!endpoint_tailgate_19) {
    mesh_tailgate_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tailgate_19 = new THREE.Mesh(
    mesh_tailgate_19Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tailgate_19.name = "\u5c3e\u95e8\u677f";
  if (endpoint_tailgate_19) {
    mesh_tailgate_19.position.copy(endpoint_tailgate_19.midpoint);
    mesh_tailgate_19.quaternion.copy(endpoint_tailgate_19.quaternion);
  }
  mesh_tailgate_19.castShadow = options.castShadow ?? true;
  mesh_tailgate_19.receiveShadow = options.receiveShadow ?? true;
  mesh_tailgate_19.userData.sculptComponent = {"id": "tailgate", "name": "尾门板", "level": "meso", "role": "body", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "车尾正视圆角矩形，rotY(π) 后向 -Z 挤出 78mm 至 z=-2.478", "geometryDescriptor": {"profile2D": {"points": [[0.78, -0.3], [0.81061, -0.29391], [0.83657, -0.27657], [0.85391, -0.25061], [0.86, -0.22], [0.86, 0.22], [0.85391, 0.25061], [0.83657, 0.27657], [0.81061, 0.29391], [0.78, 0.3], [-0.78, 0.3], [-0.81061, 0.29391], [-0.83657, 0.27657], [-0.85391, 0.25061], [-0.86, 0.22], [-0.86, -0.22], [-0.85391, -0.25061], [-0.83657, -0.27657], [-0.81061, -0.29391], [-0.78, -0.3]], "depth": 0.078, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "tailgate panel extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.72, "height": 0.6, "depth": 0.078, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.905, -2.4], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-shoulder", "name": "尾部肩线折面", "kind": "contour", "note": "尾门左右肩部各一道 r0.08 折面，参考正后图的两道竖向反光棱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-shoulder"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tailgate_19.add(mesh_tailgate_19);
  meshes["tailgate"] = mesh_tailgate_19;
  colliders["tailgate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tailgate_19);

  const endpoint_tail_lamp_band_20 = makeAttachmentEndpoint(null);
  const node_tail_lamp_band_20 = new THREE.Group();
  node_tail_lamp_band_20.name = "\u5c3e\u706f\u6697\u573a\u5e26\uff08\u5168\u5bbd\u70df\u718f\uff09__pivot";
  node_tail_lamp_band_20.scale.set(1, 1, 1);
  if (endpoint_tail_lamp_band_20) {
    node_tail_lamp_band_20.position.copy(endpoint_tail_lamp_band_20.start);
    node_tail_lamp_band_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_lamp_band_20.position.set(0.0, 1.072, -2.486);
    node_tail_lamp_band_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_lamp_band_20.userData.sculptComponent = {"id": "tail-lamp-band", "name": "尾灯暗场带（全宽烟熏）", "level": "meso", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.7, "height": 0.185, "depth": 0.02, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.072, -2.486], "rotation": [0, 0, 0], "scale": [1.7, 0.185, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-band", "name": "烟熏灯带承托 LUXEED 字标", "kind": "linework", "note": "R17：暗场带加高至 18.5cm 并外凸出尾门面，LUXEED 字标嵌在带内（参考正后图层次）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-band"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_tail_lamp_band_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tail_lamp_band_20);
  nodes["tail-lamp-band"] = node_tail_lamp_band_20;
  const mesh_tail_lamp_band_20Geometry = endpoint_tail_lamp_band_20
    ? new THREE.CylinderGeometry(endpoint_tail_lamp_band_20.endRadius, endpoint_tail_lamp_band_20.baseRadius, endpoint_tail_lamp_band_20.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tail_lamp_band_20) {
    mesh_tail_lamp_band_20Geometry.scale(1.7, 0.185, 0.02);
  }
  const mesh_tail_lamp_band_20 = new THREE.Mesh(
    mesh_tail_lamp_band_20Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_lamp_band_20.name = "\u5c3e\u706f\u6697\u573a\u5e26\uff08\u5168\u5bbd\u70df\u718f\uff09";
  if (endpoint_tail_lamp_band_20) {
    mesh_tail_lamp_band_20.position.copy(endpoint_tail_lamp_band_20.midpoint);
    mesh_tail_lamp_band_20.quaternion.copy(endpoint_tail_lamp_band_20.quaternion);
  }
  mesh_tail_lamp_band_20.castShadow = options.castShadow ?? true;
  mesh_tail_lamp_band_20.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_lamp_band_20.userData.sculptComponent = {"id": "tail-lamp-band", "name": "尾灯暗场带（全宽烟熏）", "level": "meso", "role": "lamp", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.7, "height": 0.185, "depth": 0.02, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.072, -2.486], "rotation": [0, 0, 0], "scale": [1.7, 0.185, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-band", "name": "烟熏灯带承托 LUXEED 字标", "kind": "linework", "note": "R17：暗场带加高至 18.5cm 并外凸出尾门面，LUXEED 字标嵌在带内（参考正后图层次）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-band"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_tail_lamp_band_20.add(mesh_tail_lamp_band_20);
  meshes["tail-lamp-band"] = mesh_tail_lamp_band_20;
  colliders["tail-lamp-band"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tail_lamp_band_20);

  const endpoint_tail_light_bar_21 = makeAttachmentEndpoint(null);
  const node_tail_light_bar_21 = new THREE.Group();
  node_tail_light_bar_21.name = "\u8d2f\u7a7f\u5f0f\u5c3e\u706f\uff08\u5168\u5bbd\u7ea2\u5149\uff09__pivot";
  node_tail_light_bar_21.scale.set(1, 1, 1);
  if (endpoint_tail_light_bar_21) {
    node_tail_light_bar_21.position.copy(endpoint_tail_light_bar_21.start);
    node_tail_light_bar_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_light_bar_21.position.set(0.0, 1.1, -2.5);
    node_tail_light_bar_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_light_bar_21.userData.sculptComponent = {"id": "tail-light-bar", "name": "贯穿式尾灯（全宽红光）", "level": "meso", "role": "lamp", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.66, "height": 0.03, "depth": 0.014, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.1, -2.5], "rotation": [0, 0, 0], "scale": [1.66, 0.03, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-bar-red", "name": "贯穿红光标线", "kind": "emissive", "note": "全宽 1.66m 红光带位于烟熏暗场带上沿，刹车时整条加亮"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-bar-red"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_bar_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tail_light_bar_21);
  nodes["tail-light-bar"] = node_tail_light_bar_21;
  const mesh_tail_light_bar_21Geometry = endpoint_tail_light_bar_21
    ? new THREE.CylinderGeometry(endpoint_tail_light_bar_21.endRadius, endpoint_tail_light_bar_21.baseRadius, endpoint_tail_light_bar_21.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tail_light_bar_21) {
    mesh_tail_light_bar_21Geometry.scale(1.66, 0.03, 0.014);
  }
  const mesh_tail_light_bar_21 = new THREE.Mesh(
    mesh_tail_light_bar_21Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_light_bar_21.name = "\u8d2f\u7a7f\u5f0f\u5c3e\u706f\uff08\u5168\u5bbd\u7ea2\u5149\uff09";
  if (endpoint_tail_light_bar_21) {
    mesh_tail_light_bar_21.position.copy(endpoint_tail_light_bar_21.midpoint);
    mesh_tail_light_bar_21.quaternion.copy(endpoint_tail_light_bar_21.quaternion);
  }
  mesh_tail_light_bar_21.castShadow = options.castShadow ?? true;
  mesh_tail_light_bar_21.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_light_bar_21.userData.sculptComponent = {"id": "tail-light-bar", "name": "贯穿式尾灯（全宽红光）", "level": "meso", "role": "lamp", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.66, "height": 0.03, "depth": 0.014, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.1, -2.5], "rotation": [0, 0, 0], "scale": [1.66, 0.03, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tail-bar-red", "name": "贯穿红光标线", "kind": "emissive", "note": "全宽 1.66m 红光带位于烟熏暗场带上沿，刹车时整条加亮"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-tail-bar-red"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_bar_21.add(mesh_tail_light_bar_21);
  meshes["tail-light-bar"] = mesh_tail_light_bar_21;
  colliders["tail-light-bar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tail_light_bar_21);

  const endpoint_tail_light_split_l_22 = makeAttachmentEndpoint(null);
  const node_tail_light_split_l_22 = new THREE.Group();
  node_tail_light_split_l_22.name = "\u5c3e\u706f\u4fa7\u6bb5\uff08\u5de6\uff09__pivot";
  node_tail_light_split_l_22.scale.set(1, 1, 1);
  if (endpoint_tail_light_split_l_22) {
    node_tail_light_split_l_22.position.copy(endpoint_tail_light_split_l_22.start);
    node_tail_light_split_l_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_light_split_l_22.position.set(0.79, 1.1, -2.372);
    node_tail_light_split_l_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_light_split_l_22.userData.sculptComponent = {"id": "tail-light-split-l", "name": "尾灯侧段（左）", "level": "micro", "role": "lamp", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.052, "depth": 0.23, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.79, 1.1, -2.372], "rotation": [0, 0, 0], "scale": [0.085, 0.052, 0.23]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_split_l_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tail_light_split_l_22);
  nodes["tail-light-split-l"] = node_tail_light_split_l_22;
  const mesh_tail_light_split_l_22Geometry = endpoint_tail_light_split_l_22
    ? new THREE.CylinderGeometry(endpoint_tail_light_split_l_22.endRadius, endpoint_tail_light_split_l_22.baseRadius, endpoint_tail_light_split_l_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tail_light_split_l_22) {
    mesh_tail_light_split_l_22Geometry.scale(0.085, 0.052, 0.23);
  }
  const mesh_tail_light_split_l_22 = new THREE.Mesh(
    mesh_tail_light_split_l_22Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_light_split_l_22.name = "\u5c3e\u706f\u4fa7\u6bb5\uff08\u5de6\uff09";
  if (endpoint_tail_light_split_l_22) {
    mesh_tail_light_split_l_22.position.copy(endpoint_tail_light_split_l_22.midpoint);
    mesh_tail_light_split_l_22.quaternion.copy(endpoint_tail_light_split_l_22.quaternion);
  }
  mesh_tail_light_split_l_22.castShadow = options.castShadow ?? true;
  mesh_tail_light_split_l_22.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_light_split_l_22.userData.sculptComponent = {"id": "tail-light-split-l", "name": "尾灯侧段（左）", "level": "micro", "role": "lamp", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.052, "depth": 0.23, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.79, 1.1, -2.372], "rotation": [0, 0, 0], "scale": [0.085, 0.052, 0.23]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_split_l_22.add(mesh_tail_light_split_l_22);
  meshes["tail-light-split-l"] = mesh_tail_light_split_l_22;
  colliders["tail-light-split-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tail_light_split_l_22);

  const endpoint_tail_light_split_r_23 = makeAttachmentEndpoint(null);
  const node_tail_light_split_r_23 = new THREE.Group();
  node_tail_light_split_r_23.name = "\u5c3e\u706f\u4fa7\u6bb5\uff08\u53f3\uff09__pivot";
  node_tail_light_split_r_23.scale.set(1, 1, 1);
  if (endpoint_tail_light_split_r_23) {
    node_tail_light_split_r_23.position.copy(endpoint_tail_light_split_r_23.start);
    node_tail_light_split_r_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_light_split_r_23.position.set(-0.79, 1.1, -2.372);
    node_tail_light_split_r_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_light_split_r_23.userData.sculptComponent = {"id": "tail-light-split-r", "name": "尾灯侧段（右）", "level": "micro", "role": "lamp", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.052, "depth": 0.23, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.79, 1.1, -2.372], "rotation": [0, 0, 0], "scale": [0.085, 0.052, 0.23]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_split_r_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tail_light_split_r_23);
  nodes["tail-light-split-r"] = node_tail_light_split_r_23;
  const mesh_tail_light_split_r_23Geometry = endpoint_tail_light_split_r_23
    ? new THREE.CylinderGeometry(endpoint_tail_light_split_r_23.endRadius, endpoint_tail_light_split_r_23.baseRadius, endpoint_tail_light_split_r_23.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tail_light_split_r_23) {
    mesh_tail_light_split_r_23Geometry.scale(0.085, 0.052, 0.23);
  }
  const mesh_tail_light_split_r_23 = new THREE.Mesh(
    mesh_tail_light_split_r_23Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_light_split_r_23.name = "\u5c3e\u706f\u4fa7\u6bb5\uff08\u53f3\uff09";
  if (endpoint_tail_light_split_r_23) {
    mesh_tail_light_split_r_23.position.copy(endpoint_tail_light_split_r_23.midpoint);
    mesh_tail_light_split_r_23.quaternion.copy(endpoint_tail_light_split_r_23.quaternion);
  }
  mesh_tail_light_split_r_23.castShadow = options.castShadow ?? true;
  mesh_tail_light_split_r_23.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_light_split_r_23.userData.sculptComponent = {"id": "tail-light-split-r", "name": "尾灯侧段（右）", "level": "micro", "role": "lamp", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.052, "depth": 0.23, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.79, 1.1, -2.372], "rotation": [0, 0, 0], "scale": [0.085, 0.052, 0.23]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tail_light_split_r_23.add(mesh_tail_light_split_r_23);
  meshes["tail-light-split-r"] = mesh_tail_light_split_r_23;
  colliders["tail-light-split-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tail_light_split_r_23);

  const endpoint_lettering_luxeed_24 = makeAttachmentEndpoint(null);
  const node_lettering_luxeed_24 = new THREE.Group();
  node_lettering_luxeed_24.name = "LUXEED \u5b57\u6807__pivot";
  node_lettering_luxeed_24.scale.set(1, 1, 1);
  if (endpoint_lettering_luxeed_24) {
    node_lettering_luxeed_24.position.copy(endpoint_lettering_luxeed_24.start);
    node_lettering_luxeed_24.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_lettering_luxeed_24.position.set(0.0, 1.022, -2.5);
    node_lettering_luxeed_24.rotation.set(0.0, 3.14159, 0.0);
  }
  node_lettering_luxeed_24.userData.sculptComponent = {"id": "lettering-luxeed", "name": "LUXEED 字标", "level": "micro", "role": "badge", "importance": 0.9, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.62, "height": 0.078, "depth": 0.004, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.022, -2.5], "rotation": [0, 3.14159, 0], "scale": [0.62, 0.078, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-luxeed-lettering", "name": "L U X E E D 宽间距字标", "kind": "decal", "note": "6 字母宽字距排列，嵌于烟熏暗场带内、贯穿红光带正下方（适配层 Canvas 绘制，仅文字性引用）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-luxeed-lettering"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_lettering_luxeed_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_lettering_luxeed_24);
  nodes["lettering-luxeed"] = node_lettering_luxeed_24;
  const mesh_lettering_luxeed_24Geometry = endpoint_lettering_luxeed_24
    ? new THREE.CylinderGeometry(endpoint_lettering_luxeed_24.endRadius, endpoint_lettering_luxeed_24.baseRadius, endpoint_lettering_luxeed_24.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_lettering_luxeed_24) {
    mesh_lettering_luxeed_24Geometry.scale(0.62, 0.078, 0.004);
  }
  const mesh_lettering_luxeed_24 = new THREE.Mesh(
    mesh_lettering_luxeed_24Geometry,
    materialMap["plate-mark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lettering_luxeed_24.name = "LUXEED \u5b57\u6807";
  if (endpoint_lettering_luxeed_24) {
    mesh_lettering_luxeed_24.position.copy(endpoint_lettering_luxeed_24.midpoint);
    mesh_lettering_luxeed_24.quaternion.copy(endpoint_lettering_luxeed_24.quaternion);
  }
  mesh_lettering_luxeed_24.castShadow = options.castShadow ?? true;
  mesh_lettering_luxeed_24.receiveShadow = options.receiveShadow ?? true;
  mesh_lettering_luxeed_24.userData.sculptComponent = {"id": "lettering-luxeed", "name": "LUXEED 字标", "level": "micro", "role": "badge", "importance": 0.9, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.62, "height": 0.078, "depth": 0.004, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.022, -2.5], "rotation": [0, 3.14159, 0], "scale": [0.62, 0.078, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-luxeed-lettering", "name": "L U X E E D 宽间距字标", "kind": "decal", "note": "6 字母宽字距排列，嵌于烟熏暗场带内、贯穿红光带正下方（适配层 Canvas 绘制，仅文字性引用）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-luxeed-lettering"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_lettering_luxeed_24.add(mesh_lettering_luxeed_24);
  meshes["lettering-luxeed"] = mesh_lettering_luxeed_24;
  colliders["lettering-luxeed"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_lettering_luxeed_24);

  const endpoint_badge_l_25 = makeAttachmentEndpoint(null);
  const node_badge_l_25 = new THREE.Group();
  node_badge_l_25.name = "\u5c3e\u90e8\u94ed\u724c\uff08\u5947\u745e\u6c7d\u8f66\uff09__pivot";
  node_badge_l_25.scale.set(1, 1, 1);
  if (endpoint_badge_l_25) {
    node_badge_l_25.position.copy(endpoint_badge_l_25.start);
    node_badge_l_25.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_badge_l_25.position.set(0.62, 0.86, -2.484);
    node_badge_l_25.rotation.set(0.0, 3.14159, 0.0);
  }
  node_badge_l_25.userData.sculptComponent = {"id": "badge-l", "name": "尾部铭牌（奇瑞汽车）", "level": "micro", "role": "badge", "importance": 0.65, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.185, "height": 0.04, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.62, 0.86, -2.484], "rotation": [0, 3.14159, 0], "scale": [0.185, 0.04, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_badge_l_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_badge_l_25);
  nodes["badge-l"] = node_badge_l_25;
  const mesh_badge_l_25Geometry = endpoint_badge_l_25
    ? new THREE.CylinderGeometry(endpoint_badge_l_25.endRadius, endpoint_badge_l_25.baseRadius, endpoint_badge_l_25.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_badge_l_25) {
    mesh_badge_l_25Geometry.scale(0.185, 0.04, 0.004);
  }
  const mesh_badge_l_25 = new THREE.Mesh(
    mesh_badge_l_25Geometry,
    materialMap["plate-mark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_badge_l_25.name = "\u5c3e\u90e8\u94ed\u724c\uff08\u5947\u745e\u6c7d\u8f66\uff09";
  if (endpoint_badge_l_25) {
    mesh_badge_l_25.position.copy(endpoint_badge_l_25.midpoint);
    mesh_badge_l_25.quaternion.copy(endpoint_badge_l_25.quaternion);
  }
  mesh_badge_l_25.castShadow = options.castShadow ?? true;
  mesh_badge_l_25.receiveShadow = options.receiveShadow ?? true;
  mesh_badge_l_25.userData.sculptComponent = {"id": "badge-l", "name": "尾部铭牌（奇瑞汽车）", "level": "micro", "role": "badge", "importance": 0.65, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.185, "height": 0.04, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.62, 0.86, -2.484], "rotation": [0, 3.14159, 0], "scale": [0.185, 0.04, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_badge_l_25.add(mesh_badge_l_25);
  meshes["badge-l"] = mesh_badge_l_25;
  colliders["badge-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_badge_l_25);

  const endpoint_badge_r_26 = makeAttachmentEndpoint(null);
  const node_badge_r_26 = new THREE.Group();
  node_badge_r_26.name = "\u5c3e\u90e8\u94ed\u724c\uff08\u667a\u754cR7\uff09__pivot";
  node_badge_r_26.scale.set(1, 1, 1);
  if (endpoint_badge_r_26) {
    node_badge_r_26.position.copy(endpoint_badge_r_26.start);
    node_badge_r_26.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_badge_r_26.position.set(-0.62, 0.86, -2.484);
    node_badge_r_26.rotation.set(0.0, 3.14159, 0.0);
  }
  node_badge_r_26.userData.sculptComponent = {"id": "badge-r", "name": "尾部铭牌（智界R7）", "level": "micro", "role": "badge", "importance": 0.65, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.185, "height": 0.04, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.62, 0.86, -2.484], "rotation": [0, 3.14159, 0], "scale": [0.185, 0.04, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_badge_r_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_badge_r_26);
  nodes["badge-r"] = node_badge_r_26;
  const mesh_badge_r_26Geometry = endpoint_badge_r_26
    ? new THREE.CylinderGeometry(endpoint_badge_r_26.endRadius, endpoint_badge_r_26.baseRadius, endpoint_badge_r_26.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_badge_r_26) {
    mesh_badge_r_26Geometry.scale(0.185, 0.04, 0.004);
  }
  const mesh_badge_r_26 = new THREE.Mesh(
    mesh_badge_r_26Geometry,
    materialMap["plate-mark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_badge_r_26.name = "\u5c3e\u90e8\u94ed\u724c\uff08\u667a\u754cR7\uff09";
  if (endpoint_badge_r_26) {
    mesh_badge_r_26.position.copy(endpoint_badge_r_26.midpoint);
    mesh_badge_r_26.quaternion.copy(endpoint_badge_r_26.quaternion);
  }
  mesh_badge_r_26.castShadow = options.castShadow ?? true;
  mesh_badge_r_26.receiveShadow = options.receiveShadow ?? true;
  mesh_badge_r_26.userData.sculptComponent = {"id": "badge-r", "name": "尾部铭牌（智界R7）", "level": "micro", "role": "badge", "importance": 0.65, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.185, "height": 0.04, "depth": 0.004, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.62, 0.86, -2.484], "rotation": [0, 3.14159, 0], "scale": [0.185, 0.04, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "plate-mark", "materialLayers": ["plate-mark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 214, 1.0)", "secondaryAlbedo": "rgba(201, 206, 214, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_badge_r_26.add(mesh_badge_r_26);
  meshes["badge-r"] = mesh_badge_r_26;
  colliders["badge-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_badge_r_26);

  const endpoint_rear_bumper_27 = makeAttachmentEndpoint(null);
  const node_rear_bumper_27 = new THREE.Group();
  node_rear_bumper_27.name = "\u540e\u4fdd\u9669\u6760\uff08\u9ed1\u8272\u4e0b\u5305\u56f4\uff09__pivot";
  node_rear_bumper_27.scale.set(1, 1, 1);
  if (endpoint_rear_bumper_27) {
    node_rear_bumper_27.position.copy(endpoint_rear_bumper_27.start);
    node_rear_bumper_27.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_rear_bumper_27.position.set(0.0, 0.42, -2.382);
    node_rear_bumper_27.rotation.set(0.0, 3.14159, 0.0);
  }
  node_rear_bumper_27.userData.sculptComponent = {"id": "rear-bumper", "name": "后保险杠（黑色下包围）", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "正视圆角矩形向 -Z 挤出 98mm 的黑色下包围", "geometryDescriptor": {"profile2D": {"points": [[0.83, -0.2], [0.85679, -0.19467], [0.8795, -0.1795], [0.89467, -0.15679], [0.9, -0.13], [0.9, 0.13], [0.89467, 0.15679], [0.8795, 0.1795], [0.85679, 0.19467], [0.83, 0.2], [-0.83, 0.2], [-0.85679, 0.19467], [-0.8795, 0.1795], [-0.89467, 0.15679], [-0.9, 0.13], [-0.9, -0.13], [-0.89467, -0.15679], [-0.8795, -0.1795], [-0.85679, -0.19467], [-0.83, -0.2]], "depth": 0.098, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "rear bumper extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.8, "height": 0.4, "depth": 0.098, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.42, -2.382], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rear-diffuser", "name": "扩散器 + 反光条", "kind": "groove", "note": "下包围中部扩散器凹槽，两侧各一条红色反光条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-rear-diffuser"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_bumper_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rear_bumper_27);
  nodes["rear-bumper"] = node_rear_bumper_27;
  const mesh_rear_bumper_27Geometry = endpoint_rear_bumper_27
    ? new THREE.CylinderGeometry(endpoint_rear_bumper_27.endRadius, endpoint_rear_bumper_27.baseRadius, endpoint_rear_bumper_27.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.83, -0.2], [0.85679, -0.19467], [0.8795, -0.1795], [0.89467, -0.15679], [0.9, -0.13], [0.9, 0.13], [0.89467, 0.15679], [0.8795, 0.1795], [0.85679, 0.19467], [0.83, 0.2], [-0.83, 0.2], [-0.85679, 0.19467], [-0.8795, 0.1795], [-0.89467, 0.15679], [-0.9, 0.13], [-0.9, -0.13], [-0.89467, -0.15679], [-0.8795, -0.1795], [-0.85679, -0.19467], [-0.83, -0.2]], "depth": 0.098, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}});
  if (!endpoint_rear_bumper_27) {
    mesh_rear_bumper_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rear_bumper_27 = new THREE.Mesh(
    mesh_rear_bumper_27Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_bumper_27.name = "\u540e\u4fdd\u9669\u6760\uff08\u9ed1\u8272\u4e0b\u5305\u56f4\uff09";
  if (endpoint_rear_bumper_27) {
    mesh_rear_bumper_27.position.copy(endpoint_rear_bumper_27.midpoint);
    mesh_rear_bumper_27.quaternion.copy(endpoint_rear_bumper_27.quaternion);
  }
  mesh_rear_bumper_27.castShadow = options.castShadow ?? true;
  mesh_rear_bumper_27.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_bumper_27.userData.sculptComponent = {"id": "rear-bumper", "name": "后保险杠（黑色下包围）", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "正视圆角矩形向 -Z 挤出 98mm 的黑色下包围", "geometryDescriptor": {"profile2D": {"points": [[0.83, -0.2], [0.85679, -0.19467], [0.8795, -0.1795], [0.89467, -0.15679], [0.9, -0.13], [0.9, 0.13], [0.89467, 0.15679], [0.8795, 0.1795], [0.85679, 0.19467], [0.83, 0.2], [-0.83, 0.2], [-0.85679, 0.19467], [-0.8795, 0.1795], [-0.89467, 0.15679], [-0.9, 0.13], [-0.9, -0.13], [-0.89467, -0.15679], [-0.8795, -0.1795], [-0.85679, -0.19467], [-0.83, -0.2]], "depth": 0.098, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "rear bumper extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.8, "height": 0.4, "depth": 0.098, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.42, -2.382], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rear-diffuser", "name": "扩散器 + 反光条", "kind": "groove", "note": "下包围中部扩散器凹槽，两侧各一条红色反光条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": ["d-rear-diffuser"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_bumper_27.add(mesh_rear_bumper_27);
  meshes["rear-bumper"] = mesh_rear_bumper_27;
  colliders["rear-bumper"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_bumper_27);

  const endpoint_rear_diffuser_28 = makeAttachmentEndpoint(null);
  const node_rear_diffuser_28 = new THREE.Group();
  node_rear_diffuser_28.name = "\u540e\u6269\u6563\u5668__pivot";
  node_rear_diffuser_28.scale.set(1, 1, 1);
  if (endpoint_rear_diffuser_28) {
    node_rear_diffuser_28.position.copy(endpoint_rear_diffuser_28.start);
    node_rear_diffuser_28.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_rear_diffuser_28.position.set(0.0, 0.245, -2.404);
    node_rear_diffuser_28.rotation.set(0.0, 3.14159, 0.0);
  }
  node_rear_diffuser_28.userData.sculptComponent = {"id": "rear-diffuser", "name": "后扩散器", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "扩散器凹槽挤出件", "geometryDescriptor": {"profile2D": {"points": [[0.51, -0.065], [0.52531, -0.06196], [0.53828, -0.05328], [0.54696, -0.04031], [0.55, -0.025], [0.55, 0.025], [0.54696, 0.04031], [0.53828, 0.05328], [0.52531, 0.06196], [0.51, 0.065], [-0.51, 0.065], [-0.52531, 0.06196], [-0.53828, 0.05328], [-0.54696, 0.04031], [-0.55, 0.025], [-0.55, -0.025], [-0.54696, -0.04031], [-0.53828, -0.05328], [-0.52531, -0.06196], [-0.51, -0.065]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "diffuser recess", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.1, "height": 0.13, "depth": 0.07, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.245, -2.404], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_diffuser_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rear_diffuser_28);
  nodes["rear-diffuser"] = node_rear_diffuser_28;
  const mesh_rear_diffuser_28Geometry = endpoint_rear_diffuser_28
    ? new THREE.CylinderGeometry(endpoint_rear_diffuser_28.endRadius, endpoint_rear_diffuser_28.baseRadius, endpoint_rear_diffuser_28.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.51, -0.065], [0.52531, -0.06196], [0.53828, -0.05328], [0.54696, -0.04031], [0.55, -0.025], [0.55, 0.025], [0.54696, 0.04031], [0.53828, 0.05328], [0.52531, 0.06196], [0.51, 0.065], [-0.51, 0.065], [-0.52531, 0.06196], [-0.53828, 0.05328], [-0.54696, 0.04031], [-0.55, 0.025], [-0.55, -0.025], [-0.54696, -0.04031], [-0.53828, -0.05328], [-0.52531, -0.06196], [-0.51, -0.065]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_rear_diffuser_28) {
    mesh_rear_diffuser_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rear_diffuser_28 = new THREE.Mesh(
    mesh_rear_diffuser_28Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_diffuser_28.name = "\u540e\u6269\u6563\u5668";
  if (endpoint_rear_diffuser_28) {
    mesh_rear_diffuser_28.position.copy(endpoint_rear_diffuser_28.midpoint);
    mesh_rear_diffuser_28.quaternion.copy(endpoint_rear_diffuser_28.quaternion);
  }
  mesh_rear_diffuser_28.castShadow = options.castShadow ?? true;
  mesh_rear_diffuser_28.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_diffuser_28.userData.sculptComponent = {"id": "rear-diffuser", "name": "后扩散器", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "扩散器凹槽挤出件", "geometryDescriptor": {"profile2D": {"points": [[0.51, -0.065], [0.52531, -0.06196], [0.53828, -0.05328], [0.54696, -0.04031], [0.55, -0.025], [0.55, 0.025], [0.54696, 0.04031], [0.53828, 0.05328], [0.52531, 0.06196], [0.51, 0.065], [-0.51, 0.065], [-0.52531, 0.06196], [-0.53828, 0.05328], [-0.54696, 0.04031], [-0.55, 0.025], [-0.55, -0.025], [-0.54696, -0.04031], [-0.53828, -0.05328], [-0.52531, -0.06196], [-0.51, -0.065]], "depth": 0.07, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "diffuser recess", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.1, "height": 0.13, "depth": 0.07, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.245, -2.404], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_diffuser_28.add(mesh_rear_diffuser_28);
  meshes["rear-diffuser"] = mesh_rear_diffuser_28;
  colliders["rear-diffuser"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_diffuser_28);

  const endpoint_rear_reflector_l_29 = makeAttachmentEndpoint(null);
  const node_rear_reflector_l_29 = new THREE.Group();
  node_rear_reflector_l_29.name = "\u540e\u53cd\u5149\u6761\uff08\u5de6\uff09__pivot";
  node_rear_reflector_l_29.scale.set(1, 1, 1);
  if (endpoint_rear_reflector_l_29) {
    node_rear_reflector_l_29.position.copy(endpoint_rear_reflector_l_29.start);
    node_rear_reflector_l_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rear_reflector_l_29.position.set(0.625, 0.26, -2.492);
    node_rear_reflector_l_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_rear_reflector_l_29.userData.sculptComponent = {"id": "rear-reflector-l", "name": "后反光条（左）", "level": "micro", "role": "lamp", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.24, "height": 0.03, "depth": 0.01, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.625, 0.26, -2.492], "rotation": [0, 0, 0], "scale": [0.24, 0.03, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_reflector_l_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rear_reflector_l_29);
  nodes["rear-reflector-l"] = node_rear_reflector_l_29;
  const mesh_rear_reflector_l_29Geometry = endpoint_rear_reflector_l_29
    ? new THREE.CylinderGeometry(endpoint_rear_reflector_l_29.endRadius, endpoint_rear_reflector_l_29.baseRadius, endpoint_rear_reflector_l_29.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rear_reflector_l_29) {
    mesh_rear_reflector_l_29Geometry.scale(0.24, 0.03, 0.01);
  }
  const mesh_rear_reflector_l_29 = new THREE.Mesh(
    mesh_rear_reflector_l_29Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_reflector_l_29.name = "\u540e\u53cd\u5149\u6761\uff08\u5de6\uff09";
  if (endpoint_rear_reflector_l_29) {
    mesh_rear_reflector_l_29.position.copy(endpoint_rear_reflector_l_29.midpoint);
    mesh_rear_reflector_l_29.quaternion.copy(endpoint_rear_reflector_l_29.quaternion);
  }
  mesh_rear_reflector_l_29.castShadow = options.castShadow ?? true;
  mesh_rear_reflector_l_29.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_reflector_l_29.userData.sculptComponent = {"id": "rear-reflector-l", "name": "后反光条（左）", "level": "micro", "role": "lamp", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.24, "height": 0.03, "depth": 0.01, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.625, 0.26, -2.492], "rotation": [0, 0, 0], "scale": [0.24, 0.03, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_reflector_l_29.add(mesh_rear_reflector_l_29);
  meshes["rear-reflector-l"] = mesh_rear_reflector_l_29;
  colliders["rear-reflector-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_reflector_l_29);

  const endpoint_rear_reflector_r_30 = makeAttachmentEndpoint(null);
  const node_rear_reflector_r_30 = new THREE.Group();
  node_rear_reflector_r_30.name = "\u540e\u53cd\u5149\u6761\uff08\u53f3\uff09__pivot";
  node_rear_reflector_r_30.scale.set(1, 1, 1);
  if (endpoint_rear_reflector_r_30) {
    node_rear_reflector_r_30.position.copy(endpoint_rear_reflector_r_30.start);
    node_rear_reflector_r_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rear_reflector_r_30.position.set(-0.625, 0.26, -2.492);
    node_rear_reflector_r_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_rear_reflector_r_30.userData.sculptComponent = {"id": "rear-reflector-r", "name": "后反光条（右）", "level": "micro", "role": "lamp", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.24, "height": 0.03, "depth": 0.01, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.625, 0.26, -2.492], "rotation": [0, 0, 0], "scale": [0.24, 0.03, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_reflector_r_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rear_reflector_r_30);
  nodes["rear-reflector-r"] = node_rear_reflector_r_30;
  const mesh_rear_reflector_r_30Geometry = endpoint_rear_reflector_r_30
    ? new THREE.CylinderGeometry(endpoint_rear_reflector_r_30.endRadius, endpoint_rear_reflector_r_30.baseRadius, endpoint_rear_reflector_r_30.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rear_reflector_r_30) {
    mesh_rear_reflector_r_30Geometry.scale(0.24, 0.03, 0.01);
  }
  const mesh_rear_reflector_r_30 = new THREE.Mesh(
    mesh_rear_reflector_r_30Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_reflector_r_30.name = "\u540e\u53cd\u5149\u6761\uff08\u53f3\uff09";
  if (endpoint_rear_reflector_r_30) {
    mesh_rear_reflector_r_30.position.copy(endpoint_rear_reflector_r_30.midpoint);
    mesh_rear_reflector_r_30.quaternion.copy(endpoint_rear_reflector_r_30.quaternion);
  }
  mesh_rear_reflector_r_30.castShadow = options.castShadow ?? true;
  mesh_rear_reflector_r_30.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_reflector_r_30.userData.sculptComponent = {"id": "rear-reflector-r", "name": "后反光条（右）", "level": "micro", "role": "lamp", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.24, "height": 0.03, "depth": 0.01, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.625, 0.26, -2.492], "rotation": [0, 0, 0], "scale": [0.24, 0.03, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_reflector_r_30.add(mesh_rear_reflector_r_30);
  meshes["rear-reflector-r"] = mesh_rear_reflector_r_30;
  colliders["rear-reflector-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_reflector_r_30);

  const endpoint_spoiler_31 = makeAttachmentEndpoint(null);
  const node_spoiler_31 = new THREE.Group();
  node_spoiler_31.name = "\u5c3e\u7ffc\uff08\u9e2d\u5c3e\u6270\u6d41\u677f\uff09__pivot";
  node_spoiler_31.scale.set(1, 1, 1);
  if (endpoint_spoiler_31) {
    node_spoiler_31.position.copy(endpoint_spoiler_31.start);
    node_spoiler_31.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_spoiler_31.position.set(0.67, 0.0, 0.0);
    node_spoiler_31.rotation.set(0.0, -1.5708, 0.0);
  }
  node_spoiler_31.userData.sculptComponent = {"id": "spoiler", "name": "尾翼（鸭尾扰流板）", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视楔形薄板挤出，贴合溜背尾端", "geometryDescriptor": {"profile2D": {"points": [[-2.27, 1.237], [-2.41, 1.215], [-2.432, 1.177], [-2.33, 1.161], [-2.24, 1.173], [-2.245, 1.215]], "depth": 1.34, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "duck-tail spoiler blade", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.34, "height": 0.09, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.67, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-spoiler-lip", "name": "鸭尾上翘", "kind": "ridge", "note": "尾端 y1.24 上翘唇口（R17 随溜背线下压），后视图中尾门上方那道横向亮棱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear", "img-r7-34"], "details": ["d-spoiler-lip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_spoiler_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_spoiler_31);
  nodes["spoiler"] = node_spoiler_31;
  const mesh_spoiler_31Geometry = endpoint_spoiler_31
    ? new THREE.CylinderGeometry(endpoint_spoiler_31.endRadius, endpoint_spoiler_31.baseRadius, endpoint_spoiler_31.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-2.27, 1.237], [-2.41, 1.215], [-2.432, 1.177], [-2.33, 1.161], [-2.24, 1.173], [-2.245, 1.215]], "depth": 1.34, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}});
  if (!endpoint_spoiler_31) {
    mesh_spoiler_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_spoiler_31 = new THREE.Mesh(
    mesh_spoiler_31Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_spoiler_31.name = "\u5c3e\u7ffc\uff08\u9e2d\u5c3e\u6270\u6d41\u677f\uff09";
  if (endpoint_spoiler_31) {
    mesh_spoiler_31.position.copy(endpoint_spoiler_31.midpoint);
    mesh_spoiler_31.quaternion.copy(endpoint_spoiler_31.quaternion);
  }
  mesh_spoiler_31.castShadow = options.castShadow ?? true;
  mesh_spoiler_31.receiveShadow = options.receiveShadow ?? true;
  mesh_spoiler_31.userData.sculptComponent = {"id": "spoiler", "name": "尾翼（鸭尾扰流板）", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视楔形薄板挤出，贴合溜背尾端", "geometryDescriptor": {"profile2D": {"points": [[-2.27, 1.237], [-2.41, 1.215], [-2.432, 1.177], [-2.33, 1.161], [-2.24, 1.173], [-2.245, 1.215]], "depth": 1.34, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "duck-tail spoiler blade", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.34, "height": 0.09, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.67, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-spoiler-lip", "name": "鸭尾上翘", "kind": "ridge", "note": "尾端 y1.24 上翘唇口（R17 随溜背线下压），后视图中尾门上方那道横向亮棱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear", "img-r7-34"], "details": ["d-spoiler-lip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_spoiler_31.add(mesh_spoiler_31);
  meshes["spoiler"] = mesh_spoiler_31;
  colliders["spoiler"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_spoiler_31);

  const endpoint_high_mount_brake_32 = makeAttachmentEndpoint(null);
  const node_high_mount_brake_32 = new THREE.Group();
  node_high_mount_brake_32.name = "\u9ad8\u4f4d\u5239\u8f66\u706f__pivot";
  node_high_mount_brake_32.scale.set(1, 1, 1);
  if (endpoint_high_mount_brake_32) {
    node_high_mount_brake_32.position.copy(endpoint_high_mount_brake_32.start);
    node_high_mount_brake_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_high_mount_brake_32.position.set(0.0, 1.195, -2.484);
    node_high_mount_brake_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_high_mount_brake_32.userData.sculptComponent = {"id": "high-mount-brake", "name": "高位刹车灯", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.48, "height": 0.016, "depth": 0.02, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.195, -2.484], "rotation": [0, 0, 0], "scale": [0.48, 0.016, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_high_mount_brake_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_high_mount_brake_32);
  nodes["high-mount-brake"] = node_high_mount_brake_32;
  const mesh_high_mount_brake_32Geometry = endpoint_high_mount_brake_32
    ? new THREE.CylinderGeometry(endpoint_high_mount_brake_32.endRadius, endpoint_high_mount_brake_32.baseRadius, endpoint_high_mount_brake_32.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_high_mount_brake_32) {
    mesh_high_mount_brake_32Geometry.scale(0.48, 0.016, 0.02);
  }
  const mesh_high_mount_brake_32 = new THREE.Mesh(
    mesh_high_mount_brake_32Geometry,
    materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_high_mount_brake_32.name = "\u9ad8\u4f4d\u5239\u8f66\u706f";
  if (endpoint_high_mount_brake_32) {
    mesh_high_mount_brake_32.position.copy(endpoint_high_mount_brake_32.midpoint);
    mesh_high_mount_brake_32.quaternion.copy(endpoint_high_mount_brake_32.quaternion);
  }
  mesh_high_mount_brake_32.castShadow = options.castShadow ?? true;
  mesh_high_mount_brake_32.receiveShadow = options.receiveShadow ?? true;
  mesh_high_mount_brake_32.userData.sculptComponent = {"id": "high-mount-brake", "name": "高位刹车灯", "level": "micro", "role": "lamp", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.48, "height": 0.016, "depth": 0.02, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.195, -2.484], "rotation": [0, 0, 0], "scale": [0.48, 0.016, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-red", "materialLayers": ["lamp-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 31, 44, 1.0)", "secondaryAlbedo": "rgba(181, 31, 44, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_high_mount_brake_32.add(mesh_high_mount_brake_32);
  meshes["high-mount-brake"] = mesh_high_mount_brake_32;
  colliders["high-mount-brake"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_high_mount_brake_32);

  const endpoint_windshield_33 = makeAttachmentEndpoint(null);
  const node_windshield_33 = new THREE.Group();
  node_windshield_33.name = "\u524d\u6321\u73bb\u7483__pivot";
  node_windshield_33.scale.set(1, 1, 1);
  if (endpoint_windshield_33) {
    node_windshield_33.position.copy(endpoint_windshield_33.start);
    node_windshield_33.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_windshield_33.position.set(0.89, 0.0, 0.0);
    node_windshield_33.rotation.set(0.0, -1.5708, 0.0);
  }
  node_windshield_33.userData.sculptComponent = {"id": "windshield", "name": "前挡玻璃", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视薄壳带挤出，前挡倾角 30°（相对水平面）", "geometryDescriptor": {"profile2D": {"points": [[0.98, 1.062], [0.7, 1.23], [0.47, 1.36], [0.34, 1.452], [0.32614, 1.43241], [0.4574, 1.33957], [0.68789, 1.20928], [0.96765, 1.04142]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "windshield shell band", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.44, "depth": 0.66, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-clear", "materialLayers": ["glass-clear"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-windshield-rake", "name": "大倾角前挡", "kind": "contour", "note": "下沿 z0.98 y1.06 → 上沿 z0.34 y1.45，倾角约 30°，敞篷感舱口"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-top"], "details": ["d-windshield-rake"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 147, 156, 1.0)", "secondaryAlbedo": "rgba(138, 147, 156, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_windshield_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_windshield_33);
  nodes["windshield"] = node_windshield_33;
  const mesh_windshield_33Geometry = endpoint_windshield_33
    ? new THREE.CylinderGeometry(endpoint_windshield_33.endRadius, endpoint_windshield_33.baseRadius, endpoint_windshield_33.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.98, 1.062], [0.7, 1.23], [0.47, 1.36], [0.34, 1.452], [0.32614, 1.43241], [0.4574, 1.33957], [0.68789, 1.20928], [0.96765, 1.04142]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_windshield_33) {
    mesh_windshield_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_windshield_33 = new THREE.Mesh(
    mesh_windshield_33Geometry,
    materialMap["glass-clear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_windshield_33.name = "\u524d\u6321\u73bb\u7483";
  if (endpoint_windshield_33) {
    mesh_windshield_33.position.copy(endpoint_windshield_33.midpoint);
    mesh_windshield_33.quaternion.copy(endpoint_windshield_33.quaternion);
  }
  mesh_windshield_33.castShadow = options.castShadow ?? true;
  mesh_windshield_33.receiveShadow = options.receiveShadow ?? true;
  mesh_windshield_33.userData.sculptComponent = {"id": "windshield", "name": "前挡玻璃", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视薄壳带挤出，前挡倾角 30°（相对水平面）", "geometryDescriptor": {"profile2D": {"points": [[0.98, 1.062], [0.7, 1.23], [0.47, 1.36], [0.34, 1.452], [0.32614, 1.43241], [0.4574, 1.33957], [0.68789, 1.20928], [0.96765, 1.04142]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "windshield shell band", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.44, "depth": 0.66, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-clear", "materialLayers": ["glass-clear"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-windshield-rake", "name": "大倾角前挡", "kind": "contour", "note": "下沿 z0.98 y1.06 → 上沿 z0.34 y1.45，倾角约 30°，敞篷感舱口"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-top"], "details": ["d-windshield-rake"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 147, 156, 1.0)", "secondaryAlbedo": "rgba(138, 147, 156, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_windshield_33.add(mesh_windshield_33);
  meshes["windshield"] = mesh_windshield_33;
  colliders["windshield"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_windshield_33);

  const endpoint_roof_glass_34 = makeAttachmentEndpoint(null);
  const node_roof_glass_34 = new THREE.Group();
  node_roof_glass_34.name = "\u5168\u666f\u5929\u5e55\u73bb\u7483__pivot";
  node_roof_glass_34.scale.set(1, 1, 1);
  if (endpoint_roof_glass_34) {
    node_roof_glass_34.position.copy(endpoint_roof_glass_34.start);
    node_roof_glass_34.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_roof_glass_34.position.set(0.89, 0.0, 0.0);
    node_roof_glass_34.rotation.set(0.0, -1.5708, 0.0);
  }
  node_roof_glass_34.userData.sculptComponent = {"id": "roof-glass", "name": "全景天幕玻璃", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视拱形薄壳带挤出，表达天幕的纵向弧面", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.5], [0.1, 1.556], [-0.2, 1.598], [-0.45, 1.628], [-0.7, 1.622], [-0.95, 1.601], [-1.2, 1.563], [-1.42, 1.518], [-1.55, 1.484], [-1.54241, 1.45498], [-1.41339, 1.48874], [-1.19478, 1.53346], [-0.94648, 1.57121], [-0.69838, 1.59204], [-0.45144, 1.59803], [-0.20389, 1.56825], [0.09464, 1.52648], [0.33318, 1.47078]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "panoramic roof glass shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.16, "depth": 2.06, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-panoramic-roof", "name": "大面积全景天幕", "kind": "gloss", "note": "前 0.34 → 后 -1.70 连续玻璃，顶视图中占车顶 70% 面积"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-34"], "details": ["d-panoramic-roof"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_roof_glass_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_glass_34);
  nodes["roof-glass"] = node_roof_glass_34;
  const mesh_roof_glass_34Geometry = endpoint_roof_glass_34
    ? new THREE.CylinderGeometry(endpoint_roof_glass_34.endRadius, endpoint_roof_glass_34.baseRadius, endpoint_roof_glass_34.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.34, 1.5], [0.1, 1.556], [-0.2, 1.598], [-0.45, 1.628], [-0.7, 1.622], [-0.95, 1.601], [-1.2, 1.563], [-1.42, 1.518], [-1.55, 1.484], [-1.54241, 1.45498], [-1.41339, 1.48874], [-1.19478, 1.53346], [-0.94648, 1.57121], [-0.69838, 1.59204], [-0.45144, 1.59803], [-0.20389, 1.56825], [0.09464, 1.52648], [0.33318, 1.47078]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_roof_glass_34) {
    mesh_roof_glass_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_glass_34 = new THREE.Mesh(
    mesh_roof_glass_34Geometry,
    materialMap["glass-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_glass_34.name = "\u5168\u666f\u5929\u5e55\u73bb\u7483";
  if (endpoint_roof_glass_34) {
    mesh_roof_glass_34.position.copy(endpoint_roof_glass_34.midpoint);
    mesh_roof_glass_34.quaternion.copy(endpoint_roof_glass_34.quaternion);
  }
  mesh_roof_glass_34.castShadow = options.castShadow ?? true;
  mesh_roof_glass_34.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_glass_34.userData.sculptComponent = {"id": "roof-glass", "name": "全景天幕玻璃", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视拱形薄壳带挤出，表达天幕的纵向弧面", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.5], [0.1, 1.556], [-0.2, 1.598], [-0.45, 1.628], [-0.7, 1.622], [-0.95, 1.601], [-1.2, 1.563], [-1.42, 1.518], [-1.55, 1.484], [-1.54241, 1.45498], [-1.41339, 1.48874], [-1.19478, 1.53346], [-0.94648, 1.57121], [-0.69838, 1.59204], [-0.45144, 1.59803], [-0.20389, 1.56825], [0.09464, 1.52648], [0.33318, 1.47078]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "panoramic roof glass shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.16, "depth": 2.06, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-panoramic-roof", "name": "大面积全景天幕", "kind": "gloss", "note": "前 0.34 → 后 -1.70 连续玻璃，顶视图中占车顶 70% 面积"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-34"], "details": ["d-panoramic-roof"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_roof_glass_34.add(mesh_roof_glass_34);
  meshes["roof-glass"] = mesh_roof_glass_34;
  colliders["roof-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_glass_34);

  const endpoint_roof_rail_l_35 = makeAttachmentEndpoint(null);
  const node_roof_rail_l_35 = new THREE.Group();
  node_roof_rail_l_35.name = "\u8f66\u9876\u94a3\u91d1\u8fb9\u6881\uff08\u5de6\uff09__pivot";
  node_roof_rail_l_35.scale.set(1, 1, 1);
  if (endpoint_roof_rail_l_35) {
    node_roof_rail_l_35.position.copy(endpoint_roof_rail_l_35.start);
    node_roof_rail_l_35.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_roof_rail_l_35.position.set(0.948, 0.0, 0.0);
    node_roof_rail_l_35.rotation.set(0.0, -1.5708, 0.0);
  }
  node_roof_rail_l_35.userData.sculptComponent = {"id": "roof-rail-l", "name": "车顶钣金边梁（左）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "天幕外缘的车漆边梁，按同一根拱线降低 4mm 以免与玻璃共面", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.496], [0.1, 1.552], [-0.2, 1.594], [-0.45, 1.624], [-0.7, 1.618], [-0.95, 1.597], [-1.2, 1.559], [-1.42, 1.514], [-1.55, 1.48], [-1.53785, 1.43356], [-1.40943, 1.46718], [-1.19165, 1.51173], [-0.94438, 1.54933], [-0.69741, 1.57007], [-0.4523, 1.57606], [-0.20623, 1.54641], [0.09143, 1.50477], [0.32909, 1.44926]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "roof side rail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.16, "depth": 2.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.948, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rail_l_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_rail_l_35);
  nodes["roof-rail-l"] = node_roof_rail_l_35;
  const mesh_roof_rail_l_35Geometry = endpoint_roof_rail_l_35
    ? new THREE.CylinderGeometry(endpoint_roof_rail_l_35.endRadius, endpoint_roof_rail_l_35.baseRadius, endpoint_roof_rail_l_35.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.34, 1.496], [0.1, 1.552], [-0.2, 1.594], [-0.45, 1.624], [-0.7, 1.618], [-0.95, 1.597], [-1.2, 1.559], [-1.42, 1.514], [-1.55, 1.48], [-1.53785, 1.43356], [-1.40943, 1.46718], [-1.19165, 1.51173], [-0.94438, 1.54933], [-0.69741, 1.57007], [-0.4523, 1.57606], [-0.20623, 1.54641], [0.09143, 1.50477], [0.32909, 1.44926]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_roof_rail_l_35) {
    mesh_roof_rail_l_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_rail_l_35 = new THREE.Mesh(
    mesh_roof_rail_l_35Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_rail_l_35.name = "\u8f66\u9876\u94a3\u91d1\u8fb9\u6881\uff08\u5de6\uff09";
  if (endpoint_roof_rail_l_35) {
    mesh_roof_rail_l_35.position.copy(endpoint_roof_rail_l_35.midpoint);
    mesh_roof_rail_l_35.quaternion.copy(endpoint_roof_rail_l_35.quaternion);
  }
  mesh_roof_rail_l_35.castShadow = options.castShadow ?? true;
  mesh_roof_rail_l_35.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_rail_l_35.userData.sculptComponent = {"id": "roof-rail-l", "name": "车顶钣金边梁（左）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "天幕外缘的车漆边梁，按同一根拱线降低 4mm 以免与玻璃共面", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.496], [0.1, 1.552], [-0.2, 1.594], [-0.45, 1.624], [-0.7, 1.618], [-0.95, 1.597], [-1.2, 1.559], [-1.42, 1.514], [-1.55, 1.48], [-1.53785, 1.43356], [-1.40943, 1.46718], [-1.19165, 1.51173], [-0.94438, 1.54933], [-0.69741, 1.57007], [-0.4523, 1.57606], [-0.20623, 1.54641], [0.09143, 1.50477], [0.32909, 1.44926]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "roof side rail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.16, "depth": 2.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.948, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rail_l_35.add(mesh_roof_rail_l_35);
  meshes["roof-rail-l"] = mesh_roof_rail_l_35;
  colliders["roof-rail-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_rail_l_35);

  const endpoint_roof_rail_r_36 = makeAttachmentEndpoint(null);
  const node_roof_rail_r_36 = new THREE.Group();
  node_roof_rail_r_36.name = "\u8f66\u9876\u94a3\u91d1\u8fb9\u6881\uff08\u53f3\uff09__pivot";
  node_roof_rail_r_36.scale.set(1, 1, 1);
  if (endpoint_roof_rail_r_36) {
    node_roof_rail_r_36.position.copy(endpoint_roof_rail_r_36.start);
    node_roof_rail_r_36.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_roof_rail_r_36.position.set(-0.948, 0.0, 0.0);
    node_roof_rail_r_36.rotation.set(0.0, 1.5708, 0.0);
  }
  node_roof_rail_r_36.userData.sculptComponent = {"id": "roof-rail-r", "name": "车顶钣金边梁（右）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "天幕外缘的车漆边梁，按同一根拱线降低 4mm 以免与玻璃共面", "geometryDescriptor": {"profile2D": {"points": [[-0.32909, 1.44926], [-0.09143, 1.50477], [0.20623, 1.54641], [0.4523, 1.57606], [0.69741, 1.57007], [0.94438, 1.54933], [1.19165, 1.51173], [1.40943, 1.46718], [1.53785, 1.43356], [1.55, 1.48], [1.42, 1.514], [1.2, 1.559], [0.95, 1.597], [0.7, 1.618], [0.45, 1.624], [0.2, 1.594], [-0.1, 1.552], [-0.34, 1.496]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "roof side rail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.16, "depth": 2.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.948, 0, 0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rail_r_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_rail_r_36);
  nodes["roof-rail-r"] = node_roof_rail_r_36;
  const mesh_roof_rail_r_36Geometry = endpoint_roof_rail_r_36
    ? new THREE.CylinderGeometry(endpoint_roof_rail_r_36.endRadius, endpoint_roof_rail_r_36.baseRadius, endpoint_roof_rail_r_36.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.32909, 1.44926], [-0.09143, 1.50477], [0.20623, 1.54641], [0.4523, 1.57606], [0.69741, 1.57007], [0.94438, 1.54933], [1.19165, 1.51173], [1.40943, 1.46718], [1.53785, 1.43356], [1.55, 1.48], [1.42, 1.514], [1.2, 1.559], [0.95, 1.597], [0.7, 1.618], [0.45, 1.624], [0.2, 1.594], [-0.1, 1.552], [-0.34, 1.496]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_roof_rail_r_36) {
    mesh_roof_rail_r_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_rail_r_36 = new THREE.Mesh(
    mesh_roof_rail_r_36Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_rail_r_36.name = "\u8f66\u9876\u94a3\u91d1\u8fb9\u6881\uff08\u53f3\uff09";
  if (endpoint_roof_rail_r_36) {
    mesh_roof_rail_r_36.position.copy(endpoint_roof_rail_r_36.midpoint);
    mesh_roof_rail_r_36.quaternion.copy(endpoint_roof_rail_r_36.quaternion);
  }
  mesh_roof_rail_r_36.castShadow = options.castShadow ?? true;
  mesh_roof_rail_r_36.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_rail_r_36.userData.sculptComponent = {"id": "roof-rail-r", "name": "车顶钣金边梁（右）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "天幕外缘的车漆边梁，按同一根拱线降低 4mm 以免与玻璃共面", "geometryDescriptor": {"profile2D": {"points": [[-0.32909, 1.44926], [-0.09143, 1.50477], [0.20623, 1.54641], [0.4523, 1.57606], [0.69741, 1.57007], [0.94438, 1.54933], [1.19165, 1.51173], [1.40943, 1.46718], [1.53785, 1.43356], [1.55, 1.48], [1.42, 1.514], [1.2, 1.559], [0.95, 1.597], [0.7, 1.618], [0.45, 1.624], [0.2, 1.594], [-0.1, 1.552], [-0.34, 1.496]], "depth": 0.086, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "roof side rail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.16, "depth": 2.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.948, 0, 0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rail_r_36.add(mesh_roof_rail_r_36);
  meshes["roof-rail-r"] = mesh_roof_rail_r_36;
  colliders["roof-rail-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_rail_r_36);

  const endpoint_roof_header_37 = makeAttachmentEndpoint(null);
  const node_roof_header_37 = new THREE.Group();
  node_roof_header_37.name = "\u524d\u9876\u6a2a\u6881__pivot";
  node_roof_header_37.scale.set(1, 1, 1);
  if (endpoint_roof_header_37) {
    node_roof_header_37.position.copy(endpoint_roof_header_37.start);
    node_roof_header_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_header_37.position.set(0.0, 1.496, 0.33);
    node_roof_header_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_header_37.userData.sculptComponent = {"id": "roof-header", "name": "前顶横梁", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.792, "height": 0.046, "depth": 0.09, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.496, 0.33], "rotation": [0, 0, 0], "scale": [1.792, 0.046, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_header_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_header_37);
  nodes["roof-header"] = node_roof_header_37;
  const mesh_roof_header_37Geometry = endpoint_roof_header_37
    ? new THREE.CylinderGeometry(endpoint_roof_header_37.endRadius, endpoint_roof_header_37.baseRadius, endpoint_roof_header_37.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_roof_header_37) {
    mesh_roof_header_37Geometry.scale(1.792, 0.046, 0.09);
  }
  const mesh_roof_header_37 = new THREE.Mesh(
    mesh_roof_header_37Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_header_37.name = "\u524d\u9876\u6a2a\u6881";
  if (endpoint_roof_header_37) {
    mesh_roof_header_37.position.copy(endpoint_roof_header_37.midpoint);
    mesh_roof_header_37.quaternion.copy(endpoint_roof_header_37.quaternion);
  }
  mesh_roof_header_37.castShadow = options.castShadow ?? true;
  mesh_roof_header_37.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_header_37.userData.sculptComponent = {"id": "roof-header", "name": "前顶横梁", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.792, "height": 0.046, "depth": 0.09, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.496, 0.33], "rotation": [0, 0, 0], "scale": [1.792, 0.046, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_header_37.add(mesh_roof_header_37);
  meshes["roof-header"] = mesh_roof_header_37;
  colliders["roof-header"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_header_37);

  const endpoint_rear_glass_38 = makeAttachmentEndpoint(null);
  const node_rear_glass_38 = new THREE.Group();
  node_rear_glass_38.name = "\u540e\u6321\u73bb\u7483\uff08\u6e9c\u80cc\u659c\u9762\uff09__pivot";
  node_rear_glass_38.scale.set(1, 1, 1);
  if (endpoint_rear_glass_38) {
    node_rear_glass_38.position.copy(endpoint_rear_glass_38.start);
    node_rear_glass_38.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_rear_glass_38.position.set(0.89, 0.0, 0.0);
    node_rear_glass_38.rotation.set(0.0, -1.5708, 0.0);
  }
  node_rear_glass_38.userData.sculptComponent = {"id": "rear-glass", "name": "后挡玻璃（溜背斜面）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "溜背斜面薄壳带挤出，后挡相对水平面约 19°（R17 按参考图压俯冲线）", "geometryDescriptor": {"profile2D": {"points": [[-1.55, 1.484], [-1.75, 1.42], [-1.95, 1.34], [-2.15, 1.258], [-2.32, 1.196], [-2.42, 1.18], [-2.41589, 1.15433], [-2.31278, 1.17102], [-2.14057, 1.23377], [-1.94024, 1.3159], [-1.74119, 1.39554], [-1.54208, 1.45924]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "fastback rear glass shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.3, "depth": 0.89, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-fastback-rear", "name": "溜背后挡", "kind": "contour", "note": "车顶 -0.7 起持续下压，-1.55 后斜落至尾门 y1.18，与侧视参考一致"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear", "img-r7-side"], "details": ["d-fastback-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_glass_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rear_glass_38);
  nodes["rear-glass"] = node_rear_glass_38;
  const mesh_rear_glass_38Geometry = endpoint_rear_glass_38
    ? new THREE.CylinderGeometry(endpoint_rear_glass_38.endRadius, endpoint_rear_glass_38.baseRadius, endpoint_rear_glass_38.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-1.55, 1.484], [-1.75, 1.42], [-1.95, 1.34], [-2.15, 1.258], [-2.32, 1.196], [-2.42, 1.18], [-2.41589, 1.15433], [-2.31278, 1.17102], [-2.14057, 1.23377], [-1.94024, 1.3159], [-1.74119, 1.39554], [-1.54208, 1.45924]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_rear_glass_38) {
    mesh_rear_glass_38Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rear_glass_38 = new THREE.Mesh(
    mesh_rear_glass_38Geometry,
    materialMap["glass-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_glass_38.name = "\u540e\u6321\u73bb\u7483\uff08\u6e9c\u80cc\u659c\u9762\uff09";
  if (endpoint_rear_glass_38) {
    mesh_rear_glass_38.position.copy(endpoint_rear_glass_38.midpoint);
    mesh_rear_glass_38.quaternion.copy(endpoint_rear_glass_38.quaternion);
  }
  mesh_rear_glass_38.castShadow = options.castShadow ?? true;
  mesh_rear_glass_38.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_glass_38.userData.sculptComponent = {"id": "rear-glass", "name": "后挡玻璃（溜背斜面）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "溜背斜面薄壳带挤出，后挡相对水平面约 19°（R17 按参考图压俯冲线）", "geometryDescriptor": {"profile2D": {"points": [[-1.55, 1.484], [-1.75, 1.42], [-1.95, 1.34], [-2.15, 1.258], [-2.32, 1.196], [-2.42, 1.18], [-2.41589, 1.15433], [-2.31278, 1.17102], [-2.14057, 1.23377], [-1.94024, 1.3159], [-1.74119, 1.39554], [-1.54208, 1.45924]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "fastback rear glass shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.3, "depth": 0.89, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-fastback-rear", "name": "溜背后挡", "kind": "contour", "note": "车顶 -0.7 起持续下压，-1.55 后斜落至尾门 y1.18，与侧视参考一致"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rear", "img-r7-side"], "details": ["d-fastback-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_glass_38.add(mesh_rear_glass_38);
  meshes["rear-glass"] = mesh_rear_glass_38;
  colliders["rear-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_glass_38);

  const endpoint_side_glass_l_39 = makeAttachmentEndpoint(null);
  const node_side_glass_l_39 = new THREE.Group();
  node_side_glass_l_39.name = "\u4fa7\u7a97\u73bb\u7483\u5e26\uff08\u5de6\uff09__pivot";
  node_side_glass_l_39.scale.set(1, 1, 1);
  if (endpoint_side_glass_l_39) {
    node_side_glass_l_39.position.copy(endpoint_side_glass_l_39.start);
    node_side_glass_l_39.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_side_glass_l_39.position.set(0.918, 0.0, 0.0);
    node_side_glass_l_39.rotation.set(0.0, -1.5708, 0.0);
  }
  node_side_glass_l_39.userData.sculptComponent = {"id": "side-glass-l", "name": "侧窗玻璃带（左）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗轮廓薄片挤出（30mm），只做窗面不封舱", "geometryDescriptor": {"profile2D": {"points": [[0.965, 1.094], [0.7, 1.25], [0.43, 1.412], [0.33, 1.466], [-0.2, 1.556], [-0.7, 1.578], [-1.1, 1.542], [-1.48, 1.46], [-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.6, 1.108], [-0.9, 1.1], [-0.1, 1.098], [0.6, 1.096]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "side window pane extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.5, "depth": 2.86, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.918, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dlo-l", "name": "窗框镀铬 + 后段上扬", "kind": "linework", "note": "窗下沿 y1.096→1.108 微扬，窗框镀铬饰条另件覆盖"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-34"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_side_glass_l_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_side_glass_l_39);
  nodes["side-glass-l"] = node_side_glass_l_39;
  const mesh_side_glass_l_39Geometry = endpoint_side_glass_l_39
    ? new THREE.CylinderGeometry(endpoint_side_glass_l_39.endRadius, endpoint_side_glass_l_39.baseRadius, endpoint_side_glass_l_39.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.965, 1.094], [0.7, 1.25], [0.43, 1.412], [0.33, 1.466], [-0.2, 1.556], [-0.7, 1.578], [-1.1, 1.542], [-1.48, 1.46], [-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.6, 1.108], [-0.9, 1.1], [-0.1, 1.098], [0.6, 1.096]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_side_glass_l_39) {
    mesh_side_glass_l_39Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_side_glass_l_39 = new THREE.Mesh(
    mesh_side_glass_l_39Geometry,
    materialMap["glass-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_side_glass_l_39.name = "\u4fa7\u7a97\u73bb\u7483\u5e26\uff08\u5de6\uff09";
  if (endpoint_side_glass_l_39) {
    mesh_side_glass_l_39.position.copy(endpoint_side_glass_l_39.midpoint);
    mesh_side_glass_l_39.quaternion.copy(endpoint_side_glass_l_39.quaternion);
  }
  mesh_side_glass_l_39.castShadow = options.castShadow ?? true;
  mesh_side_glass_l_39.receiveShadow = options.receiveShadow ?? true;
  mesh_side_glass_l_39.userData.sculptComponent = {"id": "side-glass-l", "name": "侧窗玻璃带（左）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗轮廓薄片挤出（30mm），只做窗面不封舱", "geometryDescriptor": {"profile2D": {"points": [[0.965, 1.094], [0.7, 1.25], [0.43, 1.412], [0.33, 1.466], [-0.2, 1.556], [-0.7, 1.578], [-1.1, 1.542], [-1.48, 1.46], [-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.6, 1.108], [-0.9, 1.1], [-0.1, 1.098], [0.6, 1.096]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "side window pane extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.5, "depth": 2.86, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.918, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dlo-l", "name": "窗框镀铬 + 后段上扬", "kind": "linework", "note": "窗下沿 y1.096→1.108 微扬，窗框镀铬饰条另件覆盖"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-34"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_side_glass_l_39.add(mesh_side_glass_l_39);
  meshes["side-glass-l"] = mesh_side_glass_l_39;
  colliders["side-glass-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_side_glass_l_39);

  const endpoint_belt_chrome_l_40 = makeAttachmentEndpoint(null);
  const node_belt_chrome_l_40 = new THREE.Group();
  node_belt_chrome_l_40.name = "\u7a97\u4e0b\u6cbf\u9540\u94ec\u9970\u6761\uff08\u5de6\uff09__pivot";
  node_belt_chrome_l_40.scale.set(1, 1, 1);
  if (endpoint_belt_chrome_l_40) {
    node_belt_chrome_l_40.position.copy(endpoint_belt_chrome_l_40.start);
    node_belt_chrome_l_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_belt_chrome_l_40.position.set(0.93, 1.096, -0.48);
    node_belt_chrome_l_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_belt_chrome_l_40.userData.sculptComponent = {"id": "belt-chrome-l", "name": "窗下沿镀铬饰条（左）", "level": "micro", "role": "trim", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.02, "depth": 2.7, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.93, 1.096, -0.48], "rotation": [0, 0, 0], "scale": [0.014, 0.02, 2.7]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_belt_chrome_l_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_belt_chrome_l_40);
  nodes["belt-chrome-l"] = node_belt_chrome_l_40;
  const mesh_belt_chrome_l_40Geometry = endpoint_belt_chrome_l_40
    ? new THREE.CylinderGeometry(endpoint_belt_chrome_l_40.endRadius, endpoint_belt_chrome_l_40.baseRadius, endpoint_belt_chrome_l_40.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_belt_chrome_l_40) {
    mesh_belt_chrome_l_40Geometry.scale(0.014, 0.02, 2.7);
  }
  const mesh_belt_chrome_l_40 = new THREE.Mesh(
    mesh_belt_chrome_l_40Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_belt_chrome_l_40.name = "\u7a97\u4e0b\u6cbf\u9540\u94ec\u9970\u6761\uff08\u5de6\uff09";
  if (endpoint_belt_chrome_l_40) {
    mesh_belt_chrome_l_40.position.copy(endpoint_belt_chrome_l_40.midpoint);
    mesh_belt_chrome_l_40.quaternion.copy(endpoint_belt_chrome_l_40.quaternion);
  }
  mesh_belt_chrome_l_40.castShadow = options.castShadow ?? true;
  mesh_belt_chrome_l_40.receiveShadow = options.receiveShadow ?? true;
  mesh_belt_chrome_l_40.userData.sculptComponent = {"id": "belt-chrome-l", "name": "窗下沿镀铬饰条（左）", "level": "micro", "role": "trim", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.02, "depth": 2.7, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.93, 1.096, -0.48], "rotation": [0, 0, 0], "scale": [0.014, 0.02, 2.7]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_belt_chrome_l_40.add(mesh_belt_chrome_l_40);
  meshes["belt-chrome-l"] = mesh_belt_chrome_l_40;
  colliders["belt-chrome-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_belt_chrome_l_40);

  const endpoint_apillar_l_41 = makeAttachmentEndpoint(null);
  const node_apillar_l_41 = new THREE.Group();
  node_apillar_l_41.name = "A \u67f1\uff08\u5de6\uff09__pivot";
  node_apillar_l_41.scale.set(1, 1, 1);
  if (endpoint_apillar_l_41) {
    node_apillar_l_41.position.copy(endpoint_apillar_l_41.start);
    node_apillar_l_41.rotation.set(-1.048, 0.0, 0.0);
  } else {
    node_apillar_l_41.position.set(0.845, 1.268, 0.66);
    node_apillar_l_41.rotation.set(-1.048, 0.0, 0.0);
  }
  node_apillar_l_41.userData.sculptComponent = {"id": "apillar-l", "name": "A 柱（左）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.74, "depth": 0.076, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.845, 1.268, 0.66], "rotation": [-1.048, 0, 0], "scale": [0.086, 0.74, 0.076]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_apillar_l_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_apillar_l_41);
  nodes["apillar-l"] = node_apillar_l_41;
  const mesh_apillar_l_41Geometry = endpoint_apillar_l_41
    ? new THREE.CylinderGeometry(endpoint_apillar_l_41.endRadius, endpoint_apillar_l_41.baseRadius, endpoint_apillar_l_41.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_apillar_l_41) {
    mesh_apillar_l_41Geometry.scale(0.086, 0.74, 0.076);
  }
  const mesh_apillar_l_41 = new THREE.Mesh(
    mesh_apillar_l_41Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_apillar_l_41.name = "A \u67f1\uff08\u5de6\uff09";
  if (endpoint_apillar_l_41) {
    mesh_apillar_l_41.position.copy(endpoint_apillar_l_41.midpoint);
    mesh_apillar_l_41.quaternion.copy(endpoint_apillar_l_41.quaternion);
  }
  mesh_apillar_l_41.castShadow = options.castShadow ?? true;
  mesh_apillar_l_41.receiveShadow = options.receiveShadow ?? true;
  mesh_apillar_l_41.userData.sculptComponent = {"id": "apillar-l", "name": "A 柱（左）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.74, "depth": 0.076, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.845, 1.268, 0.66], "rotation": [-1.048, 0, 0], "scale": [0.086, 0.74, 0.076]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_apillar_l_41.add(mesh_apillar_l_41);
  meshes["apillar-l"] = mesh_apillar_l_41;
  colliders["apillar-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_apillar_l_41);

  const endpoint_bpillar_l_42 = makeAttachmentEndpoint(null);
  const node_bpillar_l_42 = new THREE.Group();
  node_bpillar_l_42.name = "B \u67f1\uff08\u5de6\uff09__pivot";
  node_bpillar_l_42.scale.set(1, 1, 1);
  if (endpoint_bpillar_l_42) {
    node_bpillar_l_42.position.copy(endpoint_bpillar_l_42.start);
    node_bpillar_l_42.rotation.set(-0.08, 0.0, 0.0);
  } else {
    node_bpillar_l_42.position.set(0.922, 1.33, 0.17);
    node_bpillar_l_42.rotation.set(-0.08, 0.0, 0.0);
  }
  node_bpillar_l_42.userData.sculptComponent = {"id": "bpillar-l", "name": "B 柱（左）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.47, "depth": 0.055, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.922, 1.33, 0.17], "rotation": [-0.08, 0, 0], "scale": [0.03, 0.47, 0.055]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_bpillar_l_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_bpillar_l_42);
  nodes["bpillar-l"] = node_bpillar_l_42;
  const mesh_bpillar_l_42Geometry = endpoint_bpillar_l_42
    ? new THREE.CylinderGeometry(endpoint_bpillar_l_42.endRadius, endpoint_bpillar_l_42.baseRadius, endpoint_bpillar_l_42.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bpillar_l_42) {
    mesh_bpillar_l_42Geometry.scale(0.03, 0.47, 0.055);
  }
  const mesh_bpillar_l_42 = new THREE.Mesh(
    mesh_bpillar_l_42Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bpillar_l_42.name = "B \u67f1\uff08\u5de6\uff09";
  if (endpoint_bpillar_l_42) {
    mesh_bpillar_l_42.position.copy(endpoint_bpillar_l_42.midpoint);
    mesh_bpillar_l_42.quaternion.copy(endpoint_bpillar_l_42.quaternion);
  }
  mesh_bpillar_l_42.castShadow = options.castShadow ?? true;
  mesh_bpillar_l_42.receiveShadow = options.receiveShadow ?? true;
  mesh_bpillar_l_42.userData.sculptComponent = {"id": "bpillar-l", "name": "B 柱（左）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.47, "depth": 0.055, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.922, 1.33, 0.17], "rotation": [-0.08, 0, 0], "scale": [0.03, 0.47, 0.055]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_bpillar_l_42.add(mesh_bpillar_l_42);
  meshes["bpillar-l"] = mesh_bpillar_l_42;
  colliders["bpillar-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_bpillar_l_42);

  const endpoint_cpillar_l_43 = makeAttachmentEndpoint(null);
  const node_cpillar_l_43 = new THREE.Group();
  node_cpillar_l_43.name = "C \u67f1\uff08\u5de6\uff09__pivot";
  node_cpillar_l_43.scale.set(1, 1, 1);
  if (endpoint_cpillar_l_43) {
    node_cpillar_l_43.position.copy(endpoint_cpillar_l_43.start);
    node_cpillar_l_43.rotation.set(-0.3, 0.0, 0.0);
  } else {
    node_cpillar_l_43.position.set(0.922, 1.33, -1.42);
    node_cpillar_l_43.rotation.set(-0.3, 0.0, 0.0);
  }
  node_cpillar_l_43.userData.sculptComponent = {"id": "cpillar-l", "name": "C 柱（左）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.075, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.922, 1.33, -1.42], "rotation": [-0.3, 0, 0], "scale": [0.03, 0.4, 0.075]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cpillar_l_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_cpillar_l_43);
  nodes["cpillar-l"] = node_cpillar_l_43;
  const mesh_cpillar_l_43Geometry = endpoint_cpillar_l_43
    ? new THREE.CylinderGeometry(endpoint_cpillar_l_43.endRadius, endpoint_cpillar_l_43.baseRadius, endpoint_cpillar_l_43.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_cpillar_l_43) {
    mesh_cpillar_l_43Geometry.scale(0.03, 0.4, 0.075);
  }
  const mesh_cpillar_l_43 = new THREE.Mesh(
    mesh_cpillar_l_43Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cpillar_l_43.name = "C \u67f1\uff08\u5de6\uff09";
  if (endpoint_cpillar_l_43) {
    mesh_cpillar_l_43.position.copy(endpoint_cpillar_l_43.midpoint);
    mesh_cpillar_l_43.quaternion.copy(endpoint_cpillar_l_43.quaternion);
  }
  mesh_cpillar_l_43.castShadow = options.castShadow ?? true;
  mesh_cpillar_l_43.receiveShadow = options.receiveShadow ?? true;
  mesh_cpillar_l_43.userData.sculptComponent = {"id": "cpillar-l", "name": "C 柱（左）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.075, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.922, 1.33, -1.42], "rotation": [-0.3, 0, 0], "scale": [0.03, 0.4, 0.075]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cpillar_l_43.add(mesh_cpillar_l_43);
  meshes["cpillar-l"] = mesh_cpillar_l_43;
  colliders["cpillar-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cpillar_l_43);

  const endpoint_side_glass_r_44 = makeAttachmentEndpoint(null);
  const node_side_glass_r_44 = new THREE.Group();
  node_side_glass_r_44.name = "\u4fa7\u7a97\u73bb\u7483\u5e26\uff08\u53f3\uff09__pivot";
  node_side_glass_r_44.scale.set(1, 1, 1);
  if (endpoint_side_glass_r_44) {
    node_side_glass_r_44.position.copy(endpoint_side_glass_r_44.start);
    node_side_glass_r_44.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_side_glass_r_44.position.set(-0.918, 0.0, 0.0);
    node_side_glass_r_44.rotation.set(0.0, 1.5708, 0.0);
  }
  node_side_glass_r_44.userData.sculptComponent = {"id": "side-glass-r", "name": "侧窗玻璃带（右）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗轮廓薄片挤出（30mm），只做窗面不封舱", "geometryDescriptor": {"profile2D": {"points": [[-0.6, 1.096], [0.1, 1.098], [0.9, 1.1], [1.6, 1.108], [1.88, 1.15], [1.88, 1.262], [1.76, 1.39], [1.48, 1.46], [1.1, 1.542], [0.7, 1.578], [0.2, 1.556], [-0.33, 1.466], [-0.43, 1.412], [-0.7, 1.25], [-0.965, 1.094]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "side window pane extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.5, "depth": 2.86, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.918, 0, 0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dlo-r", "name": "窗框镀铬 + 后段上扬", "kind": "linework", "note": "窗下沿 y1.096→1.108 微扬，窗框镀铬饰条另件覆盖"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-34"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_side_glass_r_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_side_glass_r_44);
  nodes["side-glass-r"] = node_side_glass_r_44;
  const mesh_side_glass_r_44Geometry = endpoint_side_glass_r_44
    ? new THREE.CylinderGeometry(endpoint_side_glass_r_44.endRadius, endpoint_side_glass_r_44.baseRadius, endpoint_side_glass_r_44.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.6, 1.096], [0.1, 1.098], [0.9, 1.1], [1.6, 1.108], [1.88, 1.15], [1.88, 1.262], [1.76, 1.39], [1.48, 1.46], [1.1, 1.542], [0.7, 1.578], [0.2, 1.556], [-0.33, 1.466], [-0.43, 1.412], [-0.7, 1.25], [-0.965, 1.094]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_side_glass_r_44) {
    mesh_side_glass_r_44Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_side_glass_r_44 = new THREE.Mesh(
    mesh_side_glass_r_44Geometry,
    materialMap["glass-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_side_glass_r_44.name = "\u4fa7\u7a97\u73bb\u7483\u5e26\uff08\u53f3\uff09";
  if (endpoint_side_glass_r_44) {
    mesh_side_glass_r_44.position.copy(endpoint_side_glass_r_44.midpoint);
    mesh_side_glass_r_44.quaternion.copy(endpoint_side_glass_r_44.quaternion);
  }
  mesh_side_glass_r_44.castShadow = options.castShadow ?? true;
  mesh_side_glass_r_44.receiveShadow = options.receiveShadow ?? true;
  mesh_side_glass_r_44.userData.sculptComponent = {"id": "side-glass-r", "name": "侧窗玻璃带（右）", "level": "meso", "role": "glass", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗轮廓薄片挤出（30mm），只做窗面不封舱", "geometryDescriptor": {"profile2D": {"points": [[-0.6, 1.096], [0.1, 1.098], [0.9, 1.1], [1.6, 1.108], [1.88, 1.15], [1.88, 1.262], [1.76, 1.39], [1.48, 1.46], [1.1, 1.542], [0.7, 1.578], [0.2, 1.556], [-0.33, 1.466], [-0.43, 1.412], [-0.7, 1.25], [-0.965, 1.094]], "depth": 0.03, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "side window pane extrusion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.5, "depth": 2.86, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.918, 0, 0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dlo-r", "name": "窗框镀铬 + 后段上扬", "kind": "linework", "note": "窗下沿 y1.096→1.108 微扬，窗框镀铬饰条另件覆盖"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-34"], "details": ["d-dlo-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 26, 34, 1.0)", "secondaryAlbedo": "rgba(20, 26, 34, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_side_glass_r_44.add(mesh_side_glass_r_44);
  meshes["side-glass-r"] = mesh_side_glass_r_44;
  colliders["side-glass-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_side_glass_r_44);

  const endpoint_belt_chrome_r_45 = makeAttachmentEndpoint(null);
  const node_belt_chrome_r_45 = new THREE.Group();
  node_belt_chrome_r_45.name = "\u7a97\u4e0b\u6cbf\u9540\u94ec\u9970\u6761\uff08\u53f3\uff09__pivot";
  node_belt_chrome_r_45.scale.set(1, 1, 1);
  if (endpoint_belt_chrome_r_45) {
    node_belt_chrome_r_45.position.copy(endpoint_belt_chrome_r_45.start);
    node_belt_chrome_r_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_belt_chrome_r_45.position.set(-0.93, 1.096, -0.48);
    node_belt_chrome_r_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_belt_chrome_r_45.userData.sculptComponent = {"id": "belt-chrome-r", "name": "窗下沿镀铬饰条（右）", "level": "micro", "role": "trim", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.02, "depth": 2.7, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.93, 1.096, -0.48], "rotation": [0, 0, 0], "scale": [0.014, 0.02, 2.7]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-dlo-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_belt_chrome_r_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_belt_chrome_r_45);
  nodes["belt-chrome-r"] = node_belt_chrome_r_45;
  const mesh_belt_chrome_r_45Geometry = endpoint_belt_chrome_r_45
    ? new THREE.CylinderGeometry(endpoint_belt_chrome_r_45.endRadius, endpoint_belt_chrome_r_45.baseRadius, endpoint_belt_chrome_r_45.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_belt_chrome_r_45) {
    mesh_belt_chrome_r_45Geometry.scale(0.014, 0.02, 2.7);
  }
  const mesh_belt_chrome_r_45 = new THREE.Mesh(
    mesh_belt_chrome_r_45Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_belt_chrome_r_45.name = "\u7a97\u4e0b\u6cbf\u9540\u94ec\u9970\u6761\uff08\u53f3\uff09";
  if (endpoint_belt_chrome_r_45) {
    mesh_belt_chrome_r_45.position.copy(endpoint_belt_chrome_r_45.midpoint);
    mesh_belt_chrome_r_45.quaternion.copy(endpoint_belt_chrome_r_45.quaternion);
  }
  mesh_belt_chrome_r_45.castShadow = options.castShadow ?? true;
  mesh_belt_chrome_r_45.receiveShadow = options.receiveShadow ?? true;
  mesh_belt_chrome_r_45.userData.sculptComponent = {"id": "belt-chrome-r", "name": "窗下沿镀铬饰条（右）", "level": "micro", "role": "trim", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.02, "depth": 2.7, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.93, 1.096, -0.48], "rotation": [0, 0, 0], "scale": [0.014, 0.02, 2.7]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-dlo-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_belt_chrome_r_45.add(mesh_belt_chrome_r_45);
  meshes["belt-chrome-r"] = mesh_belt_chrome_r_45;
  colliders["belt-chrome-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_belt_chrome_r_45);

  const endpoint_apillar_r_46 = makeAttachmentEndpoint(null);
  const node_apillar_r_46 = new THREE.Group();
  node_apillar_r_46.name = "A \u67f1\uff08\u53f3\uff09__pivot";
  node_apillar_r_46.scale.set(1, 1, 1);
  if (endpoint_apillar_r_46) {
    node_apillar_r_46.position.copy(endpoint_apillar_r_46.start);
    node_apillar_r_46.rotation.set(-1.048, 0.0, 0.0);
  } else {
    node_apillar_r_46.position.set(-0.845, 1.268, 0.66);
    node_apillar_r_46.rotation.set(-1.048, 0.0, 0.0);
  }
  node_apillar_r_46.userData.sculptComponent = {"id": "apillar-r", "name": "A 柱（右）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.74, "depth": 0.076, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.845, 1.268, 0.66], "rotation": [-1.048, 0, 0], "scale": [0.086, 0.74, 0.076]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_apillar_r_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_apillar_r_46);
  nodes["apillar-r"] = node_apillar_r_46;
  const mesh_apillar_r_46Geometry = endpoint_apillar_r_46
    ? new THREE.CylinderGeometry(endpoint_apillar_r_46.endRadius, endpoint_apillar_r_46.baseRadius, endpoint_apillar_r_46.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_apillar_r_46) {
    mesh_apillar_r_46Geometry.scale(0.086, 0.74, 0.076);
  }
  const mesh_apillar_r_46 = new THREE.Mesh(
    mesh_apillar_r_46Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_apillar_r_46.name = "A \u67f1\uff08\u53f3\uff09";
  if (endpoint_apillar_r_46) {
    mesh_apillar_r_46.position.copy(endpoint_apillar_r_46.midpoint);
    mesh_apillar_r_46.quaternion.copy(endpoint_apillar_r_46.quaternion);
  }
  mesh_apillar_r_46.castShadow = options.castShadow ?? true;
  mesh_apillar_r_46.receiveShadow = options.receiveShadow ?? true;
  mesh_apillar_r_46.userData.sculptComponent = {"id": "apillar-r", "name": "A 柱（右）", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.086, "height": 0.74, "depth": 0.076, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.845, 1.268, 0.66], "rotation": [-1.048, 0, 0], "scale": [0.086, 0.74, 0.076]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-front", "img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_apillar_r_46.add(mesh_apillar_r_46);
  meshes["apillar-r"] = mesh_apillar_r_46;
  colliders["apillar-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_apillar_r_46);

  const endpoint_bpillar_r_47 = makeAttachmentEndpoint(null);
  const node_bpillar_r_47 = new THREE.Group();
  node_bpillar_r_47.name = "B \u67f1\uff08\u53f3\uff09__pivot";
  node_bpillar_r_47.scale.set(1, 1, 1);
  if (endpoint_bpillar_r_47) {
    node_bpillar_r_47.position.copy(endpoint_bpillar_r_47.start);
    node_bpillar_r_47.rotation.set(-0.08, 0.0, 0.0);
  } else {
    node_bpillar_r_47.position.set(-0.922, 1.33, 0.17);
    node_bpillar_r_47.rotation.set(-0.08, 0.0, 0.0);
  }
  node_bpillar_r_47.userData.sculptComponent = {"id": "bpillar-r", "name": "B 柱（右）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.47, "depth": 0.055, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.922, 1.33, 0.17], "rotation": [-0.08, 0, 0], "scale": [0.03, 0.47, 0.055]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_bpillar_r_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_bpillar_r_47);
  nodes["bpillar-r"] = node_bpillar_r_47;
  const mesh_bpillar_r_47Geometry = endpoint_bpillar_r_47
    ? new THREE.CylinderGeometry(endpoint_bpillar_r_47.endRadius, endpoint_bpillar_r_47.baseRadius, endpoint_bpillar_r_47.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bpillar_r_47) {
    mesh_bpillar_r_47Geometry.scale(0.03, 0.47, 0.055);
  }
  const mesh_bpillar_r_47 = new THREE.Mesh(
    mesh_bpillar_r_47Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bpillar_r_47.name = "B \u67f1\uff08\u53f3\uff09";
  if (endpoint_bpillar_r_47) {
    mesh_bpillar_r_47.position.copy(endpoint_bpillar_r_47.midpoint);
    mesh_bpillar_r_47.quaternion.copy(endpoint_bpillar_r_47.quaternion);
  }
  mesh_bpillar_r_47.castShadow = options.castShadow ?? true;
  mesh_bpillar_r_47.receiveShadow = options.receiveShadow ?? true;
  mesh_bpillar_r_47.userData.sculptComponent = {"id": "bpillar-r", "name": "B 柱（右）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.47, "depth": 0.055, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.922, 1.33, 0.17], "rotation": [-0.08, 0, 0], "scale": [0.03, 0.47, 0.055]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_bpillar_r_47.add(mesh_bpillar_r_47);
  meshes["bpillar-r"] = mesh_bpillar_r_47;
  colliders["bpillar-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_bpillar_r_47);

  const endpoint_cpillar_r_48 = makeAttachmentEndpoint(null);
  const node_cpillar_r_48 = new THREE.Group();
  node_cpillar_r_48.name = "C \u67f1\uff08\u53f3\uff09__pivot";
  node_cpillar_r_48.scale.set(1, 1, 1);
  if (endpoint_cpillar_r_48) {
    node_cpillar_r_48.position.copy(endpoint_cpillar_r_48.start);
    node_cpillar_r_48.rotation.set(-0.3, 0.0, 0.0);
  } else {
    node_cpillar_r_48.position.set(-0.922, 1.33, -1.42);
    node_cpillar_r_48.rotation.set(-0.3, 0.0, 0.0);
  }
  node_cpillar_r_48.userData.sculptComponent = {"id": "cpillar-r", "name": "C 柱（右）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.075, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.922, 1.33, -1.42], "rotation": [-0.3, 0, 0], "scale": [0.03, 0.4, 0.075]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cpillar_r_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_cpillar_r_48);
  nodes["cpillar-r"] = node_cpillar_r_48;
  const mesh_cpillar_r_48Geometry = endpoint_cpillar_r_48
    ? new THREE.CylinderGeometry(endpoint_cpillar_r_48.endRadius, endpoint_cpillar_r_48.baseRadius, endpoint_cpillar_r_48.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_cpillar_r_48) {
    mesh_cpillar_r_48Geometry.scale(0.03, 0.4, 0.075);
  }
  const mesh_cpillar_r_48 = new THREE.Mesh(
    mesh_cpillar_r_48Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cpillar_r_48.name = "C \u67f1\uff08\u53f3\uff09";
  if (endpoint_cpillar_r_48) {
    mesh_cpillar_r_48.position.copy(endpoint_cpillar_r_48.midpoint);
    mesh_cpillar_r_48.quaternion.copy(endpoint_cpillar_r_48.quaternion);
  }
  mesh_cpillar_r_48.castShadow = options.castShadow ?? true;
  mesh_cpillar_r_48.receiveShadow = options.receiveShadow ?? true;
  mesh_cpillar_r_48.userData.sculptComponent = {"id": "cpillar-r", "name": "C 柱（右）", "level": "micro", "role": "body", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.075, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.922, 1.33, -1.42], "rotation": [-0.3, 0, 0], "scale": [0.03, 0.4, 0.075]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-pillar-black"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cpillar_r_48.add(mesh_cpillar_r_48);
  meshes["cpillar-r"] = mesh_cpillar_r_48;
  colliders["cpillar-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cpillar_r_48);

  const endpoint_dpillar_49 = makeAttachmentEndpoint(null);
  const node_dpillar_49 = new THREE.Group();
  node_dpillar_49.name = "D \u67f1\uff08\u6e9c\u80cc\u5c3e\u67f1\uff0c\u8f66\u6f06\uff09__pivot";
  node_dpillar_49.scale.set(1, 1, 1);
  if (endpoint_dpillar_49) {
    node_dpillar_49.position.copy(endpoint_dpillar_49.start);
    node_dpillar_49.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_dpillar_49.position.set(0.89, 0.0, 0.0);
    node_dpillar_49.rotation.set(0.0, -1.5708, 0.0);
  }
  node_dpillar_49.userData.sculptComponent = {"id": "dpillar", "name": "D 柱（溜背尾柱，车漆）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视楔形薄壳挤出，封住后挡玻璃与侧窗之间的 D 柱面", "geometryDescriptor": {"profile2D": {"points": [[-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.7, 1.108], [-1.56, 1.18], [-1.6, 1.445]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "D-pillar wedge shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.46, "depth": 0.5, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_dpillar_49);
  nodes["dpillar"] = node_dpillar_49;
  const mesh_dpillar_49Geometry = endpoint_dpillar_49
    ? new THREE.CylinderGeometry(endpoint_dpillar_49.endRadius, endpoint_dpillar_49.baseRadius, endpoint_dpillar_49.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.7, 1.108], [-1.56, 1.18], [-1.6, 1.445]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}});
  if (!endpoint_dpillar_49) {
    mesh_dpillar_49Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dpillar_49 = new THREE.Mesh(
    mesh_dpillar_49Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dpillar_49.name = "D \u67f1\uff08\u6e9c\u80cc\u5c3e\u67f1\uff0c\u8f66\u6f06\uff09";
  if (endpoint_dpillar_49) {
    mesh_dpillar_49.position.copy(endpoint_dpillar_49.midpoint);
    mesh_dpillar_49.quaternion.copy(endpoint_dpillar_49.quaternion);
  }
  mesh_dpillar_49.castShadow = options.castShadow ?? true;
  mesh_dpillar_49.receiveShadow = options.receiveShadow ?? true;
  mesh_dpillar_49.userData.sculptComponent = {"id": "dpillar", "name": "D 柱（溜背尾柱，车漆）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.88, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧视楔形薄壳挤出，封住后挡玻璃与侧窗之间的 D 柱面", "geometryDescriptor": {"profile2D": {"points": [[-1.76, 1.39], [-1.88, 1.262], [-1.88, 1.15], [-1.7, 1.108], [-1.56, 1.18], [-1.6, 1.445]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.008, "offset": -0.008, "segments": 2}}, "topologyIntent": "D-pillar wedge shell", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.78, "height": 0.46, "depth": 0.5, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side", "img-r7-rear"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_49.add(mesh_dpillar_49);
  meshes["dpillar"] = mesh_dpillar_49;
  colliders["dpillar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dpillar_49);

  const endpoint_roof_lidar_50 = makeAttachmentEndpoint(null);
  const node_roof_lidar_50 = new THREE.Group();
  node_roof_lidar_50.name = "\u8f66\u9876\u524d\u4e2d\u592e\u6fc0\u5149\u96f7\u8fbe\u51f8\u53f0__pivot";
  node_roof_lidar_50.scale.set(1, 1, 1);
  if (endpoint_roof_lidar_50) {
    node_roof_lidar_50.position.copy(endpoint_roof_lidar_50.start);
    node_roof_lidar_50.rotation.set(-1.5708, 0.0, 0.0);
  } else {
    node_roof_lidar_50.position.set(0.0, 1.56, 0.06);
    node_roof_lidar_50.rotation.set(-1.5708, 0.0, 0.0);
  }
  node_roof_lidar_50.userData.sculptComponent = {"id": "roof-lidar", "name": "车顶前中央激光雷达凸台", "level": "meso", "role": "sensor", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "俯视圆角矩形凸台沿 +Y 挤出 62mm（rotX -90° 使挤出方向朝上）", "geometryDescriptor": {"profile2D": {"points": [[0.06, -0.075], [0.07339, -0.07234], [0.08475, -0.06475], [0.09234, -0.05339], [0.095, -0.04], [0.095, 0.04], [0.09234, 0.05339], [0.08475, 0.06475], [0.07339, 0.07234], [0.06, 0.075], [-0.06, 0.075], [-0.07339, 0.07234], [-0.08475, 0.06475], [-0.09234, 0.05339], [-0.095, 0.04], [-0.095, -0.04], [-0.09234, -0.05339], [-0.08475, -0.06475], [-0.07339, -0.07234], [-0.06, -0.075]], "depth": 0.06, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "lidar pod", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.19, "height": 0.06, "depth": 0.15, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.56, 0.06], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-roof-lidar", "name": "顶置激光雷达凸台", "kind": "bevel", "note": "顶视图车顶前中央一个 19×15cm 凸台，是 R7 智驾版的身份特征"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top"], "details": ["d-roof-lidar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_lidar_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_lidar_50);
  nodes["roof-lidar"] = node_roof_lidar_50;
  const mesh_roof_lidar_50Geometry = endpoint_roof_lidar_50
    ? new THREE.CylinderGeometry(endpoint_roof_lidar_50.endRadius, endpoint_roof_lidar_50.baseRadius, endpoint_roof_lidar_50.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.06, -0.075], [0.07339, -0.07234], [0.08475, -0.06475], [0.09234, -0.05339], [0.095, -0.04], [0.095, 0.04], [0.09234, 0.05339], [0.08475, 0.06475], [0.07339, 0.07234], [0.06, 0.075], [-0.06, 0.075], [-0.07339, 0.07234], [-0.08475, 0.06475], [-0.09234, 0.05339], [-0.095, 0.04], [-0.095, -0.04], [-0.09234, -0.05339], [-0.08475, -0.06475], [-0.07339, -0.07234], [-0.06, -0.075]], "depth": 0.06, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}});
  if (!endpoint_roof_lidar_50) {
    mesh_roof_lidar_50Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_lidar_50 = new THREE.Mesh(
    mesh_roof_lidar_50Geometry,
    materialMap["housing-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_lidar_50.name = "\u8f66\u9876\u524d\u4e2d\u592e\u6fc0\u5149\u96f7\u8fbe\u51f8\u53f0";
  if (endpoint_roof_lidar_50) {
    mesh_roof_lidar_50.position.copy(endpoint_roof_lidar_50.midpoint);
    mesh_roof_lidar_50.quaternion.copy(endpoint_roof_lidar_50.quaternion);
  }
  mesh_roof_lidar_50.castShadow = options.castShadow ?? true;
  mesh_roof_lidar_50.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_lidar_50.userData.sculptComponent = {"id": "roof-lidar", "name": "车顶前中央激光雷达凸台", "level": "meso", "role": "sensor", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "俯视圆角矩形凸台沿 +Y 挤出 62mm（rotX -90° 使挤出方向朝上）", "geometryDescriptor": {"profile2D": {"points": [[0.06, -0.075], [0.07339, -0.07234], [0.08475, -0.06475], [0.09234, -0.05339], [0.095, -0.04], [0.095, 0.04], [0.09234, 0.05339], [0.08475, 0.06475], [0.07339, 0.07234], [0.06, 0.075], [-0.06, 0.075], [-0.07339, 0.07234], [-0.08475, 0.06475], [-0.09234, 0.05339], [-0.095, 0.04], [-0.095, -0.04], [-0.09234, -0.05339], [-0.08475, -0.06475], [-0.07339, -0.07234], [-0.06, -0.075]], "depth": 0.06, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 2}}, "topologyIntent": "lidar pod", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.19, "height": 0.06, "depth": 0.15, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.56, 0.06], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-roof-lidar", "name": "顶置激光雷达凸台", "kind": "bevel", "note": "顶视图车顶前中央一个 19×15cm 凸台，是 R7 智驾版的身份特征"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-top"], "details": ["d-roof-lidar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 23, 26, 1.0)", "secondaryAlbedo": "rgba(20, 23, 26, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_lidar_50.add(mesh_roof_lidar_50);
  meshes["roof-lidar"] = mesh_roof_lidar_50;
  colliders["roof-lidar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_lidar_50);

  const endpoint_rocker_l_51 = makeAttachmentEndpoint(null);
  const node_rocker_l_51 = new THREE.Group();
  node_rocker_l_51.name = "\u4fa7\u88d9\u9ed1\u5316\u62a4\u677f\uff08\u5de6\uff09__pivot";
  node_rocker_l_51.scale.set(1, 1, 1);
  if (endpoint_rocker_l_51) {
    node_rocker_l_51.position.copy(endpoint_rocker_l_51.start);
    node_rocker_l_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rocker_l_51.position.set(0.938, 0.238, 0.02);
    node_rocker_l_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_rocker_l_51.userData.sculptComponent = {"id": "rocker-l", "name": "侧裙黑化护板（左）", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.066, "height": 0.12, "depth": 2.24, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.938, 0.238, 0.02], "rotation": [0, 0, 0], "scale": [0.066, 0.12, 2.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rocker-l", "name": "门槛黑化条", "kind": "linework", "note": "轮拱之间的黑色侧裙，参考侧视图中车身下沿那道暗带"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-rocker-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_l_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rocker_l_51);
  nodes["rocker-l"] = node_rocker_l_51;
  const mesh_rocker_l_51Geometry = endpoint_rocker_l_51
    ? new THREE.CylinderGeometry(endpoint_rocker_l_51.endRadius, endpoint_rocker_l_51.baseRadius, endpoint_rocker_l_51.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rocker_l_51) {
    mesh_rocker_l_51Geometry.scale(0.066, 0.12, 2.24);
  }
  const mesh_rocker_l_51 = new THREE.Mesh(
    mesh_rocker_l_51Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rocker_l_51.name = "\u4fa7\u88d9\u9ed1\u5316\u62a4\u677f\uff08\u5de6\uff09";
  if (endpoint_rocker_l_51) {
    mesh_rocker_l_51.position.copy(endpoint_rocker_l_51.midpoint);
    mesh_rocker_l_51.quaternion.copy(endpoint_rocker_l_51.quaternion);
  }
  mesh_rocker_l_51.castShadow = options.castShadow ?? true;
  mesh_rocker_l_51.receiveShadow = options.receiveShadow ?? true;
  mesh_rocker_l_51.userData.sculptComponent = {"id": "rocker-l", "name": "侧裙黑化护板（左）", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.066, "height": 0.12, "depth": 2.24, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.938, 0.238, 0.02], "rotation": [0, 0, 0], "scale": [0.066, 0.12, 2.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rocker-l", "name": "门槛黑化条", "kind": "linework", "note": "轮拱之间的黑色侧裙，参考侧视图中车身下沿那道暗带"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-rocker-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_l_51.add(mesh_rocker_l_51);
  meshes["rocker-l"] = mesh_rocker_l_51;
  colliders["rocker-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rocker_l_51);

  const endpoint_mirror_body_l_52 = makeAttachmentEndpoint(null);
  const node_mirror_body_l_52 = new THREE.Group();
  node_mirror_body_l_52.name = "\u5916\u540e\u89c6\u955c\u955c\u4f53\uff08\u5de6\uff09__pivot";
  node_mirror_body_l_52.scale.set(1, 1, 1);
  if (endpoint_mirror_body_l_52) {
    node_mirror_body_l_52.position.copy(endpoint_mirror_body_l_52.start);
    node_mirror_body_l_52.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_mirror_body_l_52.position.set(0.916, 1.108, 0.742);
    node_mirror_body_l_52.rotation.set(0.0, 3.14159, 0.0);
  }
  node_mirror_body_l_52.userData.sculptComponent = {"id": "mirror-body-l", "name": "外后视镜镜体（左）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形镜壳，rotY(π) 后向 -Z 挤出 10cm", "geometryDescriptor": {"profile2D": {"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "mirror housing", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.21, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.916, 1.108, 0.742], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_body_l_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_body_l_52);
  nodes["mirror-body-l"] = node_mirror_body_l_52;
  const mesh_mirror_body_l_52Geometry = endpoint_mirror_body_l_52
    ? new THREE.CylinderGeometry(endpoint_mirror_body_l_52.endRadius, endpoint_mirror_body_l_52.baseRadius, endpoint_mirror_body_l_52.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}});
  if (!endpoint_mirror_body_l_52) {
    mesh_mirror_body_l_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mirror_body_l_52 = new THREE.Mesh(
    mesh_mirror_body_l_52Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_body_l_52.name = "\u5916\u540e\u89c6\u955c\u955c\u4f53\uff08\u5de6\uff09";
  if (endpoint_mirror_body_l_52) {
    mesh_mirror_body_l_52.position.copy(endpoint_mirror_body_l_52.midpoint);
    mesh_mirror_body_l_52.quaternion.copy(endpoint_mirror_body_l_52.quaternion);
  }
  mesh_mirror_body_l_52.castShadow = options.castShadow ?? true;
  mesh_mirror_body_l_52.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_body_l_52.userData.sculptComponent = {"id": "mirror-body-l", "name": "外后视镜镜体（左）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形镜壳，rotY(π) 后向 -Z 挤出 10cm", "geometryDescriptor": {"profile2D": {"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "mirror housing", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.21, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.916, 1.108, 0.742], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_body_l_52.add(mesh_mirror_body_l_52);
  meshes["mirror-body-l"] = mesh_mirror_body_l_52;
  colliders["mirror-body-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_body_l_52);

  const endpoint_mirror_glass_l_53 = makeAttachmentEndpoint(null);
  const node_mirror_glass_l_53 = new THREE.Group();
  node_mirror_glass_l_53.name = "\u540e\u89c6\u955c\u955c\u7247\uff08\u5de6\uff09__pivot";
  node_mirror_glass_l_53.scale.set(1, 1, 1);
  if (endpoint_mirror_glass_l_53) {
    node_mirror_glass_l_53.position.copy(endpoint_mirror_glass_l_53.start);
    node_mirror_glass_l_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mirror_glass_l_53.position.set(0.916, 1.108, 0.632);
    node_mirror_glass_l_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_mirror_glass_l_53.userData.sculptComponent = {"id": "mirror-glass-l", "name": "后视镜镜片（左）", "level": "micro", "role": "glass", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.126, "height": 0.092, "depth": 0.01, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.916, 1.108, 0.632], "rotation": [0, 0, 0], "scale": [0.126, 0.092, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_glass_l_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_glass_l_53);
  nodes["mirror-glass-l"] = node_mirror_glass_l_53;
  const mesh_mirror_glass_l_53Geometry = endpoint_mirror_glass_l_53
    ? new THREE.CylinderGeometry(endpoint_mirror_glass_l_53.endRadius, endpoint_mirror_glass_l_53.baseRadius, endpoint_mirror_glass_l_53.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_mirror_glass_l_53) {
    mesh_mirror_glass_l_53Geometry.scale(0.126, 0.092, 0.01);
  }
  const mesh_mirror_glass_l_53 = new THREE.Mesh(
    mesh_mirror_glass_l_53Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_glass_l_53.name = "\u540e\u89c6\u955c\u955c\u7247\uff08\u5de6\uff09";
  if (endpoint_mirror_glass_l_53) {
    mesh_mirror_glass_l_53.position.copy(endpoint_mirror_glass_l_53.midpoint);
    mesh_mirror_glass_l_53.quaternion.copy(endpoint_mirror_glass_l_53.quaternion);
  }
  mesh_mirror_glass_l_53.castShadow = options.castShadow ?? true;
  mesh_mirror_glass_l_53.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_glass_l_53.userData.sculptComponent = {"id": "mirror-glass-l", "name": "后视镜镜片（左）", "level": "micro", "role": "glass", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.126, "height": 0.092, "depth": 0.01, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.916, 1.108, 0.632], "rotation": [0, 0, 0], "scale": [0.126, 0.092, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_glass_l_53.add(mesh_mirror_glass_l_53);
  meshes["mirror-glass-l"] = mesh_mirror_glass_l_53;
  colliders["mirror-glass-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_glass_l_53);

  const endpoint_rocker_r_54 = makeAttachmentEndpoint(null);
  const node_rocker_r_54 = new THREE.Group();
  node_rocker_r_54.name = "\u4fa7\u88d9\u9ed1\u5316\u62a4\u677f\uff08\u53f3\uff09__pivot";
  node_rocker_r_54.scale.set(1, 1, 1);
  if (endpoint_rocker_r_54) {
    node_rocker_r_54.position.copy(endpoint_rocker_r_54.start);
    node_rocker_r_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rocker_r_54.position.set(-0.938, 0.238, 0.02);
    node_rocker_r_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_rocker_r_54.userData.sculptComponent = {"id": "rocker-r", "name": "侧裙黑化护板（右）", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.066, "height": 0.12, "depth": 2.24, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.938, 0.238, 0.02], "rotation": [0, 0, 0], "scale": [0.066, 0.12, 2.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rocker-r", "name": "门槛黑化条", "kind": "linework", "note": "轮拱之间的黑色侧裙，参考侧视图中车身下沿那道暗带"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-rocker-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_r_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rocker_r_54);
  nodes["rocker-r"] = node_rocker_r_54;
  const mesh_rocker_r_54Geometry = endpoint_rocker_r_54
    ? new THREE.CylinderGeometry(endpoint_rocker_r_54.endRadius, endpoint_rocker_r_54.baseRadius, endpoint_rocker_r_54.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rocker_r_54) {
    mesh_rocker_r_54Geometry.scale(0.066, 0.12, 2.24);
  }
  const mesh_rocker_r_54 = new THREE.Mesh(
    mesh_rocker_r_54Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rocker_r_54.name = "\u4fa7\u88d9\u9ed1\u5316\u62a4\u677f\uff08\u53f3\uff09";
  if (endpoint_rocker_r_54) {
    mesh_rocker_r_54.position.copy(endpoint_rocker_r_54.midpoint);
    mesh_rocker_r_54.quaternion.copy(endpoint_rocker_r_54.quaternion);
  }
  mesh_rocker_r_54.castShadow = options.castShadow ?? true;
  mesh_rocker_r_54.receiveShadow = options.receiveShadow ?? true;
  mesh_rocker_r_54.userData.sculptComponent = {"id": "rocker-r", "name": "侧裙黑化护板（右）", "level": "meso", "role": "body", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.066, "height": 0.12, "depth": 2.24, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.938, 0.238, 0.02], "rotation": [0, 0, 0], "scale": [0.066, 0.12, 2.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rocker-r", "name": "门槛黑化条", "kind": "linework", "note": "轮拱之间的黑色侧裙，参考侧视图中车身下沿那道暗带"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-rocker-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_r_54.add(mesh_rocker_r_54);
  meshes["rocker-r"] = mesh_rocker_r_54;
  colliders["rocker-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rocker_r_54);

  const endpoint_mirror_body_r_55 = makeAttachmentEndpoint(null);
  const node_mirror_body_r_55 = new THREE.Group();
  node_mirror_body_r_55.name = "\u5916\u540e\u89c6\u955c\u955c\u4f53\uff08\u53f3\uff09__pivot";
  node_mirror_body_r_55.scale.set(1, 1, 1);
  if (endpoint_mirror_body_r_55) {
    node_mirror_body_r_55.position.copy(endpoint_mirror_body_r_55.start);
    node_mirror_body_r_55.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_mirror_body_r_55.position.set(-0.916, 1.108, 0.742);
    node_mirror_body_r_55.rotation.set(0.0, 3.14159, 0.0);
  }
  node_mirror_body_r_55.userData.sculptComponent = {"id": "mirror-body-r", "name": "外后视镜镜体（右）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形镜壳，rotY(π) 后向 -Z 挤出 10cm", "geometryDescriptor": {"profile2D": {"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "mirror housing", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.21, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.916, 1.108, 0.742], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_body_r_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_body_r_55);
  nodes["mirror-body-r"] = node_mirror_body_r_55;
  const mesh_mirror_body_r_55Geometry = endpoint_mirror_body_r_55
    ? new THREE.CylinderGeometry(endpoint_mirror_body_r_55.endRadius, endpoint_mirror_body_r_55.baseRadius, endpoint_mirror_body_r_55.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}});
  if (!endpoint_mirror_body_r_55) {
    mesh_mirror_body_r_55Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mirror_body_r_55 = new THREE.Mesh(
    mesh_mirror_body_r_55Geometry,
    materialMap["paint-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_body_r_55.name = "\u5916\u540e\u89c6\u955c\u955c\u4f53\uff08\u53f3\uff09";
  if (endpoint_mirror_body_r_55) {
    mesh_mirror_body_r_55.position.copy(endpoint_mirror_body_r_55.midpoint);
    mesh_mirror_body_r_55.quaternion.copy(endpoint_mirror_body_r_55.quaternion);
  }
  mesh_mirror_body_r_55.castShadow = options.castShadow ?? true;
  mesh_mirror_body_r_55.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_body_r_55.userData.sculptComponent = {"id": "mirror-body-r", "name": "外后视镜镜体（右）", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "圆角矩形镜壳，rotY(π) 后向 -Z 挤出 10cm", "geometryDescriptor": {"profile2D": {"points": [[0.04, -0.055], [0.05148, -0.05272], [0.06121, -0.04621], [0.06772, -0.03648], [0.07, -0.025], [0.07, 0.025], [0.06772, 0.03648], [0.06121, 0.04621], [0.05148, 0.05272], [0.04, 0.055], [-0.04, 0.055], [-0.05148, 0.05272], [-0.06121, 0.04621], [-0.06772, 0.03648], [-0.07, 0.025], [-0.07, -0.025], [-0.06772, -0.03648], [-0.06121, -0.04621], [-0.05148, -0.05272], [-0.04, -0.055]], "depth": 0.1, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "mirror housing", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.21, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.916, 1.108, 0.742], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-green", "materialLayers": ["paint-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-front"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 92, 80, 1.0)", "secondaryAlbedo": "rgba(29, 92, 80, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_body_r_55.add(mesh_mirror_body_r_55);
  meshes["mirror-body-r"] = mesh_mirror_body_r_55;
  colliders["mirror-body-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_body_r_55);

  const endpoint_mirror_glass_r_56 = makeAttachmentEndpoint(null);
  const node_mirror_glass_r_56 = new THREE.Group();
  node_mirror_glass_r_56.name = "\u540e\u89c6\u955c\u955c\u7247\uff08\u53f3\uff09__pivot";
  node_mirror_glass_r_56.scale.set(1, 1, 1);
  if (endpoint_mirror_glass_r_56) {
    node_mirror_glass_r_56.position.copy(endpoint_mirror_glass_r_56.start);
    node_mirror_glass_r_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mirror_glass_r_56.position.set(-0.916, 1.108, 0.632);
    node_mirror_glass_r_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_mirror_glass_r_56.userData.sculptComponent = {"id": "mirror-glass-r", "name": "后视镜镜片（右）", "level": "micro", "role": "glass", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.126, "height": 0.092, "depth": 0.01, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.916, 1.108, 0.632], "rotation": [0, 0, 0], "scale": [0.126, 0.092, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_glass_r_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_glass_r_56);
  nodes["mirror-glass-r"] = node_mirror_glass_r_56;
  const mesh_mirror_glass_r_56Geometry = endpoint_mirror_glass_r_56
    ? new THREE.CylinderGeometry(endpoint_mirror_glass_r_56.endRadius, endpoint_mirror_glass_r_56.baseRadius, endpoint_mirror_glass_r_56.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_mirror_glass_r_56) {
    mesh_mirror_glass_r_56Geometry.scale(0.126, 0.092, 0.01);
  }
  const mesh_mirror_glass_r_56 = new THREE.Mesh(
    mesh_mirror_glass_r_56Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_glass_r_56.name = "\u540e\u89c6\u955c\u955c\u7247\uff08\u53f3\uff09";
  if (endpoint_mirror_glass_r_56) {
    mesh_mirror_glass_r_56.position.copy(endpoint_mirror_glass_r_56.midpoint);
    mesh_mirror_glass_r_56.quaternion.copy(endpoint_mirror_glass_r_56.quaternion);
  }
  mesh_mirror_glass_r_56.castShadow = options.castShadow ?? true;
  mesh_mirror_glass_r_56.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_glass_r_56.userData.sculptComponent = {"id": "mirror-glass-r", "name": "后视镜镜片（右）", "level": "micro", "role": "glass", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.126, "height": 0.092, "depth": 0.01, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.916, 1.108, 0.632], "rotation": [0, 0, 0], "scale": [0.126, 0.092, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_glass_r_56.add(mesh_mirror_glass_r_56);
  meshes["mirror-glass-r"] = mesh_mirror_glass_r_56;
  colliders["mirror-glass-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_glass_r_56);

  const endpoint_handle_front_l_57 = makeAttachmentEndpoint(null);
  const node_handle_front_l_57 = new THREE.Group();
  node_handle_front_l_57.name = "\u9690\u85cf\u5f0f\u524d\u95e8\u628a\u624b\uff08\u5de6\uff09__pivot";
  node_handle_front_l_57.scale.set(1, 1, 1);
  if (endpoint_handle_front_l_57) {
    node_handle_front_l_57.position.copy(endpoint_handle_front_l_57.start);
    node_handle_front_l_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_front_l_57.position.set(0.949, 1.01, 0.5);
    node_handle_front_l_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_handle_front_l_57.userData.sculptComponent = {"id": "handle-front-l", "name": "隐藏式前门把手（左）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.19, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.949, 1.01, 0.5], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.19]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-flush-handle-fl", "name": "隐藏式门把手", "kind": "seam", "note": "与车身齐平的细长把手槽，外凸约 6mm；R17 按参考图复位（前把手 z0.50 / 后把手 z-0.69，齐腰线 y1.01）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": ["d-flush-handle-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_l_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_handle_front_l_57);
  nodes["handle-front-l"] = node_handle_front_l_57;
  const mesh_handle_front_l_57Geometry = endpoint_handle_front_l_57
    ? new THREE.CylinderGeometry(endpoint_handle_front_l_57.endRadius, endpoint_handle_front_l_57.baseRadius, endpoint_handle_front_l_57.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_handle_front_l_57) {
    mesh_handle_front_l_57Geometry.scale(0.014, 0.026, 0.19);
  }
  const mesh_handle_front_l_57 = new THREE.Mesh(
    mesh_handle_front_l_57Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_front_l_57.name = "\u9690\u85cf\u5f0f\u524d\u95e8\u628a\u624b\uff08\u5de6\uff09";
  if (endpoint_handle_front_l_57) {
    mesh_handle_front_l_57.position.copy(endpoint_handle_front_l_57.midpoint);
    mesh_handle_front_l_57.quaternion.copy(endpoint_handle_front_l_57.quaternion);
  }
  mesh_handle_front_l_57.castShadow = options.castShadow ?? true;
  mesh_handle_front_l_57.receiveShadow = options.receiveShadow ?? true;
  mesh_handle_front_l_57.userData.sculptComponent = {"id": "handle-front-l", "name": "隐藏式前门把手（左）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.19, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.949, 1.01, 0.5], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.19]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-flush-handle-fl", "name": "隐藏式门把手", "kind": "seam", "note": "与车身齐平的细长把手槽，外凸约 6mm；R17 按参考图复位（前把手 z0.50 / 后把手 z-0.69，齐腰线 y1.01）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": ["d-flush-handle-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_l_57.add(mesh_handle_front_l_57);
  meshes["handle-front-l"] = mesh_handle_front_l_57;
  colliders["handle-front-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_handle_front_l_57);

  const endpoint_handle_front_r_58 = makeAttachmentEndpoint(null);
  const node_handle_front_r_58 = new THREE.Group();
  node_handle_front_r_58.name = "\u9690\u85cf\u5f0f\u524d\u95e8\u628a\u624b\uff08\u53f3\uff09__pivot";
  node_handle_front_r_58.scale.set(1, 1, 1);
  if (endpoint_handle_front_r_58) {
    node_handle_front_r_58.position.copy(endpoint_handle_front_r_58.start);
    node_handle_front_r_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_front_r_58.position.set(-0.949, 1.01, 0.5);
    node_handle_front_r_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_handle_front_r_58.userData.sculptComponent = {"id": "handle-front-r", "name": "隐藏式前门把手（右）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.19, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.949, 1.01, 0.5], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.19]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-flush-handle-fr", "name": "隐藏式门把手", "kind": "seam", "note": "与车身齐平的细长把手槽，外凸约 6mm；R17 按参考图复位（前把手 z0.50 / 后把手 z-0.69，齐腰线 y1.01）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": ["d-flush-handle-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_r_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_handle_front_r_58);
  nodes["handle-front-r"] = node_handle_front_r_58;
  const mesh_handle_front_r_58Geometry = endpoint_handle_front_r_58
    ? new THREE.CylinderGeometry(endpoint_handle_front_r_58.endRadius, endpoint_handle_front_r_58.baseRadius, endpoint_handle_front_r_58.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_handle_front_r_58) {
    mesh_handle_front_r_58Geometry.scale(0.014, 0.026, 0.19);
  }
  const mesh_handle_front_r_58 = new THREE.Mesh(
    mesh_handle_front_r_58Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_front_r_58.name = "\u9690\u85cf\u5f0f\u524d\u95e8\u628a\u624b\uff08\u53f3\uff09";
  if (endpoint_handle_front_r_58) {
    mesh_handle_front_r_58.position.copy(endpoint_handle_front_r_58.midpoint);
    mesh_handle_front_r_58.quaternion.copy(endpoint_handle_front_r_58.quaternion);
  }
  mesh_handle_front_r_58.castShadow = options.castShadow ?? true;
  mesh_handle_front_r_58.receiveShadow = options.receiveShadow ?? true;
  mesh_handle_front_r_58.userData.sculptComponent = {"id": "handle-front-r", "name": "隐藏式前门把手（右）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.19, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.949, 1.01, 0.5], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.19]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-flush-handle-fr", "name": "隐藏式门把手", "kind": "seam", "note": "与车身齐平的细长把手槽，外凸约 6mm；R17 按参考图复位（前把手 z0.50 / 后把手 z-0.69，齐腰线 y1.01）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": ["d-flush-handle-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_r_58.add(mesh_handle_front_r_58);
  meshes["handle-front-r"] = mesh_handle_front_r_58;
  colliders["handle-front-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_handle_front_r_58);

  const endpoint_handle_rear_l_59 = makeAttachmentEndpoint(null);
  const node_handle_rear_l_59 = new THREE.Group();
  node_handle_rear_l_59.name = "\u9690\u85cf\u5f0f\u540e\u95e8\u628a\u624b\uff08\u5de6\uff09__pivot";
  node_handle_rear_l_59.scale.set(1, 1, 1);
  if (endpoint_handle_rear_l_59) {
    node_handle_rear_l_59.position.copy(endpoint_handle_rear_l_59.start);
    node_handle_rear_l_59.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_rear_l_59.position.set(0.949, 1.01, -0.69);
    node_handle_rear_l_59.rotation.set(0.0, 0.0, 0.0);
  }
  node_handle_rear_l_59.userData.sculptComponent = {"id": "handle-rear-l", "name": "隐藏式后门把手（左）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.185, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.949, 1.01, -0.69], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.185]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-flush-handle-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_rear_l_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_handle_rear_l_59);
  nodes["handle-rear-l"] = node_handle_rear_l_59;
  const mesh_handle_rear_l_59Geometry = endpoint_handle_rear_l_59
    ? new THREE.CylinderGeometry(endpoint_handle_rear_l_59.endRadius, endpoint_handle_rear_l_59.baseRadius, endpoint_handle_rear_l_59.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_handle_rear_l_59) {
    mesh_handle_rear_l_59Geometry.scale(0.014, 0.026, 0.185);
  }
  const mesh_handle_rear_l_59 = new THREE.Mesh(
    mesh_handle_rear_l_59Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_rear_l_59.name = "\u9690\u85cf\u5f0f\u540e\u95e8\u628a\u624b\uff08\u5de6\uff09";
  if (endpoint_handle_rear_l_59) {
    mesh_handle_rear_l_59.position.copy(endpoint_handle_rear_l_59.midpoint);
    mesh_handle_rear_l_59.quaternion.copy(endpoint_handle_rear_l_59.quaternion);
  }
  mesh_handle_rear_l_59.castShadow = options.castShadow ?? true;
  mesh_handle_rear_l_59.receiveShadow = options.receiveShadow ?? true;
  mesh_handle_rear_l_59.userData.sculptComponent = {"id": "handle-rear-l", "name": "隐藏式后门把手（左）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.185, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.949, 1.01, -0.69], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.185]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-flush-handle-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_rear_l_59.add(mesh_handle_rear_l_59);
  meshes["handle-rear-l"] = mesh_handle_rear_l_59;
  colliders["handle-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_handle_rear_l_59);

  const endpoint_handle_rear_r_60 = makeAttachmentEndpoint(null);
  const node_handle_rear_r_60 = new THREE.Group();
  node_handle_rear_r_60.name = "\u9690\u85cf\u5f0f\u540e\u95e8\u628a\u624b\uff08\u53f3\uff09__pivot";
  node_handle_rear_r_60.scale.set(1, 1, 1);
  if (endpoint_handle_rear_r_60) {
    node_handle_rear_r_60.position.copy(endpoint_handle_rear_r_60.start);
    node_handle_rear_r_60.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_rear_r_60.position.set(-0.949, 1.01, -0.69);
    node_handle_rear_r_60.rotation.set(0.0, 0.0, 0.0);
  }
  node_handle_rear_r_60.userData.sculptComponent = {"id": "handle-rear-r", "name": "隐藏式后门把手（右）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.185, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.949, 1.01, -0.69], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.185]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-flush-handle-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_rear_r_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_handle_rear_r_60);
  nodes["handle-rear-r"] = node_handle_rear_r_60;
  const mesh_handle_rear_r_60Geometry = endpoint_handle_rear_r_60
    ? new THREE.CylinderGeometry(endpoint_handle_rear_r_60.endRadius, endpoint_handle_rear_r_60.baseRadius, endpoint_handle_rear_r_60.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_handle_rear_r_60) {
    mesh_handle_rear_r_60Geometry.scale(0.014, 0.026, 0.185);
  }
  const mesh_handle_rear_r_60 = new THREE.Mesh(
    mesh_handle_rear_r_60Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_rear_r_60.name = "\u9690\u85cf\u5f0f\u540e\u95e8\u628a\u624b\uff08\u53f3\uff09";
  if (endpoint_handle_rear_r_60) {
    mesh_handle_rear_r_60.position.copy(endpoint_handle_rear_r_60.midpoint);
    mesh_handle_rear_r_60.quaternion.copy(endpoint_handle_rear_r_60.quaternion);
  }
  mesh_handle_rear_r_60.castShadow = options.castShadow ?? true;
  mesh_handle_rear_r_60.receiveShadow = options.receiveShadow ?? true;
  mesh_handle_rear_r_60.userData.sculptComponent = {"id": "handle-rear-r", "name": "隐藏式后门把手（右）", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.014, "height": 0.026, "depth": 0.185, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.949, 1.01, -0.69], "rotation": [0, 0, 0], "scale": [0.014, 0.026, 0.185]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-side"], "details": ["d-flush-handle-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_rear_r_60.add(mesh_handle_rear_r_60);
  meshes["handle-rear-r"] = mesh_handle_rear_r_60;
  colliders["handle-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_handle_rear_r_60);

  const endpoint_wheel_fl_61 = makeAttachmentEndpoint(null);
  const node_wheel_fl_61 = new THREE.Group();
  node_wheel_fl_61.name = "\u524d\u5de6\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09__pivot";
  node_wheel_fl_61.scale.set(1, 1, 1);
  if (endpoint_wheel_fl_61) {
    node_wheel_fl_61.position.copy(endpoint_wheel_fl_61.start);
    node_wheel_fl_61.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_wheel_fl_61.position.set(0.84, 0.383, 1.475);
    node_wheel_fl_61.rotation.set(0.0, 0.0, 1.5708);
  }
  node_wheel_fl_61.userData.sculptComponent = {"id": "wheel-fl", "name": "前左车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, 0.383, 1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-fl", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fl_61.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_fl_61);
  nodes["wheel-fl"] = node_wheel_fl_61;
  const mesh_wheel_fl_61Geometry = endpoint_wheel_fl_61
    ? new THREE.CylinderGeometry(endpoint_wheel_fl_61.endRadius, endpoint_wheel_fl_61.baseRadius, endpoint_wheel_fl_61.length, 16, 6)
    : buildLatheGeometry({"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32});
  if (!endpoint_wheel_fl_61) {
    mesh_wheel_fl_61Geometry.scale(0.766, 0.255, 0.766);
  }
  const mesh_wheel_fl_61 = new THREE.Mesh(
    mesh_wheel_fl_61Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_fl_61.name = "\u524d\u5de6\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09";
  if (endpoint_wheel_fl_61) {
    mesh_wheel_fl_61.position.copy(endpoint_wheel_fl_61.midpoint);
    mesh_wheel_fl_61.quaternion.copy(endpoint_wheel_fl_61.quaternion);
  }
  mesh_wheel_fl_61.castShadow = options.castShadow ?? true;
  mesh_wheel_fl_61.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_fl_61.userData.sculptComponent = {"id": "wheel-fl", "name": "前左车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, 0.383, 1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-fl", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fl_61.add(mesh_wheel_fl_61);
  meshes["wheel-fl"] = mesh_wheel_fl_61;
  colliders["wheel-fl"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_fl_61);

  const endpoint_rim_fl_62 = makeAttachmentEndpoint(null);
  const node_rim_fl_62 = new THREE.Group();
  node_rim_fl_62.name = "\u524d\u5de6\u8f6e\u5708__pivot";
  node_rim_fl_62.scale.set(1, 1, 1);
  if (endpoint_rim_fl_62) {
    node_rim_fl_62.position.copy(endpoint_rim_fl_62.start);
    node_rim_fl_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rim_fl_62.position.set(0.0, 0.0, 0.0);
    node_rim_fl_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_rim_fl_62.userData.sculptComponent = {"id": "rim-fl", "name": "前左轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-fl", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fl_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fl"] ?? root).add(node_rim_fl_62);
  nodes["rim-fl"] = node_rim_fl_62;
  const mesh_rim_fl_62Geometry = endpoint_rim_fl_62
    ? new THREE.CylinderGeometry(endpoint_rim_fl_62.endRadius, endpoint_rim_fl_62.baseRadius, endpoint_rim_fl_62.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32});
  if (!endpoint_rim_fl_62) {
    mesh_rim_fl_62Geometry.scale(0.5334, 0.235, 0.5334);
  }
  const mesh_rim_fl_62 = new THREE.Mesh(
    mesh_rim_fl_62Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_fl_62.name = "\u524d\u5de6\u8f6e\u5708";
  if (endpoint_rim_fl_62) {
    mesh_rim_fl_62.position.copy(endpoint_rim_fl_62.midpoint);
    mesh_rim_fl_62.quaternion.copy(endpoint_rim_fl_62.quaternion);
  }
  mesh_rim_fl_62.castShadow = options.castShadow ?? true;
  mesh_rim_fl_62.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_fl_62.userData.sculptComponent = {"id": "rim-fl", "name": "前左轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-fl", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fl_62.add(mesh_rim_fl_62);
  meshes["rim-fl"] = mesh_rim_fl_62;
  colliders["rim-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_fl_62);

  const endpoint_wheel_face_fl_63 = makeAttachmentEndpoint(null);
  const node_wheel_face_fl_63 = new THREE.Group();
  node_wheel_face_fl_63.name = "\u524d\u5de6\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09__pivot";
  node_wheel_face_fl_63.scale.set(1, 1, 1);
  if (endpoint_wheel_face_fl_63) {
    node_wheel_face_fl_63.position.copy(endpoint_wheel_face_fl_63.start);
    node_wheel_face_fl_63.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_face_fl_63.position.set(0.0, -0.075, 0.0);
    node_wheel_face_fl_63.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_face_fl_63.userData.sculptComponent = {"id": "wheel-face-fl", "name": "前左轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-fl", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.075, 0], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-fl", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_fl_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fl"] ?? root).add(node_wheel_face_fl_63);
  nodes["wheel-face-fl"] = node_wheel_face_fl_63;
  const mesh_wheel_face_fl_63Geometry = endpoint_wheel_face_fl_63
    ? new THREE.CylinderGeometry(endpoint_wheel_face_fl_63.endRadius, endpoint_wheel_face_fl_63.baseRadius, endpoint_wheel_face_fl_63.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_wheel_face_fl_63) {
    mesh_wheel_face_fl_63Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_face_fl_63 = new THREE.Mesh(
    mesh_wheel_face_fl_63Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_face_fl_63.name = "\u524d\u5de6\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09";
  if (endpoint_wheel_face_fl_63) {
    mesh_wheel_face_fl_63.position.copy(endpoint_wheel_face_fl_63.midpoint);
    mesh_wheel_face_fl_63.quaternion.copy(endpoint_wheel_face_fl_63.quaternion);
  }
  mesh_wheel_face_fl_63.castShadow = options.castShadow ?? true;
  mesh_wheel_face_fl_63.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_face_fl_63.userData.sculptComponent = {"id": "wheel-face-fl", "name": "前左轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-fl", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.075, 0], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-fl", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_fl_63.add(mesh_wheel_face_fl_63);
  meshes["wheel-face-fl"] = mesh_wheel_face_fl_63;
  colliders["wheel-face-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_face_fl_63);

  const endpoint_caliper_fl_64 = makeAttachmentEndpoint(null);
  const node_caliper_fl_64 = new THREE.Group();
  node_caliper_fl_64.name = "\u524d\u5de6\u7ea2\u8272\u5361\u94b3__pivot";
  node_caliper_fl_64.scale.set(1, 1, 1);
  if (endpoint_caliper_fl_64) {
    node_caliper_fl_64.position.copy(endpoint_caliper_fl_64.start);
    node_caliper_fl_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_caliper_fl_64.position.set(0.884, 0.505, 1.3250000000000002);
    node_caliper_fl_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_caliper_fl_64.userData.sculptComponent = {"id": "caliper-fl", "name": "前左红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.884, 0.505, 1.3250000000000002], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-fl", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_fl_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_caliper_fl_64);
  nodes["caliper-fl"] = node_caliper_fl_64;
  const mesh_caliper_fl_64Geometry = endpoint_caliper_fl_64
    ? new THREE.CylinderGeometry(endpoint_caliper_fl_64.endRadius, endpoint_caliper_fl_64.baseRadius, endpoint_caliper_fl_64.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_caliper_fl_64) {
    mesh_caliper_fl_64Geometry.scale(0.046, 0.19, 0.12);
  }
  const mesh_caliper_fl_64 = new THREE.Mesh(
    mesh_caliper_fl_64Geometry,
    materialMap["caliper-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_caliper_fl_64.name = "\u524d\u5de6\u7ea2\u8272\u5361\u94b3";
  if (endpoint_caliper_fl_64) {
    mesh_caliper_fl_64.position.copy(endpoint_caliper_fl_64.midpoint);
    mesh_caliper_fl_64.quaternion.copy(endpoint_caliper_fl_64.quaternion);
  }
  mesh_caliper_fl_64.castShadow = options.castShadow ?? true;
  mesh_caliper_fl_64.receiveShadow = options.receiveShadow ?? true;
  mesh_caliper_fl_64.userData.sculptComponent = {"id": "caliper-fl", "name": "前左红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.884, 0.505, 1.3250000000000002], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-fl", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-fl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_fl_64.add(mesh_caliper_fl_64);
  meshes["caliper-fl"] = mesh_caliper_fl_64;
  colliders["caliper-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_caliper_fl_64);

  const endpoint_wheel_fr_65 = makeAttachmentEndpoint(null);
  const node_wheel_fr_65 = new THREE.Group();
  node_wheel_fr_65.name = "\u524d\u53f3\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09__pivot";
  node_wheel_fr_65.scale.set(1, 1, 1);
  if (endpoint_wheel_fr_65) {
    node_wheel_fr_65.position.copy(endpoint_wheel_fr_65.start);
    node_wheel_fr_65.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_wheel_fr_65.position.set(-0.84, 0.383, 1.475);
    node_wheel_fr_65.rotation.set(0.0, 0.0, 1.5708);
  }
  node_wheel_fr_65.userData.sculptComponent = {"id": "wheel-fr", "name": "前右车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, 0.383, 1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-fr", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fr_65.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_fr_65);
  nodes["wheel-fr"] = node_wheel_fr_65;
  const mesh_wheel_fr_65Geometry = endpoint_wheel_fr_65
    ? new THREE.CylinderGeometry(endpoint_wheel_fr_65.endRadius, endpoint_wheel_fr_65.baseRadius, endpoint_wheel_fr_65.length, 16, 6)
    : buildLatheGeometry({"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32});
  if (!endpoint_wheel_fr_65) {
    mesh_wheel_fr_65Geometry.scale(0.766, 0.255, 0.766);
  }
  const mesh_wheel_fr_65 = new THREE.Mesh(
    mesh_wheel_fr_65Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_fr_65.name = "\u524d\u53f3\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09";
  if (endpoint_wheel_fr_65) {
    mesh_wheel_fr_65.position.copy(endpoint_wheel_fr_65.midpoint);
    mesh_wheel_fr_65.quaternion.copy(endpoint_wheel_fr_65.quaternion);
  }
  mesh_wheel_fr_65.castShadow = options.castShadow ?? true;
  mesh_wheel_fr_65.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_fr_65.userData.sculptComponent = {"id": "wheel-fr", "name": "前右车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, 0.383, 1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-fr", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fr_65.add(mesh_wheel_fr_65);
  meshes["wheel-fr"] = mesh_wheel_fr_65;
  colliders["wheel-fr"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_fr_65);

  const endpoint_rim_fr_66 = makeAttachmentEndpoint(null);
  const node_rim_fr_66 = new THREE.Group();
  node_rim_fr_66.name = "\u524d\u53f3\u8f6e\u5708__pivot";
  node_rim_fr_66.scale.set(1, 1, 1);
  if (endpoint_rim_fr_66) {
    node_rim_fr_66.position.copy(endpoint_rim_fr_66.start);
    node_rim_fr_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rim_fr_66.position.set(0.0, 0.0, 0.0);
    node_rim_fr_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_rim_fr_66.userData.sculptComponent = {"id": "rim-fr", "name": "前右轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-fr", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fr_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fr"] ?? root).add(node_rim_fr_66);
  nodes["rim-fr"] = node_rim_fr_66;
  const mesh_rim_fr_66Geometry = endpoint_rim_fr_66
    ? new THREE.CylinderGeometry(endpoint_rim_fr_66.endRadius, endpoint_rim_fr_66.baseRadius, endpoint_rim_fr_66.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32});
  if (!endpoint_rim_fr_66) {
    mesh_rim_fr_66Geometry.scale(0.5334, 0.235, 0.5334);
  }
  const mesh_rim_fr_66 = new THREE.Mesh(
    mesh_rim_fr_66Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_fr_66.name = "\u524d\u53f3\u8f6e\u5708";
  if (endpoint_rim_fr_66) {
    mesh_rim_fr_66.position.copy(endpoint_rim_fr_66.midpoint);
    mesh_rim_fr_66.quaternion.copy(endpoint_rim_fr_66.quaternion);
  }
  mesh_rim_fr_66.castShadow = options.castShadow ?? true;
  mesh_rim_fr_66.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_fr_66.userData.sculptComponent = {"id": "rim-fr", "name": "前右轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-fr", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fr_66.add(mesh_rim_fr_66);
  meshes["rim-fr"] = mesh_rim_fr_66;
  colliders["rim-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_fr_66);

  const endpoint_wheel_face_fr_67 = makeAttachmentEndpoint(null);
  const node_wheel_face_fr_67 = new THREE.Group();
  node_wheel_face_fr_67.name = "\u524d\u53f3\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09__pivot";
  node_wheel_face_fr_67.scale.set(1, 1, 1);
  if (endpoint_wheel_face_fr_67) {
    node_wheel_face_fr_67.position.copy(endpoint_wheel_face_fr_67.start);
    node_wheel_face_fr_67.rotation.set(-1.5708, 0.0, 0.0);
  } else {
    node_wheel_face_fr_67.position.set(0.0, 0.075, 0.0);
    node_wheel_face_fr_67.rotation.set(-1.5708, 0.0, 0.0);
  }
  node_wheel_face_fr_67.userData.sculptComponent = {"id": "wheel-face-fr", "name": "前右轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-fr", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.075, 0], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-fr", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_fr_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fr"] ?? root).add(node_wheel_face_fr_67);
  nodes["wheel-face-fr"] = node_wheel_face_fr_67;
  const mesh_wheel_face_fr_67Geometry = endpoint_wheel_face_fr_67
    ? new THREE.CylinderGeometry(endpoint_wheel_face_fr_67.endRadius, endpoint_wheel_face_fr_67.baseRadius, endpoint_wheel_face_fr_67.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_wheel_face_fr_67) {
    mesh_wheel_face_fr_67Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_face_fr_67 = new THREE.Mesh(
    mesh_wheel_face_fr_67Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_face_fr_67.name = "\u524d\u53f3\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09";
  if (endpoint_wheel_face_fr_67) {
    mesh_wheel_face_fr_67.position.copy(endpoint_wheel_face_fr_67.midpoint);
    mesh_wheel_face_fr_67.quaternion.copy(endpoint_wheel_face_fr_67.quaternion);
  }
  mesh_wheel_face_fr_67.castShadow = options.castShadow ?? true;
  mesh_wheel_face_fr_67.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_face_fr_67.userData.sculptComponent = {"id": "wheel-face-fr", "name": "前右轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-fr", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.075, 0], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-fr", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_fr_67.add(mesh_wheel_face_fr_67);
  meshes["wheel-face-fr"] = mesh_wheel_face_fr_67;
  colliders["wheel-face-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_face_fr_67);

  const endpoint_caliper_fr_68 = makeAttachmentEndpoint(null);
  const node_caliper_fr_68 = new THREE.Group();
  node_caliper_fr_68.name = "\u524d\u53f3\u7ea2\u8272\u5361\u94b3__pivot";
  node_caliper_fr_68.scale.set(1, 1, 1);
  if (endpoint_caliper_fr_68) {
    node_caliper_fr_68.position.copy(endpoint_caliper_fr_68.start);
    node_caliper_fr_68.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_caliper_fr_68.position.set(-0.884, 0.505, 1.3250000000000002);
    node_caliper_fr_68.rotation.set(0.0, 0.0, 0.0);
  }
  node_caliper_fr_68.userData.sculptComponent = {"id": "caliper-fr", "name": "前右红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.884, 0.505, 1.3250000000000002], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-fr", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_fr_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_caliper_fr_68);
  nodes["caliper-fr"] = node_caliper_fr_68;
  const mesh_caliper_fr_68Geometry = endpoint_caliper_fr_68
    ? new THREE.CylinderGeometry(endpoint_caliper_fr_68.endRadius, endpoint_caliper_fr_68.baseRadius, endpoint_caliper_fr_68.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_caliper_fr_68) {
    mesh_caliper_fr_68Geometry.scale(0.046, 0.19, 0.12);
  }
  const mesh_caliper_fr_68 = new THREE.Mesh(
    mesh_caliper_fr_68Geometry,
    materialMap["caliper-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_caliper_fr_68.name = "\u524d\u53f3\u7ea2\u8272\u5361\u94b3";
  if (endpoint_caliper_fr_68) {
    mesh_caliper_fr_68.position.copy(endpoint_caliper_fr_68.midpoint);
    mesh_caliper_fr_68.quaternion.copy(endpoint_caliper_fr_68.quaternion);
  }
  mesh_caliper_fr_68.castShadow = options.castShadow ?? true;
  mesh_caliper_fr_68.receiveShadow = options.receiveShadow ?? true;
  mesh_caliper_fr_68.userData.sculptComponent = {"id": "caliper-fr", "name": "前右红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.884, 0.505, 1.3250000000000002], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-fr", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-fr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_fr_68.add(mesh_caliper_fr_68);
  meshes["caliper-fr"] = mesh_caliper_fr_68;
  colliders["caliper-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_caliper_fr_68);

  const endpoint_wheel_rl_69 = makeAttachmentEndpoint(null);
  const node_wheel_rl_69 = new THREE.Group();
  node_wheel_rl_69.name = "\u540e\u5de6\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09__pivot";
  node_wheel_rl_69.scale.set(1, 1, 1);
  if (endpoint_wheel_rl_69) {
    node_wheel_rl_69.position.copy(endpoint_wheel_rl_69.start);
    node_wheel_rl_69.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_wheel_rl_69.position.set(0.84, 0.383, -1.475);
    node_wheel_rl_69.rotation.set(0.0, 0.0, 1.5708);
  }
  node_wheel_rl_69.userData.sculptComponent = {"id": "wheel-rl", "name": "后左车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, 0.383, -1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-rl", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rl_69.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_rl_69);
  nodes["wheel-rl"] = node_wheel_rl_69;
  const mesh_wheel_rl_69Geometry = endpoint_wheel_rl_69
    ? new THREE.CylinderGeometry(endpoint_wheel_rl_69.endRadius, endpoint_wheel_rl_69.baseRadius, endpoint_wheel_rl_69.length, 16, 6)
    : buildLatheGeometry({"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32});
  if (!endpoint_wheel_rl_69) {
    mesh_wheel_rl_69Geometry.scale(0.766, 0.255, 0.766);
  }
  const mesh_wheel_rl_69 = new THREE.Mesh(
    mesh_wheel_rl_69Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rl_69.name = "\u540e\u5de6\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09";
  if (endpoint_wheel_rl_69) {
    mesh_wheel_rl_69.position.copy(endpoint_wheel_rl_69.midpoint);
    mesh_wheel_rl_69.quaternion.copy(endpoint_wheel_rl_69.quaternion);
  }
  mesh_wheel_rl_69.castShadow = options.castShadow ?? true;
  mesh_wheel_rl_69.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rl_69.userData.sculptComponent = {"id": "wheel-rl", "name": "后左车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, 0.383, -1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-rl", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rl_69.add(mesh_wheel_rl_69);
  meshes["wheel-rl"] = mesh_wheel_rl_69;
  colliders["wheel-rl"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_rl_69);

  const endpoint_rim_rl_70 = makeAttachmentEndpoint(null);
  const node_rim_rl_70 = new THREE.Group();
  node_rim_rl_70.name = "\u540e\u5de6\u8f6e\u5708__pivot";
  node_rim_rl_70.scale.set(1, 1, 1);
  if (endpoint_rim_rl_70) {
    node_rim_rl_70.position.copy(endpoint_rim_rl_70.start);
    node_rim_rl_70.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rim_rl_70.position.set(0.0, 0.0, 0.0);
    node_rim_rl_70.rotation.set(0.0, 0.0, 0.0);
  }
  node_rim_rl_70.userData.sculptComponent = {"id": "rim-rl", "name": "后左轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-rl", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rl_70.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rl"] ?? root).add(node_rim_rl_70);
  nodes["rim-rl"] = node_rim_rl_70;
  const mesh_rim_rl_70Geometry = endpoint_rim_rl_70
    ? new THREE.CylinderGeometry(endpoint_rim_rl_70.endRadius, endpoint_rim_rl_70.baseRadius, endpoint_rim_rl_70.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32});
  if (!endpoint_rim_rl_70) {
    mesh_rim_rl_70Geometry.scale(0.5334, 0.235, 0.5334);
  }
  const mesh_rim_rl_70 = new THREE.Mesh(
    mesh_rim_rl_70Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_rl_70.name = "\u540e\u5de6\u8f6e\u5708";
  if (endpoint_rim_rl_70) {
    mesh_rim_rl_70.position.copy(endpoint_rim_rl_70.midpoint);
    mesh_rim_rl_70.quaternion.copy(endpoint_rim_rl_70.quaternion);
  }
  mesh_rim_rl_70.castShadow = options.castShadow ?? true;
  mesh_rim_rl_70.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_rl_70.userData.sculptComponent = {"id": "rim-rl", "name": "后左轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-rl", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rl_70.add(mesh_rim_rl_70);
  meshes["rim-rl"] = mesh_rim_rl_70;
  colliders["rim-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_rl_70);

  const endpoint_wheel_face_rl_71 = makeAttachmentEndpoint(null);
  const node_wheel_face_rl_71 = new THREE.Group();
  node_wheel_face_rl_71.name = "\u540e\u5de6\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09__pivot";
  node_wheel_face_rl_71.scale.set(1, 1, 1);
  if (endpoint_wheel_face_rl_71) {
    node_wheel_face_rl_71.position.copy(endpoint_wheel_face_rl_71.start);
    node_wheel_face_rl_71.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_face_rl_71.position.set(0.0, -0.075, 0.0);
    node_wheel_face_rl_71.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_face_rl_71.userData.sculptComponent = {"id": "wheel-face-rl", "name": "后左轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-rl", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.075, 0], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-rl", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_rl_71.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rl"] ?? root).add(node_wheel_face_rl_71);
  nodes["wheel-face-rl"] = node_wheel_face_rl_71;
  const mesh_wheel_face_rl_71Geometry = endpoint_wheel_face_rl_71
    ? new THREE.CylinderGeometry(endpoint_wheel_face_rl_71.endRadius, endpoint_wheel_face_rl_71.baseRadius, endpoint_wheel_face_rl_71.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_wheel_face_rl_71) {
    mesh_wheel_face_rl_71Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_face_rl_71 = new THREE.Mesh(
    mesh_wheel_face_rl_71Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_face_rl_71.name = "\u540e\u5de6\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09";
  if (endpoint_wheel_face_rl_71) {
    mesh_wheel_face_rl_71.position.copy(endpoint_wheel_face_rl_71.midpoint);
    mesh_wheel_face_rl_71.quaternion.copy(endpoint_wheel_face_rl_71.quaternion);
  }
  mesh_wheel_face_rl_71.castShadow = options.castShadow ?? true;
  mesh_wheel_face_rl_71.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_face_rl_71.userData.sculptComponent = {"id": "wheel-face-rl", "name": "后左轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-rl", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.075, 0], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-rl", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_rl_71.add(mesh_wheel_face_rl_71);
  meshes["wheel-face-rl"] = mesh_wheel_face_rl_71;
  colliders["wheel-face-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_face_rl_71);

  const endpoint_caliper_rl_72 = makeAttachmentEndpoint(null);
  const node_caliper_rl_72 = new THREE.Group();
  node_caliper_rl_72.name = "\u540e\u5de6\u7ea2\u8272\u5361\u94b3__pivot";
  node_caliper_rl_72.scale.set(1, 1, 1);
  if (endpoint_caliper_rl_72) {
    node_caliper_rl_72.position.copy(endpoint_caliper_rl_72.start);
    node_caliper_rl_72.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_caliper_rl_72.position.set(0.884, 0.505, -1.625);
    node_caliper_rl_72.rotation.set(0.0, 0.0, 0.0);
  }
  node_caliper_rl_72.userData.sculptComponent = {"id": "caliper-rl", "name": "后左红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.884, 0.505, -1.625], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-rl", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-rl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_rl_72.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_caliper_rl_72);
  nodes["caliper-rl"] = node_caliper_rl_72;
  const mesh_caliper_rl_72Geometry = endpoint_caliper_rl_72
    ? new THREE.CylinderGeometry(endpoint_caliper_rl_72.endRadius, endpoint_caliper_rl_72.baseRadius, endpoint_caliper_rl_72.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_caliper_rl_72) {
    mesh_caliper_rl_72Geometry.scale(0.046, 0.19, 0.12);
  }
  const mesh_caliper_rl_72 = new THREE.Mesh(
    mesh_caliper_rl_72Geometry,
    materialMap["caliper-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_caliper_rl_72.name = "\u540e\u5de6\u7ea2\u8272\u5361\u94b3";
  if (endpoint_caliper_rl_72) {
    mesh_caliper_rl_72.position.copy(endpoint_caliper_rl_72.midpoint);
    mesh_caliper_rl_72.quaternion.copy(endpoint_caliper_rl_72.quaternion);
  }
  mesh_caliper_rl_72.castShadow = options.castShadow ?? true;
  mesh_caliper_rl_72.receiveShadow = options.receiveShadow ?? true;
  mesh_caliper_rl_72.userData.sculptComponent = {"id": "caliper-rl", "name": "后左红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.884, 0.505, -1.625], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-rl", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-rl"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_rl_72.add(mesh_caliper_rl_72);
  meshes["caliper-rl"] = mesh_caliper_rl_72;
  colliders["caliper-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_caliper_rl_72);

  const endpoint_wheel_rr_73 = makeAttachmentEndpoint(null);
  const node_wheel_rr_73 = new THREE.Group();
  node_wheel_rr_73.name = "\u540e\u53f3\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09__pivot";
  node_wheel_rr_73.scale.set(1, 1, 1);
  if (endpoint_wheel_rr_73) {
    node_wheel_rr_73.position.copy(endpoint_wheel_rr_73.start);
    node_wheel_rr_73.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_wheel_rr_73.position.set(-0.84, 0.383, -1.475);
    node_wheel_rr_73.rotation.set(0.0, 0.0, 1.5708);
  }
  node_wheel_rr_73.userData.sculptComponent = {"id": "wheel-rr", "name": "后右车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, 0.383, -1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-rr", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rr_73.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_rr_73);
  nodes["wheel-rr"] = node_wheel_rr_73;
  const mesh_wheel_rr_73Geometry = endpoint_wheel_rr_73
    ? new THREE.CylinderGeometry(endpoint_wheel_rr_73.endRadius, endpoint_wheel_rr_73.baseRadius, endpoint_wheel_rr_73.length, 16, 6)
    : buildLatheGeometry({"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32});
  if (!endpoint_wheel_rr_73) {
    mesh_wheel_rr_73Geometry.scale(0.766, 0.255, 0.766);
  }
  const mesh_wheel_rr_73 = new THREE.Mesh(
    mesh_wheel_rr_73Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rr_73.name = "\u540e\u53f3\u8f66\u8f6e\uff08\u8f6e\u80ce\uff09";
  if (endpoint_wheel_rr_73) {
    mesh_wheel_rr_73.position.copy(endpoint_wheel_rr_73.midpoint);
    mesh_wheel_rr_73.quaternion.copy(endpoint_wheel_rr_73.quaternion);
  }
  mesh_wheel_rr_73.castShadow = options.castShadow ?? true;
  mesh_wheel_rr_73.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rr_73.userData.sculptComponent = {"id": "wheel-rr", "name": "后右车轮（轮胎）", "level": "meso", "role": "wheel", "importance": 1.0, "confidence": 0.95, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈", "geometryDescriptor": {"topologyIntent": "annular tire cross-section revolved about the axle", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.348, -0.5], [0.4, -0.498], [0.462, -0.47], [0.492, -0.42], [0.5, -0.36], [0.5, 0.36], [0.492, 0.42], [0.462, 0.47], [0.4, 0.498], [0.348, 0.5], [0.348, -0.5]], "segments": 32}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.766, "depth": 0.766, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, 0.383, -1.475], "rotation": [0, 0, 1.5708], "scale": [0.766, 0.255, 0.766]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-tire-rr", "name": "255/45 R21 轮胎", "kind": "contour", "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 0.85)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rr_73.add(mesh_wheel_rr_73);
  meshes["wheel-rr"] = mesh_wheel_rr_73;
  colliders["wheel-rr"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766], "isTrigger": false, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_rr_73);

  const endpoint_rim_rr_74 = makeAttachmentEndpoint(null);
  const node_rim_rr_74 = new THREE.Group();
  node_rim_rr_74.name = "\u540e\u53f3\u8f6e\u5708__pivot";
  node_rim_rr_74.scale.set(1, 1, 1);
  if (endpoint_rim_rr_74) {
    node_rim_rr_74.position.copy(endpoint_rim_rr_74.start);
    node_rim_rr_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rim_rr_74.position.set(0.0, 0.0, 0.0);
    node_rim_rr_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_rim_rr_74.userData.sculptComponent = {"id": "rim-rr", "name": "后右轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-rr", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rr_74.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rr"] ?? root).add(node_rim_rr_74);
  nodes["rim-rr"] = node_rim_rr_74;
  const mesh_rim_rr_74Geometry = endpoint_rim_rr_74
    ? new THREE.CylinderGeometry(endpoint_rim_rr_74.endRadius, endpoint_rim_rr_74.baseRadius, endpoint_rim_rr_74.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32});
  if (!endpoint_rim_rr_74) {
    mesh_rim_rr_74Geometry.scale(0.5334, 0.235, 0.5334);
  }
  const mesh_rim_rr_74 = new THREE.Mesh(
    mesh_rim_rr_74Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_rr_74.name = "\u540e\u53f3\u8f6e\u5708";
  if (endpoint_rim_rr_74) {
    mesh_rim_rr_74.position.copy(endpoint_rim_rr_74.midpoint);
    mesh_rim_rr_74.quaternion.copy(endpoint_rim_rr_74.quaternion);
  }
  mesh_rim_rr_74.castShadow = options.castShadow ?? true;
  mesh_rim_rr_74.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_rr_74.userData.sculptComponent = {"id": "rim-rr", "name": "后右轮圈", "level": "meso", "role": "wheel", "importance": 0.95, "confidence": 0.92, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X", "geometryDescriptor": {"topologyIntent": "rim barrel and outboard flange", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.47, -0.47], [0.5, -0.4], [0.5, 0.4], [0.47, 0.47], [0.4, 0.5], [0.0002, 0.5]], "segments": 32}}, "parent": "wheel-rr", "attachment": null, "dimensions": {"width": 0.235, "height": 0.5334, "depth": 0.5334, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5334, 0.235, 0.5334]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rr_74.add(mesh_rim_rr_74);
  meshes["rim-rr"] = mesh_rim_rr_74;
  colliders["rim-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_rr_74);

  const endpoint_wheel_face_rr_75 = makeAttachmentEndpoint(null);
  const node_wheel_face_rr_75 = new THREE.Group();
  node_wheel_face_rr_75.name = "\u540e\u53f3\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09__pivot";
  node_wheel_face_rr_75.scale.set(1, 1, 1);
  if (endpoint_wheel_face_rr_75) {
    node_wheel_face_rr_75.position.copy(endpoint_wheel_face_rr_75.start);
    node_wheel_face_rr_75.rotation.set(-1.5708, 0.0, 0.0);
  } else {
    node_wheel_face_rr_75.position.set(0.0, 0.075, 0.0);
    node_wheel_face_rr_75.rotation.set(-1.5708, 0.0, 0.0);
  }
  node_wheel_face_rr_75.userData.sculptComponent = {"id": "wheel-face-rr", "name": "后右轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-rr", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.075, 0], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-rr", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_rr_75.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rr"] ?? root).add(node_wheel_face_rr_75);
  nodes["wheel-face-rr"] = node_wheel_face_rr_75;
  const mesh_wheel_face_rr_75Geometry = endpoint_wheel_face_rr_75
    ? new THREE.CylinderGeometry(endpoint_wheel_face_rr_75.endRadius, endpoint_wheel_face_rr_75.baseRadius, endpoint_wheel_face_rr_75.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_wheel_face_rr_75) {
    mesh_wheel_face_rr_75Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_face_rr_75 = new THREE.Mesh(
    mesh_wheel_face_rr_75Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_face_rr_75.name = "\u540e\u53f3\u8f6e\u8f90\u9762\uff08\u53cc\u5341\u8f90\uff09";
  if (endpoint_wheel_face_rr_75) {
    mesh_wheel_face_rr_75.position.copy(endpoint_wheel_face_rr_75.midpoint);
    mesh_wheel_face_rr_75.quaternion.copy(endpoint_wheel_face_rr_75.quaternion);
  }
  mesh_wheel_face_rr_75.castShadow = options.castShadow ?? true;
  mesh_wheel_face_rr_75.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_face_rr_75.userData.sculptComponent = {"id": "wheel-face-rr", "name": "后右轮辐面（双十辐）", "level": "meso", "role": "wheel", "importance": 0.98, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116", "geometryDescriptor": {"profile2D": {"points": [[0.11558, -0.00985], [0.26388, -0.00792], [0.26388, 0.00792], [0.11558, 0.00985], [0.11297, 0.02635], [0.25341, 0.07401], [0.24852, 0.08908], [0.10688, 0.04508], [0.0993, 0.05997], [0.21814, 0.1487], [0.20883, 0.16151], [0.08772, 0.0759], [0.0759, 0.08772], [0.16151, 0.20883], [0.1487, 0.21814], [0.05997, 0.0993], [0.04508, 0.10688], [0.08908, 0.24852], [0.07401, 0.25341], [0.02635, 0.11297], [0.00985, 0.11558], [0.00792, 0.26388], [-0.00792, 0.26388], [-0.00985, 0.11558], [-0.02635, 0.11297], [-0.07401, 0.25341], [-0.08908, 0.24852], [-0.04508, 0.10688], [-0.05997, 0.0993], [-0.1487, 0.21814], [-0.16151, 0.20883], [-0.0759, 0.08772], [-0.08772, 0.0759], [-0.20883, 0.16151], [-0.21814, 0.1487], [-0.0993, 0.05997], [-0.10688, 0.04508], [-0.24852, 0.08908], [-0.25341, 0.07401], [-0.11297, 0.02635], [-0.11558, 0.00985], [-0.26388, 0.00792], [-0.26388, -0.00792], [-0.11558, -0.00985], [-0.11297, -0.02635], [-0.25341, -0.07401], [-0.24852, -0.08908], [-0.10688, -0.04508], [-0.0993, -0.05997], [-0.21814, -0.1487], [-0.20883, -0.16151], [-0.08772, -0.0759], [-0.0759, -0.08772], [-0.16151, -0.20883], [-0.1487, -0.21814], [-0.05997, -0.0993], [-0.04508, -0.10688], [-0.08908, -0.24852], [-0.07401, -0.25341], [-0.02635, -0.11297], [-0.00985, -0.11558], [-0.00792, -0.26388], [0.00792, -0.26388], [0.00985, -0.11558], [0.02635, -0.11297], [0.07401, -0.25341], [0.08908, -0.24852], [0.04508, -0.10688], [0.05997, -0.0993], [0.1487, -0.21814], [0.16151, -0.20883], [0.0759, -0.08772], [0.08772, -0.0759], [0.20883, -0.16151], [0.21814, -0.1487], [0.0993, -0.05997], [0.10688, -0.04508], [0.24852, -0.08908], [0.25341, -0.07401], [0.11297, -0.02635]], "depth": 0.05, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "double-ten-spoke wheel face", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "wheel-rr", "attachment": null, "dimensions": {"width": 0.05, "height": 0.528, "depth": 0.528, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.075, 0], "rotation": [-1.5708, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-wheel-spokes-rr", "name": "双十辐黑化轮圈", "kind": "bevel", "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34", "img-r7-side"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(25, 26, 28, 1.0)", "secondaryAlbedo": "rgba(25, 26, 28, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_wheel_face_rr_75.add(mesh_wheel_face_rr_75);
  meshes["wheel-face-rr"] = mesh_wheel_face_rr_75;
  colliders["wheel-face-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_face_rr_75);

  const endpoint_caliper_rr_76 = makeAttachmentEndpoint(null);
  const node_caliper_rr_76 = new THREE.Group();
  node_caliper_rr_76.name = "\u540e\u53f3\u7ea2\u8272\u5361\u94b3__pivot";
  node_caliper_rr_76.scale.set(1, 1, 1);
  if (endpoint_caliper_rr_76) {
    node_caliper_rr_76.position.copy(endpoint_caliper_rr_76.start);
    node_caliper_rr_76.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_caliper_rr_76.position.set(-0.884, 0.505, -1.625);
    node_caliper_rr_76.rotation.set(0.0, 0.0, 0.0);
  }
  node_caliper_rr_76.userData.sculptComponent = {"id": "caliper-rr", "name": "后右红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.884, 0.505, -1.625], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-rr", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-rr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_rr_76.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_caliper_rr_76);
  nodes["caliper-rr"] = node_caliper_rr_76;
  const mesh_caliper_rr_76Geometry = endpoint_caliper_rr_76
    ? new THREE.CylinderGeometry(endpoint_caliper_rr_76.endRadius, endpoint_caliper_rr_76.baseRadius, endpoint_caliper_rr_76.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_caliper_rr_76) {
    mesh_caliper_rr_76Geometry.scale(0.046, 0.19, 0.12);
  }
  const mesh_caliper_rr_76 = new THREE.Mesh(
    mesh_caliper_rr_76Geometry,
    materialMap["caliper-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_caliper_rr_76.name = "\u540e\u53f3\u7ea2\u8272\u5361\u94b3";
  if (endpoint_caliper_rr_76) {
    mesh_caliper_rr_76.position.copy(endpoint_caliper_rr_76.midpoint);
    mesh_caliper_rr_76.quaternion.copy(endpoint_caliper_rr_76.quaternion);
  }
  mesh_caliper_rr_76.castShadow = options.castShadow ?? true;
  mesh_caliper_rr_76.receiveShadow = options.receiveShadow ?? true;
  mesh_caliper_rr_76.userData.sculptComponent = {"id": "caliper-rr", "name": "后右红色卡钳", "level": "micro", "role": "wheel", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.046, "height": 0.19, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.884, 0.505, -1.625], "rotation": [0, 0, 0], "scale": [0.046, 0.19, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "caliper-red", "materialLayers": ["caliper-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-caliper-rr", "name": "红色刹车卡钳", "kind": "gloss", "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-34"], "details": ["d-caliper-rr"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(176, 32, 42, 1.0)", "secondaryAlbedo": "rgba(176, 32, 42, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_caliper_rr_76.add(mesh_caliper_rr_76);
  meshes["caliper-rr"] = mesh_caliper_rr_76;
  colliders["caliper-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_caliper_rr_76);

  const endpoint_cabin_interior_77 = makeAttachmentEndpoint(null);
  const node_cabin_interior_77 = new THREE.Group();
  node_cabin_interior_77.name = "\u5ea7\u8231\u5bb9\u5668\uff08macro\uff0c\u51e0\u4f55\u9000\u5316\u4e3a 2cm \u8584\u7247\uff09__pivot";
  node_cabin_interior_77.scale.set(1, 1, 1);
  if (endpoint_cabin_interior_77) {
    node_cabin_interior_77.position.copy(endpoint_cabin_interior_77.start);
    node_cabin_interior_77.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cabin_interior_77.position.set(0.0, 0.0, 0.0);
    node_cabin_interior_77.rotation.set(0.0, 0.0, 0.0);
  }
  node_cabin_interior_77.userData.sculptComponent = {"id": "cabin-interior", "name": "座舱容器（macro，几何退化为 2cm 薄片）", "level": "macro", "role": "body", "importance": 0.5, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯容器节点：子件全部按世界坐标书写，故容器 position 必须归零（此处只留 2cm 退化片）", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.002, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.0, 0.0], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cabin_interior_77.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_cabin_interior_77);
  nodes["cabin-interior"] = node_cabin_interior_77;
  const mesh_cabin_interior_77Geometry = endpoint_cabin_interior_77
    ? new THREE.CylinderGeometry(endpoint_cabin_interior_77.endRadius, endpoint_cabin_interior_77.baseRadius, endpoint_cabin_interior_77.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_cabin_interior_77) {
    mesh_cabin_interior_77Geometry.scale(0.02, 0.02, 0.002);
  }
  const mesh_cabin_interior_77 = new THREE.Mesh(
    mesh_cabin_interior_77Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cabin_interior_77.name = "\u5ea7\u8231\u5bb9\u5668\uff08macro\uff0c\u51e0\u4f55\u9000\u5316\u4e3a 2cm \u8584\u7247\uff09";
  if (endpoint_cabin_interior_77) {
    mesh_cabin_interior_77.position.copy(endpoint_cabin_interior_77.midpoint);
    mesh_cabin_interior_77.quaternion.copy(endpoint_cabin_interior_77.quaternion);
  }
  mesh_cabin_interior_77.castShadow = options.castShadow ?? true;
  mesh_cabin_interior_77.receiveShadow = options.receiveShadow ?? true;
  mesh_cabin_interior_77.userData.sculptComponent = {"id": "cabin-interior", "name": "座舱容器（macro，几何退化为 2cm 薄片）", "level": "macro", "role": "body", "importance": 0.5, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯容器节点：子件全部按世界坐标书写，故容器 position 必须归零（此处只留 2cm 退化片）", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.002, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.0, 0.0], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_cabin_interior_77.add(mesh_cabin_interior_77);
  meshes["cabin-interior"] = mesh_cabin_interior_77;
  colliders["cabin-interior"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cabin_interior_77);

  const endpoint_cabin_floor_78 = makeAttachmentEndpoint(null);
  const node_cabin_floor_78 = new THREE.Group();
  node_cabin_floor_78.name = "\u5ea7\u8231\u5730\u677f__pivot";
  node_cabin_floor_78.scale.set(1, 1, 1);
  if (endpoint_cabin_floor_78) {
    node_cabin_floor_78.position.copy(endpoint_cabin_floor_78.start);
    node_cabin_floor_78.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_cabin_floor_78.position.set(0.89, 0.0, 0.0);
    node_cabin_floor_78.rotation.set(0.0, -1.5708, 0.0);
  }
  node_cabin_floor_78.userData.sculptComponent = {"id": "cabin-floor", "name": "座舱地板", "level": "meso", "role": "interior", "importance": 0.5, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "地台薄板挤出（2.76×1.78m）", "geometryDescriptor": {"profile2D": {"points": [[-1.64, 0.31], [-1.64, 0.272], [1.12, 0.272], [1.12, 0.31]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "cabin floor slab", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.038, "depth": 2.76, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "carpet", "materialLayers": ["carpet"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 46, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_floor_78.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_cabin_floor_78);
  nodes["cabin-floor"] = node_cabin_floor_78;
  const mesh_cabin_floor_78Geometry = endpoint_cabin_floor_78
    ? new THREE.CylinderGeometry(endpoint_cabin_floor_78.endRadius, endpoint_cabin_floor_78.baseRadius, endpoint_cabin_floor_78.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-1.64, 0.31], [-1.64, 0.272], [1.12, 0.272], [1.12, 0.31]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}});
  if (!endpoint_cabin_floor_78) {
    mesh_cabin_floor_78Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cabin_floor_78 = new THREE.Mesh(
    mesh_cabin_floor_78Geometry,
    materialMap["carpet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cabin_floor_78.name = "\u5ea7\u8231\u5730\u677f";
  if (endpoint_cabin_floor_78) {
    mesh_cabin_floor_78.position.copy(endpoint_cabin_floor_78.midpoint);
    mesh_cabin_floor_78.quaternion.copy(endpoint_cabin_floor_78.quaternion);
  }
  mesh_cabin_floor_78.castShadow = options.castShadow ?? true;
  mesh_cabin_floor_78.receiveShadow = options.receiveShadow ?? true;
  mesh_cabin_floor_78.userData.sculptComponent = {"id": "cabin-floor", "name": "座舱地板", "level": "meso", "role": "interior", "importance": 0.5, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "地台薄板挤出（2.76×1.78m）", "geometryDescriptor": {"profile2D": {"points": [[-1.64, 0.31], [-1.64, 0.272], [1.12, 0.272], [1.12, 0.31]], "depth": 1.78, "bevel": {"thickness": 0.004, "size": 0.004, "offset": -0.004, "segments": 1}}, "topologyIntent": "cabin floor slab", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.038, "depth": 2.76, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "carpet", "materialLayers": ["carpet"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 46, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_floor_78.add(mesh_cabin_floor_78);
  meshes["cabin-floor"] = mesh_cabin_floor_78;
  colliders["cabin-floor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cabin_floor_78);

  const endpoint_dash_upper_79 = makeAttachmentEndpoint(null);
  const node_dash_upper_79 = new THREE.Group();
  node_dash_upper_79.name = "\u4e0a\u4eea\u8868\u53f0\uff08\u7d2b\u7070\uff09__pivot";
  node_dash_upper_79.scale.set(1, 1, 1);
  if (endpoint_dash_upper_79) {
    node_dash_upper_79.position.copy(endpoint_dash_upper_79.start);
    node_dash_upper_79.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_dash_upper_79.position.set(0.89, -0.16, 0.0);
    node_dash_upper_79.rotation.set(0.0, -1.5708, 0.0);
  }
  node_dash_upper_79.userData.sculptComponent = {"id": "dash-upper", "name": "上仪表台（紫灰）", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "仪表台上体侧视断面挤出（横贯 1.78m），上缘带 12mm 圆角", "geometryDescriptor": {"profile2D": {"points": [[0.995, 0.955], [0.995, 1.07], [0.96, 1.112], [0.78, 1.122], [0.716, 1.062], [0.716, 0.955]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "upper dash pad", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.167, "depth": 0.279, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, -0.16, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dash-two-tone", "name": "上紫灰 / 下米白 双色仪表台", "kind": "linework", "note": "分色线 y0.955，紫灰上体压住米白下体的上沿（参考主驾位内饰）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-pass"], "details": ["d-dash-two-tone"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_upper_79.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_upper_79);
  nodes["dash-upper"] = node_dash_upper_79;
  const mesh_dash_upper_79Geometry = endpoint_dash_upper_79
    ? new THREE.CylinderGeometry(endpoint_dash_upper_79.endRadius, endpoint_dash_upper_79.baseRadius, endpoint_dash_upper_79.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.995, 0.955], [0.995, 1.07], [0.96, 1.112], [0.78, 1.122], [0.716, 1.062], [0.716, 0.955]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}});
  if (!endpoint_dash_upper_79) {
    mesh_dash_upper_79Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dash_upper_79 = new THREE.Mesh(
    mesh_dash_upper_79Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_upper_79.name = "\u4e0a\u4eea\u8868\u53f0\uff08\u7d2b\u7070\uff09";
  if (endpoint_dash_upper_79) {
    mesh_dash_upper_79.position.copy(endpoint_dash_upper_79.midpoint);
    mesh_dash_upper_79.quaternion.copy(endpoint_dash_upper_79.quaternion);
  }
  mesh_dash_upper_79.castShadow = options.castShadow ?? true;
  mesh_dash_upper_79.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_upper_79.userData.sculptComponent = {"id": "dash-upper", "name": "上仪表台（紫灰）", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "仪表台上体侧视断面挤出（横贯 1.78m），上缘带 12mm 圆角", "geometryDescriptor": {"profile2D": {"points": [[0.995, 0.955], [0.995, 1.07], [0.96, 1.112], [0.78, 1.122], [0.716, 1.062], [0.716, 0.955]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "upper dash pad", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.167, "depth": 0.279, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.89, -0.16, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dash-two-tone", "name": "上紫灰 / 下米白 双色仪表台", "kind": "linework", "note": "分色线 y0.955，紫灰上体压住米白下体的上沿（参考主驾位内饰）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-pass"], "details": ["d-dash-two-tone"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_upper_79.add(mesh_dash_upper_79);
  meshes["dash-upper"] = mesh_dash_upper_79;
  colliders["dash-upper"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_upper_79);

  const endpoint_dash_lower_80 = makeAttachmentEndpoint(null);
  const node_dash_lower_80 = new THREE.Group();
  node_dash_lower_80.name = "\u4e0b\u4eea\u8868\u53f0\uff08\u7c73\u767d\uff09__pivot";
  node_dash_lower_80.scale.set(1, 1, 1);
  if (endpoint_dash_lower_80) {
    node_dash_lower_80.position.copy(endpoint_dash_lower_80.start);
    node_dash_lower_80.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_dash_lower_80.position.set(0.89, -0.16, 0.0);
    node_dash_lower_80.rotation.set(0.0, -1.5708, 0.0);
  }
  node_dash_lower_80.userData.sculptComponent = {"id": "dash-lower", "name": "下仪表台（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "仪表台下体侧视断面挤出，膝部空间留 y0.74 以下", "geometryDescriptor": {"profile2D": {"points": [[0.995, 0.955], [0.716, 0.955], [0.7, 0.9], [0.716, 0.74], [0.995, 0.74]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "lower dash", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.215, "depth": 0.295, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, -0.16, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_lower_80.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_lower_80);
  nodes["dash-lower"] = node_dash_lower_80;
  const mesh_dash_lower_80Geometry = endpoint_dash_lower_80
    ? new THREE.CylinderGeometry(endpoint_dash_lower_80.endRadius, endpoint_dash_lower_80.baseRadius, endpoint_dash_lower_80.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.995, 0.955], [0.716, 0.955], [0.7, 0.9], [0.716, 0.74], [0.995, 0.74]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}});
  if (!endpoint_dash_lower_80) {
    mesh_dash_lower_80Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dash_lower_80 = new THREE.Mesh(
    mesh_dash_lower_80Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_lower_80.name = "\u4e0b\u4eea\u8868\u53f0\uff08\u7c73\u767d\uff09";
  if (endpoint_dash_lower_80) {
    mesh_dash_lower_80.position.copy(endpoint_dash_lower_80.midpoint);
    mesh_dash_lower_80.quaternion.copy(endpoint_dash_lower_80.quaternion);
  }
  mesh_dash_lower_80.castShadow = options.castShadow ?? true;
  mesh_dash_lower_80.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_lower_80.userData.sculptComponent = {"id": "dash-lower", "name": "下仪表台（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "仪表台下体侧视断面挤出，膝部空间留 y0.74 以下", "geometryDescriptor": {"profile2D": {"points": [[0.995, 0.955], [0.716, 0.955], [0.7, 0.9], [0.716, 0.74], [0.995, 0.74]], "depth": 1.78, "bevel": {"thickness": 0.006, "size": 0.01, "offset": -0.01, "segments": 2}}, "topologyIntent": "lower dash", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.215, "depth": 0.295, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.89, -0.16, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_lower_80.add(mesh_dash_lower_80);
  meshes["dash-lower"] = mesh_dash_lower_80;
  colliders["dash-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_lower_80);

  const endpoint_dash_chrome_strip_81 = makeAttachmentEndpoint(null);
  const node_dash_chrome_strip_81 = new THREE.Group();
  node_dash_chrome_strip_81.name = "\u4eea\u8868\u53f0\u9540\u94ec\u5206\u8272\u6761__pivot";
  node_dash_chrome_strip_81.scale.set(1, 1, 1);
  if (endpoint_dash_chrome_strip_81) {
    node_dash_chrome_strip_81.position.copy(endpoint_dash_chrome_strip_81.start);
    node_dash_chrome_strip_81.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dash_chrome_strip_81.position.set(0.0, 0.848, 0.742);
    node_dash_chrome_strip_81.rotation.set(0.0, 0.0, 0.0);
  }
  node_dash_chrome_strip_81.userData.sculptComponent = {"id": "dash-chrome-strip", "name": "仪表台镀铬分色条", "level": "micro", "role": "trim", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.56, "height": 0.012, "depth": 0.018, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.848, 0.742], "rotation": [0, 0, 0], "scale": [1.56, 0.012, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dash-chrome", "name": "贯穿镀铬饰条", "kind": "gloss", "note": "紫灰/米白分色线上一条 1.56m 镀铬细条，副驾视图里最亮的一根水平线"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-dash-chrome"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dash_chrome_strip_81.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_chrome_strip_81);
  nodes["dash-chrome-strip"] = node_dash_chrome_strip_81;
  const mesh_dash_chrome_strip_81Geometry = endpoint_dash_chrome_strip_81
    ? new THREE.CylinderGeometry(endpoint_dash_chrome_strip_81.endRadius, endpoint_dash_chrome_strip_81.baseRadius, endpoint_dash_chrome_strip_81.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_dash_chrome_strip_81) {
    mesh_dash_chrome_strip_81Geometry.scale(1.56, 0.012, 0.018);
  }
  const mesh_dash_chrome_strip_81 = new THREE.Mesh(
    mesh_dash_chrome_strip_81Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_chrome_strip_81.name = "\u4eea\u8868\u53f0\u9540\u94ec\u5206\u8272\u6761";
  if (endpoint_dash_chrome_strip_81) {
    mesh_dash_chrome_strip_81.position.copy(endpoint_dash_chrome_strip_81.midpoint);
    mesh_dash_chrome_strip_81.quaternion.copy(endpoint_dash_chrome_strip_81.quaternion);
  }
  mesh_dash_chrome_strip_81.castShadow = options.castShadow ?? true;
  mesh_dash_chrome_strip_81.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_chrome_strip_81.userData.sculptComponent = {"id": "dash-chrome-strip", "name": "仪表台镀铬分色条", "level": "micro", "role": "trim", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.56, "height": 0.012, "depth": 0.018, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.848, 0.742], "rotation": [0, 0, 0], "scale": [1.56, 0.012, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-dash-chrome", "name": "贯穿镀铬饰条", "kind": "gloss", "note": "紫灰/米白分色线上一条 1.56m 镀铬细条，副驾视图里最亮的一根水平线"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-dash-chrome"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dash_chrome_strip_81.add(mesh_dash_chrome_strip_81);
  meshes["dash-chrome-strip"] = mesh_dash_chrome_strip_81;
  colliders["dash-chrome-strip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_chrome_strip_81);

  const endpoint_dash_vent_82 = makeAttachmentEndpoint(null);
  const node_dash_vent_82 = new THREE.Group();
  node_dash_vent_82.name = "\u4e2d\u592e\u51fa\u98ce\u53e3\uff08\u5706\u5f62\uff09__pivot";
  node_dash_vent_82.scale.set(1, 1, 1);
  if (endpoint_dash_vent_82) {
    node_dash_vent_82.position.copy(endpoint_dash_vent_82.start);
    node_dash_vent_82.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_dash_vent_82.position.set(0.0, 0.91, 0.7);
    node_dash_vent_82.rotation.set(1.5708, 0.0, 0.0);
  }
  node_dash_vent_82.userData.sculptComponent = {"id": "dash-vent", "name": "中央出风口（圆形）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "圆形出风口：回转体（lathe）轴向朝 +Z", "geometryDescriptor": {"topologyIntent": "round air vent bezel", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.42, -0.5], [0.5, -0.4], [0.5, 0.4], [0.42, 0.5], [0.0002, 0.5]], "segments": 24}}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.088, "height": 0.088, "depth": 0.03, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.0, 0.91, 0.7], "rotation": [1.5708, 0, 0], "scale": [0.088, 0.03, 0.088]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "bronze-dark", "materialLayers": ["bronze-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-round-vent", "name": "圆形出风口 + 镀铬风量旋钮", "kind": "bevel", "note": "参考内饰图里仪表台中央的圆形出风口（含中央旋钮）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-round-vent"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 91, 69, 1.0)", "secondaryAlbedo": "rgba(107, 91, 69, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dash_vent_82.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_vent_82);
  nodes["dash-vent"] = node_dash_vent_82;
  const mesh_dash_vent_82Geometry = endpoint_dash_vent_82
    ? new THREE.CylinderGeometry(endpoint_dash_vent_82.endRadius, endpoint_dash_vent_82.baseRadius, endpoint_dash_vent_82.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.42, -0.5], [0.5, -0.4], [0.5, 0.4], [0.42, 0.5], [0.0002, 0.5]], "segments": 24});
  if (!endpoint_dash_vent_82) {
    mesh_dash_vent_82Geometry.scale(0.088, 0.03, 0.088);
  }
  const mesh_dash_vent_82 = new THREE.Mesh(
    mesh_dash_vent_82Geometry,
    materialMap["bronze-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_vent_82.name = "\u4e2d\u592e\u51fa\u98ce\u53e3\uff08\u5706\u5f62\uff09";
  if (endpoint_dash_vent_82) {
    mesh_dash_vent_82.position.copy(endpoint_dash_vent_82.midpoint);
    mesh_dash_vent_82.quaternion.copy(endpoint_dash_vent_82.quaternion);
  }
  mesh_dash_vent_82.castShadow = options.castShadow ?? true;
  mesh_dash_vent_82.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_vent_82.userData.sculptComponent = {"id": "dash-vent", "name": "中央出风口（圆形）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "圆形出风口：回转体（lathe）轴向朝 +Z", "geometryDescriptor": {"topologyIntent": "round air vent bezel", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.42, -0.5], [0.5, -0.4], [0.5, 0.4], [0.42, 0.5], [0.0002, 0.5]], "segments": 24}}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.088, "height": 0.088, "depth": 0.03, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.0, 0.91, 0.7], "rotation": [1.5708, 0, 0], "scale": [0.088, 0.03, 0.088]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "bronze-dark", "materialLayers": ["bronze-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-round-vent", "name": "圆形出风口 + 镀铬风量旋钮", "kind": "bevel", "note": "参考内饰图里仪表台中央的圆形出风口（含中央旋钮）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-round-vent"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 91, 69, 1.0)", "secondaryAlbedo": "rgba(107, 91, 69, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dash_vent_82.add(mesh_dash_vent_82);
  meshes["dash-vent"] = mesh_dash_vent_82;
  colliders["dash-vent"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_vent_82);

  const endpoint_center_screen_83 = makeAttachmentEndpoint(null);
  const node_center_screen_83 = new THREE.Group();
  node_center_screen_83.name = "15.6 \u5bf8\u60ac\u6d6e\u4e2d\u63a7\u5c4f__pivot";
  node_center_screen_83.scale.set(1, 1, 1);
  if (endpoint_center_screen_83) {
    node_center_screen_83.position.copy(endpoint_center_screen_83.start);
    node_center_screen_83.rotation.set(-0.14, 0.0, 0.0);
  } else {
    node_center_screen_83.position.set(0.0, 1.04, 0.716);
    node_center_screen_83.rotation.set(-0.14, 0.0, 0.0);
  }
  node_center_screen_83.userData.sculptComponent = {"id": "center-screen", "name": "15.6 寸悬浮中控屏", "level": "meso", "role": "screen", "importance": 1.0, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：横置 16:9 悬浮屏，靠 Canvas UI 贴图识别", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.345, "height": 0.2, "depth": 0.006, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.04, 0.716], "rotation": [-0.14, 0, 0], "scale": [0.345, 0.2, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-center-screen", "name": "横置悬浮 15.6 寸中控屏", "kind": "emissive", "note": "屏体上沿高出仪表台 6cm，向驾驶者倾斜 8°（参考主驾/副驾视图）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-pass"], "details": ["d-center-screen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_center_screen_83.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_center_screen_83);
  nodes["center-screen"] = node_center_screen_83;
  const mesh_center_screen_83Geometry = endpoint_center_screen_83
    ? new THREE.CylinderGeometry(endpoint_center_screen_83.endRadius, endpoint_center_screen_83.baseRadius, endpoint_center_screen_83.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_center_screen_83) {
    mesh_center_screen_83Geometry.scale(0.345, 0.2, 0.006);
  }
  const mesh_center_screen_83 = new THREE.Mesh(
    mesh_center_screen_83Geometry,
    materialMap["screen-ui"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_center_screen_83.name = "15.6 \u5bf8\u60ac\u6d6e\u4e2d\u63a7\u5c4f";
  if (endpoint_center_screen_83) {
    mesh_center_screen_83.position.copy(endpoint_center_screen_83.midpoint);
    mesh_center_screen_83.quaternion.copy(endpoint_center_screen_83.quaternion);
  }
  mesh_center_screen_83.castShadow = options.castShadow ?? true;
  mesh_center_screen_83.receiveShadow = options.receiveShadow ?? true;
  mesh_center_screen_83.userData.sculptComponent = {"id": "center-screen", "name": "15.6 寸悬浮中控屏", "level": "meso", "role": "screen", "importance": 1.0, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：横置 16:9 悬浮屏，靠 Canvas UI 贴图识别", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.345, "height": 0.2, "depth": 0.006, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.04, 0.716], "rotation": [-0.14, 0, 0], "scale": [0.345, 0.2, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-center-screen", "name": "横置悬浮 15.6 寸中控屏", "kind": "emissive", "note": "屏体上沿高出仪表台 6cm，向驾驶者倾斜 8°（参考主驾/副驾视图）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-pass"], "details": ["d-center-screen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_center_screen_83.add(mesh_center_screen_83);
  meshes["center-screen"] = mesh_center_screen_83;
  colliders["center-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_center_screen_83);

  const endpoint_center_screen_frame_84 = makeAttachmentEndpoint(null);
  const node_center_screen_frame_84 = new THREE.Group();
  node_center_screen_frame_84.name = "\u4e2d\u63a7\u5c4f\u80cc\u6846__pivot";
  node_center_screen_frame_84.scale.set(1, 1, 1);
  if (endpoint_center_screen_frame_84) {
    node_center_screen_frame_84.position.copy(endpoint_center_screen_frame_84.start);
    node_center_screen_frame_84.rotation.set(-0.14, 0.0, 0.0);
  } else {
    node_center_screen_frame_84.position.set(0.0, 1.04, 0.7);
    node_center_screen_frame_84.rotation.set(-0.14, 0.0, 0.0);
  }
  node_center_screen_frame_84.userData.sculptComponent = {"id": "center-screen-frame", "name": "中控屏背框", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.365, "height": 0.22, "depth": 0.014, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.04, 0.7], "rotation": [-0.14, 0, 0], "scale": [0.365, 0.22, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_center_screen_frame_84.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_center_screen_frame_84);
  nodes["center-screen-frame"] = node_center_screen_frame_84;
  const mesh_center_screen_frame_84Geometry = endpoint_center_screen_frame_84
    ? new THREE.CylinderGeometry(endpoint_center_screen_frame_84.endRadius, endpoint_center_screen_frame_84.baseRadius, endpoint_center_screen_frame_84.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_center_screen_frame_84) {
    mesh_center_screen_frame_84Geometry.scale(0.365, 0.22, 0.014);
  }
  const mesh_center_screen_frame_84 = new THREE.Mesh(
    mesh_center_screen_frame_84Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_center_screen_frame_84.name = "\u4e2d\u63a7\u5c4f\u80cc\u6846";
  if (endpoint_center_screen_frame_84) {
    mesh_center_screen_frame_84.position.copy(endpoint_center_screen_frame_84.midpoint);
    mesh_center_screen_frame_84.quaternion.copy(endpoint_center_screen_frame_84.quaternion);
  }
  mesh_center_screen_frame_84.castShadow = options.castShadow ?? true;
  mesh_center_screen_frame_84.receiveShadow = options.receiveShadow ?? true;
  mesh_center_screen_frame_84.userData.sculptComponent = {"id": "center-screen-frame", "name": "中控屏背框", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.365, "height": 0.22, "depth": 0.014, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.04, 0.7], "rotation": [-0.14, 0, 0], "scale": [0.365, 0.22, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_center_screen_frame_84.add(mesh_center_screen_frame_84);
  meshes["center-screen-frame"] = mesh_center_screen_frame_84;
  colliders["center-screen-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_center_screen_frame_84);

  const endpoint_cluster_screen_85 = makeAttachmentEndpoint(null);
  const node_cluster_screen_85 = new THREE.Group();
  node_cluster_screen_85.name = "10.25 \u5bf8\u4eea\u8868\u5c4f__pivot";
  node_cluster_screen_85.scale.set(1, 1, 1);
  if (endpoint_cluster_screen_85) {
    node_cluster_screen_85.position.copy(endpoint_cluster_screen_85.start);
    node_cluster_screen_85.rotation.set(-0.18, 0.0, 0.0);
  } else {
    node_cluster_screen_85.position.set(0.36, 0.968, 0.792);
    node_cluster_screen_85.rotation.set(-0.18, 0.0, 0.0);
  }
  node_cluster_screen_85.userData.sculptComponent = {"id": "cluster-screen", "name": "10.25 寸仪表屏", "level": "meso", "role": "screen", "importance": 0.95, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：横条仪表，位于方向盘后、仪表台凹槽内", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.227, "height": 0.128, "depth": 0.005, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.36, 0.968, 0.792], "rotation": [-0.18, 0, 0], "scale": [0.227, 0.128, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "gauge-ui", "materialLayers": ["gauge-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-cluster-screen", "name": "方向盘后 10.25 寸横条仪表", "kind": "emissive", "note": "屏体被方向盘上缘遮挡约 1/5，速度/踏板力/挡位由适配层 15Hz 重绘"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-cluster-screen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(6, 10, 8, 1.0)", "secondaryAlbedo": "rgba(6, 10, 8, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_cluster_screen_85.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_cluster_screen_85);
  nodes["cluster-screen"] = node_cluster_screen_85;
  const mesh_cluster_screen_85Geometry = endpoint_cluster_screen_85
    ? new THREE.CylinderGeometry(endpoint_cluster_screen_85.endRadius, endpoint_cluster_screen_85.baseRadius, endpoint_cluster_screen_85.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_cluster_screen_85) {
    mesh_cluster_screen_85Geometry.scale(0.227, 0.128, 0.005);
  }
  const mesh_cluster_screen_85 = new THREE.Mesh(
    mesh_cluster_screen_85Geometry,
    materialMap["gauge-ui"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cluster_screen_85.name = "10.25 \u5bf8\u4eea\u8868\u5c4f";
  if (endpoint_cluster_screen_85) {
    mesh_cluster_screen_85.position.copy(endpoint_cluster_screen_85.midpoint);
    mesh_cluster_screen_85.quaternion.copy(endpoint_cluster_screen_85.quaternion);
  }
  mesh_cluster_screen_85.castShadow = options.castShadow ?? true;
  mesh_cluster_screen_85.receiveShadow = options.receiveShadow ?? true;
  mesh_cluster_screen_85.userData.sculptComponent = {"id": "cluster-screen", "name": "10.25 寸仪表屏", "level": "meso", "role": "screen", "importance": 0.95, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：横条仪表，位于方向盘后、仪表台凹槽内", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.227, "height": 0.128, "depth": 0.005, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.36, 0.968, 0.792], "rotation": [-0.18, 0, 0], "scale": [0.227, 0.128, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "gauge-ui", "materialLayers": ["gauge-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-cluster-screen", "name": "方向盘后 10.25 寸横条仪表", "kind": "emissive", "note": "屏体被方向盘上缘遮挡约 1/5，速度/踏板力/挡位由适配层 15Hz 重绘"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-cluster-screen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(6, 10, 8, 1.0)", "secondaryAlbedo": "rgba(6, 10, 8, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_cluster_screen_85.add(mesh_cluster_screen_85);
  meshes["cluster-screen"] = mesh_cluster_screen_85;
  colliders["cluster-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cluster_screen_85);

  const endpoint_rear_screen_86 = makeAttachmentEndpoint(null);
  const node_rear_screen_86 = new THREE.Group();
  node_rear_screen_86.name = "\u540e\u6392\u63a7\u5236\u5c4f__pivot";
  node_rear_screen_86.scale.set(1, 1, 1);
  if (endpoint_rear_screen_86) {
    node_rear_screen_86.position.copy(endpoint_rear_screen_86.start);
    node_rear_screen_86.rotation.set(0.1, 3.14159, 0.0);
  } else {
    node_rear_screen_86.position.set(0.0, 0.76, -0.588);
    node_rear_screen_86.rotation.set(0.1, 3.14159, 0.0);
  }
  node_rear_screen_86.userData.sculptComponent = {"id": "rear-screen", "name": "后排控制屏", "level": "micro", "role": "screen", "importance": 0.7, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：中岛后端向后排的小屏", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.2, "height": 0.115, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.76, -0.588], "rotation": [0.1, 3.14159, 0], "scale": [0.2, 0.115, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_screen_86.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_rear_screen_86);
  nodes["rear-screen"] = node_rear_screen_86;
  const mesh_rear_screen_86Geometry = endpoint_rear_screen_86
    ? new THREE.CylinderGeometry(endpoint_rear_screen_86.endRadius, endpoint_rear_screen_86.baseRadius, endpoint_rear_screen_86.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_rear_screen_86) {
    mesh_rear_screen_86Geometry.scale(0.2, 0.115, 0.005);
  }
  const mesh_rear_screen_86 = new THREE.Mesh(
    mesh_rear_screen_86Geometry,
    materialMap["screen-ui"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_screen_86.name = "\u540e\u6392\u63a7\u5236\u5c4f";
  if (endpoint_rear_screen_86) {
    mesh_rear_screen_86.position.copy(endpoint_rear_screen_86.midpoint);
    mesh_rear_screen_86.quaternion.copy(endpoint_rear_screen_86.quaternion);
  }
  mesh_rear_screen_86.castShadow = options.castShadow ?? true;
  mesh_rear_screen_86.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_screen_86.userData.sculptComponent = {"id": "rear-screen", "name": "后排控制屏", "level": "micro", "role": "screen", "importance": 0.7, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "纯显示面：中岛后端向后排的小屏", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.2, "height": 0.115, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.76, -0.588], "rotation": [0.1, 3.14159, 0], "scale": [0.2, 0.115, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_rear_screen_86.add(mesh_rear_screen_86);
  meshes["rear-screen"] = mesh_rear_screen_86;
  colliders["rear-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_screen_86);

  const endpoint_steering_87 = makeAttachmentEndpoint(null);
  const node_steering_87 = new THREE.Group();
  node_steering_87.name = "\u53cc\u8f90\u65b9\u5411\u76d8\uff08\u7d2b\u771f\u76ae\uff09__pivot";
  node_steering_87.scale.set(1, 1, 1);
  if (endpoint_steering_87) {
    node_steering_87.position.copy(endpoint_steering_87.start);
    node_steering_87.rotation.set(0.32, 0.0, 0.0);
  } else {
    node_steering_87.position.set(0.36, 0.925, 0.64);
    node_steering_87.rotation.set(0.32, 0.0, 0.0);
  }
  node_steering_87.userData.sculptComponent = {"id": "steering", "name": "双辐方向盘（紫真皮）", "level": "meso", "role": "steer", "importance": 0.95, "confidence": 0.92, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "圆环体（torus：环半径 0.45×0.40=0.18m）绕 X 倾斜 18°", "geometryDescriptor": {"topologyIntent": "steering rim torus", "torusTubeRatio": 0.2, "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.05, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.36, 0.925, 0.64], "rotation": [0.32, 0, 0], "scale": [0.4, 0.4, 0.13]}, "actionProfile": {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-steer-double-spoke", "name": "双辐方向盘 + 米白中央板", "kind": "bevel", "note": "3/9 点两辐横条，中央盾形标座为米白真皮包覆（参考主驾位）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-steer-double-spoke"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_steering_87.userData.actionProfile = {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_steering_87);
  nodes["steering"] = node_steering_87;
  const mesh_steering_87Geometry = endpoint_steering_87
    ? new THREE.CylinderGeometry(endpoint_steering_87.endRadius, endpoint_steering_87.baseRadius, endpoint_steering_87.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.09, 12, 48);
  if (!endpoint_steering_87) {
    mesh_steering_87Geometry.scale(0.4, 0.4, 0.13);
  }
  const mesh_steering_87 = new THREE.Mesh(
    mesh_steering_87Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_steering_87.name = "\u53cc\u8f90\u65b9\u5411\u76d8\uff08\u7d2b\u771f\u76ae\uff09";
  if (endpoint_steering_87) {
    mesh_steering_87.position.copy(endpoint_steering_87.midpoint);
    mesh_steering_87.quaternion.copy(endpoint_steering_87.quaternion);
  }
  mesh_steering_87.castShadow = options.castShadow ?? true;
  mesh_steering_87.receiveShadow = options.receiveShadow ?? true;
  mesh_steering_87.userData.sculptComponent = {"id": "steering", "name": "双辐方向盘（紫真皮）", "level": "meso", "role": "steer", "importance": 0.95, "confidence": 0.92, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "圆环体（torus：环半径 0.45×0.40=0.18m）绕 X 倾斜 18°", "geometryDescriptor": {"topologyIntent": "steering rim torus", "torusTubeRatio": 0.2, "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.05, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.36, 0.925, 0.64], "rotation": [0.32, 0, 0], "scale": [0.4, 0.4, 0.13]}, "actionProfile": {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-steer-double-spoke", "name": "双辐方向盘 + 米白中央板", "kind": "bevel", "note": "3/9 点两辐横条，中央盾形标座为米白真皮包覆（参考主驾位）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-steer-double-spoke"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_steering_87.add(mesh_steering_87);
  meshes["steering"] = mesh_steering_87;
  colliders["steering"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_steering_87);

  const endpoint_steering_hub_88 = makeAttachmentEndpoint(null);
  const node_steering_hub_88 = new THREE.Group();
  node_steering_hub_88.name = "\u65b9\u5411\u76d8\u4e2d\u592e\u677f\uff08\u7c73\u767d\uff09__pivot";
  node_steering_hub_88.scale.set(1, 1, 1);
  if (endpoint_steering_hub_88) {
    node_steering_hub_88.position.copy(endpoint_steering_hub_88.start);
    node_steering_hub_88.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_steering_hub_88.position.set(0.0, 0.0, 0.004);
    node_steering_hub_88.rotation.set(1.5708, 0.0, 0.0);
  }
  node_steering_hub_88.userData.sculptComponent = {"id": "steering-hub", "name": "方向盘中央板（米白）", "level": "meso", "role": "steer", "importance": 0.9, "confidence": 0.9, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "中央板回转体（r0.10m），轴向 +Z", "geometryDescriptor": {"topologyIntent": "steering hub disc", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.5, -0.35], [0.5, 0.35], [0.4, 0.5], [0.0002, 0.5]], "segments": 24}}, "parent": "steering", "attachment": null, "dimensions": {"width": 0.2, "height": 0.045, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0.004], "rotation": [1.5708, 0, 0], "scale": [0.2, 0.045, 0.2]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-steer-double-spoke"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_steering_hub_88.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["steering"] ?? root).add(node_steering_hub_88);
  nodes["steering-hub"] = node_steering_hub_88;
  const mesh_steering_hub_88Geometry = endpoint_steering_hub_88
    ? new THREE.CylinderGeometry(endpoint_steering_hub_88.endRadius, endpoint_steering_hub_88.baseRadius, endpoint_steering_hub_88.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0002, -0.5], [0.4, -0.5], [0.5, -0.35], [0.5, 0.35], [0.4, 0.5], [0.0002, 0.5]], "segments": 24});
  if (!endpoint_steering_hub_88) {
    mesh_steering_hub_88Geometry.scale(0.2, 0.045, 0.2);
  }
  const mesh_steering_hub_88 = new THREE.Mesh(
    mesh_steering_hub_88Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_steering_hub_88.name = "\u65b9\u5411\u76d8\u4e2d\u592e\u677f\uff08\u7c73\u767d\uff09";
  if (endpoint_steering_hub_88) {
    mesh_steering_hub_88.position.copy(endpoint_steering_hub_88.midpoint);
    mesh_steering_hub_88.quaternion.copy(endpoint_steering_hub_88.quaternion);
  }
  mesh_steering_hub_88.castShadow = options.castShadow ?? true;
  mesh_steering_hub_88.receiveShadow = options.receiveShadow ?? true;
  mesh_steering_hub_88.userData.sculptComponent = {"id": "steering-hub", "name": "方向盘中央板（米白）", "level": "meso", "role": "steer", "importance": 0.9, "confidence": 0.9, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "中央板回转体（r0.10m），轴向 +Z", "geometryDescriptor": {"topologyIntent": "steering hub disc", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0002, -0.5], [0.4, -0.5], [0.5, -0.35], [0.5, 0.35], [0.4, 0.5], [0.0002, 0.5]], "segments": 24}}, "parent": "steering", "attachment": null, "dimensions": {"width": 0.2, "height": 0.045, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0.004], "rotation": [1.5708, 0, 0], "scale": [0.2, 0.045, 0.2]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-steer-double-spoke"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_steering_hub_88.add(mesh_steering_hub_88);
  meshes["steering-hub"] = mesh_steering_hub_88;
  colliders["steering-hub"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_steering_hub_88);

  const endpoint_steering_badge_89 = makeAttachmentEndpoint(null);
  const node_steering_badge_89 = new THREE.Group();
  node_steering_badge_89.name = "\u65b9\u5411\u76d8\u76fe\u5f62\u6807__pivot";
  node_steering_badge_89.scale.set(1, 1, 1);
  if (endpoint_steering_badge_89) {
    node_steering_badge_89.position.copy(endpoint_steering_badge_89.start);
    node_steering_badge_89.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_steering_badge_89.position.set(0.0, 0.01, -0.036);
    node_steering_badge_89.rotation.set(0.0, 3.14159, 0.0);
  }
  node_steering_badge_89.userData.sculptComponent = {"id": "steering-badge", "name": "方向盘盾形标", "level": "micro", "role": "badge", "importance": 0.75, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "steering", "attachment": null, "dimensions": {"width": 0.062, "height": 0.078, "depth": 0.004, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.01, -0.036], "rotation": [0, 3.14159, 0], "scale": [0.062, 0.078, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_steering_badge_89.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["steering"] ?? root).add(node_steering_badge_89);
  nodes["steering-badge"] = node_steering_badge_89;
  const mesh_steering_badge_89Geometry = endpoint_steering_badge_89
    ? new THREE.CylinderGeometry(endpoint_steering_badge_89.endRadius, endpoint_steering_badge_89.baseRadius, endpoint_steering_badge_89.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_steering_badge_89) {
    mesh_steering_badge_89Geometry.scale(0.062, 0.078, 0.004);
  }
  const mesh_steering_badge_89 = new THREE.Mesh(
    mesh_steering_badge_89Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_steering_badge_89.name = "\u65b9\u5411\u76d8\u76fe\u5f62\u6807";
  if (endpoint_steering_badge_89) {
    mesh_steering_badge_89.position.copy(endpoint_steering_badge_89.midpoint);
    mesh_steering_badge_89.quaternion.copy(endpoint_steering_badge_89.quaternion);
  }
  mesh_steering_badge_89.castShadow = options.castShadow ?? true;
  mesh_steering_badge_89.receiveShadow = options.receiveShadow ?? true;
  mesh_steering_badge_89.userData.sculptComponent = {"id": "steering-badge", "name": "方向盘盾形标", "level": "micro", "role": "badge", "importance": 0.75, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "steering", "attachment": null, "dimensions": {"width": 0.062, "height": 0.078, "depth": 0.004, "units": "meters", "confidence": 0.88}, "transform": {"position": [0, 0.01, -0.036], "rotation": [0, 3.14159, 0], "scale": [0.062, 0.078, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_steering_badge_89.add(mesh_steering_badge_89);
  meshes["steering-badge"] = mesh_steering_badge_89;
  colliders["steering-badge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_steering_badge_89);

  const endpoint_pedal_brake_90 = makeAttachmentEndpoint(null);
  const node_pedal_brake_90 = new THREE.Group();
  node_pedal_brake_90.name = "\u5236\u52a8\u8e0f\u677f__pivot";
  node_pedal_brake_90.scale.set(1, 1, 1);
  if (endpoint_pedal_brake_90) {
    node_pedal_brake_90.position.copy(endpoint_pedal_brake_90.start);
    node_pedal_brake_90.rotation.set(-0.3, 0.0, 0.0);
  } else {
    node_pedal_brake_90.position.set(0.44, 0.36, 1.02);
    node_pedal_brake_90.rotation.set(-0.3, 0.0, 0.0);
  }
  node_pedal_brake_90.userData.sculptComponent = {"id": "pedal-brake", "name": "制动踏板", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.08, "height": 0.15, "depth": 0.02, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.44, 0.36, 1.02], "rotation": [-0.3, 0, 0], "scale": [0.08, 0.15, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "pedal-metal", "materialLayers": ["pedal-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 146, 152, 1.0)", "secondaryAlbedo": "rgba(142, 146, 152, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_pedal_brake_90.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_pedal_brake_90);
  nodes["pedal-brake"] = node_pedal_brake_90;
  const mesh_pedal_brake_90Geometry = endpoint_pedal_brake_90
    ? new THREE.CylinderGeometry(endpoint_pedal_brake_90.endRadius, endpoint_pedal_brake_90.baseRadius, endpoint_pedal_brake_90.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_pedal_brake_90) {
    mesh_pedal_brake_90Geometry.scale(0.08, 0.15, 0.02);
  }
  const mesh_pedal_brake_90 = new THREE.Mesh(
    mesh_pedal_brake_90Geometry,
    materialMap["pedal-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pedal_brake_90.name = "\u5236\u52a8\u8e0f\u677f";
  if (endpoint_pedal_brake_90) {
    mesh_pedal_brake_90.position.copy(endpoint_pedal_brake_90.midpoint);
    mesh_pedal_brake_90.quaternion.copy(endpoint_pedal_brake_90.quaternion);
  }
  mesh_pedal_brake_90.castShadow = options.castShadow ?? true;
  mesh_pedal_brake_90.receiveShadow = options.receiveShadow ?? true;
  mesh_pedal_brake_90.userData.sculptComponent = {"id": "pedal-brake", "name": "制动踏板", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.08, "height": 0.15, "depth": 0.02, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.44, 0.36, 1.02], "rotation": [-0.3, 0, 0], "scale": [0.08, 0.15, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "pedal-metal", "materialLayers": ["pedal-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 146, 152, 1.0)", "secondaryAlbedo": "rgba(142, 146, 152, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_pedal_brake_90.add(mesh_pedal_brake_90);
  meshes["pedal-brake"] = mesh_pedal_brake_90;
  colliders["pedal-brake"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_pedal_brake_90);

  const endpoint_pedal_accel_91 = makeAttachmentEndpoint(null);
  const node_pedal_accel_91 = new THREE.Group();
  node_pedal_accel_91.name = "\u52a0\u901f\u8e0f\u677f__pivot";
  node_pedal_accel_91.scale.set(1, 1, 1);
  if (endpoint_pedal_accel_91) {
    node_pedal_accel_91.position.copy(endpoint_pedal_accel_91.start);
    node_pedal_accel_91.rotation.set(-0.36, 0.0, 0.0);
  } else {
    node_pedal_accel_91.position.set(0.3, 0.34, 1.03);
    node_pedal_accel_91.rotation.set(-0.36, 0.0, 0.0);
  }
  node_pedal_accel_91.userData.sculptComponent = {"id": "pedal-accel", "name": "加速踏板", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.06, "height": 0.19, "depth": 0.018, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.3, 0.34, 1.03], "rotation": [-0.36, 0, 0], "scale": [0.06, 0.19, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "pedal-metal", "materialLayers": ["pedal-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 146, 152, 1.0)", "secondaryAlbedo": "rgba(142, 146, 152, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_pedal_accel_91.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_pedal_accel_91);
  nodes["pedal-accel"] = node_pedal_accel_91;
  const mesh_pedal_accel_91Geometry = endpoint_pedal_accel_91
    ? new THREE.CylinderGeometry(endpoint_pedal_accel_91.endRadius, endpoint_pedal_accel_91.baseRadius, endpoint_pedal_accel_91.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_pedal_accel_91) {
    mesh_pedal_accel_91Geometry.scale(0.06, 0.19, 0.018);
  }
  const mesh_pedal_accel_91 = new THREE.Mesh(
    mesh_pedal_accel_91Geometry,
    materialMap["pedal-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pedal_accel_91.name = "\u52a0\u901f\u8e0f\u677f";
  if (endpoint_pedal_accel_91) {
    mesh_pedal_accel_91.position.copy(endpoint_pedal_accel_91.midpoint);
    mesh_pedal_accel_91.quaternion.copy(endpoint_pedal_accel_91.quaternion);
  }
  mesh_pedal_accel_91.castShadow = options.castShadow ?? true;
  mesh_pedal_accel_91.receiveShadow = options.receiveShadow ?? true;
  mesh_pedal_accel_91.userData.sculptComponent = {"id": "pedal-accel", "name": "加速踏板", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.06, "height": 0.19, "depth": 0.018, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.3, 0.34, 1.03], "rotation": [-0.36, 0, 0], "scale": [0.06, 0.19, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "pedal-metal", "materialLayers": ["pedal-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 146, 152, 1.0)", "secondaryAlbedo": "rgba(142, 146, 152, 0.85)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_pedal_accel_91.add(mesh_pedal_accel_91);
  meshes["pedal-accel"] = mesh_pedal_accel_91;
  colliders["pedal-accel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_pedal_accel_91);

  const endpoint_center_console_92 = makeAttachmentEndpoint(null);
  const node_center_console_92 = new THREE.Group();
  node_center_console_92.name = "\u4e2d\u592e\u901a\u9053\u5c9b\u53f0\uff08\u7c73\u767d\uff09__pivot";
  node_center_console_92.scale.set(1, 1, 1);
  if (endpoint_center_console_92) {
    node_center_console_92.position.copy(endpoint_center_console_92.start);
    node_center_console_92.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_center_console_92.position.set(0.17, 0.0, 0.0);
    node_center_console_92.rotation.set(0.0, -1.5708, 0.0);
  }
  node_center_console_92.userData.sculptComponent = {"id": "center-console", "name": "中央通道岛台（米白）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "中岛侧视断面挤出 0.34m 宽，前高后低", "geometryDescriptor": {"profile2D": {"points": [[-0.52, 0.66], [-0.52, 0.36], [-0.48, 0.3], [0.6, 0.3], [0.6, 0.66]], "depth": 0.34, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "center console body", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.36, "depth": 1.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.17, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-console-island", "name": "悬浮中岛 + 无线充", "kind": "linework", "note": "中岛顶面 y0.66 略低于坐垫，前段斜置充电板"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-console-island"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_center_console_92.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_center_console_92);
  nodes["center-console"] = node_center_console_92;
  const mesh_center_console_92Geometry = endpoint_center_console_92
    ? new THREE.CylinderGeometry(endpoint_center_console_92.endRadius, endpoint_center_console_92.baseRadius, endpoint_center_console_92.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.52, 0.66], [-0.52, 0.36], [-0.48, 0.3], [0.6, 0.3], [0.6, 0.66]], "depth": 0.34, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}});
  if (!endpoint_center_console_92) {
    mesh_center_console_92Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_center_console_92 = new THREE.Mesh(
    mesh_center_console_92Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_center_console_92.name = "\u4e2d\u592e\u901a\u9053\u5c9b\u53f0\uff08\u7c73\u767d\uff09";
  if (endpoint_center_console_92) {
    mesh_center_console_92.position.copy(endpoint_center_console_92.midpoint);
    mesh_center_console_92.quaternion.copy(endpoint_center_console_92.quaternion);
  }
  mesh_center_console_92.castShadow = options.castShadow ?? true;
  mesh_center_console_92.receiveShadow = options.receiveShadow ?? true;
  mesh_center_console_92.userData.sculptComponent = {"id": "center-console", "name": "中央通道岛台（米白）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "中岛侧视断面挤出 0.34m 宽，前高后低", "geometryDescriptor": {"profile2D": {"points": [[-0.52, 0.66], [-0.52, 0.36], [-0.48, 0.3], [0.6, 0.3], [0.6, 0.66]], "depth": 0.34, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "center console body", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.36, "depth": 1.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.17, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-console-island", "name": "悬浮中岛 + 无线充", "kind": "linework", "note": "中岛顶面 y0.66 略低于坐垫，前段斜置充电板"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-console-island"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_center_console_92.add(mesh_center_console_92);
  meshes["center-console"] = mesh_center_console_92;
  colliders["center-console"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_center_console_92);

  const endpoint_console_armrest_93 = makeAttachmentEndpoint(null);
  const node_console_armrest_93 = new THREE.Group();
  node_console_armrest_93.name = "\u4e2d\u5c9b\u7d2b\u7070\u6276\u624b__pivot";
  node_console_armrest_93.scale.set(1, 1, 1);
  if (endpoint_console_armrest_93) {
    node_console_armrest_93.position.copy(endpoint_console_armrest_93.start);
    node_console_armrest_93.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_console_armrest_93.position.set(0.16, 0.0, 0.0);
    node_console_armrest_93.rotation.set(0.0, -1.5708, 0.0);
  }
  node_console_armrest_93.userData.sculptComponent = {"id": "console-armrest", "name": "中岛紫灰扶手", "level": "meso", "role": "interior", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "扶手断面挤出 0.32m 宽，顶面 y0.75", "geometryDescriptor": {"profile2D": {"points": [[-0.52, 0.752], [-0.5, 0.7], [-0.1, 0.7], [-0.1, 0.752]], "depth": 0.32, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "console armrest pad", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.32, "height": 0.09, "depth": 0.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.16, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_console_armrest_93.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_console_armrest_93);
  nodes["console-armrest"] = node_console_armrest_93;
  const mesh_console_armrest_93Geometry = endpoint_console_armrest_93
    ? new THREE.CylinderGeometry(endpoint_console_armrest_93.endRadius, endpoint_console_armrest_93.baseRadius, endpoint_console_armrest_93.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.52, 0.752], [-0.5, 0.7], [-0.1, 0.7], [-0.1, 0.752]], "depth": 0.32, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}});
  if (!endpoint_console_armrest_93) {
    mesh_console_armrest_93Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_console_armrest_93 = new THREE.Mesh(
    mesh_console_armrest_93Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_console_armrest_93.name = "\u4e2d\u5c9b\u7d2b\u7070\u6276\u624b";
  if (endpoint_console_armrest_93) {
    mesh_console_armrest_93.position.copy(endpoint_console_armrest_93.midpoint);
    mesh_console_armrest_93.quaternion.copy(endpoint_console_armrest_93.quaternion);
  }
  mesh_console_armrest_93.castShadow = options.castShadow ?? true;
  mesh_console_armrest_93.receiveShadow = options.receiveShadow ?? true;
  mesh_console_armrest_93.userData.sculptComponent = {"id": "console-armrest", "name": "中岛紫灰扶手", "level": "meso", "role": "interior", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "扶手断面挤出 0.32m 宽，顶面 y0.75", "geometryDescriptor": {"profile2D": {"points": [[-0.52, 0.752], [-0.5, 0.7], [-0.1, 0.7], [-0.1, 0.752]], "depth": 0.32, "bevel": {"thickness": 0.006, "size": 0.012, "offset": -0.012, "segments": 2}}, "topologyIntent": "console armrest pad", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.32, "height": 0.09, "depth": 0.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.16, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_console_armrest_93.add(mesh_console_armrest_93);
  meshes["console-armrest"] = mesh_console_armrest_93;
  colliders["console-armrest"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_console_armrest_93);

  const endpoint_seat_driver_cushion_94 = makeAttachmentEndpoint(null);
  const node_seat_driver_cushion_94 = new THREE.Group();
  node_seat_driver_cushion_94.name = "\u4e3b\u9a7e\u5750\u57ab\uff08\u7c73\u767d\uff09__pivot";
  node_seat_driver_cushion_94.scale.set(1, 1, 1);
  if (endpoint_seat_driver_cushion_94) {
    node_seat_driver_cushion_94.position.copy(endpoint_seat_driver_cushion_94.start);
    node_seat_driver_cushion_94.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_driver_cushion_94.position.set(0.61, 0.0, 0.0);
    node_seat_driver_cushion_94.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_driver_cushion_94.userData.sculptComponent = {"id": "seat-driver-cushion", "name": "主驾坐垫（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "坐垫侧视断面挤出 0.50m 宽，坐面高 y0.60（H 点口径）；挤出恒朝 -x，右侧节点取内缘", "geometryDescriptor": {"profile2D": {"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "seat cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.2, "depth": 0.58, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.61, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-seat-quilt-driver", "name": "米白座椅缝线分块", "kind": "stitch", "note": "坐垫/靠背各 3 道纵向缝线，由适配层菱格贴图表达"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat", "img-r7-dash"], "details": ["d-seat-quilt-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_cushion_94.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_driver_cushion_94);
  nodes["seat-driver-cushion"] = node_seat_driver_cushion_94;
  const mesh_seat_driver_cushion_94Geometry = endpoint_seat_driver_cushion_94
    ? new THREE.CylinderGeometry(endpoint_seat_driver_cushion_94.endRadius, endpoint_seat_driver_cushion_94.baseRadius, endpoint_seat_driver_cushion_94.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}});
  if (!endpoint_seat_driver_cushion_94) {
    mesh_seat_driver_cushion_94Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_driver_cushion_94 = new THREE.Mesh(
    mesh_seat_driver_cushion_94Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_driver_cushion_94.name = "\u4e3b\u9a7e\u5750\u57ab\uff08\u7c73\u767d\uff09";
  if (endpoint_seat_driver_cushion_94) {
    mesh_seat_driver_cushion_94.position.copy(endpoint_seat_driver_cushion_94.midpoint);
    mesh_seat_driver_cushion_94.quaternion.copy(endpoint_seat_driver_cushion_94.quaternion);
  }
  mesh_seat_driver_cushion_94.castShadow = options.castShadow ?? true;
  mesh_seat_driver_cushion_94.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_driver_cushion_94.userData.sculptComponent = {"id": "seat-driver-cushion", "name": "主驾坐垫（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "坐垫侧视断面挤出 0.50m 宽，坐面高 y0.60（H 点口径）；挤出恒朝 -x，右侧节点取内缘", "geometryDescriptor": {"profile2D": {"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "seat cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.2, "depth": 0.58, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.61, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-seat-quilt-driver", "name": "米白座椅缝线分块", "kind": "stitch", "note": "坐垫/靠背各 3 道纵向缝线，由适配层菱格贴图表达"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat", "img-r7-dash"], "details": ["d-seat-quilt-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_cushion_94.add(mesh_seat_driver_cushion_94);
  meshes["seat-driver-cushion"] = mesh_seat_driver_cushion_94;
  colliders["seat-driver-cushion"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_driver_cushion_94);

  const endpoint_seat_driver_back_95 = makeAttachmentEndpoint(null);
  const node_seat_driver_back_95 = new THREE.Group();
  node_seat_driver_back_95.name = "\u4e3b\u9a7e\u9760\u80cc\uff08\u7c73\u767d\uff09__pivot";
  node_seat_driver_back_95.scale.set(1, 1, 1);
  if (endpoint_seat_driver_back_95) {
    node_seat_driver_back_95.position.copy(endpoint_seat_driver_back_95.start);
    node_seat_driver_back_95.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_driver_back_95.position.set(0.61, 0.0, 0.0);
    node_seat_driver_back_95.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_driver_back_95.userData.sculptComponent = {"id": "seat-driver-back", "name": "主驾靠背（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "靠背侧视断面挤出（后倾 22°），顶端 y1.048（+Z 端为靠背背侧）", "geometryDescriptor": {"profile2D": {"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "seat backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.47, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.61, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-rearseat"], "details": ["d-seat-quilt-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_back_95.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_driver_back_95);
  nodes["seat-driver-back"] = node_seat_driver_back_95;
  const mesh_seat_driver_back_95Geometry = endpoint_seat_driver_back_95
    ? new THREE.CylinderGeometry(endpoint_seat_driver_back_95.endRadius, endpoint_seat_driver_back_95.baseRadius, endpoint_seat_driver_back_95.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}});
  if (!endpoint_seat_driver_back_95) {
    mesh_seat_driver_back_95Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_driver_back_95 = new THREE.Mesh(
    mesh_seat_driver_back_95Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_driver_back_95.name = "\u4e3b\u9a7e\u9760\u80cc\uff08\u7c73\u767d\uff09";
  if (endpoint_seat_driver_back_95) {
    mesh_seat_driver_back_95.position.copy(endpoint_seat_driver_back_95.midpoint);
    mesh_seat_driver_back_95.quaternion.copy(endpoint_seat_driver_back_95.quaternion);
  }
  mesh_seat_driver_back_95.castShadow = options.castShadow ?? true;
  mesh_seat_driver_back_95.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_driver_back_95.userData.sculptComponent = {"id": "seat-driver-back", "name": "主驾靠背（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "靠背侧视断面挤出（后倾 22°），顶端 y1.048（+Z 端为靠背背侧）", "geometryDescriptor": {"profile2D": {"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "seat backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.47, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.61, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-rearseat"], "details": ["d-seat-quilt-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_back_95.add(mesh_seat_driver_back_95);
  meshes["seat-driver-back"] = mesh_seat_driver_back_95;
  colliders["seat-driver-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_driver_back_95);

  const endpoint_seat_driver_headrest_96 = makeAttachmentEndpoint(null);
  const node_seat_driver_headrest_96 = new THREE.Group();
  node_seat_driver_headrest_96.name = "\u4e3b\u9a7e\u5934\u6795\uff08\u6d45\u8272\uff09__pivot";
  node_seat_driver_headrest_96.scale.set(1, 1, 1);
  if (endpoint_seat_driver_headrest_96) {
    node_seat_driver_headrest_96.position.copy(endpoint_seat_driver_headrest_96.start);
    node_seat_driver_headrest_96.rotation.set(-0.26, 0.0, 0.0);
  } else {
    node_seat_driver_headrest_96.position.set(0.36, 1.152, -0.196);
    node_seat_driver_headrest_96.rotation.set(-0.26, 0.0, 0.0);
  }
  node_seat_driver_headrest_96.userData.sculptComponent = {"id": "seat-driver-headrest", "name": "主驾头枕（浅色）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.3, "height": 0.17, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.36, 1.152, -0.196], "rotation": [-0.26, 0, 0], "scale": [0.3, 0.17, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-headrest-driver", "name": "浅色一体式头枕", "kind": "bevel", "note": "头枕前倾 15°，参考后排图里米白头枕的圆角轮廓"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_headrest_96.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_driver_headrest_96);
  nodes["seat-driver-headrest"] = node_seat_driver_headrest_96;
  const mesh_seat_driver_headrest_96Geometry = endpoint_seat_driver_headrest_96
    ? new THREE.CylinderGeometry(endpoint_seat_driver_headrest_96.endRadius, endpoint_seat_driver_headrest_96.baseRadius, endpoint_seat_driver_headrest_96.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_driver_headrest_96) {
    mesh_seat_driver_headrest_96Geometry.scale(0.3, 0.17, 0.12);
  }
  const mesh_seat_driver_headrest_96 = new THREE.Mesh(
    mesh_seat_driver_headrest_96Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_driver_headrest_96.name = "\u4e3b\u9a7e\u5934\u6795\uff08\u6d45\u8272\uff09";
  if (endpoint_seat_driver_headrest_96) {
    mesh_seat_driver_headrest_96.position.copy(endpoint_seat_driver_headrest_96.midpoint);
    mesh_seat_driver_headrest_96.quaternion.copy(endpoint_seat_driver_headrest_96.quaternion);
  }
  mesh_seat_driver_headrest_96.castShadow = options.castShadow ?? true;
  mesh_seat_driver_headrest_96.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_driver_headrest_96.userData.sculptComponent = {"id": "seat-driver-headrest", "name": "主驾头枕（浅色）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.3, "height": 0.17, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.36, 1.152, -0.196], "rotation": [-0.26, 0, 0], "scale": [0.3, 0.17, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-headrest-driver", "name": "浅色一体式头枕", "kind": "bevel", "note": "头枕前倾 15°，参考后排图里米白头枕的圆角轮廓"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-driver"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_headrest_96.add(mesh_seat_driver_headrest_96);
  meshes["seat-driver-headrest"] = mesh_seat_driver_headrest_96;
  colliders["seat-driver-headrest"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_driver_headrest_96);

  const endpoint_seat_passenger_cushion_97 = makeAttachmentEndpoint(null);
  const node_seat_passenger_cushion_97 = new THREE.Group();
  node_seat_passenger_cushion_97.name = "\u526f\u9a7e\u5750\u57ab\uff08\u7c73\u767d\uff09__pivot";
  node_seat_passenger_cushion_97.scale.set(1, 1, 1);
  if (endpoint_seat_passenger_cushion_97) {
    node_seat_passenger_cushion_97.position.copy(endpoint_seat_passenger_cushion_97.start);
    node_seat_passenger_cushion_97.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_passenger_cushion_97.position.set(-0.10999999999999999, 0.0, 0.0);
    node_seat_passenger_cushion_97.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_passenger_cushion_97.userData.sculptComponent = {"id": "seat-passenger-cushion", "name": "副驾坐垫（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "坐垫侧视断面挤出 0.50m 宽，坐面高 y0.60（H 点口径）；挤出恒朝 -x，右侧节点取内缘", "geometryDescriptor": {"profile2D": {"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "seat cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.2, "depth": 0.58, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.10999999999999999, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-seat-quilt-passenger", "name": "米白座椅缝线分块", "kind": "stitch", "note": "坐垫/靠背各 3 道纵向缝线，由适配层菱格贴图表达"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat", "img-r7-dash"], "details": ["d-seat-quilt-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_cushion_97.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_passenger_cushion_97);
  nodes["seat-passenger-cushion"] = node_seat_passenger_cushion_97;
  const mesh_seat_passenger_cushion_97Geometry = endpoint_seat_passenger_cushion_97
    ? new THREE.CylinderGeometry(endpoint_seat_passenger_cushion_97.endRadius, endpoint_seat_passenger_cushion_97.baseRadius, endpoint_seat_passenger_cushion_97.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}});
  if (!endpoint_seat_passenger_cushion_97) {
    mesh_seat_passenger_cushion_97Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_passenger_cushion_97 = new THREE.Mesh(
    mesh_seat_passenger_cushion_97Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_passenger_cushion_97.name = "\u526f\u9a7e\u5750\u57ab\uff08\u7c73\u767d\uff09";
  if (endpoint_seat_passenger_cushion_97) {
    mesh_seat_passenger_cushion_97.position.copy(endpoint_seat_passenger_cushion_97.midpoint);
    mesh_seat_passenger_cushion_97.quaternion.copy(endpoint_seat_passenger_cushion_97.quaternion);
  }
  mesh_seat_passenger_cushion_97.castShadow = options.castShadow ?? true;
  mesh_seat_passenger_cushion_97.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_passenger_cushion_97.userData.sculptComponent = {"id": "seat-passenger-cushion", "name": "副驾坐垫（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "坐垫侧视断面挤出 0.50m 宽，坐面高 y0.60（H 点口径）；挤出恒朝 -x，右侧节点取内缘", "geometryDescriptor": {"profile2D": {"points": [[0.335, 0.6], [0.24, 0.612], [0.06, 0.6], [-0.18, 0.596], [-0.245, 0.552], [-0.238, 0.452], [-0.18, 0.418], [0.06, 0.41], [0.25, 0.424], [0.335, 0.478]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "seat cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.2, "depth": 0.58, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.10999999999999999, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-seat-quilt-passenger", "name": "米白座椅缝线分块", "kind": "stitch", "note": "坐垫/靠背各 3 道纵向缝线，由适配层菱格贴图表达"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat", "img-r7-dash"], "details": ["d-seat-quilt-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_cushion_97.add(mesh_seat_passenger_cushion_97);
  meshes["seat-passenger-cushion"] = mesh_seat_passenger_cushion_97;
  colliders["seat-passenger-cushion"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_passenger_cushion_97);

  const endpoint_seat_passenger_back_98 = makeAttachmentEndpoint(null);
  const node_seat_passenger_back_98 = new THREE.Group();
  node_seat_passenger_back_98.name = "\u526f\u9a7e\u9760\u80cc\uff08\u7c73\u767d\uff09__pivot";
  node_seat_passenger_back_98.scale.set(1, 1, 1);
  if (endpoint_seat_passenger_back_98) {
    node_seat_passenger_back_98.position.copy(endpoint_seat_passenger_back_98.start);
    node_seat_passenger_back_98.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_passenger_back_98.position.set(-0.10999999999999999, 0.0, 0.0);
    node_seat_passenger_back_98.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_passenger_back_98.userData.sculptComponent = {"id": "seat-passenger-back", "name": "副驾靠背（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "靠背侧视断面挤出（后倾 22°），顶端 y1.048（+Z 端为靠背背侧）", "geometryDescriptor": {"profile2D": {"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "seat backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.47, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.10999999999999999, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-rearseat"], "details": ["d-seat-quilt-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_back_98.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_passenger_back_98);
  nodes["seat-passenger-back"] = node_seat_passenger_back_98;
  const mesh_seat_passenger_back_98Geometry = endpoint_seat_passenger_back_98
    ? new THREE.CylinderGeometry(endpoint_seat_passenger_back_98.endRadius, endpoint_seat_passenger_back_98.baseRadius, endpoint_seat_passenger_back_98.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}});
  if (!endpoint_seat_passenger_back_98) {
    mesh_seat_passenger_back_98Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_passenger_back_98 = new THREE.Mesh(
    mesh_seat_passenger_back_98Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_passenger_back_98.name = "\u526f\u9a7e\u9760\u80cc\uff08\u7c73\u767d\uff09";
  if (endpoint_seat_passenger_back_98) {
    mesh_seat_passenger_back_98.position.copy(endpoint_seat_passenger_back_98.midpoint);
    mesh_seat_passenger_back_98.quaternion.copy(endpoint_seat_passenger_back_98.quaternion);
  }
  mesh_seat_passenger_back_98.castShadow = options.castShadow ?? true;
  mesh_seat_passenger_back_98.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_passenger_back_98.userData.sculptComponent = {"id": "seat-passenger-back", "name": "副驾靠背（米白）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "靠背侧视断面挤出（后倾 22°），顶端 y1.048（+Z 端为靠背背侧）", "geometryDescriptor": {"profile2D": {"points": [[-0.052, 0.59], [-0.058, 0.7], [-0.096, 0.9], [-0.18, 1.048], [-0.262, 1.02], [-0.238, 0.88], [-0.196, 0.7], [-0.15, 0.59]], "depth": 0.5, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "seat backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.5, "height": 0.47, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.10999999999999999, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash", "img-r7-rearseat"], "details": ["d-seat-quilt-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_back_98.add(mesh_seat_passenger_back_98);
  meshes["seat-passenger-back"] = mesh_seat_passenger_back_98;
  colliders["seat-passenger-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_passenger_back_98);

  const endpoint_seat_passenger_headrest_99 = makeAttachmentEndpoint(null);
  const node_seat_passenger_headrest_99 = new THREE.Group();
  node_seat_passenger_headrest_99.name = "\u526f\u9a7e\u5934\u6795\uff08\u6d45\u8272\uff09__pivot";
  node_seat_passenger_headrest_99.scale.set(1, 1, 1);
  if (endpoint_seat_passenger_headrest_99) {
    node_seat_passenger_headrest_99.position.copy(endpoint_seat_passenger_headrest_99.start);
    node_seat_passenger_headrest_99.rotation.set(-0.26, 0.0, 0.0);
  } else {
    node_seat_passenger_headrest_99.position.set(-0.36, 1.152, -0.196);
    node_seat_passenger_headrest_99.rotation.set(-0.26, 0.0, 0.0);
  }
  node_seat_passenger_headrest_99.userData.sculptComponent = {"id": "seat-passenger-headrest", "name": "副驾头枕（浅色）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.3, "height": 0.17, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.36, 1.152, -0.196], "rotation": [-0.26, 0, 0], "scale": [0.3, 0.17, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-headrest-passenger", "name": "浅色一体式头枕", "kind": "bevel", "note": "头枕前倾 15°，参考后排图里米白头枕的圆角轮廓"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_headrest_99.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_passenger_headrest_99);
  nodes["seat-passenger-headrest"] = node_seat_passenger_headrest_99;
  const mesh_seat_passenger_headrest_99Geometry = endpoint_seat_passenger_headrest_99
    ? new THREE.CylinderGeometry(endpoint_seat_passenger_headrest_99.endRadius, endpoint_seat_passenger_headrest_99.baseRadius, endpoint_seat_passenger_headrest_99.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_passenger_headrest_99) {
    mesh_seat_passenger_headrest_99Geometry.scale(0.3, 0.17, 0.12);
  }
  const mesh_seat_passenger_headrest_99 = new THREE.Mesh(
    mesh_seat_passenger_headrest_99Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_passenger_headrest_99.name = "\u526f\u9a7e\u5934\u6795\uff08\u6d45\u8272\uff09";
  if (endpoint_seat_passenger_headrest_99) {
    mesh_seat_passenger_headrest_99.position.copy(endpoint_seat_passenger_headrest_99.midpoint);
    mesh_seat_passenger_headrest_99.quaternion.copy(endpoint_seat_passenger_headrest_99.quaternion);
  }
  mesh_seat_passenger_headrest_99.castShadow = options.castShadow ?? true;
  mesh_seat_passenger_headrest_99.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_passenger_headrest_99.userData.sculptComponent = {"id": "seat-passenger-headrest", "name": "副驾头枕（浅色）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.3, "height": 0.17, "depth": 0.12, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.36, 1.152, -0.196], "rotation": [-0.26, 0, 0], "scale": [0.3, 0.17, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-headrest-passenger", "name": "浅色一体式头枕", "kind": "bevel", "note": "头枕前倾 15°，参考后排图里米白头枕的圆角轮廓"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-passenger"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_headrest_99.add(mesh_seat_passenger_headrest_99);
  meshes["seat-passenger-headrest"] = mesh_seat_passenger_headrest_99;
  colliders["seat-passenger-headrest"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_passenger_headrest_99);

  const endpoint_seat_rear_cushion_100 = makeAttachmentEndpoint(null);
  const node_seat_rear_cushion_100 = new THREE.Group();
  node_seat_rear_cushion_100.name = "\u540e\u6392\u5750\u57ab\uff08\u4e00\u4f53\u5f0f\u957f\u51f3\uff09__pivot";
  node_seat_rear_cushion_100.scale.set(1, 1, 1);
  if (endpoint_seat_rear_cushion_100) {
    node_seat_rear_cushion_100.position.copy(endpoint_seat_rear_cushion_100.start);
    node_seat_rear_cushion_100.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_rear_cushion_100.position.set(0.72, 0.0, -0.72);
    node_seat_rear_cushion_100.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_rear_cushion_100.userData.sculptComponent = {"id": "seat-rear-cushion", "name": "后排坐垫（一体式长凳）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "后排长凳坐垫断面挤出 1.44m 宽", "geometryDescriptor": {"profile2D": {"points": [[0.3, 0.585], [0.18, 0.596], [-0.06, 0.592], [-0.3, 0.586], [-0.36, 0.54], [-0.352, 0.452], [-0.3, 0.42], [-0.06, 0.414], [0.19, 0.42], [0.3, 0.47]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "rear bench cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.44, "height": 0.18, "depth": 0.66, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.72, 0, -0.72], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rear-bench", "name": "一体式长凳", "kind": "stitch", "note": "坐垫面 y0.59，长 1.44m，中间无明显断开（参考后排图）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-rear-bench"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_cushion_100.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_rear_cushion_100);
  nodes["seat-rear-cushion"] = node_seat_rear_cushion_100;
  const mesh_seat_rear_cushion_100Geometry = endpoint_seat_rear_cushion_100
    ? new THREE.CylinderGeometry(endpoint_seat_rear_cushion_100.endRadius, endpoint_seat_rear_cushion_100.baseRadius, endpoint_seat_rear_cushion_100.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.3, 0.585], [0.18, 0.596], [-0.06, 0.592], [-0.3, 0.586], [-0.36, 0.54], [-0.352, 0.452], [-0.3, 0.42], [-0.06, 0.414], [0.19, 0.42], [0.3, 0.47]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}});
  if (!endpoint_seat_rear_cushion_100) {
    mesh_seat_rear_cushion_100Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_rear_cushion_100 = new THREE.Mesh(
    mesh_seat_rear_cushion_100Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_cushion_100.name = "\u540e\u6392\u5750\u57ab\uff08\u4e00\u4f53\u5f0f\u957f\u51f3\uff09";
  if (endpoint_seat_rear_cushion_100) {
    mesh_seat_rear_cushion_100.position.copy(endpoint_seat_rear_cushion_100.midpoint);
    mesh_seat_rear_cushion_100.quaternion.copy(endpoint_seat_rear_cushion_100.quaternion);
  }
  mesh_seat_rear_cushion_100.castShadow = options.castShadow ?? true;
  mesh_seat_rear_cushion_100.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_cushion_100.userData.sculptComponent = {"id": "seat-rear-cushion", "name": "后排坐垫（一体式长凳）", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "后排长凳坐垫断面挤出 1.44m 宽", "geometryDescriptor": {"profile2D": {"points": [[0.3, 0.585], [0.18, 0.596], [-0.06, 0.592], [-0.3, 0.586], [-0.36, 0.54], [-0.352, 0.452], [-0.3, 0.42], [-0.06, 0.414], [0.19, 0.42], [0.3, 0.47]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.018, "offset": -0.018, "segments": 3}}, "topologyIntent": "rear bench cushion", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.018, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.44, "height": 0.18, "depth": 0.66, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.72, 0, -0.72], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-rear-bench", "name": "一体式长凳", "kind": "stitch", "note": "坐垫面 y0.59，长 1.44m，中间无明显断开（参考后排图）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-rear-bench"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_cushion_100.add(mesh_seat_rear_cushion_100);
  meshes["seat-rear-cushion"] = mesh_seat_rear_cushion_100;
  colliders["seat-rear-cushion"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_cushion_100);

  const endpoint_seat_rear_back_101 = makeAttachmentEndpoint(null);
  const node_seat_rear_back_101 = new THREE.Group();
  node_seat_rear_back_101.name = "\u540e\u6392\u9760\u80cc__pivot";
  node_seat_rear_back_101.scale.set(1, 1, 1);
  if (endpoint_seat_rear_back_101) {
    node_seat_rear_back_101.position.copy(endpoint_seat_rear_back_101.start);
    node_seat_rear_back_101.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_seat_rear_back_101.position.set(0.72, 0.0, -0.72);
    node_seat_rear_back_101.rotation.set(0.0, -1.5708, 0.0);
  }
  node_seat_rear_back_101.userData.sculptComponent = {"id": "seat-rear-back", "name": "后排靠背", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "后排靠背断面挤出，后倾 18°，顶端 y1.024", "geometryDescriptor": {"profile2D": {"points": [[-0.202, 0.58], [-0.208, 0.7], [-0.238, 0.88], [-0.31, 1.024], [-0.392, 1.0], [-0.372, 0.88], [-0.336, 0.7], [-0.29, 0.58]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "rear bench backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.44, "height": 0.44, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.72, 0, -0.72], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-rear-bench"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_back_101.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_rear_back_101);
  nodes["seat-rear-back"] = node_seat_rear_back_101;
  const mesh_seat_rear_back_101Geometry = endpoint_seat_rear_back_101
    ? new THREE.CylinderGeometry(endpoint_seat_rear_back_101.endRadius, endpoint_seat_rear_back_101.baseRadius, endpoint_seat_rear_back_101.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.202, 0.58], [-0.208, 0.7], [-0.238, 0.88], [-0.31, 1.024], [-0.392, 1.0], [-0.372, 0.88], [-0.336, 0.7], [-0.29, 0.58]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}});
  if (!endpoint_seat_rear_back_101) {
    mesh_seat_rear_back_101Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seat_rear_back_101 = new THREE.Mesh(
    mesh_seat_rear_back_101Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_back_101.name = "\u540e\u6392\u9760\u80cc";
  if (endpoint_seat_rear_back_101) {
    mesh_seat_rear_back_101.position.copy(endpoint_seat_rear_back_101.midpoint);
    mesh_seat_rear_back_101.quaternion.copy(endpoint_seat_rear_back_101.quaternion);
  }
  mesh_seat_rear_back_101.castShadow = options.castShadow ?? true;
  mesh_seat_rear_back_101.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_back_101.userData.sculptComponent = {"id": "seat-rear-back", "name": "后排靠背", "level": "meso", "role": "interior", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "后排靠背断面挤出，后倾 18°，顶端 y1.024", "geometryDescriptor": {"profile2D": {"points": [[-0.202, 0.58], [-0.208, 0.7], [-0.238, 0.88], [-0.31, 1.024], [-0.392, 1.0], [-0.372, 0.88], [-0.336, 0.7], [-0.29, 0.58]], "depth": 1.44, "bevel": {"thickness": 0.006, "size": 0.016, "offset": -0.016, "segments": 3}}, "topologyIntent": "rear bench backrest", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.016, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.44, "height": 0.44, "depth": 0.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.72, 0, -0.72], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-rear-bench"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_back_101.add(mesh_seat_rear_back_101);
  meshes["seat-rear-back"] = mesh_seat_rear_back_101;
  colliders["seat-rear-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_back_101);

  const endpoint_headrest_rear_l_102 = makeAttachmentEndpoint(null);
  const node_headrest_rear_l_102 = new THREE.Group();
  node_headrest_rear_l_102.name = "\u540e\u6392\u5934\u6795\uff08\u5de6\uff09__pivot";
  node_headrest_rear_l_102.scale.set(1, 1, 1);
  if (endpoint_headrest_rear_l_102) {
    node_headrest_rear_l_102.position.copy(endpoint_headrest_rear_l_102.start);
    node_headrest_rear_l_102.rotation.set(-0.2, 0.0, 0.0);
  } else {
    node_headrest_rear_l_102.position.set(0.43, 1.108, -1.02);
    node_headrest_rear_l_102.rotation.set(-0.2, 0.0, 0.0);
  }
  node_headrest_rear_l_102.userData.sculptComponent = {"id": "headrest-rear-l", "name": "后排头枕（左）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.28, "height": 0.16, "depth": 0.112, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.43, 1.108, -1.02], "rotation": [-0.2, 0, 0], "scale": [0.28, 0.16, 0.112]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headrest_rear_l_102.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_headrest_rear_l_102);
  nodes["headrest-rear-l"] = node_headrest_rear_l_102;
  const mesh_headrest_rear_l_102Geometry = endpoint_headrest_rear_l_102
    ? new THREE.CylinderGeometry(endpoint_headrest_rear_l_102.endRadius, endpoint_headrest_rear_l_102.baseRadius, endpoint_headrest_rear_l_102.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headrest_rear_l_102) {
    mesh_headrest_rear_l_102Geometry.scale(0.28, 0.16, 0.112);
  }
  const mesh_headrest_rear_l_102 = new THREE.Mesh(
    mesh_headrest_rear_l_102Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headrest_rear_l_102.name = "\u540e\u6392\u5934\u6795\uff08\u5de6\uff09";
  if (endpoint_headrest_rear_l_102) {
    mesh_headrest_rear_l_102.position.copy(endpoint_headrest_rear_l_102.midpoint);
    mesh_headrest_rear_l_102.quaternion.copy(endpoint_headrest_rear_l_102.quaternion);
  }
  mesh_headrest_rear_l_102.castShadow = options.castShadow ?? true;
  mesh_headrest_rear_l_102.receiveShadow = options.receiveShadow ?? true;
  mesh_headrest_rear_l_102.userData.sculptComponent = {"id": "headrest-rear-l", "name": "后排头枕（左）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.28, "height": 0.16, "depth": 0.112, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.43, 1.108, -1.02], "rotation": [-0.2, 0, 0], "scale": [0.28, 0.16, 0.112]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headrest_rear_l_102.add(mesh_headrest_rear_l_102);
  meshes["headrest-rear-l"] = mesh_headrest_rear_l_102;
  colliders["headrest-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headrest_rear_l_102);

  const endpoint_headrest_rear_r_103 = makeAttachmentEndpoint(null);
  const node_headrest_rear_r_103 = new THREE.Group();
  node_headrest_rear_r_103.name = "\u540e\u6392\u5934\u6795\uff08\u53f3\uff09__pivot";
  node_headrest_rear_r_103.scale.set(1, 1, 1);
  if (endpoint_headrest_rear_r_103) {
    node_headrest_rear_r_103.position.copy(endpoint_headrest_rear_r_103.start);
    node_headrest_rear_r_103.rotation.set(-0.2, 0.0, 0.0);
  } else {
    node_headrest_rear_r_103.position.set(-0.43, 1.108, -1.02);
    node_headrest_rear_r_103.rotation.set(-0.2, 0.0, 0.0);
  }
  node_headrest_rear_r_103.userData.sculptComponent = {"id": "headrest-rear-r", "name": "后排头枕（右）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.28, "height": 0.16, "depth": 0.112, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.43, 1.108, -1.02], "rotation": [-0.2, 0, 0], "scale": [0.28, 0.16, 0.112]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headrest_rear_r_103.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_headrest_rear_r_103);
  nodes["headrest-rear-r"] = node_headrest_rear_r_103;
  const mesh_headrest_rear_r_103Geometry = endpoint_headrest_rear_r_103
    ? new THREE.CylinderGeometry(endpoint_headrest_rear_r_103.endRadius, endpoint_headrest_rear_r_103.baseRadius, endpoint_headrest_rear_r_103.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headrest_rear_r_103) {
    mesh_headrest_rear_r_103Geometry.scale(0.28, 0.16, 0.112);
  }
  const mesh_headrest_rear_r_103 = new THREE.Mesh(
    mesh_headrest_rear_r_103Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headrest_rear_r_103.name = "\u540e\u6392\u5934\u6795\uff08\u53f3\uff09";
  if (endpoint_headrest_rear_r_103) {
    mesh_headrest_rear_r_103.position.copy(endpoint_headrest_rear_r_103.midpoint);
    mesh_headrest_rear_r_103.quaternion.copy(endpoint_headrest_rear_r_103.quaternion);
  }
  mesh_headrest_rear_r_103.castShadow = options.castShadow ?? true;
  mesh_headrest_rear_r_103.receiveShadow = options.receiveShadow ?? true;
  mesh_headrest_rear_r_103.userData.sculptComponent = {"id": "headrest-rear-r", "name": "后排头枕（右）", "level": "micro", "role": "interior", "importance": 0.7, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.28, "height": 0.16, "depth": 0.112, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.43, 1.108, -1.02], "rotation": [-0.2, 0, 0], "scale": [0.28, 0.16, 0.112]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-headrest-rear"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headrest_rear_r_103.add(mesh_headrest_rear_r_103);
  meshes["headrest-rear-r"] = mesh_headrest_rear_r_103;
  colliders["headrest-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headrest_rear_r_103);

  const endpoint_door_card_front_l_104 = makeAttachmentEndpoint(null);
  const node_door_card_front_l_104 = new THREE.Group();
  node_door_card_front_l_104.name = "\u524d\u95e8\u5185\u9970\u677f\uff08\u5de6\uff09__pivot";
  node_door_card_front_l_104.scale.set(1, 1, 1);
  if (endpoint_door_card_front_l_104) {
    node_door_card_front_l_104.position.copy(endpoint_door_card_front_l_104.start);
    node_door_card_front_l_104.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_card_front_l_104.position.set(0.878, 0.74, 0.61);
    node_door_card_front_l_104.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_card_front_l_104.userData.sculptComponent = {"id": "door-card-front-l", "name": "前门内饰板（左）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.878, 0.74, 0.61], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-door-two-tone-l", "name": "米白门板 + 紫灰上沿", "kind": "linework", "note": "门板 y0.96 以上紫灰、以下米白，分界处一条镀铬饰条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": ["d-door-two-tone-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_front_l_104.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_card_front_l_104);
  nodes["door-card-front-l"] = node_door_card_front_l_104;
  const mesh_door_card_front_l_104Geometry = endpoint_door_card_front_l_104
    ? new THREE.CylinderGeometry(endpoint_door_card_front_l_104.endRadius, endpoint_door_card_front_l_104.baseRadius, endpoint_door_card_front_l_104.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_card_front_l_104) {
    mesh_door_card_front_l_104Geometry.scale(0.05, 0.62, 0.62);
  }
  const mesh_door_card_front_l_104 = new THREE.Mesh(
    mesh_door_card_front_l_104Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_card_front_l_104.name = "\u524d\u95e8\u5185\u9970\u677f\uff08\u5de6\uff09";
  if (endpoint_door_card_front_l_104) {
    mesh_door_card_front_l_104.position.copy(endpoint_door_card_front_l_104.midpoint);
    mesh_door_card_front_l_104.quaternion.copy(endpoint_door_card_front_l_104.quaternion);
  }
  mesh_door_card_front_l_104.castShadow = options.castShadow ?? true;
  mesh_door_card_front_l_104.receiveShadow = options.receiveShadow ?? true;
  mesh_door_card_front_l_104.userData.sculptComponent = {"id": "door-card-front-l", "name": "前门内饰板（左）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.878, 0.74, 0.61], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-door-two-tone-l", "name": "米白门板 + 紫灰上沿", "kind": "linework", "note": "门板 y0.96 以上紫灰、以下米白，分界处一条镀铬饰条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": ["d-door-two-tone-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_front_l_104.add(mesh_door_card_front_l_104);
  meshes["door-card-front-l"] = mesh_door_card_front_l_104;
  colliders["door-card-front-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_card_front_l_104);

  const endpoint_door_card_rear_l_105 = makeAttachmentEndpoint(null);
  const node_door_card_rear_l_105 = new THREE.Group();
  node_door_card_rear_l_105.name = "\u540e\u95e8\u5185\u9970\u677f\uff08\u5de6\uff09__pivot";
  node_door_card_rear_l_105.scale.set(1, 1, 1);
  if (endpoint_door_card_rear_l_105) {
    node_door_card_rear_l_105.position.copy(endpoint_door_card_rear_l_105.start);
    node_door_card_rear_l_105.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_card_rear_l_105.position.set(0.878, 0.74, -0.78);
    node_door_card_rear_l_105.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_card_rear_l_105.userData.sculptComponent = {"id": "door-card-rear-l", "name": "后门内饰板（左）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.878, 0.74, -0.78], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-door-two-tone-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_rear_l_105.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_card_rear_l_105);
  nodes["door-card-rear-l"] = node_door_card_rear_l_105;
  const mesh_door_card_rear_l_105Geometry = endpoint_door_card_rear_l_105
    ? new THREE.CylinderGeometry(endpoint_door_card_rear_l_105.endRadius, endpoint_door_card_rear_l_105.baseRadius, endpoint_door_card_rear_l_105.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_card_rear_l_105) {
    mesh_door_card_rear_l_105Geometry.scale(0.05, 0.62, 1.0);
  }
  const mesh_door_card_rear_l_105 = new THREE.Mesh(
    mesh_door_card_rear_l_105Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_card_rear_l_105.name = "\u540e\u95e8\u5185\u9970\u677f\uff08\u5de6\uff09";
  if (endpoint_door_card_rear_l_105) {
    mesh_door_card_rear_l_105.position.copy(endpoint_door_card_rear_l_105.midpoint);
    mesh_door_card_rear_l_105.quaternion.copy(endpoint_door_card_rear_l_105.quaternion);
  }
  mesh_door_card_rear_l_105.castShadow = options.castShadow ?? true;
  mesh_door_card_rear_l_105.receiveShadow = options.receiveShadow ?? true;
  mesh_door_card_rear_l_105.userData.sculptComponent = {"id": "door-card-rear-l", "name": "后门内饰板（左）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.878, 0.74, -0.78], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-door-two-tone-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_rear_l_105.add(mesh_door_card_rear_l_105);
  meshes["door-card-rear-l"] = mesh_door_card_rear_l_105;
  colliders["door-card-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_card_rear_l_105);

  const endpoint_door_trim_front_l_106 = makeAttachmentEndpoint(null);
  const node_door_trim_front_l_106 = new THREE.Group();
  node_door_trim_front_l_106.name = "\u524d\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u5de6\uff09__pivot";
  node_door_trim_front_l_106.scale.set(1, 1, 1);
  if (endpoint_door_trim_front_l_106) {
    node_door_trim_front_l_106.position.copy(endpoint_door_trim_front_l_106.start);
    node_door_trim_front_l_106.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_trim_front_l_106.position.set(0.868, 0.992, 0.61);
    node_door_trim_front_l_106.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_trim_front_l_106.userData.sculptComponent = {"id": "door-trim-front-l", "name": "前门紫灰上沿（左）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.868, 0.992, 0.61], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_front_l_106.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_trim_front_l_106);
  nodes["door-trim-front-l"] = node_door_trim_front_l_106;
  const mesh_door_trim_front_l_106Geometry = endpoint_door_trim_front_l_106
    ? new THREE.CylinderGeometry(endpoint_door_trim_front_l_106.endRadius, endpoint_door_trim_front_l_106.baseRadius, endpoint_door_trim_front_l_106.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_trim_front_l_106) {
    mesh_door_trim_front_l_106Geometry.scale(0.055, 0.12, 0.62);
  }
  const mesh_door_trim_front_l_106 = new THREE.Mesh(
    mesh_door_trim_front_l_106Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_trim_front_l_106.name = "\u524d\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u5de6\uff09";
  if (endpoint_door_trim_front_l_106) {
    mesh_door_trim_front_l_106.position.copy(endpoint_door_trim_front_l_106.midpoint);
    mesh_door_trim_front_l_106.quaternion.copy(endpoint_door_trim_front_l_106.quaternion);
  }
  mesh_door_trim_front_l_106.castShadow = options.castShadow ?? true;
  mesh_door_trim_front_l_106.receiveShadow = options.receiveShadow ?? true;
  mesh_door_trim_front_l_106.userData.sculptComponent = {"id": "door-trim-front-l", "name": "前门紫灰上沿（左）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.868, 0.992, 0.61], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_front_l_106.add(mesh_door_trim_front_l_106);
  meshes["door-trim-front-l"] = mesh_door_trim_front_l_106;
  colliders["door-trim-front-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_trim_front_l_106);

  const endpoint_door_trim_rear_l_107 = makeAttachmentEndpoint(null);
  const node_door_trim_rear_l_107 = new THREE.Group();
  node_door_trim_rear_l_107.name = "\u540e\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u5de6\uff09__pivot";
  node_door_trim_rear_l_107.scale.set(1, 1, 1);
  if (endpoint_door_trim_rear_l_107) {
    node_door_trim_rear_l_107.position.copy(endpoint_door_trim_rear_l_107.start);
    node_door_trim_rear_l_107.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_trim_rear_l_107.position.set(0.868, 0.992, -0.78);
    node_door_trim_rear_l_107.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_trim_rear_l_107.userData.sculptComponent = {"id": "door-trim-rear-l", "name": "后门紫灰上沿（左）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.868, 0.992, -0.78], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_rear_l_107.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_trim_rear_l_107);
  nodes["door-trim-rear-l"] = node_door_trim_rear_l_107;
  const mesh_door_trim_rear_l_107Geometry = endpoint_door_trim_rear_l_107
    ? new THREE.CylinderGeometry(endpoint_door_trim_rear_l_107.endRadius, endpoint_door_trim_rear_l_107.baseRadius, endpoint_door_trim_rear_l_107.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_trim_rear_l_107) {
    mesh_door_trim_rear_l_107Geometry.scale(0.055, 0.12, 1.0);
  }
  const mesh_door_trim_rear_l_107 = new THREE.Mesh(
    mesh_door_trim_rear_l_107Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_trim_rear_l_107.name = "\u540e\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u5de6\uff09";
  if (endpoint_door_trim_rear_l_107) {
    mesh_door_trim_rear_l_107.position.copy(endpoint_door_trim_rear_l_107.midpoint);
    mesh_door_trim_rear_l_107.quaternion.copy(endpoint_door_trim_rear_l_107.quaternion);
  }
  mesh_door_trim_rear_l_107.castShadow = options.castShadow ?? true;
  mesh_door_trim_rear_l_107.receiveShadow = options.receiveShadow ?? true;
  mesh_door_trim_rear_l_107.userData.sculptComponent = {"id": "door-trim-rear-l", "name": "后门紫灰上沿（左）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.868, 0.992, -0.78], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_rear_l_107.add(mesh_door_trim_rear_l_107);
  meshes["door-trim-rear-l"] = mesh_door_trim_rear_l_107;
  colliders["door-trim-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_trim_rear_l_107);

  const endpoint_door_speaker_front_l_108 = makeAttachmentEndpoint(null);
  const node_door_speaker_front_l_108 = new THREE.Group();
  node_door_speaker_front_l_108.name = "\u524d\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u5de6\uff09__pivot";
  node_door_speaker_front_l_108.scale.set(1, 1, 1);
  if (endpoint_door_speaker_front_l_108) {
    node_door_speaker_front_l_108.position.copy(endpoint_door_speaker_front_l_108.start);
    node_door_speaker_front_l_108.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_door_speaker_front_l_108.position.set(0.852, 0.6, 0.74);
    node_door_speaker_front_l_108.rotation.set(0.0, -1.5708, 0.0);
  }
  node_door_speaker_front_l_108.userData.sculptComponent = {"id": "door-speaker-front-l", "name": "前门扬声器网罩（左）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.852, 0.6, 0.74], "rotation": [0, -1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-speaker-mesh-l", "name": "白色网格扬声器罩", "kind": "hole", "note": "门板下部 19×26cm 白色冲孔网罩（后排参考图最明显）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_front_l_108.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_speaker_front_l_108);
  nodes["door-speaker-front-l"] = node_door_speaker_front_l_108;
  const mesh_door_speaker_front_l_108Geometry = endpoint_door_speaker_front_l_108
    ? new THREE.CylinderGeometry(endpoint_door_speaker_front_l_108.endRadius, endpoint_door_speaker_front_l_108.baseRadius, endpoint_door_speaker_front_l_108.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_door_speaker_front_l_108) {
    mesh_door_speaker_front_l_108Geometry.scale(0.19, 0.26, 0.005);
  }
  const mesh_door_speaker_front_l_108 = new THREE.Mesh(
    mesh_door_speaker_front_l_108Geometry,
    materialMap["speaker-lattice"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_speaker_front_l_108.name = "\u524d\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u5de6\uff09";
  if (endpoint_door_speaker_front_l_108) {
    mesh_door_speaker_front_l_108.position.copy(endpoint_door_speaker_front_l_108.midpoint);
    mesh_door_speaker_front_l_108.quaternion.copy(endpoint_door_speaker_front_l_108.quaternion);
  }
  mesh_door_speaker_front_l_108.castShadow = options.castShadow ?? true;
  mesh_door_speaker_front_l_108.receiveShadow = options.receiveShadow ?? true;
  mesh_door_speaker_front_l_108.userData.sculptComponent = {"id": "door-speaker-front-l", "name": "前门扬声器网罩（左）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.852, 0.6, 0.74], "rotation": [0, -1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-speaker-mesh-l", "name": "白色网格扬声器罩", "kind": "hole", "note": "门板下部 19×26cm 白色冲孔网罩（后排参考图最明显）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_front_l_108.add(mesh_door_speaker_front_l_108);
  meshes["door-speaker-front-l"] = mesh_door_speaker_front_l_108;
  colliders["door-speaker-front-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_speaker_front_l_108);

  const endpoint_door_speaker_rear_l_109 = makeAttachmentEndpoint(null);
  const node_door_speaker_rear_l_109 = new THREE.Group();
  node_door_speaker_rear_l_109.name = "\u540e\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u5de6\uff09__pivot";
  node_door_speaker_rear_l_109.scale.set(1, 1, 1);
  if (endpoint_door_speaker_rear_l_109) {
    node_door_speaker_rear_l_109.position.copy(endpoint_door_speaker_rear_l_109.start);
    node_door_speaker_rear_l_109.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_door_speaker_rear_l_109.position.set(0.852, 0.6, -0.64);
    node_door_speaker_rear_l_109.rotation.set(0.0, -1.5708, 0.0);
  }
  node_door_speaker_rear_l_109.userData.sculptComponent = {"id": "door-speaker-rear-l", "name": "后门扬声器网罩（左）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.852, 0.6, -0.64], "rotation": [0, -1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_rear_l_109.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_speaker_rear_l_109);
  nodes["door-speaker-rear-l"] = node_door_speaker_rear_l_109;
  const mesh_door_speaker_rear_l_109Geometry = endpoint_door_speaker_rear_l_109
    ? new THREE.CylinderGeometry(endpoint_door_speaker_rear_l_109.endRadius, endpoint_door_speaker_rear_l_109.baseRadius, endpoint_door_speaker_rear_l_109.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_door_speaker_rear_l_109) {
    mesh_door_speaker_rear_l_109Geometry.scale(0.19, 0.26, 0.005);
  }
  const mesh_door_speaker_rear_l_109 = new THREE.Mesh(
    mesh_door_speaker_rear_l_109Geometry,
    materialMap["speaker-lattice"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_speaker_rear_l_109.name = "\u540e\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u5de6\uff09";
  if (endpoint_door_speaker_rear_l_109) {
    mesh_door_speaker_rear_l_109.position.copy(endpoint_door_speaker_rear_l_109.midpoint);
    mesh_door_speaker_rear_l_109.quaternion.copy(endpoint_door_speaker_rear_l_109.quaternion);
  }
  mesh_door_speaker_rear_l_109.castShadow = options.castShadow ?? true;
  mesh_door_speaker_rear_l_109.receiveShadow = options.receiveShadow ?? true;
  mesh_door_speaker_rear_l_109.userData.sculptComponent = {"id": "door-speaker-rear-l", "name": "后门扬声器网罩（左）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.852, 0.6, -0.64], "rotation": [0, -1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_rear_l_109.add(mesh_door_speaker_rear_l_109);
  meshes["door-speaker-rear-l"] = mesh_door_speaker_rear_l_109;
  colliders["door-speaker-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_speaker_rear_l_109);

  const endpoint_door_card_front_r_110 = makeAttachmentEndpoint(null);
  const node_door_card_front_r_110 = new THREE.Group();
  node_door_card_front_r_110.name = "\u524d\u95e8\u5185\u9970\u677f\uff08\u53f3\uff09__pivot";
  node_door_card_front_r_110.scale.set(1, 1, 1);
  if (endpoint_door_card_front_r_110) {
    node_door_card_front_r_110.position.copy(endpoint_door_card_front_r_110.start);
    node_door_card_front_r_110.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_card_front_r_110.position.set(-0.878, 0.74, 0.61);
    node_door_card_front_r_110.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_card_front_r_110.userData.sculptComponent = {"id": "door-card-front-r", "name": "前门内饰板（右）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.878, 0.74, 0.61], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-door-two-tone-r", "name": "米白门板 + 紫灰上沿", "kind": "linework", "note": "门板 y0.96 以上紫灰、以下米白，分界处一条镀铬饰条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": ["d-door-two-tone-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_front_r_110.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_card_front_r_110);
  nodes["door-card-front-r"] = node_door_card_front_r_110;
  const mesh_door_card_front_r_110Geometry = endpoint_door_card_front_r_110
    ? new THREE.CylinderGeometry(endpoint_door_card_front_r_110.endRadius, endpoint_door_card_front_r_110.baseRadius, endpoint_door_card_front_r_110.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_card_front_r_110) {
    mesh_door_card_front_r_110Geometry.scale(0.05, 0.62, 0.62);
  }
  const mesh_door_card_front_r_110 = new THREE.Mesh(
    mesh_door_card_front_r_110Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_card_front_r_110.name = "\u524d\u95e8\u5185\u9970\u677f\uff08\u53f3\uff09";
  if (endpoint_door_card_front_r_110) {
    mesh_door_card_front_r_110.position.copy(endpoint_door_card_front_r_110.midpoint);
    mesh_door_card_front_r_110.quaternion.copy(endpoint_door_card_front_r_110.quaternion);
  }
  mesh_door_card_front_r_110.castShadow = options.castShadow ?? true;
  mesh_door_card_front_r_110.receiveShadow = options.receiveShadow ?? true;
  mesh_door_card_front_r_110.userData.sculptComponent = {"id": "door-card-front-r", "name": "前门内饰板（右）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.878, 0.74, 0.61], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-door-two-tone-r", "name": "米白门板 + 紫灰上沿", "kind": "linework", "note": "门板 y0.96 以上紫灰、以下米白，分界处一条镀铬饰条"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": ["d-door-two-tone-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_front_r_110.add(mesh_door_card_front_r_110);
  meshes["door-card-front-r"] = mesh_door_card_front_r_110;
  colliders["door-card-front-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_card_front_r_110);

  const endpoint_door_card_rear_r_111 = makeAttachmentEndpoint(null);
  const node_door_card_rear_r_111 = new THREE.Group();
  node_door_card_rear_r_111.name = "\u540e\u95e8\u5185\u9970\u677f\uff08\u53f3\uff09__pivot";
  node_door_card_rear_r_111.scale.set(1, 1, 1);
  if (endpoint_door_card_rear_r_111) {
    node_door_card_rear_r_111.position.copy(endpoint_door_card_rear_r_111.start);
    node_door_card_rear_r_111.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_card_rear_r_111.position.set(-0.878, 0.74, -0.78);
    node_door_card_rear_r_111.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_card_rear_r_111.userData.sculptComponent = {"id": "door-card-rear-r", "name": "后门内饰板（右）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.878, 0.74, -0.78], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-door-two-tone-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_rear_r_111.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_card_rear_r_111);
  nodes["door-card-rear-r"] = node_door_card_rear_r_111;
  const mesh_door_card_rear_r_111Geometry = endpoint_door_card_rear_r_111
    ? new THREE.CylinderGeometry(endpoint_door_card_rear_r_111.endRadius, endpoint_door_card_rear_r_111.baseRadius, endpoint_door_card_rear_r_111.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_card_rear_r_111) {
    mesh_door_card_rear_r_111Geometry.scale(0.05, 0.62, 1.0);
  }
  const mesh_door_card_rear_r_111 = new THREE.Mesh(
    mesh_door_card_rear_r_111Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_card_rear_r_111.name = "\u540e\u95e8\u5185\u9970\u677f\uff08\u53f3\uff09";
  if (endpoint_door_card_rear_r_111) {
    mesh_door_card_rear_r_111.position.copy(endpoint_door_card_rear_r_111.midpoint);
    mesh_door_card_rear_r_111.quaternion.copy(endpoint_door_card_rear_r_111.quaternion);
  }
  mesh_door_card_rear_r_111.castShadow = options.castShadow ?? true;
  mesh_door_card_rear_r_111.receiveShadow = options.receiveShadow ?? true;
  mesh_door_card_rear_r_111.userData.sculptComponent = {"id": "door-card-rear-r", "name": "后门内饰板（右）", "level": "meso", "role": "interior", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.05, "height": 0.62, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.878, 0.74, -0.78], "rotation": [0, 0, 0], "scale": [0.05, 0.62, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-door-two-tone-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_card_rear_r_111.add(mesh_door_card_rear_r_111);
  meshes["door-card-rear-r"] = mesh_door_card_rear_r_111;
  colliders["door-card-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_card_rear_r_111);

  const endpoint_door_trim_front_r_112 = makeAttachmentEndpoint(null);
  const node_door_trim_front_r_112 = new THREE.Group();
  node_door_trim_front_r_112.name = "\u524d\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u53f3\uff09__pivot";
  node_door_trim_front_r_112.scale.set(1, 1, 1);
  if (endpoint_door_trim_front_r_112) {
    node_door_trim_front_r_112.position.copy(endpoint_door_trim_front_r_112.start);
    node_door_trim_front_r_112.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_trim_front_r_112.position.set(-0.868, 0.992, 0.61);
    node_door_trim_front_r_112.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_trim_front_r_112.userData.sculptComponent = {"id": "door-trim-front-r", "name": "前门紫灰上沿（右）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.868, 0.992, 0.61], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_front_r_112.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_trim_front_r_112);
  nodes["door-trim-front-r"] = node_door_trim_front_r_112;
  const mesh_door_trim_front_r_112Geometry = endpoint_door_trim_front_r_112
    ? new THREE.CylinderGeometry(endpoint_door_trim_front_r_112.endRadius, endpoint_door_trim_front_r_112.baseRadius, endpoint_door_trim_front_r_112.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_trim_front_r_112) {
    mesh_door_trim_front_r_112Geometry.scale(0.055, 0.12, 0.62);
  }
  const mesh_door_trim_front_r_112 = new THREE.Mesh(
    mesh_door_trim_front_r_112Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_trim_front_r_112.name = "\u524d\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u53f3\uff09";
  if (endpoint_door_trim_front_r_112) {
    mesh_door_trim_front_r_112.position.copy(endpoint_door_trim_front_r_112.midpoint);
    mesh_door_trim_front_r_112.quaternion.copy(endpoint_door_trim_front_r_112.quaternion);
  }
  mesh_door_trim_front_r_112.castShadow = options.castShadow ?? true;
  mesh_door_trim_front_r_112.receiveShadow = options.receiveShadow ?? true;
  mesh_door_trim_front_r_112.userData.sculptComponent = {"id": "door-trim-front-r", "name": "前门紫灰上沿（右）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 0.62, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.868, 0.992, 0.61], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_front_r_112.add(mesh_door_trim_front_r_112);
  meshes["door-trim-front-r"] = mesh_door_trim_front_r_112;
  colliders["door-trim-front-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_trim_front_r_112);

  const endpoint_door_trim_rear_r_113 = makeAttachmentEndpoint(null);
  const node_door_trim_rear_r_113 = new THREE.Group();
  node_door_trim_rear_r_113.name = "\u540e\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u53f3\uff09__pivot";
  node_door_trim_rear_r_113.scale.set(1, 1, 1);
  if (endpoint_door_trim_rear_r_113) {
    node_door_trim_rear_r_113.position.copy(endpoint_door_trim_rear_r_113.start);
    node_door_trim_rear_r_113.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_trim_rear_r_113.position.set(-0.868, 0.992, -0.78);
    node_door_trim_rear_r_113.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_trim_rear_r_113.userData.sculptComponent = {"id": "door-trim-rear-r", "name": "后门紫灰上沿（右）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.868, 0.992, -0.78], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_rear_r_113.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_trim_rear_r_113);
  nodes["door-trim-rear-r"] = node_door_trim_rear_r_113;
  const mesh_door_trim_rear_r_113Geometry = endpoint_door_trim_rear_r_113
    ? new THREE.CylinderGeometry(endpoint_door_trim_rear_r_113.endRadius, endpoint_door_trim_rear_r_113.baseRadius, endpoint_door_trim_rear_r_113.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_trim_rear_r_113) {
    mesh_door_trim_rear_r_113Geometry.scale(0.055, 0.12, 1.0);
  }
  const mesh_door_trim_rear_r_113 = new THREE.Mesh(
    mesh_door_trim_rear_r_113Geometry,
    materialMap["leather-plum"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_trim_rear_r_113.name = "\u540e\u95e8\u7d2b\u7070\u4e0a\u6cbf\uff08\u53f3\uff09";
  if (endpoint_door_trim_rear_r_113) {
    mesh_door_trim_rear_r_113.position.copy(endpoint_door_trim_rear_r_113.midpoint);
    mesh_door_trim_rear_r_113.quaternion.copy(endpoint_door_trim_rear_r_113.quaternion);
  }
  mesh_door_trim_rear_r_113.castShadow = options.castShadow ?? true;
  mesh_door_trim_rear_r_113.receiveShadow = options.receiveShadow ?? true;
  mesh_door_trim_rear_r_113.userData.sculptComponent = {"id": "door-trim-rear-r", "name": "后门紫灰上沿（右）", "level": "micro", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.055, "height": 0.12, "depth": 1.0, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.868, 0.992, -0.78], "rotation": [0, 0, 0], "scale": [0.055, 0.12, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-plum", "materialLayers": ["leather-plum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 90, 114, 1.0)", "secondaryAlbedo": "rgba(110, 90, 114, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_trim_rear_r_113.add(mesh_door_trim_rear_r_113);
  meshes["door-trim-rear-r"] = mesh_door_trim_rear_r_113;
  colliders["door-trim-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_trim_rear_r_113);

  const endpoint_door_speaker_front_r_114 = makeAttachmentEndpoint(null);
  const node_door_speaker_front_r_114 = new THREE.Group();
  node_door_speaker_front_r_114.name = "\u524d\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u53f3\uff09__pivot";
  node_door_speaker_front_r_114.scale.set(1, 1, 1);
  if (endpoint_door_speaker_front_r_114) {
    node_door_speaker_front_r_114.position.copy(endpoint_door_speaker_front_r_114.start);
    node_door_speaker_front_r_114.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_door_speaker_front_r_114.position.set(-0.852, 0.6, 0.74);
    node_door_speaker_front_r_114.rotation.set(0.0, 1.5708, 0.0);
  }
  node_door_speaker_front_r_114.userData.sculptComponent = {"id": "door-speaker-front-r", "name": "前门扬声器网罩（右）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.852, 0.6, 0.74], "rotation": [0, 1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-speaker-mesh-r", "name": "白色网格扬声器罩", "kind": "hole", "note": "门板下部 19×26cm 白色冲孔网罩（后排参考图最明显）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_front_r_114.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_speaker_front_r_114);
  nodes["door-speaker-front-r"] = node_door_speaker_front_r_114;
  const mesh_door_speaker_front_r_114Geometry = endpoint_door_speaker_front_r_114
    ? new THREE.CylinderGeometry(endpoint_door_speaker_front_r_114.endRadius, endpoint_door_speaker_front_r_114.baseRadius, endpoint_door_speaker_front_r_114.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_door_speaker_front_r_114) {
    mesh_door_speaker_front_r_114Geometry.scale(0.19, 0.26, 0.005);
  }
  const mesh_door_speaker_front_r_114 = new THREE.Mesh(
    mesh_door_speaker_front_r_114Geometry,
    materialMap["speaker-lattice"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_speaker_front_r_114.name = "\u524d\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u53f3\uff09";
  if (endpoint_door_speaker_front_r_114) {
    mesh_door_speaker_front_r_114.position.copy(endpoint_door_speaker_front_r_114.midpoint);
    mesh_door_speaker_front_r_114.quaternion.copy(endpoint_door_speaker_front_r_114.quaternion);
  }
  mesh_door_speaker_front_r_114.castShadow = options.castShadow ?? true;
  mesh_door_speaker_front_r_114.receiveShadow = options.receiveShadow ?? true;
  mesh_door_speaker_front_r_114.userData.sculptComponent = {"id": "door-speaker-front-r", "name": "前门扬声器网罩（右）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.852, 0.6, 0.74], "rotation": [0, 1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-speaker-mesh-r", "name": "白色网格扬声器罩", "kind": "hole", "note": "门板下部 19×26cm 白色冲孔网罩（后排参考图最明显）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_front_r_114.add(mesh_door_speaker_front_r_114);
  meshes["door-speaker-front-r"] = mesh_door_speaker_front_r_114;
  colliders["door-speaker-front-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_speaker_front_r_114);

  const endpoint_door_speaker_rear_r_115 = makeAttachmentEndpoint(null);
  const node_door_speaker_rear_r_115 = new THREE.Group();
  node_door_speaker_rear_r_115.name = "\u540e\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u53f3\uff09__pivot";
  node_door_speaker_rear_r_115.scale.set(1, 1, 1);
  if (endpoint_door_speaker_rear_r_115) {
    node_door_speaker_rear_r_115.position.copy(endpoint_door_speaker_rear_r_115.start);
    node_door_speaker_rear_r_115.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_door_speaker_rear_r_115.position.set(-0.852, 0.6, -0.64);
    node_door_speaker_rear_r_115.rotation.set(0.0, 1.5708, 0.0);
  }
  node_door_speaker_rear_r_115.userData.sculptComponent = {"id": "door-speaker-rear-r", "name": "后门扬声器网罩（右）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.852, 0.6, -0.64], "rotation": [0, 1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_rear_r_115.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_speaker_rear_r_115);
  nodes["door-speaker-rear-r"] = node_door_speaker_rear_r_115;
  const mesh_door_speaker_rear_r_115Geometry = endpoint_door_speaker_rear_r_115
    ? new THREE.CylinderGeometry(endpoint_door_speaker_rear_r_115.endRadius, endpoint_door_speaker_rear_r_115.baseRadius, endpoint_door_speaker_rear_r_115.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_door_speaker_rear_r_115) {
    mesh_door_speaker_rear_r_115Geometry.scale(0.19, 0.26, 0.005);
  }
  const mesh_door_speaker_rear_r_115 = new THREE.Mesh(
    mesh_door_speaker_rear_r_115Geometry,
    materialMap["speaker-lattice"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_speaker_rear_r_115.name = "\u540e\u95e8\u626c\u58f0\u5668\u7f51\u7f69\uff08\u53f3\uff09";
  if (endpoint_door_speaker_rear_r_115) {
    mesh_door_speaker_rear_r_115.position.copy(endpoint_door_speaker_rear_r_115.midpoint);
    mesh_door_speaker_rear_r_115.quaternion.copy(endpoint_door_speaker_rear_r_115.quaternion);
  }
  mesh_door_speaker_rear_r_115.castShadow = options.castShadow ?? true;
  mesh_door_speaker_rear_r_115.receiveShadow = options.receiveShadow ?? true;
  mesh_door_speaker_rear_r_115.userData.sculptComponent = {"id": "door-speaker-rear-r", "name": "后门扬声器网罩（右）", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.19, "height": 0.26, "depth": 0.005, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.852, 0.6, -0.64], "rotation": [0, 1.5708, 0], "scale": [0.19, 0.26, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "speaker-lattice", "materialLayers": ["speaker-lattice"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-rearseat"], "details": ["d-speaker-mesh-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 210, 198, 1.0)", "secondaryAlbedo": "rgba(217, 210, 198, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_door_speaker_rear_r_115.add(mesh_door_speaker_rear_r_115);
  meshes["door-speaker-rear-r"] = mesh_door_speaker_rear_r_115;
  colliders["door-speaker-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_speaker_rear_r_115);

  const endpoint_apillar_inner_l_116 = makeAttachmentEndpoint(null);
  const node_apillar_inner_l_116 = new THREE.Group();
  node_apillar_inner_l_116.name = "A \u67f1\u5185\u9970\uff08\u5de6\uff09__pivot";
  node_apillar_inner_l_116.scale.set(1, 1, 1);
  if (endpoint_apillar_inner_l_116) {
    node_apillar_inner_l_116.position.copy(endpoint_apillar_inner_l_116.start);
    node_apillar_inner_l_116.rotation.set(-1.048, 0.0, 0.0);
  } else {
    node_apillar_inner_l_116.position.set(0.826, 1.268, 0.664);
    node_apillar_inner_l_116.rotation.set(-1.048, 0.0, 0.0);
  }
  node_apillar_inner_l_116.userData.sculptComponent = {"id": "apillar-inner-l", "name": "A 柱内饰（左）", "level": "meso", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.73, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.826, 1.268, 0.664], "rotation": [-1.048, 0, 0], "scale": [0.07, 0.73, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-apillar-ivory-l", "name": "白色 A 柱", "kind": "linework", "note": "副驾视图里 A 柱内侧为米白皮革包覆"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-apillar-ivory-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_apillar_inner_l_116.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_apillar_inner_l_116);
  nodes["apillar-inner-l"] = node_apillar_inner_l_116;
  const mesh_apillar_inner_l_116Geometry = endpoint_apillar_inner_l_116
    ? new THREE.CylinderGeometry(endpoint_apillar_inner_l_116.endRadius, endpoint_apillar_inner_l_116.baseRadius, endpoint_apillar_inner_l_116.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_apillar_inner_l_116) {
    mesh_apillar_inner_l_116Geometry.scale(0.07, 0.73, 0.08);
  }
  const mesh_apillar_inner_l_116 = new THREE.Mesh(
    mesh_apillar_inner_l_116Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_apillar_inner_l_116.name = "A \u67f1\u5185\u9970\uff08\u5de6\uff09";
  if (endpoint_apillar_inner_l_116) {
    mesh_apillar_inner_l_116.position.copy(endpoint_apillar_inner_l_116.midpoint);
    mesh_apillar_inner_l_116.quaternion.copy(endpoint_apillar_inner_l_116.quaternion);
  }
  mesh_apillar_inner_l_116.castShadow = options.castShadow ?? true;
  mesh_apillar_inner_l_116.receiveShadow = options.receiveShadow ?? true;
  mesh_apillar_inner_l_116.userData.sculptComponent = {"id": "apillar-inner-l", "name": "A 柱内饰（左）", "level": "meso", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.73, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.826, 1.268, 0.664], "rotation": [-1.048, 0, 0], "scale": [0.07, 0.73, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-apillar-ivory-l", "name": "白色 A 柱", "kind": "linework", "note": "副驾视图里 A 柱内侧为米白皮革包覆"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-apillar-ivory-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_apillar_inner_l_116.add(mesh_apillar_inner_l_116);
  meshes["apillar-inner-l"] = mesh_apillar_inner_l_116;
  colliders["apillar-inner-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_apillar_inner_l_116);

  const endpoint_apillar_inner_r_117 = makeAttachmentEndpoint(null);
  const node_apillar_inner_r_117 = new THREE.Group();
  node_apillar_inner_r_117.name = "A \u67f1\u5185\u9970\uff08\u53f3\uff09__pivot";
  node_apillar_inner_r_117.scale.set(1, 1, 1);
  if (endpoint_apillar_inner_r_117) {
    node_apillar_inner_r_117.position.copy(endpoint_apillar_inner_r_117.start);
    node_apillar_inner_r_117.rotation.set(-1.048, 0.0, 0.0);
  } else {
    node_apillar_inner_r_117.position.set(-0.826, 1.268, 0.664);
    node_apillar_inner_r_117.rotation.set(-1.048, 0.0, 0.0);
  }
  node_apillar_inner_r_117.userData.sculptComponent = {"id": "apillar-inner-r", "name": "A 柱内饰（右）", "level": "meso", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.73, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.826, 1.268, 0.664], "rotation": [-1.048, 0, 0], "scale": [0.07, 0.73, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-apillar-ivory-r", "name": "白色 A 柱", "kind": "linework", "note": "副驾视图里 A 柱内侧为米白皮革包覆"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-apillar-ivory-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_apillar_inner_r_117.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_apillar_inner_r_117);
  nodes["apillar-inner-r"] = node_apillar_inner_r_117;
  const mesh_apillar_inner_r_117Geometry = endpoint_apillar_inner_r_117
    ? new THREE.CylinderGeometry(endpoint_apillar_inner_r_117.endRadius, endpoint_apillar_inner_r_117.baseRadius, endpoint_apillar_inner_r_117.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_apillar_inner_r_117) {
    mesh_apillar_inner_r_117Geometry.scale(0.07, 0.73, 0.08);
  }
  const mesh_apillar_inner_r_117 = new THREE.Mesh(
    mesh_apillar_inner_r_117Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_apillar_inner_r_117.name = "A \u67f1\u5185\u9970\uff08\u53f3\uff09";
  if (endpoint_apillar_inner_r_117) {
    mesh_apillar_inner_r_117.position.copy(endpoint_apillar_inner_r_117.midpoint);
    mesh_apillar_inner_r_117.quaternion.copy(endpoint_apillar_inner_r_117.quaternion);
  }
  mesh_apillar_inner_r_117.castShadow = options.castShadow ?? true;
  mesh_apillar_inner_r_117.receiveShadow = options.receiveShadow ?? true;
  mesh_apillar_inner_r_117.userData.sculptComponent = {"id": "apillar-inner-r", "name": "A 柱内饰（右）", "level": "meso", "role": "interior", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.73, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.826, 1.268, 0.664], "rotation": [-1.048, 0, 0], "scale": [0.07, 0.73, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-apillar-ivory-r", "name": "白色 A 柱", "kind": "linework", "note": "副驾视图里 A 柱内侧为米白皮革包覆"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-apillar-ivory-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_apillar_inner_r_117.add(mesh_apillar_inner_r_117);
  meshes["apillar-inner-r"] = mesh_apillar_inner_r_117;
  colliders["apillar-inner-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_apillar_inner_r_117);

  const endpoint_headliner_118 = makeAttachmentEndpoint(null);
  const node_headliner_118 = new THREE.Group();
  node_headliner_118.name = "\u9876\u68da\uff08\u7c73\u767d\u9e82\u76ae\uff09__pivot";
  node_headliner_118.scale.set(1, 1, 1);
  if (endpoint_headliner_118) {
    node_headliner_118.position.copy(endpoint_headliner_118.start);
    node_headliner_118.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_headliner_118.position.set(0.86, 0.0, 0.0);
    node_headliner_118.rotation.set(0.0, -1.5708, 0.0);
  }
  node_headliner_118.userData.sculptComponent = {"id": "headliner", "name": "顶棚（米白麂皮）", "level": "meso", "role": "interior", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "顶棚薄板挤出，跟随天幕下表面（y1.52-1.56）", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.494], [-0.2, 1.565], [-0.7, 1.573], [-1.24, 1.522], [-1.56, 1.462], [-1.56, 1.44], [-1.26, 1.5], [-0.7, 1.548], [-0.2, 1.54], [0.34, 1.47]], "depth": 1.72, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 1}}, "topologyIntent": "headliner panel", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.72, "height": 0.03, "depth": 2.1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.86, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "suede-ivory", "materialLayers": ["suede-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(239, 234, 224, 1.0)", "secondaryAlbedo": "rgba(239, 234, 224, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_118.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_headliner_118);
  nodes["headliner"] = node_headliner_118;
  const mesh_headliner_118Geometry = endpoint_headliner_118
    ? new THREE.CylinderGeometry(endpoint_headliner_118.endRadius, endpoint_headliner_118.baseRadius, endpoint_headliner_118.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.34, 1.494], [-0.2, 1.565], [-0.7, 1.573], [-1.24, 1.522], [-1.56, 1.462], [-1.56, 1.44], [-1.26, 1.5], [-0.7, 1.548], [-0.2, 1.54], [0.34, 1.47]], "depth": 1.72, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 1}});
  if (!endpoint_headliner_118) {
    mesh_headliner_118Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_headliner_118 = new THREE.Mesh(
    mesh_headliner_118Geometry,
    materialMap["suede-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headliner_118.name = "\u9876\u68da\uff08\u7c73\u767d\u9e82\u76ae\uff09";
  if (endpoint_headliner_118) {
    mesh_headliner_118.position.copy(endpoint_headliner_118.midpoint);
    mesh_headliner_118.quaternion.copy(endpoint_headliner_118.quaternion);
  }
  mesh_headliner_118.castShadow = options.castShadow ?? true;
  mesh_headliner_118.receiveShadow = options.receiveShadow ?? true;
  mesh_headliner_118.userData.sculptComponent = {"id": "headliner", "name": "顶棚（米白麂皮）", "level": "meso", "role": "interior", "importance": 0.8, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "顶棚薄板挤出，跟随天幕下表面（y1.52-1.56）", "geometryDescriptor": {"profile2D": {"points": [[0.34, 1.494], [-0.2, 1.565], [-0.7, 1.573], [-1.24, 1.522], [-1.56, 1.462], [-1.56, 1.44], [-1.26, 1.5], [-0.7, 1.548], [-0.2, 1.54], [0.34, 1.47]], "depth": 1.72, "bevel": {"thickness": 0.006, "size": 0.006, "offset": -0.006, "segments": 1}}, "topologyIntent": "headliner panel", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.72, "height": 0.03, "depth": 2.1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.86, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "suede-ivory", "materialLayers": ["suede-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass", "img-r7-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(239, 234, 224, 1.0)", "secondaryAlbedo": "rgba(239, 234, 224, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_118.add(mesh_headliner_118);
  meshes["headliner"] = mesh_headliner_118;
  colliders["headliner"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headliner_118);

  const endpoint_sun_visor_l_119 = makeAttachmentEndpoint(null);
  const node_sun_visor_l_119 = new THREE.Group();
  node_sun_visor_l_119.name = "\u906e\u9633\u677f\uff08\u5de6\uff09__pivot";
  node_sun_visor_l_119.scale.set(1, 1, 1);
  if (endpoint_sun_visor_l_119) {
    node_sun_visor_l_119.position.copy(endpoint_sun_visor_l_119.start);
    node_sun_visor_l_119.rotation.set(0.1, 0.0, 0.0);
  } else {
    node_sun_visor_l_119.position.set(0.4, 1.492, 0.42);
    node_sun_visor_l_119.rotation.set(0.1, 0.0, 0.0);
  }
  node_sun_visor_l_119.userData.sculptComponent = {"id": "sun-visor-l", "name": "遮阳板（左）", "level": "micro", "role": "interior", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.03, "depth": 0.17, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.4, 1.492, 0.42], "rotation": [0.1, 0, 0], "scale": [0.34, 0.03, 0.17]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_sun_visor_l_119.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_sun_visor_l_119);
  nodes["sun-visor-l"] = node_sun_visor_l_119;
  const mesh_sun_visor_l_119Geometry = endpoint_sun_visor_l_119
    ? new THREE.CylinderGeometry(endpoint_sun_visor_l_119.endRadius, endpoint_sun_visor_l_119.baseRadius, endpoint_sun_visor_l_119.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_sun_visor_l_119) {
    mesh_sun_visor_l_119Geometry.scale(0.34, 0.03, 0.17);
  }
  const mesh_sun_visor_l_119 = new THREE.Mesh(
    mesh_sun_visor_l_119Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sun_visor_l_119.name = "\u906e\u9633\u677f\uff08\u5de6\uff09";
  if (endpoint_sun_visor_l_119) {
    mesh_sun_visor_l_119.position.copy(endpoint_sun_visor_l_119.midpoint);
    mesh_sun_visor_l_119.quaternion.copy(endpoint_sun_visor_l_119.quaternion);
  }
  mesh_sun_visor_l_119.castShadow = options.castShadow ?? true;
  mesh_sun_visor_l_119.receiveShadow = options.receiveShadow ?? true;
  mesh_sun_visor_l_119.userData.sculptComponent = {"id": "sun-visor-l", "name": "遮阳板（左）", "level": "micro", "role": "interior", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.03, "depth": 0.17, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.4, 1.492, 0.42], "rotation": [0.1, 0, 0], "scale": [0.34, 0.03, 0.17]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_sun_visor_l_119.add(mesh_sun_visor_l_119);
  meshes["sun-visor-l"] = mesh_sun_visor_l_119;
  colliders["sun-visor-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_sun_visor_l_119);

  const endpoint_sun_visor_r_120 = makeAttachmentEndpoint(null);
  const node_sun_visor_r_120 = new THREE.Group();
  node_sun_visor_r_120.name = "\u906e\u9633\u677f\uff08\u53f3\uff09__pivot";
  node_sun_visor_r_120.scale.set(1, 1, 1);
  if (endpoint_sun_visor_r_120) {
    node_sun_visor_r_120.position.copy(endpoint_sun_visor_r_120.start);
    node_sun_visor_r_120.rotation.set(0.1, 0.0, 0.0);
  } else {
    node_sun_visor_r_120.position.set(-0.4, 1.492, 0.42);
    node_sun_visor_r_120.rotation.set(0.1, 0.0, 0.0);
  }
  node_sun_visor_r_120.userData.sculptComponent = {"id": "sun-visor-r", "name": "遮阳板（右）", "level": "micro", "role": "interior", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.03, "depth": 0.17, "units": "meters", "confidence": 0.85}, "transform": {"position": [-0.4, 1.492, 0.42], "rotation": [0.1, 0, 0], "scale": [0.34, 0.03, 0.17]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_sun_visor_r_120.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_sun_visor_r_120);
  nodes["sun-visor-r"] = node_sun_visor_r_120;
  const mesh_sun_visor_r_120Geometry = endpoint_sun_visor_r_120
    ? new THREE.CylinderGeometry(endpoint_sun_visor_r_120.endRadius, endpoint_sun_visor_r_120.baseRadius, endpoint_sun_visor_r_120.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_sun_visor_r_120) {
    mesh_sun_visor_r_120Geometry.scale(0.34, 0.03, 0.17);
  }
  const mesh_sun_visor_r_120 = new THREE.Mesh(
    mesh_sun_visor_r_120Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sun_visor_r_120.name = "\u906e\u9633\u677f\uff08\u53f3\uff09";
  if (endpoint_sun_visor_r_120) {
    mesh_sun_visor_r_120.position.copy(endpoint_sun_visor_r_120.midpoint);
    mesh_sun_visor_r_120.quaternion.copy(endpoint_sun_visor_r_120.quaternion);
  }
  mesh_sun_visor_r_120.castShadow = options.castShadow ?? true;
  mesh_sun_visor_r_120.receiveShadow = options.receiveShadow ?? true;
  mesh_sun_visor_r_120.userData.sculptComponent = {"id": "sun-visor-r", "name": "遮阳板（右）", "level": "micro", "role": "interior", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.34, "height": 0.03, "depth": 0.17, "units": "meters", "confidence": 0.85}, "transform": {"position": [-0.4, 1.492, 0.42], "rotation": [0.1, 0, 0], "scale": [0.34, 0.03, 0.17]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 230, 218, 1.0)", "secondaryAlbedo": "rgba(237, 230, 218, 0.85)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_sun_visor_r_120.add(mesh_sun_visor_r_120);
  meshes["sun-visor-r"] = mesh_sun_visor_r_120;
  colliders["sun-visor-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_sun_visor_r_120);

  const endpoint_rear_view_mirror_121 = makeAttachmentEndpoint(null);
  const node_rear_view_mirror_121 = new THREE.Group();
  node_rear_view_mirror_121.name = "\u8f66\u5185\u540e\u89c6\u955c__pivot";
  node_rear_view_mirror_121.scale.set(1, 1, 1);
  if (endpoint_rear_view_mirror_121) {
    node_rear_view_mirror_121.position.copy(endpoint_rear_view_mirror_121.start);
    node_rear_view_mirror_121.rotation.set(0.06, 0.0, 0.0);
  } else {
    node_rear_view_mirror_121.position.set(0.0, 1.462, 0.47);
    node_rear_view_mirror_121.rotation.set(0.06, 0.0, 0.0);
  }
  node_rear_view_mirror_121.userData.sculptComponent = {"id": "rear-view-mirror", "name": "车内后视镜", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.26, "height": 0.075, "depth": 0.038, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.0, 1.462, 0.47], "rotation": [0.06, 0, 0], "scale": [0.26, 0.075, 0.038]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-interior-mirror", "name": "内后视镜 + 顶部模组", "kind": "bevel", "note": "内后视镜位于前顶横梁下 12cm（参考副驾视图顶部的后视镜与 ADAS 模组）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-interior-mirror"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_view_mirror_121.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_rear_view_mirror_121);
  nodes["rear-view-mirror"] = node_rear_view_mirror_121;
  const mesh_rear_view_mirror_121Geometry = endpoint_rear_view_mirror_121
    ? new THREE.CylinderGeometry(endpoint_rear_view_mirror_121.endRadius, endpoint_rear_view_mirror_121.baseRadius, endpoint_rear_view_mirror_121.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rear_view_mirror_121) {
    mesh_rear_view_mirror_121Geometry.scale(0.26, 0.075, 0.038);
  }
  const mesh_rear_view_mirror_121 = new THREE.Mesh(
    mesh_rear_view_mirror_121Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_view_mirror_121.name = "\u8f66\u5185\u540e\u89c6\u955c";
  if (endpoint_rear_view_mirror_121) {
    mesh_rear_view_mirror_121.position.copy(endpoint_rear_view_mirror_121.midpoint);
    mesh_rear_view_mirror_121.quaternion.copy(endpoint_rear_view_mirror_121.quaternion);
  }
  mesh_rear_view_mirror_121.castShadow = options.castShadow ?? true;
  mesh_rear_view_mirror_121.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_view_mirror_121.userData.sculptComponent = {"id": "rear-view-mirror", "name": "车内后视镜", "level": "micro", "role": "interior", "importance": 0.6, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.26, "height": 0.075, "depth": 0.038, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.0, 1.462, 0.47], "rotation": [0.06, 0, 0], "scale": [0.26, 0.075, 0.038]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-interior-mirror", "name": "内后视镜 + 顶部模组", "kind": "bevel", "note": "内后视镜位于前顶横梁下 12cm（参考副驾视图顶部的后视镜与 ADAS 模组）"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-pass"], "details": ["d-interior-mirror"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 19, 22, 1.0)", "secondaryAlbedo": "rgba(18, 19, 22, 0.85)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_view_mirror_121.add(mesh_rear_view_mirror_121);
  meshes["rear-view-mirror"] = mesh_rear_view_mirror_121;
  colliders["rear-view-mirror"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rear_view_mirror_121);

  const endpoint_ambient_strip_l_122 = makeAttachmentEndpoint(null);
  const node_ambient_strip_l_122 = new THREE.Group();
  node_ambient_strip_l_122.name = "\u6c1b\u56f4\u706f\u5e26\uff08\u5de6\uff09__pivot";
  node_ambient_strip_l_122.scale.set(1, 1, 1);
  if (endpoint_ambient_strip_l_122) {
    node_ambient_strip_l_122.position.copy(endpoint_ambient_strip_l_122.start);
    node_ambient_strip_l_122.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ambient_strip_l_122.position.set(0.43, 0.948, 0.716);
    node_ambient_strip_l_122.rotation.set(0.0, 0.0, 0.0);
  }
  node_ambient_strip_l_122.userData.sculptComponent = {"id": "ambient-strip-l", "name": "氛围灯带（左）", "level": "micro", "role": "interior", "importance": 0.55, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.76, "height": 0.008, "depth": 0.008, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.43, 0.948, 0.716], "rotation": [0, 0, 0], "scale": [0.76, 0.008, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "ambient", "materialLayers": ["ambient"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-ambient-l", "name": "仪表台下沿氛围灯", "kind": "emissive", "note": "紫/冷白氛围光带，沿仪表台下沿与门板分色线走"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-ambient-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 160, 200, 1.0)", "secondaryAlbedo": "rgba(127, 160, 200, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_ambient_strip_l_122.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_ambient_strip_l_122);
  nodes["ambient-strip-l"] = node_ambient_strip_l_122;
  const mesh_ambient_strip_l_122Geometry = endpoint_ambient_strip_l_122
    ? new THREE.CylinderGeometry(endpoint_ambient_strip_l_122.endRadius, endpoint_ambient_strip_l_122.baseRadius, endpoint_ambient_strip_l_122.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_ambient_strip_l_122) {
    mesh_ambient_strip_l_122Geometry.scale(0.76, 0.008, 0.008);
  }
  const mesh_ambient_strip_l_122 = new THREE.Mesh(
    mesh_ambient_strip_l_122Geometry,
    materialMap["ambient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ambient_strip_l_122.name = "\u6c1b\u56f4\u706f\u5e26\uff08\u5de6\uff09";
  if (endpoint_ambient_strip_l_122) {
    mesh_ambient_strip_l_122.position.copy(endpoint_ambient_strip_l_122.midpoint);
    mesh_ambient_strip_l_122.quaternion.copy(endpoint_ambient_strip_l_122.quaternion);
  }
  mesh_ambient_strip_l_122.castShadow = options.castShadow ?? true;
  mesh_ambient_strip_l_122.receiveShadow = options.receiveShadow ?? true;
  mesh_ambient_strip_l_122.userData.sculptComponent = {"id": "ambient-strip-l", "name": "氛围灯带（左）", "level": "micro", "role": "interior", "importance": 0.55, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.76, "height": 0.008, "depth": 0.008, "units": "meters", "confidence": 0.85}, "transform": {"position": [0.43, 0.948, 0.716], "rotation": [0, 0, 0], "scale": [0.76, 0.008, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "ambient", "materialLayers": ["ambient"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-ambient-l", "name": "仪表台下沿氛围灯", "kind": "emissive", "note": "紫/冷白氛围光带，沿仪表台下沿与门板分色线走"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-ambient-l"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 160, 200, 1.0)", "secondaryAlbedo": "rgba(127, 160, 200, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_ambient_strip_l_122.add(mesh_ambient_strip_l_122);
  meshes["ambient-strip-l"] = mesh_ambient_strip_l_122;
  colliders["ambient-strip-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_ambient_strip_l_122);

  const endpoint_ambient_strip_r_123 = makeAttachmentEndpoint(null);
  const node_ambient_strip_r_123 = new THREE.Group();
  node_ambient_strip_r_123.name = "\u6c1b\u56f4\u706f\u5e26\uff08\u53f3\uff09__pivot";
  node_ambient_strip_r_123.scale.set(1, 1, 1);
  if (endpoint_ambient_strip_r_123) {
    node_ambient_strip_r_123.position.copy(endpoint_ambient_strip_r_123.start);
    node_ambient_strip_r_123.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ambient_strip_r_123.position.set(-0.43, 0.948, 0.716);
    node_ambient_strip_r_123.rotation.set(0.0, 0.0, 0.0);
  }
  node_ambient_strip_r_123.userData.sculptComponent = {"id": "ambient-strip-r", "name": "氛围灯带（右）", "level": "micro", "role": "interior", "importance": 0.55, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.76, "height": 0.008, "depth": 0.008, "units": "meters", "confidence": 0.85}, "transform": {"position": [-0.43, 0.948, 0.716], "rotation": [0, 0, 0], "scale": [0.76, 0.008, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "ambient", "materialLayers": ["ambient"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-ambient-r", "name": "仪表台下沿氛围灯", "kind": "emissive", "note": "紫/冷白氛围光带，沿仪表台下沿与门板分色线走"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-ambient-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 160, 200, 1.0)", "secondaryAlbedo": "rgba(127, 160, 200, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_ambient_strip_r_123.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_ambient_strip_r_123);
  nodes["ambient-strip-r"] = node_ambient_strip_r_123;
  const mesh_ambient_strip_r_123Geometry = endpoint_ambient_strip_r_123
    ? new THREE.CylinderGeometry(endpoint_ambient_strip_r_123.endRadius, endpoint_ambient_strip_r_123.baseRadius, endpoint_ambient_strip_r_123.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_ambient_strip_r_123) {
    mesh_ambient_strip_r_123Geometry.scale(0.76, 0.008, 0.008);
  }
  const mesh_ambient_strip_r_123 = new THREE.Mesh(
    mesh_ambient_strip_r_123Geometry,
    materialMap["ambient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ambient_strip_r_123.name = "\u6c1b\u56f4\u706f\u5e26\uff08\u53f3\uff09";
  if (endpoint_ambient_strip_r_123) {
    mesh_ambient_strip_r_123.position.copy(endpoint_ambient_strip_r_123.midpoint);
    mesh_ambient_strip_r_123.quaternion.copy(endpoint_ambient_strip_r_123.quaternion);
  }
  mesh_ambient_strip_r_123.castShadow = options.castShadow ?? true;
  mesh_ambient_strip_r_123.receiveShadow = options.receiveShadow ?? true;
  mesh_ambient_strip_r_123.userData.sculptComponent = {"id": "ambient-strip-r", "name": "氛围灯带（右）", "level": "micro", "role": "interior", "importance": 0.55, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 表达该部件的可展硬表面", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.76, "height": 0.008, "depth": 0.008, "units": "meters", "confidence": 0.85}, "transform": {"position": [-0.43, 0.948, 0.716], "rotation": [0, 0, 0], "scale": [0.76, 0.008, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "ambient", "materialLayers": ["ambient"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "d-ambient-r", "name": "仪表台下沿氛围灯", "kind": "emissive", "note": "紫/冷白氛围光带，沿仪表台下沿与门板分色线走"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-r7-dash"], "details": ["d-ambient-r"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 160, 200, 1.0)", "secondaryAlbedo": "rgba(127, 160, 200, 0.85)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_ambient_strip_r_123.add(mesh_ambient_strip_r_123);
  meshes["ambient-strip-r"] = mesh_ambient_strip_r_123;
  colliders["ambient-strip-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_ambient_strip_r_123);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createLuxeedR7LookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Luxeed R7 look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key-studio-softbox", "role": "key light", "direction": [-0.55, 0.75, 0.62], "color": "#FFF6EA", "intensity": 2.4, "note": "参考图为影棚三灯柔光：key light 位于车左前上方，车漆高光带沿腰线拉长"}, {"id": "fill-studio", "role": "fill light", "direction": [0.78, 0.38, -0.3], "color": "#DDE6F0", "intensity": 0.85, "note": "fill light 为右侧弱冷补光，压住暗部但不打死墨绿的青绿 flop"}, {"id": "rim-studio", "role": "rim light", "direction": [0.1, 0.55, -0.95], "color": "#FFFFFF", "intensity": 1.1, "note": "rim light / environment 反射：尾部轮廓光，尾灯带与鸭尾棱线靠它出边"}, {"id": "tone-mapping", "role": "exposure", "exposure": 1.0, "toneMapping": "ACESFilmic", "outputColorSpace": "sRGB", "background": "#E9E9EA", "note": "exposure 1.0 + ACES filmic tone mapping + sRGB 输出；参考图为浅灰无缝背景（#E9E9EA 上下渐变）"}, {"id": "contact-shadow", "role": "contact shadow", "type": "soft ground shadow", "intensity": 0.55, "radius": 0.35, "note": "contact shadow：车底一片柔和 ground shadow + 轮下加深，环境光遮蔽 AO 强度 0.45"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createLuxeedR7Environment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameLuxeedR7Camera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createLuxeedR7PresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureLuxeedR7Renderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createLuxeedR7InspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
