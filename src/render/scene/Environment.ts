/**
 * 环境：半径 5000 渐变天空球 shader + FogExp2(0xB05C6A, 38e-5) + PMREM 环境贴图。
 * 天空 shader 与 PMREM 迷你场景移植自原版（og/sg/cg/mg），保持视觉基准。
 */
import * as THREE from 'three';
import { FogExp2 } from 'three';
import { PMREMGenerator } from 'three';

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = pos.xyww; // 天空球永远在最远
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform float uCloudAmount;
  varying vec3 vDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    vec3 col;
    if (h > 0.0) {
      float t1 = smoothstep(0.0, 0.18, h);
      float t2 = smoothstep(0.12, 0.65, h);
      col = mix(uHorizon, uMid, t1);
      col = mix(col, uZenith, t2);
    } else {
      col = mix(uHorizon, uGround, smoothstep(0.0, 0.08, -h));
    }
    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
    float glow = pow(sd, 6.0) * 0.55 + pow(sd, 48.0) * 0.9;
    col += uSunColor * glow * smoothstep(-0.05, 0.05, h + 0.02);
    col += uSunColor * smoothstep(0.9993, 0.9997, sd) * 2.2;
    if (h > 0.0) {
      vec2 uv = dir.xz / (h + 0.12);
      uv *= vec2(0.6, 1.6);
      float c = fbm(uv * 1.3 + vec2(3.1, 0.7));
      c = smoothstep(0.52, 0.85, c) * uCloudAmount * smoothstep(0.02, 0.14, h) * (1.0 - smoothstep(0.35, 0.8, h));
      vec3 cloudLit = mix(vec3(0.42, 0.24, 0.30), uSunColor * 1.15, pow(sd, 3.0) * 0.8 + 0.2);
      col = mix(col, cloudLit, c * 0.85);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeSkyMaterial(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir.clone() },
      uZenith: { value: new THREE.Color(0x1d2240) },
      // 地平线向黄昏雾色 0xB05C6A 靠拢，减少天际线处雾/天色断裂
      uMid: { value: new THREE.Color(0x7a5448) },
      uHorizon: { value: new THREE.Color(0xe0836a).multiplyScalar(1.08) },
      uGround: { value: new THREE.Color(0x2e2026) },
      uSunColor: { value: new THREE.Color(0xffa055) },
      uCloudAmount: { value: 1 }
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
}

/**
 * P0-1 影棚柔光箱布局（替换原 3 块暗灰板 0xb0b0c4）：
 * PMREM 环境内容决定车漆反射观感。原 3 块暗灰小板反射强度不足，
 * 车身侧面拉不出连续横向反光带（对标报告 ① 号差距）。
 * 布局（均为 MeshBasic 匀色板 + DoubleSide 保证从原点可见）：
 *  - 长条顶置大 softbox：亮白（微暖 0xfff6ee 呼应黄昏），沿车身长度方向（z）
 *    拉长、抬高 —— 在车漆侧面照出连续横向亮带（判定标准）；
 *  - 前侧补光板：暖白 0xffe4cc（弱一档），呼应黄昏太阳方位的漫射补光；
 *  - 后侧弱补板：冷灰紫 0xd8d2e2，防止暗侧完全死黑，同时给暗侧轮廓留反射层次。
 * 黄昏基调约束：板只提供「 studio 反射内容」，不做主光源（主光仍是方向光 +
 * 天空球）；板面积/高度克制，整体环境不被拉成白天。
 */
function bakeEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, size: number): THREE.Texture {
  const pmremScene = new THREE.Scene();
  pmremScene.add(new THREE.Mesh(new THREE.SphereGeometry(size, 48, 24), makeSkyMaterial(sunDir)));
  const softboxes: Array<{ pos: [number, number, number]; w: number; h: number; color: number; gain: number; alongZ: boolean }> = [
    // 顶置长条大 softbox：长边沿 z（车身纵向），160 长 × 40 宽 @ y 95。
    // gain 2.4：车漆 envMapIntensity 已被 R10b 压到 0.55（防大理石漩涡），
    // 白色 1.0 板反射进黑漆太弱拉不出反光带（游戏页 t9 实拍实证）——
    // PMREM 走 HalfFloat 保留 HDR，板色 >1 成「过曝柔光箱」才能在暗侧漆面
    // 照出连续横向亮带（对标报告 ① 判定标准）。
    { pos: [0, 95, 0], w: 40, h: 160, color: 0xfff6ee, gain: 3.6, alongZ: true },
    // 前侧补光板（车头方向）：暖白弱一档
    { pos: [0, 34, 120], w: 95, h: 42, color: 0xffe4cc, gain: 1.35, alongZ: false },
    // 后侧弱补板：冷灰紫，防暗侧死黑
    { pos: [0, 30, -130], w: 80, h: 36, color: 0xd8d2e2, gain: 1.15, alongZ: false }
  ];
  for (const box of softboxes) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(box.color).multiplyScalar(box.gain),
      side: THREE.DoubleSide
    });
    const geo = new THREE.PlaneGeometry(box.w, box.h);
    if (box.alongZ) {
      // 顶置板：w=40 沿 x、h=160 沿 y；rotateX(-π/2) 后 y 边落到 z（长边沿车身纵向）、法线 +y
      geo.rotateX(-Math.PI / 2);
    }
    const plane = new THREE.Mesh(geo, mat);
    plane.position.set(...box.pos);
    if (!box.alongZ) plane.lookAt(0, 0, 0);
    pmremScene.add(plane);
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshBasicMaterial({ color: 0x1a1417 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  pmremScene.add(ground);

  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(pmremScene, 0.02);
  pmrem.dispose();
  return env.texture;
}

export class Environment {
  readonly sunDirection: THREE.Vector3;
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    envMapSize: number
  ) {
    const sunDir = new THREE.Vector3().setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(87.5),
      THREE.MathUtils.degToRad(215)
    );
    this.sunDirection = sunDir;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), makeSkyMaterial(sunDir));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.scene.environment = bakeEnvironment(renderer, sunDir, envMapSize);
    this.scene.fog = new FogExp2(0xb05c6a, 38e-5);
  }

  /** 天空球跟着相机平移（避免走到球边缘） */
  update(cameraPosition: THREE.Vector3): void {
    this.sky.position.copy(cameraPosition);
  }
}
