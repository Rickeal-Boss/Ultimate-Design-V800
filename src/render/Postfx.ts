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
import { damp } from '../util/math';

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
      /* R47：动态模糊默认关闭 ⇒ strength/flash 恒 0 时直接透传，
       * 把全屏 pass 从 6 tap（增强版 5 tap × RGB 3 次 = 15 次采样）降到 1 次。
       * 只加分支不改 program 结构 ⇒ prewarm 仍能编译全部分支，零首帧尖峰。 */
      if (strength <= 0.0001 && flash <= 0.0001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
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

/** 增强版：5 tap 径向加权采样 + RGB 分离（色差），high/medium 档专用
 *  R43-P0C/C：7→5 tap（真机上后处理是纯填充开销，5 tap 视觉差可忽略） */
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
      /* R47：动态模糊默认关闭 ⇒ strength/flash 恒 0 时直接透传，
       * 把全屏 pass 从 6 tap（增强版 5 tap × RGB 3 次 = 15 次采样）降到 1 次。
       * 只加分支不改 program 结构 ⇒ prewarm 仍能编译全部分支，零首帧尖峰。 */
      if (strength <= 0.0001 && flash <= 0.0001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec2 dir = vUv - vec2(0.5);
      float dist = length(dir);
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < 5; i++) {
        float t = float(i) / 4.0;
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
  /** R46 ③：一阶滞后后的实际强度（与 uniform 逐位一致；off 分支同步写回，避免切档残留） */
  private blurCurrent = 0;
  /**
   * R49-B：是否启用「默认关模糊时跳过整条 blurPass」的动态开关。
   * `#r49blurpass=off` ⇒ 恒 false ⇒ 逐位回 R48（pass 常驻、每帧照跑）。
   */
  private readonly blurAutoToggle: boolean;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: QualitySettings
  ) {
    this.pixelRatio = quality.pixelRatio;
    this.bloomScale = quality.bloomScale;
    this.blurAutoToggle = !/(?:^|[#&])r49blurpass=off/i.test(
      typeof window === 'undefined' ? '' : window.location.hash
    );
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
    /* 初值对齐：uniform 此刻 0/0 ⇒ 默认关模糊时 pass 一开始就 disabled。
     * prewarm() 会临时强制 enabled=true 编译 program，之后还原到本状态。 */
    this.syncBlurEnabled();
  }

  /** bloom 走缩放分辨率：每级 mip 面积按 scale² 缩小（0.5 → 1/4 面积） */
  private applyBloomSize(): void {
    if (!this.bloomPass) return;
    const w = Math.max(2, Math.round(this.width * this.pixelRatio * this.bloomScale));
    const h = Math.max(2, Math.round(this.height * this.pixelRatio * this.bloomScale));
    this.bloomPass.setSize(w, h);
  }

  /**
   * R46 ③ FX-A：强度一阶滞后，削掉「长帧糊一下、下一帧立刻不糊」的强度泵动
   * （与 R43 治 DPR 清晰度泵动 / 音效 spool 惯性同哲学，但视觉常数更快）。
   * - `smooth=false`（`#r46blur=off`）或 `dt<=0` ⇒ **严格 R45 基线**：直接写 uniform、无滞后。
   * - `smooth=true` ⇒ `damp(current, target, k, dt)`，升 k=20（τ0.05s）/ 降 k=8（τ0.125s）。
   *   升比降快：补偿要落在大跳发生的那一帧，回落慢一点才不产生二次阶跃。
   * 目标值仍受 Game 侧 `min(0.18, ...)` 上限约束，本方法不放大强度。
   */
  setSpeedBlur(strength: number, dt = 0, smooth = false): void {
    if (!smooth || dt <= 0) {
      this.blurCurrent = strength;
      this.blurPass.uniforms.strength.value = strength;
      this.syncBlurEnabled();
      return;
    }
    const k = strength > this.blurCurrent ? 20 : 8;
    this.blurCurrent = damp(this.blurCurrent, strength, k, dt);
    this.blurPass.uniforms.strength.value = this.blurCurrent;
    this.syncBlurEnabled();
  }

  /**
   * R49-B：默认关动态模糊时，整条 SpeedBlur 全屏 pass 是**恒等拷贝**
   * （fragment 在 `strength<=1e-4 && flash<=1e-4` 时直接 `texture2D(tDiffuse, vUv)`，
   * 见本文件 shader 的 R47 early-out），但 `EffectComposer` 仍会为它做
   * **一次全屏 quad + 一次 readBuffer→writeBuffer 的 HalfFloat RT 往返 + swapBuffers**
   * （EffectComposer.js:230-258）——这是一整帧填充率的纯浪费。
   *
   * 做法：`blurPass.enabled = false` ⇒ `EffectComposer.js:234 if (pass.enabled === false) continue;`
   * 直接跳过；`isLastEnabledPass()`（:192-200）会把 `renderToScreen` 正确交给
   * OutputPass，缓冲链本身合法（RenderPass / UnrealBloomPass 均 `needsSwap=false`，
   * 见 RenderPass.js:95 / UnrealBloomPass.js:94），输出**逐位不变**。
   *
   * ⚠ 判据必须读 **uniform 实际值**（= R46 ③ 一阶滞后后的 `blurCurrent` 与 `flash`），
   *   不能用 Game 侧算出的目标值：`setSpeedBlur` 升 k=20 / 降 k=8 的滞后在目标归零后
   *   仍有一段**余晖帧**（`blurCurrent` 从 >0 缓降），用目标值会提前关 pass ⇒ 余晖被
   *   硬截断，观感变化。brakeFlash（`setFlash`，峰值 0.85 后按 −2.2/s 衰减）同理。
   *
   * ⚠ `prewarm()` 期必须强制 `enabled=true`（见该方法），否则 SpeedBlur 的 program
   *   不会被 `composer.render()` 编译到 ⇒ 首次开模糊那帧冒出一次 program 编译尖峰，
   *   正好破坏 R42-P1 的「零首帧尖峰」。
   *
   * `#r49blurpass=off` ⇒ `blurAutoToggle=false` ⇒ 本方法恒置 enabled=true（逐位回 R48）。
   */
  private syncBlurEnabled(): void {
    if (!this.blurAutoToggle) {
      this.blurPass.enabled = true;
      return;
    }
    const s = this.blurPass.uniforms.strength.value as number;
    const f = this.blurPass.uniforms.flash.value as number;
    // 与 shader early-out 判据逐位同源（<= 1e-4 ⇒ 透传 ⇒ pass 无贡献）
    this.blurPass.enabled = s > 0.0001 || f > 0.0001;
  }

  setFlash(flash: number): void {
    this.blurPass.uniforms.flash.value = flash;
    this.syncBlurEnabled();
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

  /**
   * R46 Phase 2 ①：`#framelog` 只读本帧**实际写入**的 SpeedBlur uniform。
   * 探针必须读 uniform 而不是 Game 侧算出的目标值，否则一阶滞后（③）后
   * dump 的 blur 列与画面不一致，A/B 判据 `Σ(blur×jumpM)/ΣjumpM` 会失真。
   */
  get currentStrength(): number {
    return this.blurPass.uniforms.strength.value as number;
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
    /* R49-B：预热期**强制** blurPass 启用来编译它的 program。
     * 动态开关在「默认关模糊」时会把 blurPass 置 enabled=false（同步逻辑见
     * syncBlurEnabled），而 disabled 的 pass 在 EffectComposer.js:234 被 continue，
     * program 根本不会被编译 ⇒ 用户首次打开动态模糊（或首次 brakeFlash）的那一帧
     * 会付一次着色器编译尖峰，正好破坏 R42-P1 的意图。故此处临时开、finally 还原。 */
    const prevBlurEnabled = this.blurPass.enabled;
    try {
      this.blurPass.enabled = true;
      this.composer.setSize(8, 8);
      this.composer.render();
    } catch {
      /* 预热失败最坏退回首帧编译，不影响玩法 */
    } finally {
      // 还原真实尺寸（这一步会重建 RT，但同样只发生在加载期；与 resize() 同路径）
      this.composer.setSize(w, h);
      this.applyBloomSize();
      // 还原动态开关状态：**以 sync 为准**（uniform 此刻是初值 0/0 ⇒ 默认关模糊时
      // 会落回 disabled；`#r49blurpass=off` 时 sync 恒置 true）。prevBlurEnabled 只作
      // 异常早退的兜底（catch 分支若在 render 中途抛出，sync 仍能给出正确终态）。
      this.blurPass.enabled = prevBlurEnabled;
      this.syncBlurEnabled();
    }
  }

  dispose(): void {
    this.composer.dispose();
  }
}
