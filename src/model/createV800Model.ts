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

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
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

// Generated from ObjectSculptSpec target: Zunjie V800 Luxury MPV
// Sculpt build pass: structural-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createZunjieV800LuxuryMPVModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Zunjie V800 Luxury MPV";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 30, "aspect": 2.78, "orientation": {"yaw": 90, "pitch": 8, "roll": 0}, "positionHint": [0, 0.9, 9.5], "note": "侧视图近似正交长焦；review 渲染用同 FOV 对齐"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["paint-upper"] = createSculptMaterial(
    "paint-upper",
    {"id": "paint-upper", "name": "车漆·香槟金(上半/金版)", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C9A86B", "color": "#C9A86B", "albedo": {"base": "#C9A86B", "secondary": "#0E0E12", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.32, "metalness": 0.65, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [{"zone": "black-variant", "baseColor": "#0E0E12", "note": "黑版整车涂装切换"}], "shaderNotes": ["MeshPhysicalMaterial clearcoat 1.0 / clearcoatRoughness 0.06；黑版变体 #0E0E12 由集成层切换（localOverrides）"], "notes": "", "clearcoat": 1.0, "clearcoatRoughness": 0.06, "envMapIntensity": 1.0},
    options
  );
  materialMap["paint-lower"] = createSculptMaterial(
    "paint-lower",
    {"id": "paint-lower", "name": "车漆·深黑棕(下半)", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#221A14", "color": "#221A14", "albedo": {"base": "#221A14", "secondary": "#0E0E12", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.32, "metalness": 0.65, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["同 paint-upper 工艺；黑版车与 upper 同色"], "notes": "", "clearcoat": 1.0, "clearcoatRoughness": 0.08, "envMapIntensity": 0.9},
    options
  );
  materialMap["chrome"] = createSculptMaterial(
    "chrome",
    {"id": "chrome", "name": "镀铬饰件", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#E8E9EC", "color": "#E8E9EC", "albedo": {"base": "#E8E9EC", "secondary": "#E8E9EC", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.12, "metalness": 1.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["金属镀层，必须有 envMap 反射"], "notes": "", "envMapIntensity": 1.25},
    options
  );
  materialMap["dpillar-silver"] = createSculptMaterial(
    "dpillar-silver",
    {"id": "dpillar-silver", "name": "D柱/行李架银白", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D8D9DC", "color": "#D8D9DC", "albedo": {"base": "#D8D9DC", "secondary": "#D8D9DC", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.2, "metalness": 0.9, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["缎面银金属漆"], "notes": "", "envMapIntensity": 1.1},
    options
  );
  materialMap["glass-dark"] = createSculptMaterial(
    "glass-dark",
    {"id": "glass-dark", "name": "深色隐私玻璃", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#101418", "color": "#101418", "albedo": {"base": "#101418", "secondary": "#101418", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.05, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["近乎不透明深灰；high 档 transmission 0.5 供 cabin 内视，medium/low opacity 0.55"], "notes": "", "transmission": 0.5, "thickness": 0.03, "ior": 1.5},
    options
  );
  materialMap["glass-clear"] = createSculptMaterial(
    "glass-clear",
    {"id": "glass-clear", "name": "前挡玻璃", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#88909A", "color": "#88909A", "albedo": {"base": "#88909A", "secondary": "#88909A", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.04, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["较透明：transmission 0.85（high 档），medium/low opacity 0.4；cabin 视角必须可透视"], "notes": "", "transmission": 0.85, "thickness": 0.02, "ior": 1.52},
    options
  );
  materialMap["tire"] = createSculptMaterial(
    "tire",
    {"id": "tire", "name": "轮胎橡胶", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#141414", "color": "#141414", "albedo": {"base": "#141414", "secondary": "#141414", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.9, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["哑光橡胶；胎侧字略"], "notes": ""},
    options
  );
  materialMap["wheel-alloy"] = createSculptMaterial(
    "wheel-alloy",
    {"id": "wheel-alloy", "name": "轮圈抛光银", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C8CACD", "color": "#C8CACD", "albedo": {"base": "#C8CACD", "secondary": "#C8CACD", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.2, "metalness": 0.95, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["密辐大饼式亮面"], "notes": "", "envMapIntensity": 1.15},
    options
  );
  materialMap["housing-dark"] = createSculptMaterial(
    "housing-dark",
    {"id": "housing-dark", "name": "灯罩暗银底", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#1A1A1C", "color": "#1A1A1C", "albedo": {"base": "#1A1A1C", "secondary": "#1A1A1C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.25, "metalness": 0.8, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["灯具外壳底色"], "notes": ""},
    options
  );
  materialMap["matte-black"] = createSculptMaterial(
    "matte-black",
    {"id": "matte-black", "name": "哑光黑（格栅/护板/轮拱）", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#121214", "color": "#121214", "albedo": {"base": "#121214", "secondary": "#121214", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.75, "metalness": 0.1, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["哑光工程塑料"], "notes": ""},
    options
  );
  materialMap["screen-ui"] = createSculptMaterial(
    "screen-ui",
    {"id": "screen-ui", "name": "屏幕 UI 贴图材质", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#0A0C10", "color": "#0A0C10", "albedo": {"base": "#0A0C10", "secondary": "#0A0C10", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.12, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["Canvas HarmonyOS 风贴图作 emissiveMap+map，intensity 1.4"], "notes": "", "emissive": "#9FB6C8", "emissiveIntensity": 1.4},
    options
  );
  materialMap["gauge-ui"] = createSculptMaterial(
    "gauge-ui",
    {"id": "gauge-ui", "name": "动态仪表贴图材质", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#060A08", "color": "#060A08", "albedo": {"base": "#060A08", "secondary": "#060A08", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.12, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["集成层动态 Canvas（速度/踏板力/G 值）"], "notes": "", "emissive": "#7FD8A8", "emissiveIntensity": 1.6},
    options
  );
  materialMap["lamp-white"] = createSculptMaterial(
    "lamp-white",
    {"id": "lamp-white", "name": "白光 emissive（灯带/字标）", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#FFFFFF", "color": "#FFFFFF", "albedo": {"base": "#FFFFFF", "secondary": "#FFFFFF", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.3, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["emissive #FFFFFF intensity 2.5；MAEXTRO 用 Canvas 文字贴图作 emissiveMap"], "notes": "", "emissive": "#FFFFFF", "emissiveIntensity": 2.5},
    options
  );
  materialMap["lamp-star"] = createSculptMaterial(
    "lamp-star",
    {"id": "lamp-star", "name": "大灯星点纹理", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#EAF0FF", "color": "#EAF0FF", "albedo": {"base": "#EAF0FF", "secondary": "#EAF0FF", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.2, "metalness": 0.1, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["Canvas 星点点阵 emissiveMap，intensity 2.2"], "notes": "", "emissive": "#EAF0FF", "emissiveIntensity": 2.2},
    options
  );
  materialMap["lamp-red"] = createSculptMaterial(
    "lamp-red",
    {"id": "lamp-red", "name": "尾灯红光核心", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#FF1E14", "color": "#FF1E14", "albedo": {"base": "#FF1E14", "secondary": "#FF1E14", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.25, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["Canvas 红点阵+羽翼纹理 emissiveMap，intensity 2.0；刹车联动至 6.0"], "notes": "", "emissive": "#FF1E14", "emissiveIntensity": 2.0},
    options
  );
  materialMap["lamp-amber"] = createSculptMaterial(
    "lamp-amber",
    {"id": "lamp-amber", "name": "氛围灯带暖橙", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#FFB067", "color": "#FFB067", "albedo": {"base": "#FFB067", "secondary": "#FFB067", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.3, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["emissive #FFB067 intensity 1.8"], "notes": "", "emissive": "#FFB067", "emissiveIntensity": 1.8},
    options
  );
  materialMap["lamp-gold"] = createSculptMaterial(
    "lamp-gold",
    {"id": "lamp-gold", "name": "金色高音罩/音响点阵", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C9962E", "color": "#C9962E", "albedo": {"base": "#C9962E", "secondary": "#C9962E", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.28, "metalness": 0.85, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["金色金属+竖纹 bump"], "notes": "", "envMapIntensity": 1.1},
    options
  );
  materialMap["plate"] = createSculptMaterial(
    "plate",
    {"id": "plate", "name": "车名牌", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#0C0C0E", "color": "#0C0C0E", "albedo": {"base": "#0C0C0E", "secondary": "#0C0C0E", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.4, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["Canvas「尊界 V800」文字贴图"], "notes": ""},
    options
  );
  materialMap["leather-dark"] = createSculptMaterial(
    "leather-dark",
    {"id": "leather-dark", "name": "内饰深棕皮革(仪表台上层)", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#4A342A", "color": "#4A342A", "albedo": {"base": "#4A342A", "secondary": "#4A342A", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.62, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["细粒面 bump"], "notes": ""},
    options
  );
  materialMap["leather-warm"] = createSculptMaterial(
    "leather-warm",
    {"id": "leather-warm", "name": "内饰暖棕橙皮革", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#A05A2C", "color": "#A05A2C", "albedo": {"base": "#A05A2C", "secondary": "#A05A2C", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.58, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [{"zone": "seat-quilt", "bump": "canvas diamond-quilt", "bumpScale": 0.02}], "shaderNotes": ["全粒面+缝线；座椅用菱格 bump localOverrides"], "notes": ""},
    options
  );
  materialMap["leather-ivory"] = createSculptMaterial(
    "leather-ivory",
    {"id": "leather-ivory", "name": "米白真皮", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#E8E0D0", "color": "#E8E0D0", "albedo": {"base": "#E8E0D0", "secondary": "#E8E0D0", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.5, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["方向盘内圈/仪表台下体/顶棚后段"], "notes": ""},
    options
  );
  materialMap["wood"] = createSculptMaterial(
    "wood",
    {"id": "wood", "name": "车削红棕木纹", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#6B3418", "color": "#6B3418", "albedo": {"base": "#6B3418", "secondary": "#6B3418", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.25, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["Canvas 车削木纹贴图 + clearcoat 0.8"], "notes": "", "clearcoat": 0.8, "clearcoatRoughness": 0.15},
    options
  );
  materialMap["headliner-suede"] = createSculptMaterial(
    "headliner-suede",
    {"id": "headliner-suede", "name": "顶棚麂皮(星空顶段)", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#3A2A20", "color": "#3A2A20", "albedo": {"base": "#3A2A20", "secondary": "#3A2A20", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.88, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["穿孔麂皮 bump + 星点由 repetition 系统表达"], "notes": ""},
    options
  );
  materialMap["curtain"] = createSculptMaterial(
    "curtain",
    {"id": "curtain", "name": "后窗帘米白织物", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#D8CFC0", "color": "#D8CFC0", "albedo": {"base": "#D8CFC0", "secondary": "#D8CFC0", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.85, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["竖褶 normal 贴图（Canvas 条纹 bump）"], "notes": ""},
    options
  );
  materialMap["carpet"] = createSculptMaterial(
    "carpet",
    {"id": "carpet", "name": "长绒地毯", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#8A5A30", "color": "#8A5A30", "albedo": {"base": "#8A5A30", "secondary": "#8A5A30", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.95, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["长绒噪点 bump"], "notes": ""},
    options
  );
  materialMap["crystal"] = createSculptMaterial(
    "crystal",
    {"id": "crystal", "name": "水晶换挡旋钮", "type": "standard", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#F4EFE8", "color": "#F4EFE8", "albedo": {"base": "#F4EFE8", "secondary": "#F4EFE8", "note": "reference-derived"}, "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.2, "amplitude": 0.02}, {"id": "meso", "frequency": 8.0, "amplitude": 0.008}, {"id": "micro", "frequency": 48.0, "amplitude": 0.003}], "roughness": 0.05, "metalness": 0.0, "normal": null, "bump": null, "displacement": null, "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"}, "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0}, "localOverrides": [], "shaderNotes": ["transmission 0.9 / ior 1.45 / clearcoat 1.0（high 档），medium/low 降级高光泽"], "notes": "", "transmission": 0.9, "thickness": 0.08, "ior": 1.45, "clearcoat": 1.0},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Zunjie V800 \u6574\u8f66__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Zunjie V800 整车", "level": "macro", "role": "body", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "整车为组装体根节点", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 2.006, "height": 1.85, "depth": 5.495, "units": "meters", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [2.006, 1.85, 5.495]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(2.006, 1.85, 5.495);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Zunjie V800 \u6574\u8f66";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Zunjie V800 整车", "level": "macro", "role": "body", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "整车为组装体根节点", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 2.006, "height": 1.85, "depth": 5.495, "units": "meters", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [2.006, 1.85, 5.495]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 1.0}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
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
    node_body_lower_1.position.set(1.003, 0.0, 0.0);
    node_body_lower_1.rotation.set(0.0, -1.5708, 0.0);
  }
  node_body_lower_1.userData.sculptComponent = {"id": "body-lower", "name": "车身下半壳体", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "连续车身侧面轮廓挤出体，单壳表达全部纵向型面", "geometryDescriptor": {"profile2D": {"points": [[2.3, 0.2], [2.3, 0.38], [2.58, 0.6], [2.665, 0.82], [2.6, 0.99], [2.25, 1.03], [1.28, 1.09], [1.05, 1.09], [-1.8, 1.09], [-2.5, 1.05], [-2.78, 0.98], [-2.83, 0.82], [-2.7, 0.55], [-2.48, 0.36], [-2.48, 0.2]], "depth": 2.006}, "topologyIntent": "lofted side-profile shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.003, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-lower", "materialLayers": ["paint-lower"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "腰线高直", "kind": "proportion", "note": "y≈1.05-1.09 贯穿"}, {"name": "尾部肩线外拱", "kind": "surface", "note": "后翼子板 z-1.9~-2.6 外拱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt", "d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 26, 20, 1.0)", "secondaryAlbedo": "rgba(201, 168, 107, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_body_lower_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_body_lower_1);
  nodes["body-lower"] = node_body_lower_1;
  const mesh_body_lower_1Geometry = endpoint_body_lower_1
    ? new THREE.CylinderGeometry(endpoint_body_lower_1.endRadius, endpoint_body_lower_1.baseRadius, endpoint_body_lower_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[2.3, 0.2], [2.3, 0.38], [2.58, 0.6], [2.665, 0.82], [2.6, 0.99], [2.25, 1.03], [1.28, 1.09], [1.05, 1.09], [-1.8, 1.09], [-2.5, 1.05], [-2.78, 0.98], [-2.83, 0.82], [-2.7, 0.55], [-2.48, 0.36], [-2.48, 0.2]], "depth": 2.006});
  if (!endpoint_body_lower_1) {
    mesh_body_lower_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_lower_1 = new THREE.Mesh(
    mesh_body_lower_1Geometry,
    materialMap["paint-lower"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_lower_1.name = "\u8f66\u8eab\u4e0b\u534a\u58f3\u4f53";
  if (endpoint_body_lower_1) {
    mesh_body_lower_1.position.copy(endpoint_body_lower_1.midpoint);
    mesh_body_lower_1.quaternion.copy(endpoint_body_lower_1.quaternion);
  }
  mesh_body_lower_1.castShadow = options.castShadow ?? true;
  mesh_body_lower_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_lower_1.userData.sculptComponent = {"id": "body-lower", "name": "车身下半壳体", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "连续车身侧面轮廓挤出体，单壳表达全部纵向型面", "geometryDescriptor": {"profile2D": {"points": [[2.3, 0.2], [2.3, 0.38], [2.58, 0.6], [2.665, 0.82], [2.6, 0.99], [2.25, 1.03], [1.28, 1.09], [1.05, 1.09], [-1.8, 1.09], [-2.5, 1.05], [-2.78, 0.98], [-2.83, 0.82], [-2.7, 0.55], [-2.48, 0.36], [-2.48, 0.2]], "depth": 2.006}, "topologyIntent": "lofted side-profile shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.003, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-lower", "materialLayers": ["paint-lower"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "腰线高直", "kind": "proportion", "note": "y≈1.05-1.09 贯穿"}, {"name": "尾部肩线外拱", "kind": "surface", "note": "后翼子板 z-1.9~-2.6 外拱"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt", "d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 26, 20, 1.0)", "secondaryAlbedo": "rgba(201, 168, 107, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_body_lower_1.add(mesh_body_lower_1);
  meshes["body-lower"] = mesh_body_lower_1;
  colliders["body-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_body_lower_1);

  const endpoint_hood_panel_2 = makeAttachmentEndpoint(null);
  const node_hood_panel_2 = new THREE.Group();
  node_hood_panel_2.name = "\u673a\u76d6\u9762\u677f__pivot";
  node_hood_panel_2.scale.set(1, 1, 1);
  if (endpoint_hood_panel_2) {
    node_hood_panel_2.position.copy(endpoint_hood_panel_2.start);
    node_hood_panel_2.rotation.set(0.05, 0.0, 0.0);
  } else {
    node_hood_panel_2.position.set(0.0, 1.055, 1.92);
    node_hood_panel_2.rotation.set(0.05, 0.0, 0.0);
  }
  node_hood_panel_2.userData.sculptComponent = {"id": "hood-panel", "name": "机盖面板", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.3, "height": 0.035, "depth": 1.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.055, 1.92], "rotation": [0.05, 0, 0], "scale": [1.3, 0.035, 1.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "中央盖板缝线", "kind": "panel-line", "note": "中部纵向缝 + 前端楔形压板"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_hood_panel_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_hood_panel_2);
  nodes["hood-panel"] = node_hood_panel_2;
  const mesh_hood_panel_2Geometry = endpoint_hood_panel_2
    ? new THREE.CylinderGeometry(endpoint_hood_panel_2.endRadius, endpoint_hood_panel_2.baseRadius, endpoint_hood_panel_2.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_hood_panel_2) {
    mesh_hood_panel_2Geometry.scale(1.3, 0.035, 1.3);
  }
  const mesh_hood_panel_2 = new THREE.Mesh(
    mesh_hood_panel_2Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hood_panel_2.name = "\u673a\u76d6\u9762\u677f";
  if (endpoint_hood_panel_2) {
    mesh_hood_panel_2.position.copy(endpoint_hood_panel_2.midpoint);
    mesh_hood_panel_2.quaternion.copy(endpoint_hood_panel_2.quaternion);
  }
  mesh_hood_panel_2.castShadow = options.castShadow ?? true;
  mesh_hood_panel_2.receiveShadow = options.receiveShadow ?? true;
  mesh_hood_panel_2.userData.sculptComponent = {"id": "hood-panel", "name": "机盖面板", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.3, "height": 0.035, "depth": 1.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.055, 1.92], "rotation": [0.05, 0, 0], "scale": [1.3, 0.035, 1.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "中央盖板缝线", "kind": "panel-line", "note": "中部纵向缝 + 前端楔形压板"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_hood_panel_2.add(mesh_hood_panel_2);
  meshes["hood-panel"] = mesh_hood_panel_2;
  colliders["hood-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_hood_panel_2);

  const endpoint_greenhouse_glass_3 = makeAttachmentEndpoint(null);
  const node_greenhouse_glass_3 = new THREE.Group();
  node_greenhouse_glass_3.name = "\u73bb\u7483\u8231\u73af__pivot";
  node_greenhouse_glass_3.scale.set(1, 1, 1);
  if (endpoint_greenhouse_glass_3) {
    node_greenhouse_glass_3.position.copy(endpoint_greenhouse_glass_3.start);
    node_greenhouse_glass_3.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_greenhouse_glass_3.position.set(0.915, 0.0, 0.0);
    node_greenhouse_glass_3.rotation.set(0.0, -1.5708, 0.0);
  }
  node_greenhouse_glass_3.userData.sculptComponent = {"id": "greenhouse-glass", "name": "玻璃舱环", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗+后窗连续玻璃带，前挡独立", "geometryDescriptor": {"profile2D": {"points": [[1.02, 1.1], [0.18, 1.6], [-0.3, 1.645], [-1.8, 1.645], [-2.3, 1.56], [-2.42, 1.14]], "depth": 1.83}, "topologyIntent": "glazed band extrusion", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.915, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 20, 24, 1.0)", "secondaryAlbedo": "rgba(16, 20, 24, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_greenhouse_glass_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_greenhouse_glass_3);
  nodes["greenhouse-glass"] = node_greenhouse_glass_3;
  const mesh_greenhouse_glass_3Geometry = endpoint_greenhouse_glass_3
    ? new THREE.CylinderGeometry(endpoint_greenhouse_glass_3.endRadius, endpoint_greenhouse_glass_3.baseRadius, endpoint_greenhouse_glass_3.length, 16, 6)
    : buildExtrudeGeometry({"points": [[1.02, 1.1], [0.18, 1.6], [-0.3, 1.645], [-1.8, 1.645], [-2.3, 1.56], [-2.42, 1.14]], "depth": 1.83});
  if (!endpoint_greenhouse_glass_3) {
    mesh_greenhouse_glass_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_greenhouse_glass_3 = new THREE.Mesh(
    mesh_greenhouse_glass_3Geometry,
    materialMap["glass-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_greenhouse_glass_3.name = "\u73bb\u7483\u8231\u73af";
  if (endpoint_greenhouse_glass_3) {
    mesh_greenhouse_glass_3.position.copy(endpoint_greenhouse_glass_3.midpoint);
    mesh_greenhouse_glass_3.quaternion.copy(endpoint_greenhouse_glass_3.quaternion);
  }
  mesh_greenhouse_glass_3.castShadow = options.castShadow ?? true;
  mesh_greenhouse_glass_3.receiveShadow = options.receiveShadow ?? true;
  mesh_greenhouse_glass_3.userData.sculptComponent = {"id": "greenhouse-glass", "name": "玻璃舱环", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "侧窗+后窗连续玻璃带，前挡独立", "geometryDescriptor": {"profile2D": {"points": [[1.02, 1.1], [0.18, 1.6], [-0.3, 1.645], [-1.8, 1.645], [-2.3, 1.56], [-2.42, 1.14]], "depth": 1.83}, "topologyIntent": "glazed band extrusion", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.915, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-dark", "materialLayers": ["glass-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 20, 24, 1.0)", "secondaryAlbedo": "rgba(16, 20, 24, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_greenhouse_glass_3.add(mesh_greenhouse_glass_3);
  meshes["greenhouse-glass"] = mesh_greenhouse_glass_3;
  colliders["greenhouse-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_greenhouse_glass_3);

  const endpoint_roof_panel_4 = makeAttachmentEndpoint(null);
  const node_roof_panel_4 = new THREE.Group();
  node_roof_panel_4.name = "\u8f66\u9876\u677f__pivot";
  node_roof_panel_4.scale.set(1, 1, 1);
  if (endpoint_roof_panel_4) {
    node_roof_panel_4.position.copy(endpoint_roof_panel_4.start);
    node_roof_panel_4.rotation.set(0.0, -1.5708, 0.0);
  } else {
    node_roof_panel_4.position.set(0.8, 0.0, 0.0);
    node_roof_panel_4.rotation.set(0.0, -1.5708, 0.0);
  }
  node_roof_panel_4.userData.sculptComponent = {"id": "roof-panel", "name": "车顶板", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "顶冠弧面薄片", "geometryDescriptor": {"profile2D": {"points": [[0.98, 1.56], [0.2, 1.715], [-0.2, 1.72], [-1.8, 1.72], [-2.32, 1.585], [-2.36, 1.5], [-2.3, 1.5], [-1.8, 1.645], [0.18, 1.645]], "depth": 1.6}, "topologyIntent": "crown arc shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.015, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.8, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_panel_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_panel_4);
  nodes["roof-panel"] = node_roof_panel_4;
  const mesh_roof_panel_4Geometry = endpoint_roof_panel_4
    ? new THREE.CylinderGeometry(endpoint_roof_panel_4.endRadius, endpoint_roof_panel_4.baseRadius, endpoint_roof_panel_4.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.98, 1.56], [0.2, 1.715], [-0.2, 1.72], [-1.8, 1.72], [-2.32, 1.585], [-2.36, 1.5], [-2.3, 1.5], [-1.8, 1.645], [0.18, 1.645]], "depth": 1.6});
  if (!endpoint_roof_panel_4) {
    mesh_roof_panel_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_panel_4 = new THREE.Mesh(
    mesh_roof_panel_4Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_panel_4.name = "\u8f66\u9876\u677f";
  if (endpoint_roof_panel_4) {
    mesh_roof_panel_4.position.copy(endpoint_roof_panel_4.midpoint);
    mesh_roof_panel_4.quaternion.copy(endpoint_roof_panel_4.quaternion);
  }
  mesh_roof_panel_4.castShadow = options.castShadow ?? true;
  mesh_roof_panel_4.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_panel_4.userData.sculptComponent = {"id": "roof-panel", "name": "车顶板", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "顶冠弧面薄片", "geometryDescriptor": {"profile2D": {"points": [[0.98, 1.56], [0.2, 1.715], [-0.2, 1.72], [-1.8, 1.72], [-2.32, 1.585], [-2.36, 1.5], [-2.3, 1.5], [-1.8, 1.645], [0.18, 1.645]], "depth": 1.6}, "topologyIntent": "crown arc shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.015, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.8, 0, 0], "rotation": [0, -1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_panel_4.add(mesh_roof_panel_4);
  meshes["roof-panel"] = mesh_roof_panel_4;
  colliders["roof-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_panel_4);

  const endpoint_windshield_5 = makeAttachmentEndpoint(null);
  const node_windshield_5 = new THREE.Group();
  node_windshield_5.name = "\u524d\u6321\u73bb\u7483__pivot";
  node_windshield_5.scale.set(1, 1, 1);
  if (endpoint_windshield_5) {
    node_windshield_5.position.copy(endpoint_windshield_5.start);
    node_windshield_5.rotation.set(0.5236, 0.0, 0.0);
  } else {
    node_windshield_5.position.set(0.0, 1.345, 0.6);
    node_windshield_5.rotation.set(0.5236, 0.0, 0.0);
  }
  node_windshield_5.userData.sculptComponent = {"id": "windshield", "name": "前挡玻璃", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.5, "height": 0.025, "depth": 1.06, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.345, 0.6], "rotation": [0.5236, 0, 0], "scale": [1.5, 0.025, 1.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-clear", "materialLayers": ["glass-clear"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "车内可透视", "kind": "visibility", "note": "cabin 驾驶员视角必须能看穿"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(136, 144, 154, 1.0)", "secondaryAlbedo": "rgba(136, 144, 154, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_windshield_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_windshield_5);
  nodes["windshield"] = node_windshield_5;
  const mesh_windshield_5Geometry = endpoint_windshield_5
    ? new THREE.CylinderGeometry(endpoint_windshield_5.endRadius, endpoint_windshield_5.baseRadius, endpoint_windshield_5.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_windshield_5) {
    mesh_windshield_5Geometry.scale(1.5, 0.025, 1.06);
  }
  const mesh_windshield_5 = new THREE.Mesh(
    mesh_windshield_5Geometry,
    materialMap["glass-clear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_windshield_5.name = "\u524d\u6321\u73bb\u7483";
  if (endpoint_windshield_5) {
    mesh_windshield_5.position.copy(endpoint_windshield_5.midpoint);
    mesh_windshield_5.quaternion.copy(endpoint_windshield_5.quaternion);
  }
  mesh_windshield_5.castShadow = options.castShadow ?? true;
  mesh_windshield_5.receiveShadow = options.receiveShadow ?? true;
  mesh_windshield_5.userData.sculptComponent = {"id": "windshield", "name": "前挡玻璃", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.5, "height": 0.025, "depth": 1.06, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.345, 0.6], "rotation": [0.5236, 0, 0], "scale": [1.5, 0.025, 1.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "glass-clear", "materialLayers": ["glass-clear"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "车内可透视", "kind": "visibility", "note": "cabin 驾驶员视角必须能看穿"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(136, 144, 154, 1.0)", "secondaryAlbedo": "rgba(136, 144, 154, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_windshield_5.add(mesh_windshield_5);
  meshes["windshield"] = mesh_windshield_5;
  colliders["windshield"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_windshield_5);

  const endpoint_dpillar_l_6 = makeAttachmentEndpoint(null);
  const node_dpillar_l_6 = new THREE.Group();
  node_dpillar_l_6.name = "D \u67f1\u94f6\u767d\u5bbd\u5305\u8fb9\u5de6__pivot";
  node_dpillar_l_6.scale.set(1, 1, 1);
  if (endpoint_dpillar_l_6) {
    node_dpillar_l_6.position.copy(endpoint_dpillar_l_6.start);
    node_dpillar_l_6.rotation.set(0.0, 0.0, -0.12);
  } else {
    node_dpillar_l_6.position.set(0.9, 1.38, -2.28);
    node_dpillar_l_6.rotation.set(0.0, 0.0, -0.12);
  }
  node_dpillar_l_6.userData.sculptComponent = {"id": "dpillar-l", "name": "D 柱银白宽包边左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2, "height": 0.56, "depth": 0.34, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.9, 1.38, -2.28], "rotation": [0, 0, -0.12], "scale": [0.2, 0.56, 0.34]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-dpillar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_l_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_dpillar_l_6);
  nodes["dpillar-l"] = node_dpillar_l_6;
  const mesh_dpillar_l_6Geometry = endpoint_dpillar_l_6
    ? new THREE.CylinderGeometry(endpoint_dpillar_l_6.endRadius, endpoint_dpillar_l_6.baseRadius, endpoint_dpillar_l_6.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_dpillar_l_6) {
    mesh_dpillar_l_6Geometry.scale(0.2, 0.56, 0.34);
  }
  const mesh_dpillar_l_6 = new THREE.Mesh(
    mesh_dpillar_l_6Geometry,
    materialMap["dpillar-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dpillar_l_6.name = "D \u67f1\u94f6\u767d\u5bbd\u5305\u8fb9\u5de6";
  if (endpoint_dpillar_l_6) {
    mesh_dpillar_l_6.position.copy(endpoint_dpillar_l_6.midpoint);
    mesh_dpillar_l_6.quaternion.copy(endpoint_dpillar_l_6.quaternion);
  }
  mesh_dpillar_l_6.castShadow = options.castShadow ?? true;
  mesh_dpillar_l_6.receiveShadow = options.receiveShadow ?? true;
  mesh_dpillar_l_6.userData.sculptComponent = {"id": "dpillar-l", "name": "D 柱银白宽包边左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2, "height": 0.56, "depth": 0.34, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.9, 1.38, -2.28], "rotation": [0, 0, -0.12], "scale": [0.2, 0.56, 0.34]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-dpillar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_l_6.add(mesh_dpillar_l_6);
  meshes["dpillar-l"] = mesh_dpillar_l_6;
  colliders["dpillar-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dpillar_l_6);

  const endpoint_dpillar_r_7 = makeAttachmentEndpoint(null);
  const node_dpillar_r_7 = new THREE.Group();
  node_dpillar_r_7.name = "D \u67f1\u94f6\u767d\u5bbd\u5305\u8fb9\u53f3__pivot";
  node_dpillar_r_7.scale.set(1, 1, 1);
  if (endpoint_dpillar_r_7) {
    node_dpillar_r_7.position.copy(endpoint_dpillar_r_7.start);
    node_dpillar_r_7.rotation.set(0.0, 0.0, 0.12);
  } else {
    node_dpillar_r_7.position.set(-0.9, 1.38, -2.28);
    node_dpillar_r_7.rotation.set(0.0, 0.0, 0.12);
  }
  node_dpillar_r_7.userData.sculptComponent = {"id": "dpillar-r", "name": "D 柱银白宽包边右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2, "height": 0.56, "depth": 0.34, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.9, 1.38, -2.28], "rotation": [0, 0, 0.12], "scale": [0.2, 0.56, 0.34]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-dpillar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_r_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_dpillar_r_7);
  nodes["dpillar-r"] = node_dpillar_r_7;
  const mesh_dpillar_r_7Geometry = endpoint_dpillar_r_7
    ? new THREE.CylinderGeometry(endpoint_dpillar_r_7.endRadius, endpoint_dpillar_r_7.baseRadius, endpoint_dpillar_r_7.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_dpillar_r_7) {
    mesh_dpillar_r_7Geometry.scale(0.2, 0.56, 0.34);
  }
  const mesh_dpillar_r_7 = new THREE.Mesh(
    mesh_dpillar_r_7Geometry,
    materialMap["dpillar-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dpillar_r_7.name = "D \u67f1\u94f6\u767d\u5bbd\u5305\u8fb9\u53f3";
  if (endpoint_dpillar_r_7) {
    mesh_dpillar_r_7.position.copy(endpoint_dpillar_r_7.midpoint);
    mesh_dpillar_r_7.quaternion.copy(endpoint_dpillar_r_7.quaternion);
  }
  mesh_dpillar_r_7.castShadow = options.castShadow ?? true;
  mesh_dpillar_r_7.receiveShadow = options.receiveShadow ?? true;
  mesh_dpillar_r_7.userData.sculptComponent = {"id": "dpillar-r", "name": "D 柱银白宽包边右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2, "height": 0.56, "depth": 0.34, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.9, 1.38, -2.28], "rotation": [0, 0, 0.12], "scale": [0.2, 0.56, 0.34]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-dpillar"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_dpillar_r_7.add(mesh_dpillar_r_7);
  meshes["dpillar-r"] = mesh_dpillar_r_7;
  colliders["dpillar-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dpillar_r_7);

  const endpoint_front_end_8 = makeAttachmentEndpoint(null);
  const node_front_end_8 = new THREE.Group();
  node_front_end_8.name = "\u524d\u8138\u6a21\u5757__pivot";
  node_front_end_8.scale.set(1, 1, 1);
  if (endpoint_front_end_8) {
    node_front_end_8.position.copy(endpoint_front_end_8.start);
    node_front_end_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_end_8.position.set(0.0, 0.9, 2.62);
    node_front_end_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_end_8.userData.sculptComponent = {"id": "front-end", "name": "前脸模块", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 1.05, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.9, 2.62], "rotation": [0, 0, 0], "scale": [1.86, 1.05, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_front_end_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_end_8);
  nodes["front-end"] = node_front_end_8;
  const mesh_front_end_8Geometry = endpoint_front_end_8
    ? new THREE.CylinderGeometry(endpoint_front_end_8.endRadius, endpoint_front_end_8.baseRadius, endpoint_front_end_8.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_front_end_8) {
    mesh_front_end_8Geometry.scale(1.86, 1.05, 0.08);
  }
  const mesh_front_end_8 = new THREE.Mesh(
    mesh_front_end_8Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_end_8.name = "\u524d\u8138\u6a21\u5757";
  if (endpoint_front_end_8) {
    mesh_front_end_8.position.copy(endpoint_front_end_8.midpoint);
    mesh_front_end_8.quaternion.copy(endpoint_front_end_8.quaternion);
  }
  mesh_front_end_8.castShadow = options.castShadow ?? true;
  mesh_front_end_8.receiveShadow = options.receiveShadow ?? true;
  mesh_front_end_8.userData.sculptComponent = {"id": "front-end", "name": "前脸模块", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 1.05, "depth": 0.08, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.9, 2.62], "rotation": [0, 0, 0], "scale": [1.86, 1.05, 0.08]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_front_end_8.add(mesh_front_end_8);
  meshes["front-end"] = mesh_front_end_8;
  colliders["front-end"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_end_8);

  const endpoint_chrome_brow_9 = makeAttachmentEndpoint(null);
  const node_chrome_brow_9 = new THREE.Group();
  node_chrome_brow_9.name = "\u524d\u8138\u9540\u94ec\u4e0a\u6cbf\u9970\u6761__pivot";
  node_chrome_brow_9.scale.set(1, 1, 1);
  if (endpoint_chrome_brow_9) {
    node_chrome_brow_9.position.copy(endpoint_chrome_brow_9.start);
    node_chrome_brow_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chrome_brow_9.position.set(0.0, 0.4, -0.03);
    node_chrome_brow_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_chrome_brow_9.userData.sculptComponent = {"id": "chrome-brow", "name": "前脸镀铬上沿饰条", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1.84, "height": 0.09, "depth": 0.06, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0.4, -0.03], "rotation": [0, 0, 0], "scale": [1.84, 0.09, 0.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": ["d-maextro-mark"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_brow_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["front-end"] ?? root).add(node_chrome_brow_9);
  nodes["chrome-brow"] = node_chrome_brow_9;
  const mesh_chrome_brow_9Geometry = endpoint_chrome_brow_9
    ? new THREE.CylinderGeometry(endpoint_chrome_brow_9.endRadius, endpoint_chrome_brow_9.baseRadius, endpoint_chrome_brow_9.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_chrome_brow_9) {
    mesh_chrome_brow_9Geometry.scale(1.84, 0.09, 0.06);
  }
  const mesh_chrome_brow_9 = new THREE.Mesh(
    mesh_chrome_brow_9Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chrome_brow_9.name = "\u524d\u8138\u9540\u94ec\u4e0a\u6cbf\u9970\u6761";
  if (endpoint_chrome_brow_9) {
    mesh_chrome_brow_9.position.copy(endpoint_chrome_brow_9.midpoint);
    mesh_chrome_brow_9.quaternion.copy(endpoint_chrome_brow_9.quaternion);
  }
  mesh_chrome_brow_9.castShadow = options.castShadow ?? true;
  mesh_chrome_brow_9.receiveShadow = options.receiveShadow ?? true;
  mesh_chrome_brow_9.userData.sculptComponent = {"id": "chrome-brow", "name": "前脸镀铬上沿饰条", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1.84, "height": 0.09, "depth": 0.06, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0.4, -0.03], "rotation": [0, 0, 0], "scale": [1.84, 0.09, 0.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": ["d-maextro-mark"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_brow_9.add(mesh_chrome_brow_9);
  meshes["chrome-brow"] = mesh_chrome_brow_9;
  colliders["chrome-brow"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_chrome_brow_9);

  const endpoint_headlamp_l_10 = makeAttachmentEndpoint(null);
  const node_headlamp_l_10 = new THREE.Group();
  node_headlamp_l_10.name = "\u7ad6\u5411\u5927\u706f\u603b\u6210\u5de6__pivot";
  node_headlamp_l_10.scale.set(1, 1, 1);
  if (endpoint_headlamp_l_10) {
    node_headlamp_l_10.position.copy(endpoint_headlamp_l_10.start);
    node_headlamp_l_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_l_10.position.set(0.8, 0.06, 0.03);
    node_headlamp_l_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_l_10.userData.sculptComponent = {"id": "headlamp-l", "name": "竖向大灯总成左", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角矩形灯罩轮廓挤出", "geometryDescriptor": {"profile2D": {"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07}, "topologyIntent": "rounded vertical lamp housing", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.8, 0.06, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-design-black"], "details": ["d-headlamp-star"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 28, 1.0)", "secondaryAlbedo": "rgba(26, 26, 28, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_l_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["front-end"] ?? root).add(node_headlamp_l_10);
  nodes["headlamp-l"] = node_headlamp_l_10;
  const mesh_headlamp_l_10Geometry = endpoint_headlamp_l_10
    ? new THREE.CylinderGeometry(endpoint_headlamp_l_10.endRadius, endpoint_headlamp_l_10.baseRadius, endpoint_headlamp_l_10.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07});
  if (!endpoint_headlamp_l_10) {
    mesh_headlamp_l_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_headlamp_l_10 = new THREE.Mesh(
    mesh_headlamp_l_10Geometry,
    materialMap["housing-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_l_10.name = "\u7ad6\u5411\u5927\u706f\u603b\u6210\u5de6";
  if (endpoint_headlamp_l_10) {
    mesh_headlamp_l_10.position.copy(endpoint_headlamp_l_10.midpoint);
    mesh_headlamp_l_10.quaternion.copy(endpoint_headlamp_l_10.quaternion);
  }
  mesh_headlamp_l_10.castShadow = options.castShadow ?? true;
  mesh_headlamp_l_10.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_l_10.userData.sculptComponent = {"id": "headlamp-l", "name": "竖向大灯总成左", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角矩形灯罩轮廓挤出", "geometryDescriptor": {"profile2D": {"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07}, "topologyIntent": "rounded vertical lamp housing", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.8, 0.06, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-design-black"], "details": ["d-headlamp-star"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 28, 1.0)", "secondaryAlbedo": "rgba(26, 26, 28, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_l_10.add(mesh_headlamp_l_10);
  meshes["headlamp-l"] = mesh_headlamp_l_10;
  colliders["headlamp-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_l_10);

  const endpoint_headlamp_r_11 = makeAttachmentEndpoint(null);
  const node_headlamp_r_11 = new THREE.Group();
  node_headlamp_r_11.name = "\u7ad6\u5411\u5927\u706f\u603b\u6210\u53f3__pivot";
  node_headlamp_r_11.scale.set(1, 1, 1);
  if (endpoint_headlamp_r_11) {
    node_headlamp_r_11.position.copy(endpoint_headlamp_r_11.start);
    node_headlamp_r_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlamp_r_11.position.set(-0.8, 0.06, 0.03);
    node_headlamp_r_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlamp_r_11.userData.sculptComponent = {"id": "headlamp-r", "name": "竖向大灯总成右", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角矩形灯罩轮廓挤出", "geometryDescriptor": {"profile2D": {"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07}, "topologyIntent": "rounded vertical lamp housing", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.8, 0.06, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-design-black"], "details": ["d-headlamp-star"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 28, 1.0)", "secondaryAlbedo": "rgba(26, 26, 28, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_r_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["front-end"] ?? root).add(node_headlamp_r_11);
  nodes["headlamp-r"] = node_headlamp_r_11;
  const mesh_headlamp_r_11Geometry = endpoint_headlamp_r_11
    ? new THREE.CylinderGeometry(endpoint_headlamp_r_11.endRadius, endpoint_headlamp_r_11.baseRadius, endpoint_headlamp_r_11.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07});
  if (!endpoint_headlamp_r_11) {
    mesh_headlamp_r_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_headlamp_r_11 = new THREE.Mesh(
    mesh_headlamp_r_11Geometry,
    materialMap["housing-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlamp_r_11.name = "\u7ad6\u5411\u5927\u706f\u603b\u6210\u53f3";
  if (endpoint_headlamp_r_11) {
    mesh_headlamp_r_11.position.copy(endpoint_headlamp_r_11.midpoint);
    mesh_headlamp_r_11.quaternion.copy(endpoint_headlamp_r_11.quaternion);
  }
  mesh_headlamp_r_11.castShadow = options.castShadow ?? true;
  mesh_headlamp_r_11.receiveShadow = options.receiveShadow ?? true;
  mesh_headlamp_r_11.userData.sculptComponent = {"id": "headlamp-r", "name": "竖向大灯总成右", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角矩形灯罩轮廓挤出", "geometryDescriptor": {"profile2D": {"points": [[-0.085, -0.3], [0.0, -0.325], [0.085, -0.3], [0.1, -0.22], [0.1, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.1, 0.24], [-0.1, -0.22]], "depth": 0.07}, "topologyIntent": "rounded vertical lamp housing", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.8, 0.06, 0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "housing-dark", "materialLayers": ["housing-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence", "img-design-black"], "details": ["d-headlamp-star"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 28, 1.0)", "secondaryAlbedo": "rgba(26, 26, 28, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_headlamp_r_11.add(mesh_headlamp_r_11);
  meshes["headlamp-r"] = mesh_headlamp_r_11;
  colliders["headlamp-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headlamp_r_11);

  const endpoint_bumper_lower_12 = makeAttachmentEndpoint(null);
  const node_bumper_lower_12 = new THREE.Group();
  node_bumper_lower_12.name = "\u524d\u4fdd\u9669\u6760\u4e0b\u4f53__pivot";
  node_bumper_lower_12.scale.set(1, 1, 1);
  if (endpoint_bumper_lower_12) {
    node_bumper_lower_12.position.copy(endpoint_bumper_lower_12.start);
    node_bumper_lower_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bumper_lower_12.position.set(0.0, -0.44, 0.005);
    node_bumper_lower_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_bumper_lower_12.userData.sculptComponent = {"id": "bumper-lower", "name": "前保险杠下体", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1.92, "height": 0.32, "depth": 0.1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.44, 0.005], "rotation": [0, 0, 0], "scale": [1.92, 0.32, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-lower", "materialLayers": ["paint-lower"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 26, 20, 1.0)", "secondaryAlbedo": "rgba(201, 168, 107, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_bumper_lower_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["front-end"] ?? root).add(node_bumper_lower_12);
  nodes["bumper-lower"] = node_bumper_lower_12;
  const mesh_bumper_lower_12Geometry = endpoint_bumper_lower_12
    ? new THREE.CylinderGeometry(endpoint_bumper_lower_12.endRadius, endpoint_bumper_lower_12.baseRadius, endpoint_bumper_lower_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bumper_lower_12) {
    mesh_bumper_lower_12Geometry.scale(1.92, 0.32, 0.1);
  }
  const mesh_bumper_lower_12 = new THREE.Mesh(
    mesh_bumper_lower_12Geometry,
    materialMap["paint-lower"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bumper_lower_12.name = "\u524d\u4fdd\u9669\u6760\u4e0b\u4f53";
  if (endpoint_bumper_lower_12) {
    mesh_bumper_lower_12.position.copy(endpoint_bumper_lower_12.midpoint);
    mesh_bumper_lower_12.quaternion.copy(endpoint_bumper_lower_12.quaternion);
  }
  mesh_bumper_lower_12.castShadow = options.castShadow ?? true;
  mesh_bumper_lower_12.receiveShadow = options.receiveShadow ?? true;
  mesh_bumper_lower_12.userData.sculptComponent = {"id": "bumper-lower", "name": "前保险杠下体", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-end", "attachment": null, "dimensions": {"width": 1.92, "height": 0.32, "depth": 0.1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, -0.44, 0.005], "rotation": [0, 0, 0], "scale": [1.92, 0.32, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-lower", "materialLayers": ["paint-lower"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 26, 20, 1.0)", "secondaryAlbedo": "rgba(201, 168, 107, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_bumper_lower_12.add(mesh_bumper_lower_12);
  meshes["bumper-lower"] = mesh_bumper_lower_12;
  colliders["bumper-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_bumper_lower_12);

  const endpoint_tailgate_13 = makeAttachmentEndpoint(null);
  const node_tailgate_13 = new THREE.Group();
  node_tailgate_13.name = "\u5c3e\u95e8\u6a21\u5757__pivot";
  node_tailgate_13.scale.set(1, 1, 1);
  if (endpoint_tailgate_13) {
    node_tailgate_13.position.copy(endpoint_tailgate_13.start);
    node_tailgate_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tailgate_13.position.set(0.0, 1.02, -2.8);
    node_tailgate_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_tailgate_13.userData.sculptComponent = {"id": "tailgate", "name": "尾门模块", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 1.05, "depth": 0.07, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.02, -2.8], "rotation": [0, 0, 0], "scale": [1.86, 1.05, 0.07]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tailgate_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_tailgate_13);
  nodes["tailgate"] = node_tailgate_13;
  const mesh_tailgate_13Geometry = endpoint_tailgate_13
    ? new THREE.CylinderGeometry(endpoint_tailgate_13.endRadius, endpoint_tailgate_13.baseRadius, endpoint_tailgate_13.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tailgate_13) {
    mesh_tailgate_13Geometry.scale(1.86, 1.05, 0.07);
  }
  const mesh_tailgate_13 = new THREE.Mesh(
    mesh_tailgate_13Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tailgate_13.name = "\u5c3e\u95e8\u6a21\u5757";
  if (endpoint_tailgate_13) {
    mesh_tailgate_13.position.copy(endpoint_tailgate_13.midpoint);
    mesh_tailgate_13.quaternion.copy(endpoint_tailgate_13.quaternion);
  }
  mesh_tailgate_13.castShadow = options.castShadow ?? true;
  mesh_tailgate_13.receiveShadow = options.receiveShadow ?? true;
  mesh_tailgate_13.userData.sculptComponent = {"id": "tailgate", "name": "尾门模块", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.86, "height": 1.05, "depth": 0.07, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.02, -2.8], "rotation": [0, 0, 0], "scale": [1.86, 1.05, 0.07]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tailgate_13.add(mesh_tailgate_13);
  meshes["tailgate"] = mesh_tailgate_13;
  colliders["tailgate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tailgate_13);

  const endpoint_taillamp_l_14 = makeAttachmentEndpoint(null);
  const node_taillamp_l_14 = new THREE.Group();
  node_taillamp_l_14.name = "\u5bab\u706f\u5c3e\u706f\u5de6__pivot";
  node_taillamp_l_14.scale.set(1, 1, 1);
  if (endpoint_taillamp_l_14) {
    node_taillamp_l_14.position.copy(endpoint_taillamp_l_14.start);
    node_taillamp_l_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_taillamp_l_14.position.set(0.84, -0.12, -0.02);
    node_taillamp_l_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_taillamp_l_14.userData.sculptComponent = {"id": "taillamp-l", "name": "宫灯尾灯左", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角镀铬宫灯外框", "geometryDescriptor": {"profile2D": {"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06}, "topologyIntent": "rounded vertical lantern frame", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, -0.12, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-tail-lantern"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_taillamp_l_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["tailgate"] ?? root).add(node_taillamp_l_14);
  nodes["taillamp-l"] = node_taillamp_l_14;
  const mesh_taillamp_l_14Geometry = endpoint_taillamp_l_14
    ? new THREE.CylinderGeometry(endpoint_taillamp_l_14.endRadius, endpoint_taillamp_l_14.baseRadius, endpoint_taillamp_l_14.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06});
  if (!endpoint_taillamp_l_14) {
    mesh_taillamp_l_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_taillamp_l_14 = new THREE.Mesh(
    mesh_taillamp_l_14Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_taillamp_l_14.name = "\u5bab\u706f\u5c3e\u706f\u5de6";
  if (endpoint_taillamp_l_14) {
    mesh_taillamp_l_14.position.copy(endpoint_taillamp_l_14.midpoint);
    mesh_taillamp_l_14.quaternion.copy(endpoint_taillamp_l_14.quaternion);
  }
  mesh_taillamp_l_14.castShadow = options.castShadow ?? true;
  mesh_taillamp_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_taillamp_l_14.userData.sculptComponent = {"id": "taillamp-l", "name": "宫灯尾灯左", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角镀铬宫灯外框", "geometryDescriptor": {"profile2D": {"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06}, "topologyIntent": "rounded vertical lantern frame", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.84, -0.12, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-tail-lantern"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_taillamp_l_14.add(mesh_taillamp_l_14);
  meshes["taillamp-l"] = mesh_taillamp_l_14;
  colliders["taillamp-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_taillamp_l_14);

  const endpoint_taillamp_r_15 = makeAttachmentEndpoint(null);
  const node_taillamp_r_15 = new THREE.Group();
  node_taillamp_r_15.name = "\u5bab\u706f\u5c3e\u706f\u53f3__pivot";
  node_taillamp_r_15.scale.set(1, 1, 1);
  if (endpoint_taillamp_r_15) {
    node_taillamp_r_15.position.copy(endpoint_taillamp_r_15.start);
    node_taillamp_r_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_taillamp_r_15.position.set(-0.84, -0.12, -0.02);
    node_taillamp_r_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_taillamp_r_15.userData.sculptComponent = {"id": "taillamp-r", "name": "宫灯尾灯右", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角镀铬宫灯外框", "geometryDescriptor": {"profile2D": {"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06}, "topologyIntent": "rounded vertical lantern frame", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, -0.12, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-tail-lantern"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_taillamp_r_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["tailgate"] ?? root).add(node_taillamp_r_15);
  nodes["taillamp-r"] = node_taillamp_r_15;
  const mesh_taillamp_r_15Geometry = endpoint_taillamp_r_15
    ? new THREE.CylinderGeometry(endpoint_taillamp_r_15.endRadius, endpoint_taillamp_r_15.baseRadius, endpoint_taillamp_r_15.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06});
  if (!endpoint_taillamp_r_15) {
    mesh_taillamp_r_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_taillamp_r_15 = new THREE.Mesh(
    mesh_taillamp_r_15Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_taillamp_r_15.name = "\u5bab\u706f\u5c3e\u706f\u53f3";
  if (endpoint_taillamp_r_15) {
    mesh_taillamp_r_15.position.copy(endpoint_taillamp_r_15.midpoint);
    mesh_taillamp_r_15.quaternion.copy(endpoint_taillamp_r_15.quaternion);
  }
  mesh_taillamp_r_15.castShadow = options.castShadow ?? true;
  mesh_taillamp_r_15.receiveShadow = options.receiveShadow ?? true;
  mesh_taillamp_r_15.userData.sculptComponent = {"id": "taillamp-r", "name": "宫灯尾灯右", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "竖圆角镀铬宫灯外框", "geometryDescriptor": {"profile2D": {"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06}, "topologyIntent": "rounded vertical lantern frame", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.84, -0.12, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": ["d-tail-lantern"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_taillamp_r_15.add(mesh_taillamp_r_15);
  meshes["taillamp-r"] = mesh_taillamp_r_15;
  colliders["taillamp-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_taillamp_r_15);

  const endpoint_tail_window_trim_16 = makeAttachmentEndpoint(null);
  const node_tail_window_trim_16 = new THREE.Group();
  node_tail_window_trim_16.name = "\u5c3e\u7a97\u94f6\u767d\u5305\u8fb9__pivot";
  node_tail_window_trim_16.scale.set(1, 1, 1);
  if (endpoint_tail_window_trim_16) {
    node_tail_window_trim_16.position.copy(endpoint_tail_window_trim_16.start);
    node_tail_window_trim_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_window_trim_16.position.set(0.0, 0.44, 0.015);
    node_tail_window_trim_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_window_trim_16.userData.sculptComponent = {"id": "tail-window-trim", "name": "尾窗银白包边", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1.3, "height": 0.1, "depth": 0.05, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0.44, 0.015], "rotation": [0, 0, 0], "scale": [1.3, 0.1, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tail_window_trim_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["tailgate"] ?? root).add(node_tail_window_trim_16);
  nodes["tail-window-trim"] = node_tail_window_trim_16;
  const mesh_tail_window_trim_16Geometry = endpoint_tail_window_trim_16
    ? new THREE.CylinderGeometry(endpoint_tail_window_trim_16.endRadius, endpoint_tail_window_trim_16.baseRadius, endpoint_tail_window_trim_16.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tail_window_trim_16) {
    mesh_tail_window_trim_16Geometry.scale(1.3, 0.1, 0.05);
  }
  const mesh_tail_window_trim_16 = new THREE.Mesh(
    mesh_tail_window_trim_16Geometry,
    materialMap["dpillar-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_window_trim_16.name = "\u5c3e\u7a97\u94f6\u767d\u5305\u8fb9";
  if (endpoint_tail_window_trim_16) {
    mesh_tail_window_trim_16.position.copy(endpoint_tail_window_trim_16.midpoint);
    mesh_tail_window_trim_16.quaternion.copy(endpoint_tail_window_trim_16.quaternion);
  }
  mesh_tail_window_trim_16.castShadow = options.castShadow ?? true;
  mesh_tail_window_trim_16.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_window_trim_16.userData.sculptComponent = {"id": "tail-window-trim", "name": "尾窗银白包边", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "tailgate", "attachment": null, "dimensions": {"width": 1.3, "height": 0.1, "depth": 0.05, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0.44, 0.015], "rotation": [0, 0, 0], "scale": [1.3, 0.1, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_tail_window_trim_16.add(mesh_tail_window_trim_16);
  meshes["tail-window-trim"] = mesh_tail_window_trim_16;
  colliders["tail-window-trim"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tail_window_trim_16);

  const endpoint_chrome_belt_l_17 = makeAttachmentEndpoint(null);
  const node_chrome_belt_l_17 = new THREE.Group();
  node_chrome_belt_l_17.name = "\u8170\u7ebf\u9540\u94ec\u4eae\u6761\u5de6__pivot";
  node_chrome_belt_l_17.scale.set(1, 1, 1);
  if (endpoint_chrome_belt_l_17) {
    node_chrome_belt_l_17.position.copy(endpoint_chrome_belt_l_17.start);
    node_chrome_belt_l_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chrome_belt_l_17.position.set(1.006, 1.005, -0.15);
    node_chrome_belt_l_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_chrome_belt_l_17.userData.sculptComponent = {"id": "chrome-belt-l", "name": "腰线镀铬亮条左", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.03, "depth": 4.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.006, 1.005, -0.15], "rotation": [0, 0, 0], "scale": [0.02, 0.03, 4.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_belt_l_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_chrome_belt_l_17);
  nodes["chrome-belt-l"] = node_chrome_belt_l_17;
  const mesh_chrome_belt_l_17Geometry = endpoint_chrome_belt_l_17
    ? new THREE.CylinderGeometry(endpoint_chrome_belt_l_17.endRadius, endpoint_chrome_belt_l_17.baseRadius, endpoint_chrome_belt_l_17.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_chrome_belt_l_17) {
    mesh_chrome_belt_l_17Geometry.scale(0.02, 0.03, 4.6);
  }
  const mesh_chrome_belt_l_17 = new THREE.Mesh(
    mesh_chrome_belt_l_17Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chrome_belt_l_17.name = "\u8170\u7ebf\u9540\u94ec\u4eae\u6761\u5de6";
  if (endpoint_chrome_belt_l_17) {
    mesh_chrome_belt_l_17.position.copy(endpoint_chrome_belt_l_17.midpoint);
    mesh_chrome_belt_l_17.quaternion.copy(endpoint_chrome_belt_l_17.quaternion);
  }
  mesh_chrome_belt_l_17.castShadow = options.castShadow ?? true;
  mesh_chrome_belt_l_17.receiveShadow = options.receiveShadow ?? true;
  mesh_chrome_belt_l_17.userData.sculptComponent = {"id": "chrome-belt-l", "name": "腰线镀铬亮条左", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.03, "depth": 4.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.006, 1.005, -0.15], "rotation": [0, 0, 0], "scale": [0.02, 0.03, 4.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_belt_l_17.add(mesh_chrome_belt_l_17);
  meshes["chrome-belt-l"] = mesh_chrome_belt_l_17;
  colliders["chrome-belt-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_chrome_belt_l_17);

  const endpoint_window_belt_l_18 = makeAttachmentEndpoint(null);
  const node_window_belt_l_18 = new THREE.Group();
  node_window_belt_l_18.name = "\u7a97\u7ebf\u9540\u94ec\u4eae\u6761\u5de6__pivot";
  node_window_belt_l_18.scale.set(1, 1, 1);
  if (endpoint_window_belt_l_18) {
    node_window_belt_l_18.position.copy(endpoint_window_belt_l_18.start);
    node_window_belt_l_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_belt_l_18.position.set(0.918, 1.105, -0.55);
    node_window_belt_l_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_belt_l_18.userData.sculptComponent = {"id": "window-belt-l", "name": "窗线镀铬亮条左", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.015, "height": 0.02, "depth": 3.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.918, 1.105, -0.55], "rotation": [0, 0, 0], "scale": [0.015, 0.02, 3.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_window_belt_l_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_window_belt_l_18);
  nodes["window-belt-l"] = node_window_belt_l_18;
  const mesh_window_belt_l_18Geometry = endpoint_window_belt_l_18
    ? new THREE.CylinderGeometry(endpoint_window_belt_l_18.endRadius, endpoint_window_belt_l_18.baseRadius, endpoint_window_belt_l_18.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_belt_l_18) {
    mesh_window_belt_l_18Geometry.scale(0.015, 0.02, 3.3);
  }
  const mesh_window_belt_l_18 = new THREE.Mesh(
    mesh_window_belt_l_18Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_belt_l_18.name = "\u7a97\u7ebf\u9540\u94ec\u4eae\u6761\u5de6";
  if (endpoint_window_belt_l_18) {
    mesh_window_belt_l_18.position.copy(endpoint_window_belt_l_18.midpoint);
    mesh_window_belt_l_18.quaternion.copy(endpoint_window_belt_l_18.quaternion);
  }
  mesh_window_belt_l_18.castShadow = options.castShadow ?? true;
  mesh_window_belt_l_18.receiveShadow = options.receiveShadow ?? true;
  mesh_window_belt_l_18.userData.sculptComponent = {"id": "window-belt-l", "name": "窗线镀铬亮条左", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.015, "height": 0.02, "depth": 3.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.918, 1.105, -0.55], "rotation": [0, 0, 0], "scale": [0.015, 0.02, 3.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_window_belt_l_18.add(mesh_window_belt_l_18);
  meshes["window-belt-l"] = mesh_window_belt_l_18;
  colliders["window-belt-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_window_belt_l_18);

  const endpoint_handle_front_l_19 = makeAttachmentEndpoint(null);
  const node_handle_front_l_19 = new THREE.Group();
  node_handle_front_l_19.name = "\u524d\u95e8\u901a\u957f\u628a\u624b\u5de6__pivot";
  node_handle_front_l_19.scale.set(1, 1, 1);
  if (endpoint_handle_front_l_19) {
    node_handle_front_l_19.position.copy(endpoint_handle_front_l_19.start);
    node_handle_front_l_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handle_front_l_19.position.set(1.012, 0.97, 1.18);
    node_handle_front_l_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_handle_front_l_19.userData.sculptComponent = {"id": "handle-front-l", "name": "前门通长把手左", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.035, "height": 0.04, "depth": 0.62, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.012, 0.97, 1.18], "rotation": [0, 0, 0], "scale": [0.035, 0.04, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-doorhandles"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_l_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_handle_front_l_19);
  nodes["handle-front-l"] = node_handle_front_l_19;
  const mesh_handle_front_l_19Geometry = endpoint_handle_front_l_19
    ? new THREE.CylinderGeometry(endpoint_handle_front_l_19.endRadius, endpoint_handle_front_l_19.baseRadius, endpoint_handle_front_l_19.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_handle_front_l_19) {
    mesh_handle_front_l_19Geometry.scale(0.035, 0.04, 0.62);
  }
  const mesh_handle_front_l_19 = new THREE.Mesh(
    mesh_handle_front_l_19Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handle_front_l_19.name = "\u524d\u95e8\u901a\u957f\u628a\u624b\u5de6";
  if (endpoint_handle_front_l_19) {
    mesh_handle_front_l_19.position.copy(endpoint_handle_front_l_19.midpoint);
    mesh_handle_front_l_19.quaternion.copy(endpoint_handle_front_l_19.quaternion);
  }
  mesh_handle_front_l_19.castShadow = options.castShadow ?? true;
  mesh_handle_front_l_19.receiveShadow = options.receiveShadow ?? true;
  mesh_handle_front_l_19.userData.sculptComponent = {"id": "handle-front-l", "name": "前门通长把手左", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.035, "height": 0.04, "depth": 0.62, "units": "meters", "confidence": 0.95}, "transform": {"position": [1.012, 0.97, 1.18], "rotation": [0, 0, 0], "scale": [0.035, 0.04, 0.62]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-doorhandles"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_handle_front_l_19.add(mesh_handle_front_l_19);
  meshes["handle-front-l"] = mesh_handle_front_l_19;
  colliders["handle-front-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_handle_front_l_19);

  const endpoint_rocker_l_20 = makeAttachmentEndpoint(null);
  const node_rocker_l_20 = new THREE.Group();
  node_rocker_l_20.name = "\u4e0b\u88d9\u62a4\u677f\u5de6__pivot";
  node_rocker_l_20.scale.set(1, 1, 1);
  if (endpoint_rocker_l_20) {
    node_rocker_l_20.position.copy(endpoint_rocker_l_20.start);
    node_rocker_l_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rocker_l_20.position.set(0.988, 0.28, -0.15);
    node_rocker_l_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_rocker_l_20.userData.sculptComponent = {"id": "rocker-l", "name": "下裙护板左", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.05, "height": 0.12, "depth": 3.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.988, 0.28, -0.15], "rotation": [0, 0, 0], "scale": [0.05, 0.12, 3.4]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_l_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rocker_l_20);
  nodes["rocker-l"] = node_rocker_l_20;
  const mesh_rocker_l_20Geometry = endpoint_rocker_l_20
    ? new THREE.CylinderGeometry(endpoint_rocker_l_20.endRadius, endpoint_rocker_l_20.baseRadius, endpoint_rocker_l_20.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rocker_l_20) {
    mesh_rocker_l_20Geometry.scale(0.05, 0.12, 3.4);
  }
  const mesh_rocker_l_20 = new THREE.Mesh(
    mesh_rocker_l_20Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rocker_l_20.name = "\u4e0b\u88d9\u62a4\u677f\u5de6";
  if (endpoint_rocker_l_20) {
    mesh_rocker_l_20.position.copy(endpoint_rocker_l_20.midpoint);
    mesh_rocker_l_20.quaternion.copy(endpoint_rocker_l_20.quaternion);
  }
  mesh_rocker_l_20.castShadow = options.castShadow ?? true;
  mesh_rocker_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_rocker_l_20.userData.sculptComponent = {"id": "rocker-l", "name": "下裙护板左", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.05, "height": 0.12, "depth": 3.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.988, 0.28, -0.15], "rotation": [0, 0, 0], "scale": [0.05, 0.12, 3.4]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_l_20.add(mesh_rocker_l_20);
  meshes["rocker-l"] = mesh_rocker_l_20;
  colliders["rocker-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rocker_l_20);

  const endpoint_mirror_l_21 = makeAttachmentEndpoint(null);
  const node_mirror_l_21 = new THREE.Group();
  node_mirror_l_21.name = "\u540e\u89c6\u955c\u5de6__pivot";
  node_mirror_l_21.scale.set(1, 1, 1);
  if (endpoint_mirror_l_21) {
    node_mirror_l_21.position.copy(endpoint_mirror_l_21.start);
    node_mirror_l_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mirror_l_21.position.set(1.1, 1.17, 1.02);
    node_mirror_l_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_mirror_l_21.userData.sculptComponent = {"id": "mirror-l", "name": "后视镜左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.22, "height": 0.13, "depth": 0.11, "units": "meters", "confidence": 0.92}, "transform": {"position": [1.1, 1.17, 1.02], "rotation": [0, 0, 0], "scale": [0.22, 0.13, 0.11]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双色壳", "kind": "two-tone", "note": "上半镀铬盖+下车色"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_l_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_l_21);
  nodes["mirror-l"] = node_mirror_l_21;
  const mesh_mirror_l_21Geometry = endpoint_mirror_l_21
    ? new THREE.CylinderGeometry(endpoint_mirror_l_21.endRadius, endpoint_mirror_l_21.baseRadius, endpoint_mirror_l_21.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_mirror_l_21) {
    mesh_mirror_l_21Geometry.scale(0.22, 0.13, 0.11);
  }
  const mesh_mirror_l_21 = new THREE.Mesh(
    mesh_mirror_l_21Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_l_21.name = "\u540e\u89c6\u955c\u5de6";
  if (endpoint_mirror_l_21) {
    mesh_mirror_l_21.position.copy(endpoint_mirror_l_21.midpoint);
    mesh_mirror_l_21.quaternion.copy(endpoint_mirror_l_21.quaternion);
  }
  mesh_mirror_l_21.castShadow = options.castShadow ?? true;
  mesh_mirror_l_21.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_l_21.userData.sculptComponent = {"id": "mirror-l", "name": "后视镜左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.22, "height": 0.13, "depth": 0.11, "units": "meters", "confidence": 0.92}, "transform": {"position": [1.1, 1.17, 1.02], "rotation": [0, 0, 0], "scale": [0.22, 0.13, 0.11]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双色壳", "kind": "two-tone", "note": "上半镀铬盖+下车色"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_l_21.add(mesh_mirror_l_21);
  meshes["mirror-l"] = mesh_mirror_l_21;
  colliders["mirror-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_l_21);

  const endpoint_chrome_belt_r_22 = makeAttachmentEndpoint(null);
  const node_chrome_belt_r_22 = new THREE.Group();
  node_chrome_belt_r_22.name = "\u8170\u7ebf\u9540\u94ec\u4eae\u6761\u53f3__pivot";
  node_chrome_belt_r_22.scale.set(1, 1, 1);
  if (endpoint_chrome_belt_r_22) {
    node_chrome_belt_r_22.position.copy(endpoint_chrome_belt_r_22.start);
    node_chrome_belt_r_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chrome_belt_r_22.position.set(-1.006, 1.005, -0.15);
    node_chrome_belt_r_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_chrome_belt_r_22.userData.sculptComponent = {"id": "chrome-belt-r", "name": "腰线镀铬亮条右", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.03, "depth": 4.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [-1.006, 1.005, -0.15], "rotation": [0, 0, 0], "scale": [0.02, 0.03, 4.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_belt_r_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_chrome_belt_r_22);
  nodes["chrome-belt-r"] = node_chrome_belt_r_22;
  const mesh_chrome_belt_r_22Geometry = endpoint_chrome_belt_r_22
    ? new THREE.CylinderGeometry(endpoint_chrome_belt_r_22.endRadius, endpoint_chrome_belt_r_22.baseRadius, endpoint_chrome_belt_r_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_chrome_belt_r_22) {
    mesh_chrome_belt_r_22Geometry.scale(0.02, 0.03, 4.6);
  }
  const mesh_chrome_belt_r_22 = new THREE.Mesh(
    mesh_chrome_belt_r_22Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chrome_belt_r_22.name = "\u8170\u7ebf\u9540\u94ec\u4eae\u6761\u53f3";
  if (endpoint_chrome_belt_r_22) {
    mesh_chrome_belt_r_22.position.copy(endpoint_chrome_belt_r_22.midpoint);
    mesh_chrome_belt_r_22.quaternion.copy(endpoint_chrome_belt_r_22.quaternion);
  }
  mesh_chrome_belt_r_22.castShadow = options.castShadow ?? true;
  mesh_chrome_belt_r_22.receiveShadow = options.receiveShadow ?? true;
  mesh_chrome_belt_r_22.userData.sculptComponent = {"id": "chrome-belt-r", "name": "腰线镀铬亮条右", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.02, "height": 0.03, "depth": 4.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [-1.006, 1.005, -0.15], "rotation": [0, 0, 0], "scale": [0.02, 0.03, 4.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-chrome-belt"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_chrome_belt_r_22.add(mesh_chrome_belt_r_22);
  meshes["chrome-belt-r"] = mesh_chrome_belt_r_22;
  colliders["chrome-belt-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_chrome_belt_r_22);

  const endpoint_window_belt_r_23 = makeAttachmentEndpoint(null);
  const node_window_belt_r_23 = new THREE.Group();
  node_window_belt_r_23.name = "\u7a97\u7ebf\u9540\u94ec\u4eae\u6761\u53f3__pivot";
  node_window_belt_r_23.scale.set(1, 1, 1);
  if (endpoint_window_belt_r_23) {
    node_window_belt_r_23.position.copy(endpoint_window_belt_r_23.start);
    node_window_belt_r_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_belt_r_23.position.set(-0.918, 1.105, -0.55);
    node_window_belt_r_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_belt_r_23.userData.sculptComponent = {"id": "window-belt-r", "name": "窗线镀铬亮条右", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.015, "height": 0.02, "depth": 3.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.918, 1.105, -0.55], "rotation": [0, 0, 0], "scale": [0.015, 0.02, 3.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_window_belt_r_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_window_belt_r_23);
  nodes["window-belt-r"] = node_window_belt_r_23;
  const mesh_window_belt_r_23Geometry = endpoint_window_belt_r_23
    ? new THREE.CylinderGeometry(endpoint_window_belt_r_23.endRadius, endpoint_window_belt_r_23.baseRadius, endpoint_window_belt_r_23.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_belt_r_23) {
    mesh_window_belt_r_23Geometry.scale(0.015, 0.02, 3.3);
  }
  const mesh_window_belt_r_23 = new THREE.Mesh(
    mesh_window_belt_r_23Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_belt_r_23.name = "\u7a97\u7ebf\u9540\u94ec\u4eae\u6761\u53f3";
  if (endpoint_window_belt_r_23) {
    mesh_window_belt_r_23.position.copy(endpoint_window_belt_r_23.midpoint);
    mesh_window_belt_r_23.quaternion.copy(endpoint_window_belt_r_23.quaternion);
  }
  mesh_window_belt_r_23.castShadow = options.castShadow ?? true;
  mesh_window_belt_r_23.receiveShadow = options.receiveShadow ?? true;
  mesh_window_belt_r_23.userData.sculptComponent = {"id": "window-belt-r", "name": "窗线镀铬亮条右", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.015, "height": 0.02, "depth": 3.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.918, 1.105, -0.55], "rotation": [0, 0, 0], "scale": [0.015, 0.02, 3.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_window_belt_r_23.add(mesh_window_belt_r_23);
  meshes["window-belt-r"] = mesh_window_belt_r_23;
  colliders["window-belt-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_window_belt_r_23);

  const endpoint_rocker_r_24 = makeAttachmentEndpoint(null);
  const node_rocker_r_24 = new THREE.Group();
  node_rocker_r_24.name = "\u4e0b\u88d9\u62a4\u677f\u53f3__pivot";
  node_rocker_r_24.scale.set(1, 1, 1);
  if (endpoint_rocker_r_24) {
    node_rocker_r_24.position.copy(endpoint_rocker_r_24.start);
    node_rocker_r_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rocker_r_24.position.set(-0.988, 0.28, -0.15);
    node_rocker_r_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_rocker_r_24.userData.sculptComponent = {"id": "rocker-r", "name": "下裙护板右", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.05, "height": 0.12, "depth": 3.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.988, 0.28, -0.15], "rotation": [0, 0, 0], "scale": [0.05, 0.12, 3.4]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_r_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rocker_r_24);
  nodes["rocker-r"] = node_rocker_r_24;
  const mesh_rocker_r_24Geometry = endpoint_rocker_r_24
    ? new THREE.CylinderGeometry(endpoint_rocker_r_24.endRadius, endpoint_rocker_r_24.baseRadius, endpoint_rocker_r_24.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rocker_r_24) {
    mesh_rocker_r_24Geometry.scale(0.05, 0.12, 3.4);
  }
  const mesh_rocker_r_24 = new THREE.Mesh(
    mesh_rocker_r_24Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rocker_r_24.name = "\u4e0b\u88d9\u62a4\u677f\u53f3";
  if (endpoint_rocker_r_24) {
    mesh_rocker_r_24.position.copy(endpoint_rocker_r_24.midpoint);
    mesh_rocker_r_24.quaternion.copy(endpoint_rocker_r_24.quaternion);
  }
  mesh_rocker_r_24.castShadow = options.castShadow ?? true;
  mesh_rocker_r_24.receiveShadow = options.receiveShadow ?? true;
  mesh_rocker_r_24.userData.sculptComponent = {"id": "rocker-r", "name": "下裙护板右", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.05, "height": 0.12, "depth": 3.4, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.988, 0.28, -0.15], "rotation": [0, 0, 0], "scale": [0.05, 0.12, 3.4]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-rocker-step"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rocker_r_24.add(mesh_rocker_r_24);
  meshes["rocker-r"] = mesh_rocker_r_24;
  colliders["rocker-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rocker_r_24);

  const endpoint_mirror_r_25 = makeAttachmentEndpoint(null);
  const node_mirror_r_25 = new THREE.Group();
  node_mirror_r_25.name = "\u540e\u89c6\u955c\u53f3__pivot";
  node_mirror_r_25.scale.set(1, 1, 1);
  if (endpoint_mirror_r_25) {
    node_mirror_r_25.position.copy(endpoint_mirror_r_25.start);
    node_mirror_r_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mirror_r_25.position.set(-1.1, 1.17, 1.02);
    node_mirror_r_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_mirror_r_25.userData.sculptComponent = {"id": "mirror-r", "name": "后视镜右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.22, "height": 0.13, "depth": 0.11, "units": "meters", "confidence": 0.92}, "transform": {"position": [-1.1, 1.17, 1.02], "rotation": [0, 0, 0], "scale": [0.22, 0.13, 0.11]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双色壳", "kind": "two-tone", "note": "上半镀铬盖+下车色"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_r_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mirror_r_25);
  nodes["mirror-r"] = node_mirror_r_25;
  const mesh_mirror_r_25Geometry = endpoint_mirror_r_25
    ? new THREE.CylinderGeometry(endpoint_mirror_r_25.endRadius, endpoint_mirror_r_25.baseRadius, endpoint_mirror_r_25.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_mirror_r_25) {
    mesh_mirror_r_25Geometry.scale(0.22, 0.13, 0.11);
  }
  const mesh_mirror_r_25 = new THREE.Mesh(
    mesh_mirror_r_25Geometry,
    materialMap["paint-upper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mirror_r_25.name = "\u540e\u89c6\u955c\u53f3";
  if (endpoint_mirror_r_25) {
    mesh_mirror_r_25.position.copy(endpoint_mirror_r_25.midpoint);
    mesh_mirror_r_25.quaternion.copy(endpoint_mirror_r_25.quaternion);
  }
  mesh_mirror_r_25.castShadow = options.castShadow ?? true;
  mesh_mirror_r_25.receiveShadow = options.receiveShadow ?? true;
  mesh_mirror_r_25.userData.sculptComponent = {"id": "mirror-r", "name": "后视镜右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.22, "height": 0.13, "depth": 0.11, "units": "meters", "confidence": 0.92}, "transform": {"position": [-1.1, 1.17, 1.02], "rotation": [0, 0, 0], "scale": [0.22, 0.13, 0.11]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "paint-upper", "materialLayers": ["paint-upper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双色壳", "kind": "two-tone", "note": "上半镀铬盖+下车色"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-intelligence"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(14, 14, 18, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_mirror_r_25.add(mesh_mirror_r_25);
  meshes["mirror-r"] = mesh_mirror_r_25;
  colliders["mirror-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mirror_r_25);

  const attachment_roof_rails_26 = {"parentSocket": "roof-panel.top", "localStart": [0.62, 0, 1.2], "localEnd": [-0.62, 0, 1.2], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.004};
  const endpoint_roof_rails_26 = makeAttachmentEndpoint(attachment_roof_rails_26);
  const node_roof_rails_26 = new THREE.Group();
  node_roof_rails_26.name = "\u8f66\u9876\u884c\u674e\u67b6\u7eb5\u8f68\u00d72__pivot";
  node_roof_rails_26.scale.set(1, 1, 1);
  if (endpoint_roof_rails_26) {
    node_roof_rails_26.position.copy(endpoint_roof_rails_26.start);
    node_roof_rails_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_rails_26.position.set(0.0, 1.895, -0.35);
    node_roof_rails_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_rails_26.userData.sculptComponent = {"id": "roof-rails", "name": "车顶行李架纵轨×2", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "双纵轨连续管", "geometryDescriptor": {"tubePath": {"points": [[0.62, 0, 1.2], [0.62, 0, -1.9], [-0.62, 0, -1.9], [-0.62, 0, 1.2]], "radius": 0.022, "closed": true}, "topologyIntent": "two parallel rails", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": {"parentSocket": "roof-panel.top", "localStart": [0.62, 0, 1.2], "localEnd": [-0.62, 0, 1.2], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.004}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.895, -0.35], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-roof-rail"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rails_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_rails_26);
  nodes["roof-rails"] = node_roof_rails_26;
  const mesh_roof_rails_26Geometry = endpoint_roof_rails_26
    ? new THREE.CylinderGeometry(endpoint_roof_rails_26.endRadius, endpoint_roof_rails_26.baseRadius, endpoint_roof_rails_26.length, 16, 6)
    : buildTubeGeometry({"points": [[0.62, 0, 1.2], [0.62, 0, -1.9], [-0.62, 0, -1.9], [-0.62, 0, 1.2]], "radius": 0.022, "closed": true});
  if (!endpoint_roof_rails_26) {
    mesh_roof_rails_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_rails_26 = new THREE.Mesh(
    mesh_roof_rails_26Geometry,
    materialMap["dpillar-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_rails_26.name = "\u8f66\u9876\u884c\u674e\u67b6\u7eb5\u8f68\u00d72";
  if (endpoint_roof_rails_26) {
    mesh_roof_rails_26.position.copy(endpoint_roof_rails_26.midpoint);
    mesh_roof_rails_26.quaternion.copy(endpoint_roof_rails_26.quaternion);
  }
  mesh_roof_rails_26.castShadow = options.castShadow ?? true;
  mesh_roof_rails_26.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_rails_26.userData.sculptComponent = {"id": "roof-rails", "name": "车顶行李架纵轨×2", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "双纵轨连续管", "geometryDescriptor": {"tubePath": {"points": [[0.62, 0, 1.2], [0.62, 0, -1.9], [-0.62, 0, -1.9], [-0.62, 0, 1.2]], "radius": 0.022, "closed": true}, "topologyIntent": "two parallel rails", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "root", "attachment": {"parentSocket": "roof-panel.top", "localStart": [0.62, 0, 1.2], "localEnd": [-0.62, 0, 1.2], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.004}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.895, -0.35], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "dpillar-silver", "materialLayers": ["dpillar-silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": ["d-roof-rail"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 217, 220, 1.0)", "secondaryAlbedo": "rgba(216, 217, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_roof_rails_26.add(mesh_roof_rails_26);
  meshes["roof-rails"] = mesh_roof_rails_26;
  colliders["roof-rails"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roof_rails_26);

  const endpoint_lidar_wedge_27 = makeAttachmentEndpoint(null);
  const node_lidar_wedge_27 = new THREE.Group();
  node_lidar_wedge_27.name = "\u6fc0\u5149\u96f7\u8fbe\u6954\u5f62\u5757__pivot";
  node_lidar_wedge_27.scale.set(1, 1, 1);
  if (endpoint_lidar_wedge_27) {
    node_lidar_wedge_27.position.copy(endpoint_lidar_wedge_27.start);
    node_lidar_wedge_27.rotation.set(0.12, 0.0, 0.0);
  } else {
    node_lidar_wedge_27.position.set(0.0, 1.9, 1.28);
    node_lidar_wedge_27.rotation.set(0.12, 0.0, 0.0);
  }
  node_lidar_wedge_27.userData.sculptComponent = {"id": "lidar-wedge", "name": "激光雷达楔形块", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.17, "height": 0.05, "depth": 0.32, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.9, 1.28], "rotation": [0.12, 0, 0], "scale": [0.17, 0.05, 0.32]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "前部楔形玻璃窗", "kind": "sensor-window", "note": "前倾斜面"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": ["d-lidar-wedge"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_lidar_wedge_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_lidar_wedge_27);
  nodes["lidar-wedge"] = node_lidar_wedge_27;
  const mesh_lidar_wedge_27Geometry = endpoint_lidar_wedge_27
    ? new THREE.CylinderGeometry(endpoint_lidar_wedge_27.endRadius, endpoint_lidar_wedge_27.baseRadius, endpoint_lidar_wedge_27.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_lidar_wedge_27) {
    mesh_lidar_wedge_27Geometry.scale(0.17, 0.05, 0.32);
  }
  const mesh_lidar_wedge_27 = new THREE.Mesh(
    mesh_lidar_wedge_27Geometry,
    materialMap["matte-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lidar_wedge_27.name = "\u6fc0\u5149\u96f7\u8fbe\u6954\u5f62\u5757";
  if (endpoint_lidar_wedge_27) {
    mesh_lidar_wedge_27.position.copy(endpoint_lidar_wedge_27.midpoint);
    mesh_lidar_wedge_27.quaternion.copy(endpoint_lidar_wedge_27.quaternion);
  }
  mesh_lidar_wedge_27.castShadow = options.castShadow ?? true;
  mesh_lidar_wedge_27.receiveShadow = options.receiveShadow ?? true;
  mesh_lidar_wedge_27.userData.sculptComponent = {"id": "lidar-wedge", "name": "激光雷达楔形块", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.17, "height": 0.05, "depth": 0.32, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.9, 1.28], "rotation": [0.12, 0, 0], "scale": [0.17, 0.05, 0.32]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "matte-black", "materialLayers": ["matte-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "前部楔形玻璃窗", "kind": "sensor-window", "note": "前倾斜面"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-intelligence"], "details": ["d-lidar-wedge"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_lidar_wedge_27.add(mesh_lidar_wedge_27);
  meshes["lidar-wedge"] = mesh_lidar_wedge_27;
  colliders["lidar-wedge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_lidar_wedge_27);

  const endpoint_wheel_fl_28 = makeAttachmentEndpoint(null);
  const node_wheel_fl_28 = new THREE.Group();
  node_wheel_fl_28.name = "\u8f66\u8f6e fl__pivot";
  node_wheel_fl_28.scale.set(1, 1, 1);
  if (endpoint_wheel_fl_28) {
    node_wheel_fl_28.position.copy(endpoint_wheel_fl_28.start);
    node_wheel_fl_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_fl_28.position.set(0.875, 0.382, 1.715);
    node_wheel_fl_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_fl_28.userData.sculptComponent = {"id": "wheel-fl", "name": "车轮 fl", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.875, 0.382, 1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fl_28.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_fl_28);
  nodes["wheel-fl"] = node_wheel_fl_28;
  const mesh_wheel_fl_28Geometry = endpoint_wheel_fl_28
    ? new THREE.CylinderGeometry(endpoint_wheel_fl_28.endRadius, endpoint_wheel_fl_28.baseRadius, endpoint_wheel_fl_28.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_wheel_fl_28) {
    mesh_wheel_fl_28Geometry.scale(0.255, 0.764, 0.764);
  }
  const mesh_wheel_fl_28 = new THREE.Mesh(
    mesh_wheel_fl_28Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_fl_28.name = "\u8f66\u8f6e fl";
  if (endpoint_wheel_fl_28) {
    mesh_wheel_fl_28.position.copy(endpoint_wheel_fl_28.midpoint);
    mesh_wheel_fl_28.quaternion.copy(endpoint_wheel_fl_28.quaternion);
  }
  mesh_wheel_fl_28.castShadow = options.castShadow ?? true;
  mesh_wheel_fl_28.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_fl_28.userData.sculptComponent = {"id": "wheel-fl", "name": "车轮 fl", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.875, 0.382, 1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fl_28.add(mesh_wheel_fl_28);
  meshes["wheel-fl"] = mesh_wheel_fl_28;
  colliders["wheel-fl"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_fl_28);

  const attachment_tire_fl_29 = {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002};
  const endpoint_tire_fl_29 = makeAttachmentEndpoint(attachment_tire_fl_29);
  const node_tire_fl_29 = new THREE.Group();
  node_tire_fl_29.name = "\u8f6e\u80ce fl__pivot";
  node_tire_fl_29.scale.set(1, 1, 1);
  if (endpoint_tire_fl_29) {
    node_tire_fl_29.position.copy(endpoint_tire_fl_29.start);
    node_tire_fl_29.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_tire_fl_29.position.set(0.0, 0.0, 0.0);
    node_tire_fl_29.rotation.set(0.0, 0.0, 1.5708);
  }
  node_tire_fl_29.userData.sculptComponent = {"id": "tire-fl", "name": "轮胎 fl", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fl", "attachment": {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_fl_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fl"] ?? root).add(node_tire_fl_29);
  nodes["tire-fl"] = node_tire_fl_29;
  const mesh_tire_fl_29Geometry = endpoint_tire_fl_29
    ? new THREE.CylinderGeometry(endpoint_tire_fl_29.endRadius, endpoint_tire_fl_29.baseRadius, endpoint_tire_fl_29.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_tire_fl_29) {
    mesh_tire_fl_29Geometry.scale(0.764, 0.255, 0.764);
  }
  const mesh_tire_fl_29 = new THREE.Mesh(
    mesh_tire_fl_29Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tire_fl_29.name = "\u8f6e\u80ce fl";
  if (endpoint_tire_fl_29) {
    mesh_tire_fl_29.position.copy(endpoint_tire_fl_29.midpoint);
    mesh_tire_fl_29.quaternion.copy(endpoint_tire_fl_29.quaternion);
  }
  mesh_tire_fl_29.castShadow = options.castShadow ?? true;
  mesh_tire_fl_29.receiveShadow = options.receiveShadow ?? true;
  mesh_tire_fl_29.userData.sculptComponent = {"id": "tire-fl", "name": "轮胎 fl", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fl", "attachment": {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_fl_29.add(mesh_tire_fl_29);
  meshes["tire-fl"] = mesh_tire_fl_29;
  colliders["tire-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tire_fl_29);

  const attachment_rim_fl_30 = {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002};
  const endpoint_rim_fl_30 = makeAttachmentEndpoint(attachment_rim_fl_30);
  const node_rim_fl_30 = new THREE.Group();
  node_rim_fl_30.name = "\u5927\u997c\u8f6e\u5708 fl__pivot";
  node_rim_fl_30.scale.set(1, 1, 1);
  if (endpoint_rim_fl_30) {
    node_rim_fl_30.position.copy(endpoint_rim_fl_30.start);
    node_rim_fl_30.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_rim_fl_30.position.set(0.0, 0.0, 0.012);
    node_rim_fl_30.rotation.set(0.0, 0.0, 1.5708);
  }
  node_rim_fl_30.userData.sculptComponent = {"id": "rim-fl", "name": "大饼轮圈 fl", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fl", "attachment": {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fl_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fl"] ?? root).add(node_rim_fl_30);
  nodes["rim-fl"] = node_rim_fl_30;
  const mesh_rim_fl_30Geometry = endpoint_rim_fl_30
    ? new THREE.CylinderGeometry(endpoint_rim_fl_30.endRadius, endpoint_rim_fl_30.baseRadius, endpoint_rim_fl_30.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rim_fl_30) {
    mesh_rim_fl_30Geometry.scale(0.6, 0.235, 0.6);
  }
  const mesh_rim_fl_30 = new THREE.Mesh(
    mesh_rim_fl_30Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_fl_30.name = "\u5927\u997c\u8f6e\u5708 fl";
  if (endpoint_rim_fl_30) {
    mesh_rim_fl_30.position.copy(endpoint_rim_fl_30.midpoint);
    mesh_rim_fl_30.quaternion.copy(endpoint_rim_fl_30.quaternion);
  }
  mesh_rim_fl_30.castShadow = options.castShadow ?? true;
  mesh_rim_fl_30.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_fl_30.userData.sculptComponent = {"id": "rim-fl", "name": "大饼轮圈 fl", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fl", "attachment": {"parentSocket": "wheel-fl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fl_30.add(mesh_rim_fl_30);
  meshes["rim-fl"] = mesh_rim_fl_30;
  colliders["rim-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_fl_30);

  const endpoint_wheel_fr_31 = makeAttachmentEndpoint(null);
  const node_wheel_fr_31 = new THREE.Group();
  node_wheel_fr_31.name = "\u8f66\u8f6e fr__pivot";
  node_wheel_fr_31.scale.set(1, 1, 1);
  if (endpoint_wheel_fr_31) {
    node_wheel_fr_31.position.copy(endpoint_wheel_fr_31.start);
    node_wheel_fr_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_fr_31.position.set(-0.875, 0.382, 1.715);
    node_wheel_fr_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_fr_31.userData.sculptComponent = {"id": "wheel-fr", "name": "车轮 fr", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.875, 0.382, 1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fr_31.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_fr_31);
  nodes["wheel-fr"] = node_wheel_fr_31;
  const mesh_wheel_fr_31Geometry = endpoint_wheel_fr_31
    ? new THREE.CylinderGeometry(endpoint_wheel_fr_31.endRadius, endpoint_wheel_fr_31.baseRadius, endpoint_wheel_fr_31.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_wheel_fr_31) {
    mesh_wheel_fr_31Geometry.scale(0.255, 0.764, 0.764);
  }
  const mesh_wheel_fr_31 = new THREE.Mesh(
    mesh_wheel_fr_31Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_fr_31.name = "\u8f66\u8f6e fr";
  if (endpoint_wheel_fr_31) {
    mesh_wheel_fr_31.position.copy(endpoint_wheel_fr_31.midpoint);
    mesh_wheel_fr_31.quaternion.copy(endpoint_wheel_fr_31.quaternion);
  }
  mesh_wheel_fr_31.castShadow = options.castShadow ?? true;
  mesh_wheel_fr_31.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_fr_31.userData.sculptComponent = {"id": "wheel-fr", "name": "车轮 fr", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.875, 0.382, 1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_fr_31.add(mesh_wheel_fr_31);
  meshes["wheel-fr"] = mesh_wheel_fr_31;
  colliders["wheel-fr"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_fr_31);

  const attachment_tire_fr_32 = {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002};
  const endpoint_tire_fr_32 = makeAttachmentEndpoint(attachment_tire_fr_32);
  const node_tire_fr_32 = new THREE.Group();
  node_tire_fr_32.name = "\u8f6e\u80ce fr__pivot";
  node_tire_fr_32.scale.set(1, 1, 1);
  if (endpoint_tire_fr_32) {
    node_tire_fr_32.position.copy(endpoint_tire_fr_32.start);
    node_tire_fr_32.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_tire_fr_32.position.set(0.0, 0.0, 0.0);
    node_tire_fr_32.rotation.set(0.0, 0.0, 1.5708);
  }
  node_tire_fr_32.userData.sculptComponent = {"id": "tire-fr", "name": "轮胎 fr", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fr", "attachment": {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_fr_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fr"] ?? root).add(node_tire_fr_32);
  nodes["tire-fr"] = node_tire_fr_32;
  const mesh_tire_fr_32Geometry = endpoint_tire_fr_32
    ? new THREE.CylinderGeometry(endpoint_tire_fr_32.endRadius, endpoint_tire_fr_32.baseRadius, endpoint_tire_fr_32.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_tire_fr_32) {
    mesh_tire_fr_32Geometry.scale(0.764, 0.255, 0.764);
  }
  const mesh_tire_fr_32 = new THREE.Mesh(
    mesh_tire_fr_32Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tire_fr_32.name = "\u8f6e\u80ce fr";
  if (endpoint_tire_fr_32) {
    mesh_tire_fr_32.position.copy(endpoint_tire_fr_32.midpoint);
    mesh_tire_fr_32.quaternion.copy(endpoint_tire_fr_32.quaternion);
  }
  mesh_tire_fr_32.castShadow = options.castShadow ?? true;
  mesh_tire_fr_32.receiveShadow = options.receiveShadow ?? true;
  mesh_tire_fr_32.userData.sculptComponent = {"id": "tire-fr", "name": "轮胎 fr", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fr", "attachment": {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_fr_32.add(mesh_tire_fr_32);
  meshes["tire-fr"] = mesh_tire_fr_32;
  colliders["tire-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tire_fr_32);

  const attachment_rim_fr_33 = {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002};
  const endpoint_rim_fr_33 = makeAttachmentEndpoint(attachment_rim_fr_33);
  const node_rim_fr_33 = new THREE.Group();
  node_rim_fr_33.name = "\u5927\u997c\u8f6e\u5708 fr__pivot";
  node_rim_fr_33.scale.set(1, 1, 1);
  if (endpoint_rim_fr_33) {
    node_rim_fr_33.position.copy(endpoint_rim_fr_33.start);
    node_rim_fr_33.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_rim_fr_33.position.set(0.0, 0.0, 0.012);
    node_rim_fr_33.rotation.set(0.0, 0.0, 1.5708);
  }
  node_rim_fr_33.userData.sculptComponent = {"id": "rim-fr", "name": "大饼轮圈 fr", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fr", "attachment": {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fr_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-fr"] ?? root).add(node_rim_fr_33);
  nodes["rim-fr"] = node_rim_fr_33;
  const mesh_rim_fr_33Geometry = endpoint_rim_fr_33
    ? new THREE.CylinderGeometry(endpoint_rim_fr_33.endRadius, endpoint_rim_fr_33.baseRadius, endpoint_rim_fr_33.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rim_fr_33) {
    mesh_rim_fr_33Geometry.scale(0.6, 0.235, 0.6);
  }
  const mesh_rim_fr_33 = new THREE.Mesh(
    mesh_rim_fr_33Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_fr_33.name = "\u5927\u997c\u8f6e\u5708 fr";
  if (endpoint_rim_fr_33) {
    mesh_rim_fr_33.position.copy(endpoint_rim_fr_33.midpoint);
    mesh_rim_fr_33.quaternion.copy(endpoint_rim_fr_33.quaternion);
  }
  mesh_rim_fr_33.castShadow = options.castShadow ?? true;
  mesh_rim_fr_33.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_fr_33.userData.sculptComponent = {"id": "rim-fr", "name": "大饼轮圈 fr", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-fr", "attachment": {"parentSocket": "wheel-fr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_fr_33.add(mesh_rim_fr_33);
  meshes["rim-fr"] = mesh_rim_fr_33;
  colliders["rim-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_fr_33);

  const endpoint_wheel_rl_34 = makeAttachmentEndpoint(null);
  const node_wheel_rl_34 = new THREE.Group();
  node_wheel_rl_34.name = "\u8f66\u8f6e rl__pivot";
  node_wheel_rl_34.scale.set(1, 1, 1);
  if (endpoint_wheel_rl_34) {
    node_wheel_rl_34.position.copy(endpoint_wheel_rl_34.start);
    node_wheel_rl_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rl_34.position.set(0.875, 0.382, -1.715);
    node_wheel_rl_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rl_34.userData.sculptComponent = {"id": "wheel-rl", "name": "车轮 rl", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.875, 0.382, -1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rl_34.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_rl_34);
  nodes["wheel-rl"] = node_wheel_rl_34;
  const mesh_wheel_rl_34Geometry = endpoint_wheel_rl_34
    ? new THREE.CylinderGeometry(endpoint_wheel_rl_34.endRadius, endpoint_wheel_rl_34.baseRadius, endpoint_wheel_rl_34.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_wheel_rl_34) {
    mesh_wheel_rl_34Geometry.scale(0.255, 0.764, 0.764);
  }
  const mesh_wheel_rl_34 = new THREE.Mesh(
    mesh_wheel_rl_34Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rl_34.name = "\u8f66\u8f6e rl";
  if (endpoint_wheel_rl_34) {
    mesh_wheel_rl_34.position.copy(endpoint_wheel_rl_34.midpoint);
    mesh_wheel_rl_34.quaternion.copy(endpoint_wheel_rl_34.quaternion);
  }
  mesh_wheel_rl_34.castShadow = options.castShadow ?? true;
  mesh_wheel_rl_34.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rl_34.userData.sculptComponent = {"id": "wheel-rl", "name": "车轮 rl", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.875, 0.382, -1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rl_34.add(mesh_wheel_rl_34);
  meshes["wheel-rl"] = mesh_wheel_rl_34;
  colliders["wheel-rl"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_rl_34);

  const attachment_tire_rl_35 = {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002};
  const endpoint_tire_rl_35 = makeAttachmentEndpoint(attachment_tire_rl_35);
  const node_tire_rl_35 = new THREE.Group();
  node_tire_rl_35.name = "\u8f6e\u80ce rl__pivot";
  node_tire_rl_35.scale.set(1, 1, 1);
  if (endpoint_tire_rl_35) {
    node_tire_rl_35.position.copy(endpoint_tire_rl_35.start);
    node_tire_rl_35.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_tire_rl_35.position.set(0.0, 0.0, 0.0);
    node_tire_rl_35.rotation.set(0.0, 0.0, 1.5708);
  }
  node_tire_rl_35.userData.sculptComponent = {"id": "tire-rl", "name": "轮胎 rl", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rl", "attachment": {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_rl_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rl"] ?? root).add(node_tire_rl_35);
  nodes["tire-rl"] = node_tire_rl_35;
  const mesh_tire_rl_35Geometry = endpoint_tire_rl_35
    ? new THREE.CylinderGeometry(endpoint_tire_rl_35.endRadius, endpoint_tire_rl_35.baseRadius, endpoint_tire_rl_35.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_tire_rl_35) {
    mesh_tire_rl_35Geometry.scale(0.764, 0.255, 0.764);
  }
  const mesh_tire_rl_35 = new THREE.Mesh(
    mesh_tire_rl_35Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tire_rl_35.name = "\u8f6e\u80ce rl";
  if (endpoint_tire_rl_35) {
    mesh_tire_rl_35.position.copy(endpoint_tire_rl_35.midpoint);
    mesh_tire_rl_35.quaternion.copy(endpoint_tire_rl_35.quaternion);
  }
  mesh_tire_rl_35.castShadow = options.castShadow ?? true;
  mesh_tire_rl_35.receiveShadow = options.receiveShadow ?? true;
  mesh_tire_rl_35.userData.sculptComponent = {"id": "tire-rl", "name": "轮胎 rl", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rl", "attachment": {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_rl_35.add(mesh_tire_rl_35);
  meshes["tire-rl"] = mesh_tire_rl_35;
  colliders["tire-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tire_rl_35);

  const attachment_rim_rl_36 = {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002};
  const endpoint_rim_rl_36 = makeAttachmentEndpoint(attachment_rim_rl_36);
  const node_rim_rl_36 = new THREE.Group();
  node_rim_rl_36.name = "\u5927\u997c\u8f6e\u5708 rl__pivot";
  node_rim_rl_36.scale.set(1, 1, 1);
  if (endpoint_rim_rl_36) {
    node_rim_rl_36.position.copy(endpoint_rim_rl_36.start);
    node_rim_rl_36.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_rim_rl_36.position.set(0.0, 0.0, 0.012);
    node_rim_rl_36.rotation.set(0.0, 0.0, 1.5708);
  }
  node_rim_rl_36.userData.sculptComponent = {"id": "rim-rl", "name": "大饼轮圈 rl", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rl", "attachment": {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rl_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rl"] ?? root).add(node_rim_rl_36);
  nodes["rim-rl"] = node_rim_rl_36;
  const mesh_rim_rl_36Geometry = endpoint_rim_rl_36
    ? new THREE.CylinderGeometry(endpoint_rim_rl_36.endRadius, endpoint_rim_rl_36.baseRadius, endpoint_rim_rl_36.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rim_rl_36) {
    mesh_rim_rl_36Geometry.scale(0.6, 0.235, 0.6);
  }
  const mesh_rim_rl_36 = new THREE.Mesh(
    mesh_rim_rl_36Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_rl_36.name = "\u5927\u997c\u8f6e\u5708 rl";
  if (endpoint_rim_rl_36) {
    mesh_rim_rl_36.position.copy(endpoint_rim_rl_36.midpoint);
    mesh_rim_rl_36.quaternion.copy(endpoint_rim_rl_36.quaternion);
  }
  mesh_rim_rl_36.castShadow = options.castShadow ?? true;
  mesh_rim_rl_36.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_rl_36.userData.sculptComponent = {"id": "rim-rl", "name": "大饼轮圈 rl", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rl", "attachment": {"parentSocket": "wheel-rl.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rl_36.add(mesh_rim_rl_36);
  meshes["rim-rl"] = mesh_rim_rl_36;
  colliders["rim-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_rl_36);

  const endpoint_wheel_rr_37 = makeAttachmentEndpoint(null);
  const node_wheel_rr_37 = new THREE.Group();
  node_wheel_rr_37.name = "\u8f66\u8f6e rr__pivot";
  node_wheel_rr_37.scale.set(1, 1, 1);
  if (endpoint_wheel_rr_37) {
    node_wheel_rr_37.position.copy(endpoint_wheel_rr_37.start);
    node_wheel_rr_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rr_37.position.set(-0.875, 0.382, -1.715);
    node_wheel_rr_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rr_37.userData.sculptComponent = {"id": "wheel-rr", "name": "车轮 rr", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.875, 0.382, -1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rr_37.userData.actionProfile = {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wheel_rr_37);
  nodes["wheel-rr"] = node_wheel_rr_37;
  const mesh_wheel_rr_37Geometry = endpoint_wheel_rr_37
    ? new THREE.CylinderGeometry(endpoint_wheel_rr_37.endRadius, endpoint_wheel_rr_37.baseRadius, endpoint_wheel_rr_37.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_wheel_rr_37) {
    mesh_wheel_rr_37Geometry.scale(0.255, 0.764, 0.764);
  }
  const mesh_wheel_rr_37 = new THREE.Mesh(
    mesh_wheel_rr_37Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rr_37.name = "\u8f66\u8f6e rr";
  if (endpoint_wheel_rr_37) {
    mesh_wheel_rr_37.position.copy(endpoint_wheel_rr_37.midpoint);
    mesh_wheel_rr_37.quaternion.copy(endpoint_wheel_rr_37.quaternion);
  }
  mesh_wheel_rr_37.castShadow = options.castShadow ?? true;
  mesh_wheel_rr_37.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rr_37.userData.sculptComponent = {"id": "wheel-rr", "name": "车轮 rr", "level": "macro", "role": "wheel", "importance": 0.95, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.255, "height": 0.764, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [-0.875, 0.382, -1.715], "rotation": [0, 0, 0], "scale": [0.255, 0.764, 0.764]}, "actionProfile": {"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black", "img-trunk"], "details": ["d-wheel-disc"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_wheel_rr_37.add(mesh_wheel_rr_37);
  meshes["wheel-rr"] = mesh_wheel_rr_37;
  colliders["wheel-rr"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": false, "notes": "旋转轴 X"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wheel_rr_37);

  const attachment_tire_rr_38 = {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002};
  const endpoint_tire_rr_38 = makeAttachmentEndpoint(attachment_tire_rr_38);
  const node_tire_rr_38 = new THREE.Group();
  node_tire_rr_38.name = "\u8f6e\u80ce rr__pivot";
  node_tire_rr_38.scale.set(1, 1, 1);
  if (endpoint_tire_rr_38) {
    node_tire_rr_38.position.copy(endpoint_tire_rr_38.start);
    node_tire_rr_38.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_tire_rr_38.position.set(0.0, 0.0, 0.0);
    node_tire_rr_38.rotation.set(0.0, 0.0, 1.5708);
  }
  node_tire_rr_38.userData.sculptComponent = {"id": "tire-rr", "name": "轮胎 rr", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rr", "attachment": {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_rr_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rr"] ?? root).add(node_tire_rr_38);
  nodes["tire-rr"] = node_tire_rr_38;
  const mesh_tire_rr_38Geometry = endpoint_tire_rr_38
    ? new THREE.CylinderGeometry(endpoint_tire_rr_38.endRadius, endpoint_tire_rr_38.baseRadius, endpoint_tire_rr_38.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_tire_rr_38) {
    mesh_tire_rr_38Geometry.scale(0.764, 0.255, 0.764);
  }
  const mesh_tire_rr_38 = new THREE.Mesh(
    mesh_tire_rr_38Geometry,
    materialMap["tire"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tire_rr_38.name = "\u8f6e\u80ce rr";
  if (endpoint_tire_rr_38) {
    mesh_tire_rr_38.position.copy(endpoint_tire_rr_38.midpoint);
    mesh_tire_rr_38.quaternion.copy(endpoint_tire_rr_38.quaternion);
  }
  mesh_tire_rr_38.castShadow = options.castShadow ?? true;
  mesh_tire_rr_38.receiveShadow = options.receiveShadow ?? true;
  mesh_tire_rr_38.userData.sculptComponent = {"id": "tire-rr", "name": "轮胎 rr", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rr", "attachment": {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, "dimensions": {"width": 0.764, "height": 0.255, "depth": 0.764, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.764, 0.255, 0.764]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "tire", "materialLayers": ["tire"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-design-black"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(20, 20, 20, 1.0)", "secondaryAlbedo": "rgba(20, 20, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9}};
  node_tire_rr_38.add(mesh_tire_rr_38);
  meshes["tire-rr"] = mesh_tire_rr_38;
  colliders["tire-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tire_rr_38);

  const attachment_rim_rr_39 = {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002};
  const endpoint_rim_rr_39 = makeAttachmentEndpoint(attachment_rim_rr_39);
  const node_rim_rr_39 = new THREE.Group();
  node_rim_rr_39.name = "\u5927\u997c\u8f6e\u5708 rr__pivot";
  node_rim_rr_39.scale.set(1, 1, 1);
  if (endpoint_rim_rr_39) {
    node_rim_rr_39.position.copy(endpoint_rim_rr_39.start);
    node_rim_rr_39.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_rim_rr_39.position.set(0.0, 0.0, 0.012);
    node_rim_rr_39.rotation.set(0.0, 0.0, 1.5708);
  }
  node_rim_rr_39.userData.sculptComponent = {"id": "rim-rr", "name": "大饼轮圈 rr", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rr", "attachment": {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rr_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-rr"] ?? root).add(node_rim_rr_39);
  nodes["rim-rr"] = node_rim_rr_39;
  const mesh_rim_rr_39Geometry = endpoint_rim_rr_39
    ? new THREE.CylinderGeometry(endpoint_rim_rr_39.endRadius, endpoint_rim_rr_39.baseRadius, endpoint_rim_rr_39.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rim_rr_39) {
    mesh_rim_rr_39Geometry.scale(0.6, 0.235, 0.6);
  }
  const mesh_rim_rr_39 = new THREE.Mesh(
    mesh_rim_rr_39Geometry,
    materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rim_rr_39.name = "\u5927\u997c\u8f6e\u5708 rr";
  if (endpoint_rim_rr_39) {
    mesh_rim_rr_39.position.copy(endpoint_rim_rr_39.midpoint);
    mesh_rim_rr_39.quaternion.copy(endpoint_rim_rr_39.quaternion);
  }
  mesh_rim_rr_39.castShadow = options.castShadow ?? true;
  mesh_rim_rr_39.receiveShadow = options.receiveShadow ?? true;
  mesh_rim_rr_39.userData.sculptComponent = {"id": "rim-rr", "name": "大饼轮圈 rr", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "cylinder 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wheel-rr", "attachment": {"parentSocket": "wheel-rr.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.6, "height": 0.235, "depth": 0.6, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 1.5708], "scale": [0.6, 0.235, 0.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wheel-alloy", "materialLayers": ["wheel-alloy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-trunk"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 202, 205, 1.0)", "secondaryAlbedo": "rgba(200, 202, 205, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_rim_rr_39.add(mesh_rim_rr_39);
  meshes["rim-rr"] = mesh_rim_rr_39;
  colliders["rim-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rim_rr_39);

  const endpoint_cabin_interior_40 = makeAttachmentEndpoint(null);
  const node_cabin_interior_40 = new THREE.Group();
  node_cabin_interior_40.name = "\u56db\u5ea7\u8c6a\u534e\u8231__pivot";
  node_cabin_interior_40.scale.set(1, 1, 1);
  if (endpoint_cabin_interior_40) {
    node_cabin_interior_40.position.copy(endpoint_cabin_interior_40.start);
    node_cabin_interior_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cabin_interior_40.position.set(0.0, 0.0, 0.0);
    node_cabin_interior_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_cabin_interior_40.userData.sculptComponent = {"id": "cabin-interior", "name": "四座豪华舱", "level": "macro", "role": "interior", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.72, "height": 1.5, "depth": 4.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.72, 1.5, 4.2]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "includeInterior 开关", "kind": "visibility-group", "note": "exterior 视角下可整体隐藏"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-cutaway"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_interior_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_cabin_interior_40);
  nodes["cabin-interior"] = node_cabin_interior_40;
  const mesh_cabin_interior_40Geometry = endpoint_cabin_interior_40
    ? new THREE.CylinderGeometry(endpoint_cabin_interior_40.endRadius, endpoint_cabin_interior_40.baseRadius, endpoint_cabin_interior_40.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_cabin_interior_40) {
    mesh_cabin_interior_40Geometry.scale(1.72, 1.5, 4.2);
  }
  const mesh_cabin_interior_40 = new THREE.Mesh(
    mesh_cabin_interior_40Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cabin_interior_40.name = "\u56db\u5ea7\u8c6a\u534e\u8231";
  if (endpoint_cabin_interior_40) {
    mesh_cabin_interior_40.position.copy(endpoint_cabin_interior_40.midpoint);
    mesh_cabin_interior_40.quaternion.copy(endpoint_cabin_interior_40.quaternion);
  }
  mesh_cabin_interior_40.castShadow = options.castShadow ?? true;
  mesh_cabin_interior_40.receiveShadow = options.receiveShadow ?? true;
  mesh_cabin_interior_40.userData.sculptComponent = {"id": "cabin-interior", "name": "四座豪华舱", "level": "macro", "role": "interior", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.72, "height": 1.5, "depth": 4.2, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.72, 1.5, 4.2]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "includeInterior 开关", "kind": "visibility-group", "note": "exterior 视角下可整体隐藏"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-cutaway"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_interior_40.add(mesh_cabin_interior_40);
  meshes["cabin-interior"] = mesh_cabin_interior_40;
  colliders["cabin-interior"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cabin_interior_40);

  const endpoint_cabin_floor_41 = makeAttachmentEndpoint(null);
  const node_cabin_floor_41 = new THREE.Group();
  node_cabin_floor_41.name = "\u5ea7\u8231\u5730\u677f+\u957f\u7ed2\u5730\u6bef__pivot";
  node_cabin_floor_41.scale.set(1, 1, 1);
  if (endpoint_cabin_floor_41) {
    node_cabin_floor_41.position.copy(endpoint_cabin_floor_41.start);
    node_cabin_floor_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cabin_floor_41.position.set(0.0, 0.3, -0.45);
    node_cabin_floor_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_cabin_floor_41.userData.sculptComponent = {"id": "cabin-floor", "name": "座舱地板+长绒地毯", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.66, "height": 0.035, "depth": 3.6, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.3, -0.45], "rotation": [0, 0, 0], "scale": [1.66, 0.035, 3.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "carpet", "materialLayers": ["carpet"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-rearseat"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 90, 48, 1.0)", "secondaryAlbedo": "rgba(138, 90, 48, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_floor_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_cabin_floor_41);
  nodes["cabin-floor"] = node_cabin_floor_41;
  const mesh_cabin_floor_41Geometry = endpoint_cabin_floor_41
    ? new THREE.CylinderGeometry(endpoint_cabin_floor_41.endRadius, endpoint_cabin_floor_41.baseRadius, endpoint_cabin_floor_41.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_cabin_floor_41) {
    mesh_cabin_floor_41Geometry.scale(1.66, 0.035, 3.6);
  }
  const mesh_cabin_floor_41 = new THREE.Mesh(
    mesh_cabin_floor_41Geometry,
    materialMap["carpet"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cabin_floor_41.name = "\u5ea7\u8231\u5730\u677f+\u957f\u7ed2\u5730\u6bef";
  if (endpoint_cabin_floor_41) {
    mesh_cabin_floor_41.position.copy(endpoint_cabin_floor_41.midpoint);
    mesh_cabin_floor_41.quaternion.copy(endpoint_cabin_floor_41.quaternion);
  }
  mesh_cabin_floor_41.castShadow = options.castShadow ?? true;
  mesh_cabin_floor_41.receiveShadow = options.receiveShadow ?? true;
  mesh_cabin_floor_41.userData.sculptComponent = {"id": "cabin-floor", "name": "座舱地板+长绒地毯", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.66, "height": 0.035, "depth": 3.6, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.3, -0.45], "rotation": [0, 0, 0], "scale": [1.66, 0.035, 3.6]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "carpet", "materialLayers": ["carpet"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-rearseat"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 90, 48, 1.0)", "secondaryAlbedo": "rgba(138, 90, 48, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_cabin_floor_41.add(mesh_cabin_floor_41);
  meshes["cabin-floor"] = mesh_cabin_floor_41;
  colliders["cabin-floor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cabin_floor_41);

  const endpoint_dash_upper_42 = makeAttachmentEndpoint(null);
  const node_dash_upper_42 = new THREE.Group();
  node_dash_upper_42.name = "\u4eea\u8868\u53f0\u4e0a\u5c42\uff08\u6df1\u68d5\u76ae\u9769\uff09__pivot";
  node_dash_upper_42.scale.set(1, 1, 1);
  if (endpoint_dash_upper_42) {
    node_dash_upper_42.position.copy(endpoint_dash_upper_42.start);
    node_dash_upper_42.rotation.set(-0.06, 0.0, 0.0);
  } else {
    node_dash_upper_42.position.set(0.0, 1.0, 1.3);
    node_dash_upper_42.rotation.set(-0.06, 0.0, 0.0);
  }
  node_dash_upper_42.userData.sculptComponent = {"id": "dash-upper", "name": "仪表台上层（深棕皮革）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.17, "depth": 0.46, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.0, 1.3], "rotation": [-0.06, 0, 0], "scale": [1.78, 0.17, 0.46]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 52, 42, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_upper_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_upper_42);
  nodes["dash-upper"] = node_dash_upper_42;
  const mesh_dash_upper_42Geometry = endpoint_dash_upper_42
    ? new THREE.CylinderGeometry(endpoint_dash_upper_42.endRadius, endpoint_dash_upper_42.baseRadius, endpoint_dash_upper_42.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_dash_upper_42) {
    mesh_dash_upper_42Geometry.scale(1.78, 0.17, 0.46);
  }
  const mesh_dash_upper_42 = new THREE.Mesh(
    mesh_dash_upper_42Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_upper_42.name = "\u4eea\u8868\u53f0\u4e0a\u5c42\uff08\u6df1\u68d5\u76ae\u9769\uff09";
  if (endpoint_dash_upper_42) {
    mesh_dash_upper_42.position.copy(endpoint_dash_upper_42.midpoint);
    mesh_dash_upper_42.quaternion.copy(endpoint_dash_upper_42.quaternion);
  }
  mesh_dash_upper_42.castShadow = options.castShadow ?? true;
  mesh_dash_upper_42.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_upper_42.userData.sculptComponent = {"id": "dash-upper", "name": "仪表台上层（深棕皮革）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.17, "depth": 0.46, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.0, 1.3], "rotation": [-0.06, 0, 0], "scale": [1.78, 0.17, 0.46]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 52, 42, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_upper_42.add(mesh_dash_upper_42);
  meshes["dash-upper"] = mesh_dash_upper_42;
  colliders["dash-upper"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_upper_42);

  const endpoint_dash_lower_43 = makeAttachmentEndpoint(null);
  const node_dash_lower_43 = new THREE.Group();
  node_dash_lower_43.name = "\u4eea\u8868\u53f0\u4e0b\u4f53\uff08\u7c73\u767d\uff09__pivot";
  node_dash_lower_43.scale.set(1, 1, 1);
  if (endpoint_dash_lower_43) {
    node_dash_lower_43.position.copy(endpoint_dash_lower_43.start);
    node_dash_lower_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dash_lower_43.position.set(0.0, 0.8, 1.4);
    node_dash_lower_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_dash_lower_43.userData.sculptComponent = {"id": "dash-lower", "name": "仪表台下体（米白）", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.26, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.8, 1.4], "rotation": [0, 0, 0], "scale": [1.78, 0.26, 0.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 208, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_lower_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_dash_lower_43);
  nodes["dash-lower"] = node_dash_lower_43;
  const mesh_dash_lower_43Geometry = endpoint_dash_lower_43
    ? new THREE.CylinderGeometry(endpoint_dash_lower_43.endRadius, endpoint_dash_lower_43.baseRadius, endpoint_dash_lower_43.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_dash_lower_43) {
    mesh_dash_lower_43Geometry.scale(1.78, 0.26, 0.3);
  }
  const mesh_dash_lower_43 = new THREE.Mesh(
    mesh_dash_lower_43Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dash_lower_43.name = "\u4eea\u8868\u53f0\u4e0b\u4f53\uff08\u7c73\u767d\uff09";
  if (endpoint_dash_lower_43) {
    mesh_dash_lower_43.position.copy(endpoint_dash_lower_43.midpoint);
    mesh_dash_lower_43.quaternion.copy(endpoint_dash_lower_43.quaternion);
  }
  mesh_dash_lower_43.castShadow = options.castShadow ?? true;
  mesh_dash_lower_43.receiveShadow = options.receiveShadow ?? true;
  mesh_dash_lower_43.userData.sculptComponent = {"id": "dash-lower", "name": "仪表台下体（米白）", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.78, "height": 0.26, "depth": 0.3, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.8, 1.4], "rotation": [0, 0, 0], "scale": [1.78, 0.26, 0.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 208, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_dash_lower_43.add(mesh_dash_lower_43);
  meshes["dash-lower"] = mesh_dash_lower_43;
  colliders["dash-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dash_lower_43);

  const endpoint_tri_screen_44 = makeAttachmentEndpoint(null);
  const node_tri_screen_44 = new THREE.Group();
  node_tri_screen_44.name = "\u8d2f\u7a7f\u4e09\u8054\u5c4f__pivot";
  node_tri_screen_44.scale.set(1, 1, 1);
  if (endpoint_tri_screen_44) {
    node_tri_screen_44.position.copy(endpoint_tri_screen_44.start);
    node_tri_screen_44.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_tri_screen_44.position.set(0.0, 1.12, 1.14);
    node_tri_screen_44.rotation.set(-0.1, 0.0, 0.0);
  }
  node_tri_screen_44.userData.sculptComponent = {"id": "tri-screen", "name": "贯穿三联屏", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.46, "height": 0.315, "depth": 0.006, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.12, 1.14], "rotation": [-0.1, 0, 0], "scale": [1.46, 0.315, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "HarmonyOS 风 UI 贴图", "kind": "screen", "note": "大时钟+卡片应用；仪表段独立动态 Canvas"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-triscreen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tri_screen_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_tri_screen_44);
  nodes["tri-screen"] = node_tri_screen_44;
  const mesh_tri_screen_44Geometry = endpoint_tri_screen_44
    ? new THREE.CylinderGeometry(endpoint_tri_screen_44.endRadius, endpoint_tri_screen_44.baseRadius, endpoint_tri_screen_44.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_tri_screen_44) {
    mesh_tri_screen_44Geometry.scale(1.46, 0.315, 0.006);
  }
  const mesh_tri_screen_44 = new THREE.Mesh(
    mesh_tri_screen_44Geometry,
    materialMap["screen-ui"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tri_screen_44.name = "\u8d2f\u7a7f\u4e09\u8054\u5c4f";
  if (endpoint_tri_screen_44) {
    mesh_tri_screen_44.position.copy(endpoint_tri_screen_44.midpoint);
    mesh_tri_screen_44.quaternion.copy(endpoint_tri_screen_44.quaternion);
  }
  mesh_tri_screen_44.castShadow = options.castShadow ?? true;
  mesh_tri_screen_44.receiveShadow = options.receiveShadow ?? true;
  mesh_tri_screen_44.userData.sculptComponent = {"id": "tri-screen", "name": "贯穿三联屏", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.46, "height": 0.315, "depth": 0.006, "units": "meters", "confidence": 0.95}, "transform": {"position": [0, 1.12, 1.14], "rotation": [-0.1, 0, 0], "scale": [1.46, 0.315, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "screen-ui", "materialLayers": ["screen-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "HarmonyOS 风 UI 贴图", "kind": "screen", "note": "大时钟+卡片应用；仪表段独立动态 Canvas"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-triscreen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 12, 16, 1.0)", "secondaryAlbedo": "rgba(10, 12, 16, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_tri_screen_44.add(mesh_tri_screen_44);
  meshes["tri-screen"] = mesh_tri_screen_44;
  colliders["tri-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tri_screen_44);

  const endpoint_gauge_screen_45 = makeAttachmentEndpoint(null);
  const node_gauge_screen_45 = new THREE.Group();
  node_gauge_screen_45.name = "\u60ac\u6d6e\u4eea\u8868\u5c4f__pivot";
  node_gauge_screen_45.scale.set(1, 1, 1);
  if (endpoint_gauge_screen_45) {
    node_gauge_screen_45.position.copy(endpoint_gauge_screen_45.start);
    node_gauge_screen_45.rotation.set(-0.14, 0.0, 0.0);
  } else {
    node_gauge_screen_45.position.set(0.72, 1.14, 1.06);
    node_gauge_screen_45.rotation.set(-0.14, 0.0, 0.0);
  }
  node_gauge_screen_45.userData.sculptComponent = {"id": "gauge-screen", "name": "悬浮仪表屏", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.38, "height": 0.2, "depth": 0.005, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.72, 1.14, 1.06], "rotation": [-0.14, 0, 0], "scale": [0.38, 0.2, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "gauge-ui", "materialLayers": ["gauge-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "动态仪表（速度/踏板力/G值）", "kind": "dynamic-canvas", "note": "集成层每帧刷新"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-triscreen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(6, 10, 8, 1.0)", "secondaryAlbedo": "rgba(6, 10, 8, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_gauge_screen_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_gauge_screen_45);
  nodes["gauge-screen"] = node_gauge_screen_45;
  const mesh_gauge_screen_45Geometry = endpoint_gauge_screen_45
    ? new THREE.CylinderGeometry(endpoint_gauge_screen_45.endRadius, endpoint_gauge_screen_45.baseRadius, endpoint_gauge_screen_45.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_gauge_screen_45) {
    mesh_gauge_screen_45Geometry.scale(0.38, 0.2, 0.005);
  }
  const mesh_gauge_screen_45 = new THREE.Mesh(
    mesh_gauge_screen_45Geometry,
    materialMap["gauge-ui"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gauge_screen_45.name = "\u60ac\u6d6e\u4eea\u8868\u5c4f";
  if (endpoint_gauge_screen_45) {
    mesh_gauge_screen_45.position.copy(endpoint_gauge_screen_45.midpoint);
    mesh_gauge_screen_45.quaternion.copy(endpoint_gauge_screen_45.quaternion);
  }
  mesh_gauge_screen_45.castShadow = options.castShadow ?? true;
  mesh_gauge_screen_45.receiveShadow = options.receiveShadow ?? true;
  mesh_gauge_screen_45.userData.sculptComponent = {"id": "gauge-screen", "name": "悬浮仪表屏", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.38, "height": 0.2, "depth": 0.005, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.72, 1.14, 1.06], "rotation": [-0.14, 0, 0], "scale": [0.38, 0.2, 0.005]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "gauge-ui", "materialLayers": ["gauge-ui"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "动态仪表（速度/踏板力/G值）", "kind": "dynamic-canvas", "note": "集成层每帧刷新"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-triscreen"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(6, 10, 8, 1.0)", "secondaryAlbedo": "rgba(6, 10, 8, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9}};
  node_gauge_screen_45.add(mesh_gauge_screen_45);
  meshes["gauge-screen"] = mesh_gauge_screen_45;
  colliders["gauge-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_gauge_screen_45);

  const endpoint_vents_strip_46 = makeAttachmentEndpoint(null);
  const node_vents_strip_46 = new THREE.Group();
  node_vents_strip_46.name = "\u6a2a\u8d2f\u51fa\u98ce\u53e3__pivot";
  node_vents_strip_46.scale.set(1, 1, 1);
  if (endpoint_vents_strip_46) {
    node_vents_strip_46.position.copy(endpoint_vents_strip_46.start);
    node_vents_strip_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vents_strip_46.position.set(0.0, 0.86, 1.13);
    node_vents_strip_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_vents_strip_46.userData.sculptComponent = {"id": "vents-strip", "name": "横贯出风口", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.62, "height": 0.05, "depth": 0.035, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.86, 1.13], "rotation": [0, 0, 0], "scale": [1.62, 0.05, 0.035]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_vents_strip_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_vents_strip_46);
  nodes["vents-strip"] = node_vents_strip_46;
  const mesh_vents_strip_46Geometry = endpoint_vents_strip_46
    ? new THREE.CylinderGeometry(endpoint_vents_strip_46.endRadius, endpoint_vents_strip_46.baseRadius, endpoint_vents_strip_46.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_vents_strip_46) {
    mesh_vents_strip_46Geometry.scale(1.62, 0.05, 0.035);
  }
  const mesh_vents_strip_46 = new THREE.Mesh(
    mesh_vents_strip_46Geometry,
    materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vents_strip_46.name = "\u6a2a\u8d2f\u51fa\u98ce\u53e3";
  if (endpoint_vents_strip_46) {
    mesh_vents_strip_46.position.copy(endpoint_vents_strip_46.midpoint);
    mesh_vents_strip_46.quaternion.copy(endpoint_vents_strip_46.quaternion);
  }
  mesh_vents_strip_46.castShadow = options.castShadow ?? true;
  mesh_vents_strip_46.receiveShadow = options.receiveShadow ?? true;
  mesh_vents_strip_46.userData.sculptComponent = {"id": "vents-strip", "name": "横贯出风口", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.62, "height": 0.05, "depth": 0.035, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0.86, 1.13], "rotation": [0, 0, 0], "scale": [1.62, 0.05, 0.035]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "chrome", "materialLayers": ["chrome"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 236, 1.0)", "secondaryAlbedo": "rgba(232, 233, 236, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9}};
  node_vents_strip_46.add(mesh_vents_strip_46);
  meshes["vents-strip"] = mesh_vents_strip_46;
  colliders["vents-strip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vents_strip_46);

  const endpoint_steering_47 = makeAttachmentEndpoint(null);
  const node_steering_47 = new THREE.Group();
  node_steering_47.name = "\u4e09\u8f90\u53cc\u8272\u65b9\u5411\u76d8__pivot";
  node_steering_47.scale.set(1, 1, 1);
  if (endpoint_steering_47) {
    node_steering_47.position.copy(endpoint_steering_47.start);
    node_steering_47.rotation.set(1.15, 0.0, 0.0);
  } else {
    node_steering_47.position.set(0.54, 0.96, 0.96);
    node_steering_47.rotation.set(1.15, 0.0, 0.0);
  }
  node_steering_47.userData.sculptComponent = {"id": "steering", "name": "三辐双色方向盘", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "torus 适合该部件的可展拓扑", "geometryDescriptor": {"torusTubeRatio": 0.09}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.05, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.54, 0.96, 0.96], "rotation": [1.15, 0, 0], "scale": [0.4, 0.4, 0.05]}, "actionProfile": {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "集成层随转向微转"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "车削木外圈+米白内圈", "kind": "two-tone-rim", "note": "外圈红棕木纹高光泽，内圈米白真皮"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-steering-dualtone"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_steering_47.userData.actionProfile = {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "集成层随转向微转"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_steering_47);
  nodes["steering"] = node_steering_47;
  const mesh_steering_47Geometry = endpoint_steering_47
    ? new THREE.CylinderGeometry(endpoint_steering_47.endRadius, endpoint_steering_47.baseRadius, endpoint_steering_47.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0405, 12, 48);
  if (!endpoint_steering_47) {
    mesh_steering_47Geometry.scale(0.4, 0.4, 0.05);
  }
  const mesh_steering_47 = new THREE.Mesh(
    mesh_steering_47Geometry,
    materialMap["wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_steering_47.name = "\u4e09\u8f90\u53cc\u8272\u65b9\u5411\u76d8";
  if (endpoint_steering_47) {
    mesh_steering_47.position.copy(endpoint_steering_47.midpoint);
    mesh_steering_47.quaternion.copy(endpoint_steering_47.quaternion);
  }
  mesh_steering_47.castShadow = options.castShadow ?? true;
  mesh_steering_47.receiveShadow = options.receiveShadow ?? true;
  mesh_steering_47.userData.sculptComponent = {"id": "steering", "name": "三辐双色方向盘", "level": "meso", "role": "detail", "importance": 0.95, "confidence": 0.95, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "torus 适合该部件的可展拓扑", "geometryDescriptor": {"torusTubeRatio": 0.09}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.05, "units": "meters", "confidence": 0.95}, "transform": {"position": [0.54, 0.96, 0.96], "rotation": [1.15, 0, 0], "scale": [0.4, 0.4, 0.05]}, "actionProfile": {"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": false, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "集成层随转向微转"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "车削木外圈+米白内圈", "kind": "two-tone-rim", "note": "外圈红棕木纹高光泽，内圈米白真皮"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-steering-dualtone"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_steering_47.add(mesh_steering_47);
  meshes["steering"] = mesh_steering_47;
  colliders["steering"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "集成层随转向微转"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_steering_47);

  const endpoint_tunnel_front_48 = makeAttachmentEndpoint(null);
  const node_tunnel_front_48 = new THREE.Group();
  node_tunnel_front_48.name = "\u4e2d\u63a7 T \u533a\uff08\u6728\u7eb9\u5ea7\uff09__pivot";
  node_tunnel_front_48.scale.set(1, 1, 1);
  if (endpoint_tunnel_front_48) {
    node_tunnel_front_48.position.copy(endpoint_tunnel_front_48.start);
    node_tunnel_front_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tunnel_front_48.position.set(0.0, 0.62, 1.02);
    node_tunnel_front_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_tunnel_front_48.userData.sculptComponent = {"id": "tunnel-front", "name": "中控 T 区（木纹座）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.42, "height": 0.34, "depth": 0.8, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.62, 1.02], "rotation": [0, 0, 0], "scale": [0.42, 0.34, 0.8]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-crystal-shift"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_tunnel_front_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_tunnel_front_48);
  nodes["tunnel-front"] = node_tunnel_front_48;
  const mesh_tunnel_front_48Geometry = endpoint_tunnel_front_48
    ? new THREE.CylinderGeometry(endpoint_tunnel_front_48.endRadius, endpoint_tunnel_front_48.baseRadius, endpoint_tunnel_front_48.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tunnel_front_48) {
    mesh_tunnel_front_48Geometry.scale(0.42, 0.34, 0.8);
  }
  const mesh_tunnel_front_48 = new THREE.Mesh(
    mesh_tunnel_front_48Geometry,
    materialMap["wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tunnel_front_48.name = "\u4e2d\u63a7 T \u533a\uff08\u6728\u7eb9\u5ea7\uff09";
  if (endpoint_tunnel_front_48) {
    mesh_tunnel_front_48.position.copy(endpoint_tunnel_front_48.midpoint);
    mesh_tunnel_front_48.quaternion.copy(endpoint_tunnel_front_48.quaternion);
  }
  mesh_tunnel_front_48.castShadow = options.castShadow ?? true;
  mesh_tunnel_front_48.receiveShadow = options.receiveShadow ?? true;
  mesh_tunnel_front_48.userData.sculptComponent = {"id": "tunnel-front", "name": "中控 T 区（木纹座）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.42, "height": 0.34, "depth": 0.8, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.62, 1.02], "rotation": [0, 0, 0], "scale": [0.42, 0.34, 0.8]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-popup1"], "details": ["d-crystal-shift"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_tunnel_front_48.add(mesh_tunnel_front_48);
  meshes["tunnel-front"] = mesh_tunnel_front_48;
  colliders["tunnel-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tunnel_front_48);

  const endpoint_tunnel_rear_49 = makeAttachmentEndpoint(null);
  const node_tunnel_rear_49 = new THREE.Group();
  node_tunnel_rear_49.name = "L \u578b\u4e2d\u5c9b\u5ef6\u4f38\u6bb5__pivot";
  node_tunnel_rear_49.scale.set(1, 1, 1);
  if (endpoint_tunnel_rear_49) {
    node_tunnel_rear_49.position.copy(endpoint_tunnel_rear_49.start);
    node_tunnel_rear_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tunnel_rear_49.position.set(0.0, 0.62, -0.55);
    node_tunnel_rear_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_tunnel_rear_49.userData.sculptComponent = {"id": "tunnel-rear", "name": "L 型中岛延伸段", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.44, "height": 0.36, "depth": 1.3, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.62, -0.55], "rotation": [0, 0, 0], "scale": [0.44, 0.36, 1.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "延伸至后排", "kind": "structure", "note": "贯穿前后排的中岛"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-cutaway"], "details": ["d-crystal-shift"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_tunnel_rear_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_tunnel_rear_49);
  nodes["tunnel-rear"] = node_tunnel_rear_49;
  const mesh_tunnel_rear_49Geometry = endpoint_tunnel_rear_49
    ? new THREE.CylinderGeometry(endpoint_tunnel_rear_49.endRadius, endpoint_tunnel_rear_49.baseRadius, endpoint_tunnel_rear_49.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_tunnel_rear_49) {
    mesh_tunnel_rear_49Geometry.scale(0.44, 0.36, 1.3);
  }
  const mesh_tunnel_rear_49 = new THREE.Mesh(
    mesh_tunnel_rear_49Geometry,
    materialMap["wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tunnel_rear_49.name = "L \u578b\u4e2d\u5c9b\u5ef6\u4f38\u6bb5";
  if (endpoint_tunnel_rear_49) {
    mesh_tunnel_rear_49.position.copy(endpoint_tunnel_rear_49.midpoint);
    mesh_tunnel_rear_49.quaternion.copy(endpoint_tunnel_rear_49.quaternion);
  }
  mesh_tunnel_rear_49.castShadow = options.castShadow ?? true;
  mesh_tunnel_rear_49.receiveShadow = options.receiveShadow ?? true;
  mesh_tunnel_rear_49.userData.sculptComponent = {"id": "tunnel-rear", "name": "L 型中岛延伸段", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.44, "height": 0.36, "depth": 1.3, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.62, -0.55], "rotation": [0, 0, 0], "scale": [0.44, 0.36, 1.3]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "wood", "materialLayers": ["wood"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "延伸至后排", "kind": "structure", "note": "贯穿前后排的中岛"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-cutaway"], "details": ["d-crystal-shift"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 52, 24, 1.0)", "secondaryAlbedo": "rgba(138, 74, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9}};
  node_tunnel_rear_49.add(mesh_tunnel_rear_49);
  meshes["tunnel-rear"] = mesh_tunnel_rear_49;
  colliders["tunnel-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tunnel_rear_49);

  const endpoint_seat_driver_50 = makeAttachmentEndpoint(null);
  const node_seat_driver_50 = new THREE.Group();
  node_seat_driver_50.name = "\u9a7e\u9a76\u4f4d__pivot";
  node_seat_driver_50.scale.set(1, 1, 1);
  if (endpoint_seat_driver_50) {
    node_seat_driver_50.position.copy(endpoint_seat_driver_50.start);
    node_seat_driver_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_driver_50.position.set(0.52, 0.62, 0.92);
    node_seat_driver_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_driver_50.userData.sculptComponent = {"id": "seat-driver", "name": "驾驶位", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.52, "height": 0.14, "depth": 0.5, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.52, 0.62, 0.92], "rotation": [0, 0, 0], "scale": [0.52, 0.14, 0.5]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_driver_50);
  nodes["seat-driver"] = node_seat_driver_50;
  const mesh_seat_driver_50Geometry = endpoint_seat_driver_50
    ? new THREE.CylinderGeometry(endpoint_seat_driver_50.endRadius, endpoint_seat_driver_50.baseRadius, endpoint_seat_driver_50.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_driver_50) {
    mesh_seat_driver_50Geometry.scale(0.52, 0.14, 0.5);
  }
  const mesh_seat_driver_50 = new THREE.Mesh(
    mesh_seat_driver_50Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_driver_50.name = "\u9a7e\u9a76\u4f4d";
  if (endpoint_seat_driver_50) {
    mesh_seat_driver_50.position.copy(endpoint_seat_driver_50.midpoint);
    mesh_seat_driver_50.quaternion.copy(endpoint_seat_driver_50.quaternion);
  }
  mesh_seat_driver_50.castShadow = options.castShadow ?? true;
  mesh_seat_driver_50.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_driver_50.userData.sculptComponent = {"id": "seat-driver", "name": "驾驶位", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.52, "height": 0.14, "depth": 0.5, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.52, 0.62, 0.92], "rotation": [0, 0, 0], "scale": [0.52, 0.14, 0.5]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_50.add(mesh_seat_driver_50);
  meshes["seat-driver"] = mesh_seat_driver_50;
  colliders["seat-driver"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_driver_50);

  const endpoint_seat_driver_back_51 = makeAttachmentEndpoint(null);
  const node_seat_driver_back_51 = new THREE.Group();
  node_seat_driver_back_51.name = "\u9a7e\u9a76\u4f4d\u00b7\u9760\u80cc__pivot";
  node_seat_driver_back_51.scale.set(1, 1, 1);
  if (endpoint_seat_driver_back_51) {
    node_seat_driver_back_51.position.copy(endpoint_seat_driver_back_51.start);
    node_seat_driver_back_51.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_seat_driver_back_51.position.set(0.0, 0.36, 0.22);
    node_seat_driver_back_51.rotation.set(-0.1, 0.0, 0.0);
  }
  node_seat_driver_back_51.userData.sculptComponent = {"id": "seat-driver-back", "name": "驾驶位·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-driver", "attachment": {"parentSocket": "seat-driver.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.5, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.22], "rotation": [-0.1, 0, 0], "scale": [0.5, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_back_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["seat-driver"] ?? root).add(node_seat_driver_back_51);
  nodes["seat-driver-back"] = node_seat_driver_back_51;
  const mesh_seat_driver_back_51Geometry = endpoint_seat_driver_back_51
    ? new THREE.CylinderGeometry(endpoint_seat_driver_back_51.endRadius, endpoint_seat_driver_back_51.baseRadius, endpoint_seat_driver_back_51.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_driver_back_51) {
    mesh_seat_driver_back_51Geometry.scale(0.5, 0.66, 0.14);
  }
  const mesh_seat_driver_back_51 = new THREE.Mesh(
    mesh_seat_driver_back_51Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_driver_back_51.name = "\u9a7e\u9a76\u4f4d\u00b7\u9760\u80cc";
  if (endpoint_seat_driver_back_51) {
    mesh_seat_driver_back_51.position.copy(endpoint_seat_driver_back_51.midpoint);
    mesh_seat_driver_back_51.quaternion.copy(endpoint_seat_driver_back_51.quaternion);
  }
  mesh_seat_driver_back_51.castShadow = options.castShadow ?? true;
  mesh_seat_driver_back_51.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_driver_back_51.userData.sculptComponent = {"id": "seat-driver-back", "name": "驾驶位·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-driver", "attachment": {"parentSocket": "seat-driver.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.5, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.22], "rotation": [-0.1, 0, 0], "scale": [0.5, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_driver_back_51.add(mesh_seat_driver_back_51);
  meshes["seat-driver-back"] = mesh_seat_driver_back_51;
  colliders["seat-driver-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_driver_back_51);

  const endpoint_seat_passenger_52 = makeAttachmentEndpoint(null);
  const node_seat_passenger_52 = new THREE.Group();
  node_seat_passenger_52.name = "\u526f\u9a7e\u4f4d__pivot";
  node_seat_passenger_52.scale.set(1, 1, 1);
  if (endpoint_seat_passenger_52) {
    node_seat_passenger_52.position.copy(endpoint_seat_passenger_52.start);
    node_seat_passenger_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_passenger_52.position.set(-0.52, 0.62, 0.92);
    node_seat_passenger_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_passenger_52.userData.sculptComponent = {"id": "seat-passenger", "name": "副驾位", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.52, "height": 0.14, "depth": 0.5, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.52, 0.62, 0.92], "rotation": [0, 0, 0], "scale": [0.52, 0.14, 0.5]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_passenger_52);
  nodes["seat-passenger"] = node_seat_passenger_52;
  const mesh_seat_passenger_52Geometry = endpoint_seat_passenger_52
    ? new THREE.CylinderGeometry(endpoint_seat_passenger_52.endRadius, endpoint_seat_passenger_52.baseRadius, endpoint_seat_passenger_52.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_passenger_52) {
    mesh_seat_passenger_52Geometry.scale(0.52, 0.14, 0.5);
  }
  const mesh_seat_passenger_52 = new THREE.Mesh(
    mesh_seat_passenger_52Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_passenger_52.name = "\u526f\u9a7e\u4f4d";
  if (endpoint_seat_passenger_52) {
    mesh_seat_passenger_52.position.copy(endpoint_seat_passenger_52.midpoint);
    mesh_seat_passenger_52.quaternion.copy(endpoint_seat_passenger_52.quaternion);
  }
  mesh_seat_passenger_52.castShadow = options.castShadow ?? true;
  mesh_seat_passenger_52.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_passenger_52.userData.sculptComponent = {"id": "seat-passenger", "name": "副驾位", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.52, "height": 0.14, "depth": 0.5, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.52, 0.62, 0.92], "rotation": [0, 0, 0], "scale": [0.52, 0.14, 0.5]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_52.add(mesh_seat_passenger_52);
  meshes["seat-passenger"] = mesh_seat_passenger_52;
  colliders["seat-passenger"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_passenger_52);

  const endpoint_seat_passenger_back_53 = makeAttachmentEndpoint(null);
  const node_seat_passenger_back_53 = new THREE.Group();
  node_seat_passenger_back_53.name = "\u526f\u9a7e\u4f4d\u00b7\u9760\u80cc__pivot";
  node_seat_passenger_back_53.scale.set(1, 1, 1);
  if (endpoint_seat_passenger_back_53) {
    node_seat_passenger_back_53.position.copy(endpoint_seat_passenger_back_53.start);
    node_seat_passenger_back_53.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_seat_passenger_back_53.position.set(0.0, 0.36, 0.22);
    node_seat_passenger_back_53.rotation.set(-0.1, 0.0, 0.0);
  }
  node_seat_passenger_back_53.userData.sculptComponent = {"id": "seat-passenger-back", "name": "副驾位·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-passenger", "attachment": {"parentSocket": "seat-passenger.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.5, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.22], "rotation": [-0.1, 0, 0], "scale": [0.5, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_back_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["seat-passenger"] ?? root).add(node_seat_passenger_back_53);
  nodes["seat-passenger-back"] = node_seat_passenger_back_53;
  const mesh_seat_passenger_back_53Geometry = endpoint_seat_passenger_back_53
    ? new THREE.CylinderGeometry(endpoint_seat_passenger_back_53.endRadius, endpoint_seat_passenger_back_53.baseRadius, endpoint_seat_passenger_back_53.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_passenger_back_53) {
    mesh_seat_passenger_back_53Geometry.scale(0.5, 0.66, 0.14);
  }
  const mesh_seat_passenger_back_53 = new THREE.Mesh(
    mesh_seat_passenger_back_53Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_passenger_back_53.name = "\u526f\u9a7e\u4f4d\u00b7\u9760\u80cc";
  if (endpoint_seat_passenger_back_53) {
    mesh_seat_passenger_back_53.position.copy(endpoint_seat_passenger_back_53.midpoint);
    mesh_seat_passenger_back_53.quaternion.copy(endpoint_seat_passenger_back_53.quaternion);
  }
  mesh_seat_passenger_back_53.castShadow = options.castShadow ?? true;
  mesh_seat_passenger_back_53.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_passenger_back_53.userData.sculptComponent = {"id": "seat-passenger-back", "name": "副驾位·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-passenger", "attachment": {"parentSocket": "seat-passenger.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.5, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.22], "rotation": [-0.1, 0, 0], "scale": [0.5, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_passenger_back_53.add(mesh_seat_passenger_back_53);
  meshes["seat-passenger-back"] = mesh_seat_passenger_back_53;
  colliders["seat-passenger-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_passenger_back_53);

  const endpoint_seat_rear_l_54 = makeAttachmentEndpoint(null);
  const node_seat_rear_l_54 = new THREE.Group();
  node_seat_rear_l_54.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u5de6__pivot";
  node_seat_rear_l_54.scale.set(1, 1, 1);
  if (endpoint_seat_rear_l_54) {
    node_seat_rear_l_54.position.copy(endpoint_seat_rear_l_54.start);
    node_seat_rear_l_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_rear_l_54.position.set(0.5, 0.62, -1.3);
    node_seat_rear_l_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_rear_l_54.userData.sculptComponent = {"id": "seat-rear-l", "name": "后排航空座左", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.56, "height": 0.14, "depth": 0.52, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.5, 0.62, -1.3], "rotation": [0, 0, 0], "scale": [0.56, 0.14, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_l_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_rear_l_54);
  nodes["seat-rear-l"] = node_seat_rear_l_54;
  const mesh_seat_rear_l_54Geometry = endpoint_seat_rear_l_54
    ? new THREE.CylinderGeometry(endpoint_seat_rear_l_54.endRadius, endpoint_seat_rear_l_54.baseRadius, endpoint_seat_rear_l_54.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_rear_l_54) {
    mesh_seat_rear_l_54Geometry.scale(0.56, 0.14, 0.52);
  }
  const mesh_seat_rear_l_54 = new THREE.Mesh(
    mesh_seat_rear_l_54Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_l_54.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u5de6";
  if (endpoint_seat_rear_l_54) {
    mesh_seat_rear_l_54.position.copy(endpoint_seat_rear_l_54.midpoint);
    mesh_seat_rear_l_54.quaternion.copy(endpoint_seat_rear_l_54.quaternion);
  }
  mesh_seat_rear_l_54.castShadow = options.castShadow ?? true;
  mesh_seat_rear_l_54.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_l_54.userData.sculptComponent = {"id": "seat-rear-l", "name": "后排航空座左", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.56, "height": 0.14, "depth": 0.52, "units": "meters", "confidence": 0.92}, "transform": {"position": [0.5, 0.62, -1.3], "rotation": [0, 0, 0], "scale": [0.56, 0.14, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_l_54.add(mesh_seat_rear_l_54);
  meshes["seat-rear-l"] = mesh_seat_rear_l_54;
  colliders["seat-rear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_l_54);

  const endpoint_seat_rear_l_back_55 = makeAttachmentEndpoint(null);
  const node_seat_rear_l_back_55 = new THREE.Group();
  node_seat_rear_l_back_55.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u5de6\u00b7\u9760\u80cc__pivot";
  node_seat_rear_l_back_55.scale.set(1, 1, 1);
  if (endpoint_seat_rear_l_back_55) {
    node_seat_rear_l_back_55.position.copy(endpoint_seat_rear_l_back_55.start);
    node_seat_rear_l_back_55.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_seat_rear_l_back_55.position.set(0.0, 0.36, 0.24);
    node_seat_rear_l_back_55.rotation.set(-0.1, 0.0, 0.0);
  }
  node_seat_rear_l_back_55.userData.sculptComponent = {"id": "seat-rear-l-back", "name": "后排航空座左·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-rear-l", "attachment": {"parentSocket": "seat-rear-l.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.54, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.24], "rotation": [-0.1, 0, 0], "scale": [0.54, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_l_back_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["seat-rear-l"] ?? root).add(node_seat_rear_l_back_55);
  nodes["seat-rear-l-back"] = node_seat_rear_l_back_55;
  const mesh_seat_rear_l_back_55Geometry = endpoint_seat_rear_l_back_55
    ? new THREE.CylinderGeometry(endpoint_seat_rear_l_back_55.endRadius, endpoint_seat_rear_l_back_55.baseRadius, endpoint_seat_rear_l_back_55.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_rear_l_back_55) {
    mesh_seat_rear_l_back_55Geometry.scale(0.54, 0.66, 0.14);
  }
  const mesh_seat_rear_l_back_55 = new THREE.Mesh(
    mesh_seat_rear_l_back_55Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_l_back_55.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u5de6\u00b7\u9760\u80cc";
  if (endpoint_seat_rear_l_back_55) {
    mesh_seat_rear_l_back_55.position.copy(endpoint_seat_rear_l_back_55.midpoint);
    mesh_seat_rear_l_back_55.quaternion.copy(endpoint_seat_rear_l_back_55.quaternion);
  }
  mesh_seat_rear_l_back_55.castShadow = options.castShadow ?? true;
  mesh_seat_rear_l_back_55.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_l_back_55.userData.sculptComponent = {"id": "seat-rear-l-back", "name": "后排航空座左·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-rear-l", "attachment": {"parentSocket": "seat-rear-l.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.54, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.24], "rotation": [-0.1, 0, 0], "scale": [0.54, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_l_back_55.add(mesh_seat_rear_l_back_55);
  meshes["seat-rear-l-back"] = mesh_seat_rear_l_back_55;
  colliders["seat-rear-l-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_l_back_55);

  const endpoint_seat_rear_r_56 = makeAttachmentEndpoint(null);
  const node_seat_rear_r_56 = new THREE.Group();
  node_seat_rear_r_56.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u53f3__pivot";
  node_seat_rear_r_56.scale.set(1, 1, 1);
  if (endpoint_seat_rear_r_56) {
    node_seat_rear_r_56.position.copy(endpoint_seat_rear_r_56.start);
    node_seat_rear_r_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_rear_r_56.position.set(-0.5, 0.62, -1.3);
    node_seat_rear_r_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_rear_r_56.userData.sculptComponent = {"id": "seat-rear-r", "name": "后排航空座右", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.56, "height": 0.14, "depth": 0.52, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.5, 0.62, -1.3], "rotation": [0, 0, 0], "scale": [0.56, 0.14, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_r_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_seat_rear_r_56);
  nodes["seat-rear-r"] = node_seat_rear_r_56;
  const mesh_seat_rear_r_56Geometry = endpoint_seat_rear_r_56
    ? new THREE.CylinderGeometry(endpoint_seat_rear_r_56.endRadius, endpoint_seat_rear_r_56.baseRadius, endpoint_seat_rear_r_56.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_rear_r_56) {
    mesh_seat_rear_r_56Geometry.scale(0.56, 0.14, 0.52);
  }
  const mesh_seat_rear_r_56 = new THREE.Mesh(
    mesh_seat_rear_r_56Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_r_56.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u53f3";
  if (endpoint_seat_rear_r_56) {
    mesh_seat_rear_r_56.position.copy(endpoint_seat_rear_r_56.midpoint);
    mesh_seat_rear_r_56.quaternion.copy(endpoint_seat_rear_r_56.quaternion);
  }
  mesh_seat_rear_r_56.castShadow = options.castShadow ?? true;
  mesh_seat_rear_r_56.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_r_56.userData.sculptComponent = {"id": "seat-rear-r", "name": "后排航空座右", "level": "meso", "role": "interior", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.56, "height": 0.14, "depth": 0.52, "units": "meters", "confidence": 0.92}, "transform": {"position": [-0.5, 0.62, -1.3], "rotation": [0, 0, 0], "scale": [0.56, 0.14, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-dash", "img-rearseat", "img-cutaway"], "details": ["d-quilted-seats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_r_56.add(mesh_seat_rear_r_56);
  meshes["seat-rear-r"] = mesh_seat_rear_r_56;
  colliders["seat-rear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_r_56);

  const endpoint_seat_rear_r_back_57 = makeAttachmentEndpoint(null);
  const node_seat_rear_r_back_57 = new THREE.Group();
  node_seat_rear_r_back_57.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u53f3\u00b7\u9760\u80cc__pivot";
  node_seat_rear_r_back_57.scale.set(1, 1, 1);
  if (endpoint_seat_rear_r_back_57) {
    node_seat_rear_r_back_57.position.copy(endpoint_seat_rear_r_back_57.start);
    node_seat_rear_r_back_57.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_seat_rear_r_back_57.position.set(0.0, 0.36, 0.24);
    node_seat_rear_r_back_57.rotation.set(-0.1, 0.0, 0.0);
  }
  node_seat_rear_r_back_57.userData.sculptComponent = {"id": "seat-rear-r-back", "name": "后排航空座右·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-rear-r", "attachment": {"parentSocket": "seat-rear-r.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.54, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.24], "rotation": [-0.1, 0, 0], "scale": [0.54, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_r_back_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["seat-rear-r"] ?? root).add(node_seat_rear_r_back_57);
  nodes["seat-rear-r-back"] = node_seat_rear_r_back_57;
  const mesh_seat_rear_r_back_57Geometry = endpoint_seat_rear_r_back_57
    ? new THREE.CylinderGeometry(endpoint_seat_rear_r_back_57.endRadius, endpoint_seat_rear_r_back_57.baseRadius, endpoint_seat_rear_r_back_57.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_seat_rear_r_back_57) {
    mesh_seat_rear_r_back_57Geometry.scale(0.54, 0.66, 0.14);
  }
  const mesh_seat_rear_r_back_57 = new THREE.Mesh(
    mesh_seat_rear_r_back_57Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_rear_r_back_57.name = "\u540e\u6392\u822a\u7a7a\u5ea7\u53f3\u00b7\u9760\u80cc";
  if (endpoint_seat_rear_r_back_57) {
    mesh_seat_rear_r_back_57.position.copy(endpoint_seat_rear_r_back_57.midpoint);
    mesh_seat_rear_r_back_57.quaternion.copy(endpoint_seat_rear_r_back_57.quaternion);
  }
  mesh_seat_rear_r_back_57.castShadow = options.castShadow ?? true;
  mesh_seat_rear_r_back_57.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_rear_r_back_57.userData.sculptComponent = {"id": "seat-rear-r-back", "name": "后排航空座右·靠背", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "seat-rear-r", "attachment": {"parentSocket": "seat-rear-r.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, "dimensions": {"width": 0.54, "height": 0.66, "depth": 0.14, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0.36, 0.24], "rotation": [-0.1, 0, 0], "scale": [0.54, 0.66, 0.14]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-rearseat"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_seat_rear_r_back_57.add(mesh_seat_rear_r_back_57);
  meshes["seat-rear-r-back"] = mesh_seat_rear_r_back_57;
  colliders["seat-rear-r-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_seat_rear_r_back_57);

  const endpoint_headliner_front_58 = makeAttachmentEndpoint(null);
  const node_headliner_front_58 = new THREE.Group();
  node_headliner_front_58.name = "\u9876\u68da\u524d\u6bb5\uff08\u9e82\u76ae\u661f\u7a7a\u9876\uff09__pivot";
  node_headliner_front_58.scale.set(1, 1, 1);
  if (endpoint_headliner_front_58) {
    node_headliner_front_58.position.copy(endpoint_headliner_front_58.start);
    node_headliner_front_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headliner_front_58.position.set(0.0, 1.7, 0.45);
    node_headliner_front_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_headliner_front_58.userData.sculptComponent = {"id": "headliner-front", "name": "顶棚前段（麂皮星空顶）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.52, "height": 0.02, "depth": 1.45, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.7, 0.45], "rotation": [0, 0, 0], "scale": [1.52, 0.02, 1.45]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "headliner-suede", "materialLayers": ["headliner-suede"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "穿孔麂皮", "kind": "perforated", "note": "细孔阵列 bump"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-starlight-headliner"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_front_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_headliner_front_58);
  nodes["headliner-front"] = node_headliner_front_58;
  const mesh_headliner_front_58Geometry = endpoint_headliner_front_58
    ? new THREE.CylinderGeometry(endpoint_headliner_front_58.endRadius, endpoint_headliner_front_58.baseRadius, endpoint_headliner_front_58.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headliner_front_58) {
    mesh_headliner_front_58Geometry.scale(1.52, 0.02, 1.45);
  }
  const mesh_headliner_front_58 = new THREE.Mesh(
    mesh_headliner_front_58Geometry,
    materialMap["headliner-suede"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headliner_front_58.name = "\u9876\u68da\u524d\u6bb5\uff08\u9e82\u76ae\u661f\u7a7a\u9876\uff09";
  if (endpoint_headliner_front_58) {
    mesh_headliner_front_58.position.copy(endpoint_headliner_front_58.midpoint);
    mesh_headliner_front_58.quaternion.copy(endpoint_headliner_front_58.quaternion);
  }
  mesh_headliner_front_58.castShadow = options.castShadow ?? true;
  mesh_headliner_front_58.receiveShadow = options.receiveShadow ?? true;
  mesh_headliner_front_58.userData.sculptComponent = {"id": "headliner-front", "name": "顶棚前段（麂皮星空顶）", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.52, "height": 0.02, "depth": 1.45, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 1.7, 0.45], "rotation": [0, 0, 0], "scale": [1.52, 0.02, 1.45]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "headliner-suede", "materialLayers": ["headliner-suede"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "穿孔麂皮", "kind": "perforated", "note": "细孔阵列 bump"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-starlight-headliner"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_front_58.add(mesh_headliner_front_58);
  meshes["headliner-front"] = mesh_headliner_front_58;
  colliders["headliner-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headliner_front_58);

  const endpoint_headliner_rear_59 = makeAttachmentEndpoint(null);
  const node_headliner_rear_59 = new THREE.Group();
  node_headliner_rear_59.name = "\u9876\u68da\u540e\u6bb5\uff08\u6d45\u8272\u7a7f\u5b54\u9769\uff09__pivot";
  node_headliner_rear_59.scale.set(1, 1, 1);
  if (endpoint_headliner_rear_59) {
    node_headliner_rear_59.position.copy(endpoint_headliner_rear_59.start);
    node_headliner_rear_59.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headliner_rear_59.position.set(0.0, 1.675, -1.35);
    node_headliner_rear_59.rotation.set(0.0, 0.0, 0.0);
  }
  node_headliner_rear_59.userData.sculptComponent = {"id": "headliner-rear", "name": "顶棚后段（浅色穿孔革）", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.52, "height": 0.02, "depth": 1.55, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.675, -1.35], "rotation": [0, 0, 0], "scale": [1.52, 0.02, 1.55]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 208, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_rear_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_headliner_rear_59);
  nodes["headliner-rear"] = node_headliner_rear_59;
  const mesh_headliner_rear_59Geometry = endpoint_headliner_rear_59
    ? new THREE.CylinderGeometry(endpoint_headliner_rear_59.endRadius, endpoint_headliner_rear_59.baseRadius, endpoint_headliner_rear_59.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_headliner_rear_59) {
    mesh_headliner_rear_59Geometry.scale(1.52, 0.02, 1.55);
  }
  const mesh_headliner_rear_59 = new THREE.Mesh(
    mesh_headliner_rear_59Geometry,
    materialMap["leather-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headliner_rear_59.name = "\u9876\u68da\u540e\u6bb5\uff08\u6d45\u8272\u7a7f\u5b54\u9769\uff09";
  if (endpoint_headliner_rear_59) {
    mesh_headliner_rear_59.position.copy(endpoint_headliner_rear_59.midpoint);
    mesh_headliner_rear_59.quaternion.copy(endpoint_headliner_rear_59.quaternion);
  }
  mesh_headliner_rear_59.castShadow = options.castShadow ?? true;
  mesh_headliner_rear_59.receiveShadow = options.receiveShadow ?? true;
  mesh_headliner_rear_59.userData.sculptComponent = {"id": "headliner-rear", "name": "顶棚后段（浅色穿孔革）", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1.52, "height": 0.02, "depth": 1.55, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 1.675, -1.35], "rotation": [0, 0, 0], "scale": [1.52, 0.02, 1.55]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-ivory", "materialLayers": ["leather-ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": [], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 208, 1.0)", "secondaryAlbedo": "rgba(74, 52, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_headliner_rear_59.add(mesh_headliner_rear_59);
  meshes["headliner-rear"] = mesh_headliner_rear_59;
  colliders["headliner-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_headliner_rear_59);

  const attachment_ambient_strip_l_60 = {"parentSocket": "headliner-front.edge", "localStart": [-0.74, 0, 0], "localEnd": [-0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002};
  const endpoint_ambient_strip_l_60 = makeAttachmentEndpoint(attachment_ambient_strip_l_60);
  const node_ambient_strip_l_60 = new THREE.Group();
  node_ambient_strip_l_60.name = "\u9876\u68da\u6c1b\u56f4\u706f\u5e26\u5de6__pivot";
  node_ambient_strip_l_60.scale.set(1, 1, 1);
  if (endpoint_ambient_strip_l_60) {
    node_ambient_strip_l_60.position.copy(endpoint_ambient_strip_l_60.start);
    node_ambient_strip_l_60.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ambient_strip_l_60.position.set(0.0, 0.0, 0.0);
    node_ambient_strip_l_60.rotation.set(0.0, 0.0, 0.0);
  }
  node_ambient_strip_l_60.userData.sculptComponent = {"id": "ambient-strip-l", "name": "顶棚氛围灯带左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "沿顶棚凹槽的连续灯管", "geometryDescriptor": {"tubePath": {"points": [[-0.74, 1.665, 1.35], [-0.78, 1.655, 0.4], [-0.78, 1.655, -1.6], [-0.74, 1.645, -2.25]], "radius": 0.012, "closed": false}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": {"parentSocket": "headliner-front.edge", "localStart": [-0.74, 0, 0], "localEnd": [-0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-amber", "materialLayers": ["lamp-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "暖橙发光贯穿", "kind": "emissive-strip", "note": "端头渐隐"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 176, 103, 1.0)", "secondaryAlbedo": "rgba(255, 176, 103, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_ambient_strip_l_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_ambient_strip_l_60);
  nodes["ambient-strip-l"] = node_ambient_strip_l_60;
  const mesh_ambient_strip_l_60Geometry = endpoint_ambient_strip_l_60
    ? new THREE.CylinderGeometry(endpoint_ambient_strip_l_60.endRadius, endpoint_ambient_strip_l_60.baseRadius, endpoint_ambient_strip_l_60.length, 16, 6)
    : buildTubeGeometry({"points": [[-0.74, 1.665, 1.35], [-0.78, 1.655, 0.4], [-0.78, 1.655, -1.6], [-0.74, 1.645, -2.25]], "radius": 0.012, "closed": false});
  if (!endpoint_ambient_strip_l_60) {
    mesh_ambient_strip_l_60Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ambient_strip_l_60 = new THREE.Mesh(
    mesh_ambient_strip_l_60Geometry,
    materialMap["lamp-amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ambient_strip_l_60.name = "\u9876\u68da\u6c1b\u56f4\u706f\u5e26\u5de6";
  if (endpoint_ambient_strip_l_60) {
    mesh_ambient_strip_l_60.position.copy(endpoint_ambient_strip_l_60.midpoint);
    mesh_ambient_strip_l_60.quaternion.copy(endpoint_ambient_strip_l_60.quaternion);
  }
  mesh_ambient_strip_l_60.castShadow = options.castShadow ?? true;
  mesh_ambient_strip_l_60.receiveShadow = options.receiveShadow ?? true;
  mesh_ambient_strip_l_60.userData.sculptComponent = {"id": "ambient-strip-l", "name": "顶棚氛围灯带左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "沿顶棚凹槽的连续灯管", "geometryDescriptor": {"tubePath": {"points": [[-0.74, 1.665, 1.35], [-0.78, 1.655, 0.4], [-0.78, 1.655, -1.6], [-0.74, 1.645, -2.25]], "radius": 0.012, "closed": false}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": {"parentSocket": "headliner-front.edge", "localStart": [-0.74, 0, 0], "localEnd": [-0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-amber", "materialLayers": ["lamp-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "暖橙发光贯穿", "kind": "emissive-strip", "note": "端头渐隐"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 176, 103, 1.0)", "secondaryAlbedo": "rgba(255, 176, 103, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_ambient_strip_l_60.add(mesh_ambient_strip_l_60);
  meshes["ambient-strip-l"] = mesh_ambient_strip_l_60;
  colliders["ambient-strip-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_ambient_strip_l_60);

  const attachment_ambient_strip_r_61 = {"parentSocket": "headliner-front.edge", "localStart": [0.74, 0, 0], "localEnd": [0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002};
  const endpoint_ambient_strip_r_61 = makeAttachmentEndpoint(attachment_ambient_strip_r_61);
  const node_ambient_strip_r_61 = new THREE.Group();
  node_ambient_strip_r_61.name = "\u9876\u68da\u6c1b\u56f4\u706f\u5e26\u53f3__pivot";
  node_ambient_strip_r_61.scale.set(1, 1, 1);
  if (endpoint_ambient_strip_r_61) {
    node_ambient_strip_r_61.position.copy(endpoint_ambient_strip_r_61.start);
    node_ambient_strip_r_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ambient_strip_r_61.position.set(0.0, 0.0, 0.0);
    node_ambient_strip_r_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_ambient_strip_r_61.userData.sculptComponent = {"id": "ambient-strip-r", "name": "顶棚氛围灯带右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "沿顶棚凹槽的连续灯管", "geometryDescriptor": {"tubePath": {"points": [[0.74, 1.665, 1.35], [0.78, 1.655, 0.4], [0.78, 1.655, -1.6], [0.74, 1.645, -2.25]], "radius": 0.012, "closed": false}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": {"parentSocket": "headliner-front.edge", "localStart": [0.74, 0, 0], "localEnd": [0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-amber", "materialLayers": ["lamp-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 176, 103, 1.0)", "secondaryAlbedo": "rgba(255, 176, 103, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_ambient_strip_r_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_ambient_strip_r_61);
  nodes["ambient-strip-r"] = node_ambient_strip_r_61;
  const mesh_ambient_strip_r_61Geometry = endpoint_ambient_strip_r_61
    ? new THREE.CylinderGeometry(endpoint_ambient_strip_r_61.endRadius, endpoint_ambient_strip_r_61.baseRadius, endpoint_ambient_strip_r_61.length, 16, 6)
    : buildTubeGeometry({"points": [[0.74, 1.665, 1.35], [0.78, 1.655, 0.4], [0.78, 1.655, -1.6], [0.74, 1.645, -2.25]], "radius": 0.012, "closed": false});
  if (!endpoint_ambient_strip_r_61) {
    mesh_ambient_strip_r_61Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ambient_strip_r_61 = new THREE.Mesh(
    mesh_ambient_strip_r_61Geometry,
    materialMap["lamp-amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ambient_strip_r_61.name = "\u9876\u68da\u6c1b\u56f4\u706f\u5e26\u53f3";
  if (endpoint_ambient_strip_r_61) {
    mesh_ambient_strip_r_61.position.copy(endpoint_ambient_strip_r_61.midpoint);
    mesh_ambient_strip_r_61.quaternion.copy(endpoint_ambient_strip_r_61.quaternion);
  }
  mesh_ambient_strip_r_61.castShadow = options.castShadow ?? true;
  mesh_ambient_strip_r_61.receiveShadow = options.receiveShadow ?? true;
  mesh_ambient_strip_r_61.userData.sculptComponent = {"id": "ambient-strip-r", "name": "顶棚氛围灯带右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "沿顶棚凹槽的连续灯管", "geometryDescriptor": {"tubePath": {"points": [[0.74, 1.665, 1.35], [0.78, 1.655, 0.4], [0.78, 1.655, -1.6], [0.74, 1.645, -2.25]], "radius": 0.012, "closed": false}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, "parent": "cabin-interior", "attachment": {"parentSocket": "headliner-front.edge", "localStart": [0.74, 0, 0], "localEnd": [0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-amber", "materialLayers": ["lamp-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 176, 103, 1.0)", "secondaryAlbedo": "rgba(255, 176, 103, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_ambient_strip_r_61.add(mesh_ambient_strip_r_61);
  meshes["ambient-strip-r"] = mesh_ambient_strip_r_61;
  colliders["ambient-strip-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_ambient_strip_r_61);

  const endpoint_door_panel_fl_62 = makeAttachmentEndpoint(null);
  const node_door_panel_fl_62 = new THREE.Group();
  node_door_panel_fl_62.name = "\u95e8\u5185\u9970\u677f fl__pivot";
  node_door_panel_fl_62.scale.set(1, 1, 1);
  if (endpoint_door_panel_fl_62) {
    node_door_panel_fl_62.position.copy(endpoint_door_panel_fl_62.start);
    node_door_panel_fl_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_panel_fl_62.position.set(0.94, 0.86, 0.85);
    node_door_panel_fl_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_panel_fl_62.userData.sculptComponent = {"id": "door-panel-fl", "name": "门内饰板 fl", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.94, 0.86, 0.85], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_fl_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_panel_fl_62);
  nodes["door-panel-fl"] = node_door_panel_fl_62;
  const mesh_door_panel_fl_62Geometry = endpoint_door_panel_fl_62
    ? new THREE.CylinderGeometry(endpoint_door_panel_fl_62.endRadius, endpoint_door_panel_fl_62.baseRadius, endpoint_door_panel_fl_62.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_panel_fl_62) {
    mesh_door_panel_fl_62Geometry.scale(0.07, 0.62, 1.15);
  }
  const mesh_door_panel_fl_62 = new THREE.Mesh(
    mesh_door_panel_fl_62Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_panel_fl_62.name = "\u95e8\u5185\u9970\u677f fl";
  if (endpoint_door_panel_fl_62) {
    mesh_door_panel_fl_62.position.copy(endpoint_door_panel_fl_62.midpoint);
    mesh_door_panel_fl_62.quaternion.copy(endpoint_door_panel_fl_62.quaternion);
  }
  mesh_door_panel_fl_62.castShadow = options.castShadow ?? true;
  mesh_door_panel_fl_62.receiveShadow = options.receiveShadow ?? true;
  mesh_door_panel_fl_62.userData.sculptComponent = {"id": "door-panel-fl", "name": "门内饰板 fl", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.94, 0.86, 0.85], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_fl_62.add(mesh_door_panel_fl_62);
  meshes["door-panel-fl"] = mesh_door_panel_fl_62;
  colliders["door-panel-fl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_panel_fl_62);

  const endpoint_door_panel_fr_63 = makeAttachmentEndpoint(null);
  const node_door_panel_fr_63 = new THREE.Group();
  node_door_panel_fr_63.name = "\u95e8\u5185\u9970\u677f fr__pivot";
  node_door_panel_fr_63.scale.set(1, 1, 1);
  if (endpoint_door_panel_fr_63) {
    node_door_panel_fr_63.position.copy(endpoint_door_panel_fr_63.start);
    node_door_panel_fr_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_panel_fr_63.position.set(-0.94, 0.86, 0.85);
    node_door_panel_fr_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_panel_fr_63.userData.sculptComponent = {"id": "door-panel-fr", "name": "门内饰板 fr", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.94, 0.86, 0.85], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_fr_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_panel_fr_63);
  nodes["door-panel-fr"] = node_door_panel_fr_63;
  const mesh_door_panel_fr_63Geometry = endpoint_door_panel_fr_63
    ? new THREE.CylinderGeometry(endpoint_door_panel_fr_63.endRadius, endpoint_door_panel_fr_63.baseRadius, endpoint_door_panel_fr_63.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_panel_fr_63) {
    mesh_door_panel_fr_63Geometry.scale(0.07, 0.62, 1.15);
  }
  const mesh_door_panel_fr_63 = new THREE.Mesh(
    mesh_door_panel_fr_63Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_panel_fr_63.name = "\u95e8\u5185\u9970\u677f fr";
  if (endpoint_door_panel_fr_63) {
    mesh_door_panel_fr_63.position.copy(endpoint_door_panel_fr_63.midpoint);
    mesh_door_panel_fr_63.quaternion.copy(endpoint_door_panel_fr_63.quaternion);
  }
  mesh_door_panel_fr_63.castShadow = options.castShadow ?? true;
  mesh_door_panel_fr_63.receiveShadow = options.receiveShadow ?? true;
  mesh_door_panel_fr_63.userData.sculptComponent = {"id": "door-panel-fr", "name": "门内饰板 fr", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.94, 0.86, 0.85], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_fr_63.add(mesh_door_panel_fr_63);
  meshes["door-panel-fr"] = mesh_door_panel_fr_63;
  colliders["door-panel-fr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_panel_fr_63);

  const endpoint_door_panel_rl_64 = makeAttachmentEndpoint(null);
  const node_door_panel_rl_64 = new THREE.Group();
  node_door_panel_rl_64.name = "\u95e8\u5185\u9970\u677f rl__pivot";
  node_door_panel_rl_64.scale.set(1, 1, 1);
  if (endpoint_door_panel_rl_64) {
    node_door_panel_rl_64.position.copy(endpoint_door_panel_rl_64.start);
    node_door_panel_rl_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_panel_rl_64.position.set(0.94, 0.86, -0.95);
    node_door_panel_rl_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_panel_rl_64.userData.sculptComponent = {"id": "door-panel-rl", "name": "门内饰板 rl", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.94, 0.86, -0.95], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_rl_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_panel_rl_64);
  nodes["door-panel-rl"] = node_door_panel_rl_64;
  const mesh_door_panel_rl_64Geometry = endpoint_door_panel_rl_64
    ? new THREE.CylinderGeometry(endpoint_door_panel_rl_64.endRadius, endpoint_door_panel_rl_64.baseRadius, endpoint_door_panel_rl_64.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_panel_rl_64) {
    mesh_door_panel_rl_64Geometry.scale(0.07, 0.62, 1.15);
  }
  const mesh_door_panel_rl_64 = new THREE.Mesh(
    mesh_door_panel_rl_64Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_panel_rl_64.name = "\u95e8\u5185\u9970\u677f rl";
  if (endpoint_door_panel_rl_64) {
    mesh_door_panel_rl_64.position.copy(endpoint_door_panel_rl_64.midpoint);
    mesh_door_panel_rl_64.quaternion.copy(endpoint_door_panel_rl_64.quaternion);
  }
  mesh_door_panel_rl_64.castShadow = options.castShadow ?? true;
  mesh_door_panel_rl_64.receiveShadow = options.receiveShadow ?? true;
  mesh_door_panel_rl_64.userData.sculptComponent = {"id": "door-panel-rl", "name": "门内饰板 rl", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.94, 0.86, -0.95], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_rl_64.add(mesh_door_panel_rl_64);
  meshes["door-panel-rl"] = mesh_door_panel_rl_64;
  colliders["door-panel-rl"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_panel_rl_64);

  const endpoint_door_panel_rr_65 = makeAttachmentEndpoint(null);
  const node_door_panel_rr_65 = new THREE.Group();
  node_door_panel_rr_65.name = "\u95e8\u5185\u9970\u677f rr__pivot";
  node_door_panel_rr_65.scale.set(1, 1, 1);
  if (endpoint_door_panel_rr_65) {
    node_door_panel_rr_65.position.copy(endpoint_door_panel_rr_65.start);
    node_door_panel_rr_65.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_panel_rr_65.position.set(-0.94, 0.86, -0.95);
    node_door_panel_rr_65.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_panel_rr_65.userData.sculptComponent = {"id": "door-panel-rr", "name": "门内饰板 rr", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.94, 0.86, -0.95], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_rr_65.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_door_panel_rr_65);
  nodes["door-panel-rr"] = node_door_panel_rr_65;
  const mesh_door_panel_rr_65Geometry = endpoint_door_panel_rr_65
    ? new THREE.CylinderGeometry(endpoint_door_panel_rr_65.endRadius, endpoint_door_panel_rr_65.baseRadius, endpoint_door_panel_rr_65.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_panel_rr_65) {
    mesh_door_panel_rr_65Geometry.scale(0.07, 0.62, 1.15);
  }
  const mesh_door_panel_rr_65 = new THREE.Mesh(
    mesh_door_panel_rr_65Geometry,
    materialMap["leather-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_panel_rr_65.name = "\u95e8\u5185\u9970\u677f rr";
  if (endpoint_door_panel_rr_65) {
    mesh_door_panel_rr_65.position.copy(endpoint_door_panel_rr_65.midpoint);
    mesh_door_panel_rr_65.quaternion.copy(endpoint_door_panel_rr_65.quaternion);
  }
  mesh_door_panel_rr_65.castShadow = options.castShadow ?? true;
  mesh_door_panel_rr_65.receiveShadow = options.receiveShadow ?? true;
  mesh_door_panel_rr_65.userData.sculptComponent = {"id": "door-panel-rr", "name": "门内饰板 rr", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "box 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.07, "height": 0.62, "depth": 1.15, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.94, 0.86, -0.95], "rotation": [0, 0, 0], "scale": [0.07, 0.62, 1.15]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "leather-warm", "materialLayers": ["leather-warm"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1", "img-popup3"], "details": ["d-ambient-strip"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 90, 44, 1.0)", "secondaryAlbedo": "rgba(232, 224, 208, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_door_panel_rr_65.add(mesh_door_panel_rr_65);
  meshes["door-panel-rr"] = mesh_door_panel_rr_65;
  colliders["door-panel-rr"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_door_panel_rr_65);

  const endpoint_curtain_l_66 = makeAttachmentEndpoint(null);
  const node_curtain_l_66 = new THREE.Group();
  node_curtain_l_66.name = "\u540e\u7a97\u5e18\u5de6__pivot";
  node_curtain_l_66.scale.set(1, 1, 1);
  if (endpoint_curtain_l_66) {
    node_curtain_l_66.position.copy(endpoint_curtain_l_66.start);
    node_curtain_l_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_curtain_l_66.position.set(0.88, 1.32, -1.55);
    node_curtain_l_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_curtain_l_66.userData.sculptComponent = {"id": "curtain-l", "name": "后窗帘左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.02, "height": 0.52, "depth": 0.85, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.88, 1.32, -1.55], "rotation": [0, 0, 0], "scale": [0.02, 0.52, 0.85]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "curtain", "materialLayers": ["curtain"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "米白竖褶", "kind": "pleated-fabric", "note": "竖褶 bump，可收拢视觉"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": ["d-curtain-pleats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 207, 192, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_curtain_l_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_curtain_l_66);
  nodes["curtain-l"] = node_curtain_l_66;
  const mesh_curtain_l_66Geometry = endpoint_curtain_l_66
    ? new THREE.CylinderGeometry(endpoint_curtain_l_66.endRadius, endpoint_curtain_l_66.baseRadius, endpoint_curtain_l_66.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_curtain_l_66) {
    mesh_curtain_l_66Geometry.scale(0.02, 0.52, 0.85);
  }
  const mesh_curtain_l_66 = new THREE.Mesh(
    mesh_curtain_l_66Geometry,
    materialMap["curtain"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_curtain_l_66.name = "\u540e\u7a97\u5e18\u5de6";
  if (endpoint_curtain_l_66) {
    mesh_curtain_l_66.position.copy(endpoint_curtain_l_66.midpoint);
    mesh_curtain_l_66.quaternion.copy(endpoint_curtain_l_66.quaternion);
  }
  mesh_curtain_l_66.castShadow = options.castShadow ?? true;
  mesh_curtain_l_66.receiveShadow = options.receiveShadow ?? true;
  mesh_curtain_l_66.userData.sculptComponent = {"id": "curtain-l", "name": "后窗帘左", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.02, "height": 0.52, "depth": 0.85, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.88, 1.32, -1.55], "rotation": [0, 0, 0], "scale": [0.02, 0.52, 0.85]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "curtain", "materialLayers": ["curtain"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"name": "米白竖褶", "kind": "pleated-fabric", "note": "竖褶 bump，可收拢视觉"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": ["d-curtain-pleats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 207, 192, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_curtain_l_66.add(mesh_curtain_l_66);
  meshes["curtain-l"] = mesh_curtain_l_66;
  colliders["curtain-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_curtain_l_66);

  const endpoint_curtain_r_67 = makeAttachmentEndpoint(null);
  const node_curtain_r_67 = new THREE.Group();
  node_curtain_r_67.name = "\u540e\u7a97\u5e18\u53f3__pivot";
  node_curtain_r_67.scale.set(1, 1, 1);
  if (endpoint_curtain_r_67) {
    node_curtain_r_67.position.copy(endpoint_curtain_r_67.start);
    node_curtain_r_67.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_curtain_r_67.position.set(-0.88, 1.32, -1.55);
    node_curtain_r_67.rotation.set(0.0, 0.0, 0.0);
  }
  node_curtain_r_67.userData.sculptComponent = {"id": "curtain-r", "name": "后窗帘右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.02, "height": 0.52, "depth": 0.85, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.88, 1.32, -1.55], "rotation": [0, 0, 0], "scale": [0.02, 0.52, 0.85]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "curtain", "materialLayers": ["curtain"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": ["d-curtain-pleats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 207, 192, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_curtain_r_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_curtain_r_67);
  nodes["curtain-r"] = node_curtain_r_67;
  const mesh_curtain_r_67Geometry = endpoint_curtain_r_67
    ? new THREE.CylinderGeometry(endpoint_curtain_r_67.endRadius, endpoint_curtain_r_67.baseRadius, endpoint_curtain_r_67.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_curtain_r_67) {
    mesh_curtain_r_67Geometry.scale(0.02, 0.52, 0.85);
  }
  const mesh_curtain_r_67 = new THREE.Mesh(
    mesh_curtain_r_67Geometry,
    materialMap["curtain"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_curtain_r_67.name = "\u540e\u7a97\u5e18\u53f3";
  if (endpoint_curtain_r_67) {
    mesh_curtain_r_67.position.copy(endpoint_curtain_r_67.midpoint);
    mesh_curtain_r_67.quaternion.copy(endpoint_curtain_r_67.quaternion);
  }
  mesh_curtain_r_67.castShadow = options.castShadow ?? true;
  mesh_curtain_r_67.receiveShadow = options.receiveShadow ?? true;
  mesh_curtain_r_67.userData.sculptComponent = {"id": "curtain-r", "name": "后窗帘右", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.88, "primitive": "plane-card", "topologyClass": "assembled-solid", "topologyRationale": "plane-card 适合该部件的可展拓扑", "geometryDescriptor": {"topologyIntent": "hard-surface precise", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 0.02, "height": 0.52, "depth": 0.85, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.88, 1.32, -1.55], "rotation": [0, 0, 0], "scale": [0.02, 0.52, 0.85]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.88}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "curtain", "materialLayers": ["curtain"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin"], "details": ["d-curtain-pleats"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 207, 192, 1.0)", "secondaryAlbedo": "rgba(216, 207, 192, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9}};
  node_curtain_r_67.add(mesh_curtain_r_67);
  meshes["curtain-r"] = mesh_curtain_r_67;
  colliders["curtain-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_curtain_r_67);

  const endpoint_starlight_field_68 = makeAttachmentEndpoint(null);
  const node_starlight_field_68 = new THREE.Group();
  node_starlight_field_68.name = "\u661f\u7a7a\u9876\u661f\u70b9\u57df__pivot";
  node_starlight_field_68.scale.set(1, 1, 1);
  if (endpoint_starlight_field_68) {
    node_starlight_field_68.position.copy(endpoint_starlight_field_68.start);
    node_starlight_field_68.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_starlight_field_68.position.set(0.0, 0.0, 0.0);
    node_starlight_field_68.rotation.set(0.0, 0.0, 0.0);
  }
  node_starlight_field_68.userData.sculptComponent = {"id": "starlight-field", "name": "星空顶星点域", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "instanced-cluster 适合该部件的可展拓扑", "geometryDescriptor": {"instancedBase": "sphere", "instancedCount": 160}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-starlight-headliner"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_starlight_field_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cabin-interior"] ?? root).add(node_starlight_field_68);
  nodes["starlight-field"] = node_starlight_field_68;
  const mesh_starlight_field_68Geometry = endpoint_starlight_field_68
    ? new THREE.CylinderGeometry(endpoint_starlight_field_68.endRadius, endpoint_starlight_field_68.baseRadius, endpoint_starlight_field_68.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_starlight_field_68) {
    mesh_starlight_field_68Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_starlight_field_68 = new THREE.Mesh(
    mesh_starlight_field_68Geometry,
    materialMap["lamp-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_starlight_field_68.name = "\u661f\u7a7a\u9876\u661f\u70b9\u57df";
  if (endpoint_starlight_field_68) {
    mesh_starlight_field_68.position.copy(endpoint_starlight_field_68.midpoint);
    mesh_starlight_field_68.quaternion.copy(endpoint_starlight_field_68.quaternion);
  }
  mesh_starlight_field_68.castShadow = options.castShadow ?? true;
  mesh_starlight_field_68.receiveShadow = options.receiveShadow ?? true;
  mesh_starlight_field_68.userData.sculptComponent = {"id": "starlight-field", "name": "星空顶星点域", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.92, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "instanced-cluster 适合该部件的可展拓扑", "geometryDescriptor": {"instancedBase": "sphere", "instancedCount": 160}, "parent": "cabin-interior", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "meters", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.92}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "lamp-white", "materialLayers": ["lamp-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["img-cabin", "img-popup1"], "details": ["d-starlight-headliner"], "fidelityTier": "hero", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_starlight_field_68.add(mesh_starlight_field_68);
  meshes["starlight-field"] = mesh_starlight_field_68;
  colliders["starlight-field"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": ""};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_starlight_field_68);

  // repetition system: starlight-points (InstancedMesh, radial, count=160, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["lamp-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 160);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 160; i++) {
      const ang = ((0.0) + (i * 360) / 160) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "starlight-points";
    parent.add(cluster);
  }

  // repetition system: wheel-spokes (InstancedMesh, radial, count=48, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["wheel-alloy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 48);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 48; i++) {
      const ang = ((0.0) + (i * 360) / 48) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "wheel-spokes";
    parent.add(cluster);
  }

  // repetition system: lantern-dot-matrix (InstancedMesh, radial, count=160, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["lamp-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 160);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 160; i++) {
      const ang = ((0.0) + (i * 360) / 160) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "lantern-dot-matrix";
    parent.add(cluster);
  }

  // repetition system: vent-slats (InstancedMesh, radial, count=26, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["chrome"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 26);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 26; i++) {
      const ang = ((0.0) + (i * 360) / 26) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "vent-slats";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "realtime-balanced", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createZunjieV800LuxuryMPVLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Zunjie V800 Luxury MPV look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"role": "key", "direction": "warm low-angle from camera-left (-X, +Z front)", "color": "#FFD2A2", "intensity": 3.3, "note": "~4500K dusk sun, matches game DirectionalLight"}, {"role": "fill", "direction": "cool opposite azimuth + elevated", "color": "#8FA9C9", "intensity": 0.4, "note": "anti-crush shadows, no shadow casting"}, {"role": "environment", "type": "PMREM from procedural dusk sky sphere", "color": "#E0836A", "intensity": 1.0, "note": "drives chrome/clearcoat reflections"}, {"role": "ambient", "type": "hemisphere", "sky": "#A9C2DD", "ground": "#4A3226", "intensity": 0.5}, {"exposure": "ACESFilmic tone mapping, exposure 0.85; emissive lamps above 0.72 bloom threshold"}, {"contactShadow": "ground contact shadow under tires via shadow map (PCF, 2048, texel-snapped ortho ±28)"}];
  lights.userData.lookDevTargets = {"qualityPriority": "realtime-balanced", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createZunjieV800LuxuryMPVEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameZunjieV800LuxuryMPVCamera(
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
export function createZunjieV800LuxuryMPVPresentationComposer(
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

export function configureZunjieV800LuxuryMPVRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createZunjieV800LuxuryMPVInspectControls(
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
