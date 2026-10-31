/**
 * 后处理：RenderPass → UnrealBloomPass(threshold .72, strength .38, radius .6)
 * → ShaderPass(SpeedBlur + Flash) → OutputPass。
 * 方案 A 档修正：原版 threshold 0.95 几乎不触发，按改造方案降到 0.72。
 *
 * P3 调光：
 * - 色调映射保持 ACESFilmic + exposure 0.85（Renderer.ts，不在本文件）
 * - SpeedBlur 增强：7 tap 径向加权采样 + RGB 分离（色差），
 *   仅 high/medium 档启用；low 档回落为 6 tap 无色差简化版
 * - Bloom 保留 threshold .72 / strength .38 / radius .6：
 *   emissive（车灯/字标/星环）在 0.72 以上即可吃到辉光
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { QualitySettings } from '../config/quality';

/** 速度径向模糊 + 撞击/断裂闪白（合并为单 pass，与原版 Lg 同职责） */
const SpeedBlurFlashShader = {
  name: 'SpeedBlurFlash',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    strength: { value: 0 },
    flash: { value: 0 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float flash;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - vec2(0.5);
      float dist = length(dir);
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < 6; i++) {
        float t = float(i) / 5.0;
        float w = 1.0 - t * 0.6;
        sum += texture2D(tDiffuse, vUv - dir * strength * dist * t) * w;
        total += w;
      }
      vec4 color = sum / total;
      color.rgb += flash;
      gl_FragColor = color;
    }
  `
};

/** 增强版：7 tap 径向加权采样 + RGB 分离（色差），high/medium 档专用 */
const SpeedBlurFlashEnhancedShader = {
  name: 'SpeedBlurFlashEnhanced',
  uniforms: SpeedBlurFlashShader.uniforms,
  vertexShader: SpeedBlurFlashShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float flash;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - vec2(0.5);
      float dist = length(dir);
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < 7; i++) {
        float t = float(i) / 6.0;
        float w = 1.0 - t * 0.65;
        vec2 off = dir * strength * dist * t;
        // RGB 分离：边缘色差随径向距离增强（速度感）
        vec3 s;
        s.r = texture2D(tDiffuse, vUv - off * 1.02).r;
        s.g = texture2D(tDiffuse, vUv - off).g;
        s.b = texture2D(tDiffuse, vUv - off * 0.98).b;
        sum += vec4(s, 1.0) * w;
        total += w;
      }
      vec4 color = sum / total;
      color.rgb += flash;
      gl_FragColor = color;
    }
  `
};

export class Postfx {
  private composer: EffectComposer;
  private blurPass: ShaderPass;
  private bloomPass: UnrealBloomPass | null = null;
  private pixelRatio: number;
  /** bloom 分辨率系数（perf-r14：核显 0.5 = 在 UnrealBloom 自带 1/2 基础上再减半） */
  private readonly bloomScale: number;
  private width = 1;
  private height = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: QualitySettings
  ) {
    this.pixelRatio = quality.pixelRatio;
    this.bloomScale = quality.bloomScale;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: quality.msaaSamples
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (quality.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x * this.bloomScale, size.y * this.bloomScale),
        0.38, // strength
        0.6, // radius
        0.72 // threshold
      );
      this.composer.addPass(this.bloomPass);
      // composer.setSize 会把 pass 尺寸重置为全分辨率，构造后立即拉回缩放尺寸
      this.applyBloomSize();
    }
    // 质量档开关：low 档用 6 tap 无色差简化版，high/medium 用增强版
    this.blurPass = new ShaderPass(
      quality.tier === 'low' ? SpeedBlurFlashShader : SpeedBlurFlashEnhancedShader
    );
    this.composer.addPass(this.blurPass);
    this.composer.addPass(new OutputPass());
  }

  /** bloom 走缩放分辨率：每级 mip 面积按 scale² 缩小（0.5 → 1/4 面积） */
  private applyBloomSize(): void {
    if (!this.bloomPass) return;
    const w = Math.max(2, Math.round(this.width * this.pixelRatio * this.bloomScale));
    const h = Math.max(2, Math.round(this.height * this.pixelRatio * this.bloomScale));
    this.bloomPass.setSize(w, h);
  }

  setSpeedBlur(strength: number): void {
    this.blurPass.uniforms.strength.value = strength;
  }

  setFlash(flash: number): void {
    this.blurPass.uniforms.flash.value = flash;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.composer.setSize(width, height);
    this.applyBloomSize();
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
    this.composer.setPixelRatio(ratio);
    this.applyBloomSize();
  }

  get currentPixelRatio(): number {
    return this.pixelRatio;
  }

  render(): void {
    this.composer.render();
  }

  /**
   * 加载期预热（R42-P1）：把 EffectComposer **全部 pass 的 program** 一次编译完。
   *
   * 为什么需要（这是 `prewarmGpu()` 的结构性盲区，本波补）：
   *   `renderer.compile(scene, camera)` 与 `renderer.render(scene, cam)` 都只走
   *   **场景材质**这条路径 —— 它们**不会**触达 composer 的
   *   `UnrealBloomPass`（自带 ~10 个内部材质/blur 链）/ `ShaderPass`(SpeedBlur) /
   *   `OutputPass` 的 program。这些 program 全都要等**首帧 `postfx.render()`**
   *   才惰性编译（弱机上可达数十 ms 的一次性首帧尖峰）。
   * 用户已放行首建时长 ⇒ 用 **8×8 小目标**先渲一帧 composer，把后处理 program 全部
   *   编译完。program 编译与 RT 尺寸无关，8×8 把 14 个全屏 pass 的填充成本压到可忽略
   *   （远小于全分辨率渲一帧），纯加载期开销。
   * 韧性：整段 try/catch —— 预热是「收益项」不是「正确性项」，失败最坏退回首帧编译，
   *   绝不允许它阻断开局；finally 无条件把 composer 尺寸还原成真实值，运行期观感/行为
   *   逐位不变（首帧 `postfx.render()` 复用的是同一批 program，直接命中缓存）。
   */
  prewarm(): void {
    const w = this.width;
    const h = this.height;
    try {
      this.composer.setSize(8, 8);
      this.composer.render();
    } catch {
      /* 预热失败最坏退回首帧编译，不影响玩法 */
    } finally {
      // 还原真实尺寸（这一步会重建 RT，但同样只发生在加载期；与 resize() 同路径）
      this.composer.setSize(w, h);
      this.applyBloomSize();
    }
  }

  dispose(): void {
    this.composer.dispose();
  }
}
