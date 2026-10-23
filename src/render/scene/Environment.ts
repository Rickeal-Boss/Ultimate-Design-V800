/**
 * 环境：半径 5000 渐变天空球 shader + FogExp2 + PMREM 环境贴图。
 *
 * R26：所有数值不再硬编码，全部来自 `src/config/environment.ts` 的 ACTIVE_ENV
 * （白石城堡 · 逆光暴风天光）。本文件只负责「按 preset 铺开」：
 * - sunDirection 由 preset.sun 的仰角/方位算出（仰角是从地平线量的真仰角，不是 phi）；
 * - 天空球 uniforms、雾、PMREM 柔光板全部读 preset；
 * - 天空 shader 与 PMREM 迷你场景结构沿用原版（og/sg/cg/mg），只换参数与两处光路表现：
 *   ① 太阳辉光改成「沿地平线横向拉宽的暖晕」（逆光参考图里没有圆盘太阳，只有一片暖带）；
 *   ② 云改成两层 fbm 相乘，重云（cloudAmount 0.85）时仍读得出层理。
 */
import * as THREE from 'three';
import { FogExp2 } from 'three';
import { PMREMGenerator } from 'three';
import { ACTIVE_ENV, type EnvPreset } from '../../config/environment';

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
  uniform vec3 uCloudLit;
  uniform vec3 uCloudDark;
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
    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
    // ── 地平线基色按太阳方位分裂 ────────────────────────────────────────
    // 参考图像素采样：地平线暖晕 #beb098(177) 只存在于**城堡正后（太阳方位）**一条，
    // 背向太阳的天空（侧向全景 / 高空斜视）是冷暗的 #61585d(90) 一档。旧代码让
    // uHorizon 360° 全向生效 ⇒ 侧机位与高空机位天光实测读到 L≈175 暖灰
    // （r27_final viaduct_side/aerial 像素探针），与参考图的阴沉冷天光相反。
    // 这里按 sd 把暖亮收回到太阳方位约 ±30° 内，其余方向转冷（uMid）。
    vec3 horizonCol = mix(uMid, uHorizon, smoothstep(0.30, 0.92, sd));
    vec3 col;
    if (h > 0.0) {
      float t1 = smoothstep(0.0, 0.18, h);
      float t2 = smoothstep(0.12, 0.65, h);
      col = mix(horizonCol, uMid, t1);
      col = mix(col, uZenith, t2);
    } else {
      col = mix(horizonCol, uGround, smoothstep(0.0, 0.08, -h));
    }
    // ── 逆光暖晕 = 贴着地平线的**横向亮带**（不是一个圆盘）─────────────────
    // ①② 方位集中度：pow(sd,4) 宽底 + pow(sd,16) 收窄，两项等权（结构按要求保留）；
    // ③ 横向权重：只在 |y| < 0.12 内满强度，把亮带压在地平线上，带外只留 16%，
    //    于是「头顶冷、地平线暖」的关系被强行拉出来，而不是一片均匀蓝灰。
    // ⚠ 幅度不是 0.55 而是 0.13：ACES + exposure 0.85 在 L≈180 以上已经进入肩部，
    //    0.55 会把带心推到 L=215（近白、直接糊掉地平线层次）；0.13 下带心 L≈192、
    //    带外（背对太阳）L≈177，正好等于参考图地平线采样 #beb098(177)。
    //    数值全部由 .qa/r26_sky_predict.mjs（shader 复刻 + ACES 复算）验过。
    // 注意 GLSL 的 smoothstep(edge0, edge1, x) 要求 edge0 < edge1。
    float glow = pow(sd, 4.0) * 0.13 + pow(sd, 16.0) * 0.13;
    float bandWeight = 1.0 - smoothstep(0.0, 0.12, abs(h));
    glow *= mix(0.16, 1.0, bandWeight);
    // 只让地平线以上的半个球吃这层光（下半球是地面方向，不该被点亮）
    col += uSunColor * glow * smoothstep(-0.10, 0.02, h);
    // 日盘：逆光里太阳被城堡/云遮住，只留一个淡核（过亮会破坏「逆光」判读）
    // R26 主理人：原式是 smoothstep(0.9990,0.9996)·0.55 —— 一个**硬边白圆盘**，
    // 在暴云暗天上直接读成"贴了一张白色圆贴纸"（verify/r26c/bridge.png 实证）。
    // 改成两级幂次叠加：宽而软的辉光 + 很窄的亮核，全程无可见边缘。
    col += uSunColor * (pow(sd, 90.0) * 0.30 + pow(sd, 900.0) * 0.55);

    if (h > 0.0) {
      vec2 uv = dir.xz / (h + 0.12);
      uv *= vec2(0.6, 1.6);
      float base = fbm(uv * 1.3 + vec2(3.1, 0.7));
      float detail = fbm(uv * 3.4 + vec2(-1.7, 2.3));
      // 两层不同尺度相乘 = 「厚云顶 + 薄云尾」。cloudAmount 0.85（重云）时单层 fbm 会糊成
      // 一整块灰板，乘上 detail 才有层理可读（参考图的云是分层的，不是平涂）。
      float cover = smoothstep(0.44, 0.80, base) * (0.72 + (detail - 0.5) * 0.55);
      float vertical = smoothstep(0.015, 0.15, h) * (1.0 - smoothstep(0.28, 0.9, h));
      float c = clamp(cover * uCloudAmount * vertical, 0.0, 0.94);
      // 亮边 / 暗底两段映射（不是单一 mix）：
      //   近太阳一侧的云缘被逆光点亮（cloudNear → uSunColor），
      //   云体厚处（detail 高）走 uCloudDark，层理就靠这条明暗二段读出来。
      // ⚠ 逆光点亮同样只限地平线附近（cloudBand）：参考图是「地平线一条暖晕、
      //    往上迅速转冷蓝灰」—— 旧代码让亮云延伸到 h≈0.9，高空机位（aerial）
      //    整片天读到 L≈160 暖白（像素探针实测），与参考图的阴沉冷天光相反。
      //    3.4° 以下满亮、17° 以上全暗，与 glow 的 bandWeight 同一思想。
      float cloudBand = 1.0 - smoothstep(0.06, 0.30, abs(h));
      vec3 cloudNear = mix(uCloudLit, uSunColor * 1.12, (pow(sd, 2.0) * 0.85 + 0.15) * cloudBand);
      vec3 cloud = mix(cloudNear, uCloudDark, smoothstep(0.34, 0.86, detail));
      col = mix(col, cloud, c);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * 天空材质。云的两种色由 mid/ground/horizon 派生 —— 上一版只有单一 uCloudShade，
 * 重云（0.85）时整片云共用一个颜色，读不出层理；这里拆成「亮边 / 暗底」两色：
 *  - uCloudLit ：云顶/云缘（mid 往地平线暖色靠 45%）
 *  - uCloudDark：云体厚处（mid 往地面暗褐靠 55% 再 ×0.52）
 * 两者都不硬编码，跟着 preset 色板自动走，换天空基调时不会留下一块「脏紫」。
 */
function makeSkyMaterial(sunDir: THREE.Vector3, preset: EnvPreset): THREE.ShaderMaterial {
  const mid = new THREE.Color(preset.sky.mid);
  // 云的两色也是「授权值」而不是「成品像素值」：×0.34 / ×0.30 是对着
  // .qa/r26_sky_predict.mjs 的 ACES 复算定的 —— 不做这个衰减，云在 0.85 云量下会整片读到 L≈150，
  // 比参考图的云（90~119）亮一档，观感就从「暴云」变成「亮阴天」。
  const cloudLit = mid
    .clone()
    .lerp(new THREE.Color(preset.sky.horizon), 0.3)
    .multiplyScalar(0.26);
  const cloudDark = mid
    .clone()
    .lerp(new THREE.Color(preset.sky.ground), 0.55)
    .multiplyScalar(0.2);
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir.clone() },
      uZenith: { value: new THREE.Color(preset.sky.zenith) },
      uMid: { value: new THREE.Color(preset.sky.mid) },
      uHorizon: { value: new THREE.Color(preset.sky.horizon) },
      uGround: { value: new THREE.Color(preset.sky.ground) },
      uSunColor: { value: new THREE.Color(preset.sky.sunColor) },
      uCloudLit: { value: cloudLit },
      uCloudDark: { value: cloudDark },
      uCloudAmount: { value: preset.sky.cloudAmount }
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
}

