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

/** 从迷你场景烘 PMREM 环境贴图（天空 + 简化山体挡板 + 地面） */
function bakeEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, size: number): THREE.Texture {
  const pmremScene = new THREE.Scene();
  pmremScene.add(new THREE.Mesh(new THREE.SphereGeometry(size, 48, 24), makeSkyMaterial(sunDir)));
  const boardMat = new THREE.MeshBasicMaterial({ color: 0xb0b0c4, side: THREE.BackSide });
  for (const [x, y, z, w, h] of [
    [0, 60, 0, 120, 14],
    [-70, 30, -20, 50, 8],
    [70, 30, 20, 50, 8]
  ] as const) {
    const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), boardMat);
    board.position.set(x, y, z);
    board.lookAt(0, 0, 0);
    pmremScene.add(board);
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