/**
 * PMREM 环境烘焙。PMREM 内容决定车漆反射观感，柔光板布局是 R10b 起实证过的
 * 「影棚布光」，R26 只把数值搬进 preset：
 *  - 顶置长条大板：沿车身纵向（z）拉长、抬高，在车漆侧面照出连续横向亮带；
 *  - 前侧补光板：暖白弱一档，呼应太阳方位的漫射；
 *  - 后侧弱补板：冷灰，防暗侧死黑并保留反射层次；
 *  - R26 新增低位暖色地面反弹板：白石地面把光打回车底/侧裙（见 preset 注释）。
 * PMREM 走 HalfFloat 保留 HDR：板色 >1 才能成「过曝柔光箱」，在漆面拉出亮带。
 */
function bakeEnvironment(
  renderer: THREE.WebGLRenderer,
  sunDir: THREE.Vector3,
  size: number,
  preset: EnvPreset
): THREE.Texture {
  const pmremScene = new THREE.Scene();
  pmremScene.add(new THREE.Mesh(new THREE.SphereGeometry(size, 48, 24), makeSkyMaterial(sunDir, preset)));
  for (const box of preset.softbox) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(box.color).multiplyScalar(box.gain),
      side: THREE.DoubleSide
    });
    const geo = new THREE.PlaneGeometry(box.w, box.h);
    if (box.alongZ) {
      // 顶置/地面板：w 沿 x、h 沿 y；rotateX(-π/2) 后 h 边落到 z（长边沿车身纵向）、法线 +y
      geo.rotateX(-Math.PI / 2);
    }
    const plane = new THREE.Mesh(geo, mat);
    plane.position.set(...box.pos);
    if (!box.alongZ) plane.lookAt(0, 0, 0);
    pmremScene.add(plane);
  }
  // 地面反射板：旧值 0x1a1417 的深色地面在亮石环境里会把车底压死，
  // 这里由 preset.sky.ground 派生（×0.3 保留「暗但暖」的地面反照关系）。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(preset.sky.ground).multiplyScalar(0.3) })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  pmremScene.add(ground);

  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(pmremScene, 0.02);
  pmrem.dispose();
  return env.texture;
}

/**
 * 仰角/方位 → 单位方向向量。
 * 注意 setFromSphericalCoords 的 phi 是**从 +Y 量**，旧代码直接传 87.5° 的
 * 「看似的仰角」其实只离地平线 2.5°，这是上一轮「太阳贴地」的根因。
 * 这里改用 theta=90°−仰角 的换算，preset 里写的仰角就真的是仰角。
 */
function directionFromSun(sun: EnvPreset['sun']): THREE.Vector3 {
  return new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - sun.elevationDeg),
    THREE.MathUtils.degToRad(sun.azimuthDeg)
  );
}

export class Environment {
  readonly sunDirection: THREE.Vector3;
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    envMapSize: number
  ) {
    const preset = ACTIVE_ENV;
    const sunDir = directionFromSun(preset.sun);
    this.sunDirection = sunDir;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), makeSkyMaterial(sunDir, preset));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.scene.environment = bakeEnvironment(renderer, sunDir, envMapSize, preset);
    this.scene.fog = new FogExp2(preset.fog.color, preset.fog.density);
  }

  /** 天空球跟着相机平移（避免走到球边缘） */
  update(cameraPosition: THREE.Vector3): void {
    this.sky.position.copy(cameraPosition);
  }
}
