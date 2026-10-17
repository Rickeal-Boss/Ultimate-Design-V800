/**
 * WebAudio 程序化音效框架（P3 涡扇化 EV 声浪版）：
 *
 * 纯电高性能车全加速的听感接近涡扇/喷气引擎：音高连续爬升、无换挡顿挫、
 * 有 spool-up 惯性（音高滞后于油门与车速）。本版用三层叠加替换旧的内燃机式
 * 「锯齿基频 + 低通扫频」建模：
 *
 * 1. 核心啸叫 whine：主振荡器（窄带带通塑形）+ 失谐副本（5–9Hz 差频拍音）
 *    + 叶片通过频率 BPF（主频 ×2，低幅）——全速时最可辨的「飞机声」特征。
 * 2. 气流轰鸣 jet roar：宽频噪声经带通，中心频率随 spool 800→3500Hz，
 *    音量随 spool 平方上升——「推背气流」的体感层。
 * 3. 低频机身 rumble：44→70Hz 三角波，音量按 spool^2.4 增长（刻意克制，
 *    否则会退回内燃机的低频轰鸣）。
 *
 * ★ spool 惯性：所有发动机层参数由内部一阶滞后状态 `spool`（0~1）驱动，
 *   音高**不直接跟车速**。加速时间常数 0.5s、减速 0.9s（涡扇转子惯性）。
 *
 * 其余层沿用：风噪（独立噪声带通）、胎啸（高 Q 共振）、再生制动双音提示、
 * 全部事件音。全部振荡器/噪声合成，零外部音频文件；循环节点统一在 dispose()
 * 停止并断开。
 */
import { VEHICLE } from '../config/physics';

/* ============================================================================
 * 参数映射纯函数（不依赖 AudioContext，可直接单测，见 tests/audio.test.ts）
 * ========================================================================== */

/** spool 上升（踩下/加速）一阶时间常数 s */
export const SPOOL_RISE_TAU = 0.5;
/** spool 回落（松油门/滑行/制动）一阶时间常数 s —— 涡扇转子惰转更慢 */
export const SPOOL_FALL_TAU = 0.9;

/** 核心啸叫频率区间 Hz（spool 0 → 1，指数映射＝音高连续爬升） */
export const WHINE_F0 = 190;
export const WHINE_F1 = 1640;

/** 气流轰鸣带通中心频率区间 Hz */
export const ROAR_HZ0 = 800;
export const ROAR_HZ1 = 3500;

/** 低频机身频率区间 Hz */
export const RUMBLE_HZ0 = 44;
export const RUMBLE_HZ1 = 70;

/** 各层音量上限（线性增益，峰值总和控制在旧版引擎+风噪水平附近，避免削波） */
export const WHINE_GAIN_MAX = 0.065;
export const ROAR_GAIN_MAX = 0.072;
export const RUMBLE_GAIN_MAX = 0.03;

/** revBlip 的 spool 冲击幅度与衰减时间常数 s */
export const BLIP_LEVEL = 0.55;
export const BLIP_TAU = 0.28;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 目标 spool（0~1）：车速归一 × 动力状态。
 * - 静止恒为 0（无声）；
 * - `powered=false`（滑行 / 电子限速动力退出 / 制动）目标降到 55%，
 *   即「滑行档」——与 Game.ts 的 atLimiter 语义一致。
 */
export function spoolTarget(speedKmh: number, powered: boolean): number {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return 0;
  const n = clamp01(speedKmh / VEHICLE.maxSpeedKmh);
  const speedTerm = Math.pow(n, 0.8);
  return clamp01(speedTerm * (powered ? 1 : 0.55));
}

/**
 * spool 一阶跟踪（惯性核心）。
 * `rising` 为真取加速时间常数，否则取减速时间常数；
 * 任意 dt 下都单调趋近目标、不瞬变、不越界、不出 NaN。
 */
export function spoolStep(current: number, target: number, dt: number, rising: boolean): number {
  const c = clamp01(current);
  const g = clamp01(target);
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (d === 0) return c;
  const tau = rising ? SPOOL_RISE_TAU : SPOOL_FALL_TAU;
  const next = c + (g - c) * (1 - Math.exp(-d / tau));
  return clamp01(next);
}

/** 核心啸叫主频 Hz：190 → 1640，指数（音高线性爬升感） */
export function whineFreq(spool: number): number {
  return WHINE_F0 * Math.pow(WHINE_F1 / WHINE_F0, clamp01(spool));
}

/** 失谐副本差频 Hz：5 → 9（产生拍频/粗糙感） */
export function whineDetuneHz(spool: number): number {
  return 5 + 4 * clamp01(spool);
}

/** 叶片通过频率 BPF Hz（主频 ×2） */
export function whineBladeFreq(spool: number): number {
  return whineFreq(spool) * 2;
}

/** 核心啸叫增益：spool=0 时严格为 0（静止无声） */
export function whineGain(spool: number): number {
  return WHINE_GAIN_MAX * Math.pow(clamp01(spool), 1.25);
}

/** 气流轰鸣带通中心频率 Hz：800 → 3500 */
export function roarCenterHz(spool: number): number {
  return ROAR_HZ0 + (ROAR_HZ1 - ROAR_HZ0) * Math.pow(clamp01(spool), 1.15);
}

/** 气流轰鸣增益：随 spool 平方上升（推背气流体感） */
export function roarGain(spool: number): number {
  return ROAR_GAIN_MAX * clamp01(spool) * clamp01(spool);
}

/** 低频机身频率 Hz：44 → 70 */
export function rumbleFreq(spool: number): number {
  return RUMBLE_HZ0 + (RUMBLE_HZ1 - RUMBLE_HZ0) * clamp01(spool);
}

/** 低频机身增益：高次幂，只在高速/全加速时轻微存在 */
export function rumbleGain(spool: number): number {
  return RUMBLE_GAIN_MAX * Math.pow(clamp01(spool), 2.4);
}

/* ============================================================================
 * 音频节点图
 * ========================================================================== */

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  // 层 1：核心啸叫
  private whineOsc: OscillatorNode | null = null;
  private whineDetOsc: OscillatorNode | null = null;
  private bladeOsc: OscillatorNode | null = null;
  private whineOscGain: GainNode | null = null;
  private whineDetGain: GainNode | null = null;
  private bladeGain: GainNode | null = null;
  private whineFilter: BiquadFilterNode | null = null;
  private bladeFilter: BiquadFilterNode | null = null;

  // 层 2：气流轰鸣
  private roarSrc: AudioBufferSourceNode | null = null;
  private roarFilter: BiquadFilterNode | null = null;
  private roarGain: GainNode | null = null;

  // 层 3：低频机身
  private rumbleOsc: OscillatorNode | null = null;
  private rumbleFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;

  // 沿用层：风噪 / 胎啸
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private squealSrc: AudioBufferSourceNode | null = null;
  private squealGain: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;

  /** 转子惯性状态（0~1），驱动全部发动机层参数 */
  private spool = 0;
  /** revBlip 的瞬时 spool 冲击，指数衰减 */
  private blip = 0;
  /** 上一帧 updateEngine 的 ctx 时间戳，用于求 dt */
  private lastEngineT = 0;
  private regenWasActive = false;
  private muted = false;

  get isMuted(): boolean {
    return this.muted;
  }

  /** 首次用户手势时解锁 */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    this.buildEngine();
    this.buildLoops();
  }

  /** 三层涡扇声浪节点图（全部连到 master） */
  private buildEngine(): void {
    if (!this.ctx || !this.master) return;

    // 层 1：核心啸叫 —— 主振荡器 + 失谐副本共用一只带通（同一通带内差频产生拍音）
    this.whineFilter = this.ctx.createBiquadFilter();
    this.whineFilter.type = 'bandpass';
    this.whineFilter.frequency.value = WHINE_F0;
    this.whineFilter.Q.value = 3.2;

    this.whineOsc = this.ctx.createOscillator();
    this.whineOsc.type = 'sawtooth';
    this.whineOsc.frequency.value = WHINE_F0;
    this.whineOscGain = this.ctx.createGain();
    this.whineOscGain.gain.value = 0;
    this.whineOsc.connect(this.whineOscGain);
    this.whineOscGain.connect(this.whineFilter);

    this.whineDetOsc = this.ctx.createOscillator();
    this.whineDetOsc.type = 'sawtooth';
    this.whineDetOsc.frequency.value = WHINE_F0 + 5;
    this.whineDetGain = this.ctx.createGain();
    this.whineDetGain.gain.value = 0;
    this.whineDetOsc.connect(this.whineDetGain);
    this.whineDetGain.connect(this.whineFilter);

    this.whineFilter.connect(this.master);

    // 叶片通过频率（主频 ×2，低幅）
    this.bladeFilter = this.ctx.createBiquadFilter();
    this.bladeFilter.type = 'bandpass';
    this.bladeFilter.frequency.value = WHINE_F0 * 2;
    this.bladeFilter.Q.value = 5;
    this.bladeOsc = this.ctx.createOscillator();
    this.bladeOsc.type = 'sawtooth';
    this.bladeOsc.frequency.value = WHINE_F0 * 2;
    this.bladeGain = this.ctx.createGain();
    this.bladeGain.gain.value = 0;
    this.bladeOsc.connect(this.bladeFilter);
    this.bladeFilter.connect(this.bladeGain);
    this.bladeGain.connect(this.master);

    // 层 3：低频机身（先建，噪声源在 buildLoops 里共用缓冲）
    this.rumbleFilter = this.ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 120;
    this.rumbleOsc = this.ctx.createOscillator();
    this.rumbleOsc.type = 'triangle';
    this.rumbleOsc.frequency.value = RUMBLE_HZ0;
    this.rumbleGain = this.ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleOsc.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);

    this.whineOsc.start();
    this.whineDetOsc.start();
    this.bladeOsc.start();
    this.rumbleOsc.start();
  }

  /** 循环噪声缓冲（2s 白噪声） */
  private makeNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const length = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private buildLoops(): void {
    if (!this.ctx || !this.master) return;
    const buffer = this.makeNoiseBuffer();
    if (!buffer) return;

    // 层 2：气流轰鸣 —— 宽频噪声带通，中心频率随 spool 800→3500Hz
    this.roarSrc = this.ctx.createBufferSource();
    this.roarSrc.buffer = buffer;
    this.roarSrc.loop = true;
    this.roarFilter = this.ctx.createBiquadFilter();
    this.roarFilter.type = 'bandpass';
    this.roarFilter.frequency.value = ROAR_HZ0;
    this.roarFilter.Q.value = 0.8;
    this.roarGain = this.ctx.createGain();
    this.roarGain.gain.value = 0;
    this.roarSrc.connect(this.roarFilter);
    this.roarFilter.connect(this.roarGain);
    this.roarGain.connect(this.master);
    this.roarSrc.start();

    // 风噪：白噪声 + 带通，音量/频率随速度（与 roar 频带部分重叠，故系数略降）
    this.windSrc = this.ctx.createBufferSource();
    this.windSrc.buffer = buffer;
    this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    // 胎啸：噪声 + 高 Q 带通共振峰
    this.squealSrc = this.ctx.createBufferSource();
    this.squealSrc.buffer = buffer;
    this.squealSrc.loop = true;
    this.squealFilter = this.ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 2300;
    this.squealFilter.Q.value = 9;
    this.squealGain = this.ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.master);
    this.squealSrc.start();
  }

  /**
   * 发动机声随速度/动力状态：先算目标 spool，再经一阶惯性推进，
   * 最后由 spool 统一驱动三层参数（音高不直接跟车速）。
   */
  updateEngine(speedKmh: number, powered: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dt =
      this.lastEngineT === 0 ? 1 / 60 : Math.min(0.25, Math.max(0, t - this.lastEngineT));
    this.lastEngineT = t;

    // revBlip 冲击：指数衰减后与车速目标取大者
    this.blip = this.blip > 0.001 ? this.blip * Math.exp(-dt / BLIP_TAU) : 0;
    const target = Math.max(spoolTarget(speedKmh, powered), this.blip);

    // ★ 惯性：加速/减速不同时间常数
    this.spool = spoolStep(this.spool, target, dt, target > this.spool);
    this.applySpool(t);
  }

  /** 把 spool 映射到三层节点参数（setTargetAtTime 再做一层音频级平滑，防拉链噪声） */
  private applySpool(t: number): void {
    const s = this.spool;
    const wf = whineFreq(s);
    const bf = whineBladeFreq(s);
    const wg = whineGain(s);

    if (this.whineOsc) this.whineOsc.frequency.setTargetAtTime(wf, t, 0.05);
    if (this.whineDetOsc) {
      this.whineDetOsc.frequency.setTargetAtTime(wf + whineDetuneHz(s), t, 0.05);
    }
    if (this.bladeOsc) this.bladeOsc.frequency.setTargetAtTime(bf, t, 0.05);
    if (this.whineFilter) this.whineFilter.frequency.setTargetAtTime(wf, t, 0.06);
    if (this.bladeFilter) this.bladeFilter.frequency.setTargetAtTime(bf, t, 0.06);
    if (this.whineOscGain) this.whineOscGain.gain.setTargetAtTime(wg, t, 0.06);
    if (this.whineDetGain) this.whineDetGain.gain.setTargetAtTime(wg * 0.55, t, 0.06);
    if (this.bladeGain) this.bladeGain.gain.setTargetAtTime(wg * 0.2, t, 0.06);

    if (this.roarFilter) this.roarFilter.frequency.setTargetAtTime(roarCenterHz(s), t, 0.08);
    if (this.roarGain) this.roarGain.gain.setTargetAtTime(roarGain(s), t, 0.1);

    if (this.rumbleOsc) this.rumbleOsc.frequency.setTargetAtTime(rumbleFreq(s), t, 0.08);
    if (this.rumbleGain) this.rumbleGain.gain.setTargetAtTime(rumbleGain(s), t, 0.12);
  }

  /** 风噪随速度（speedNorm 0~1） */
  updateWind(speedNorm: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const n = Math.min(1, Math.max(0, speedNorm));
    this.windGain.gain.setTargetAtTime(0.09 * n * n, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(400 + n * 1400, t, 0.2);
  }

  /** 胎啸：制动强度 > 0.45 且车速足够时触发 */
  updateSqueal(intensity: number, speedMs: number): void {
    if (!this.ctx || !this.squealGain) return;
    const t = this.ctx.currentTime;
    const active = intensity > 0.45 && speedMs > 4;
    const target = active ? 0.09 * Math.min(1, (intensity - 0.45) / 0.4) : 0;
    this.squealGain.gain.setTargetAtTime(target, t, active ? 0.03 : 0.12);
  }

  /** 回收提示音：再生制动激活沿触发轻双音 */
  updateRegen(active: boolean): void {
    if (active && !this.regenWasActive) {
      this.beep(1180, 0.08, 'sine', 0.06);
      window.setTimeout(() => this.beep(1560, 0.1, 'sine', 0.06), 90);
    }
    this.regenWasActive = active;
  }

  private beep(freq: number, duration: number, type: OscillatorType = 'sine', gain = 0.25): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  private noiseBurst(duration: number, gain: number, filterHz: number): void {
    if (!this.ctx || !this.master) return;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterHz;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start();
  }

  countdownBeep(final: boolean): void {
    this.beep(final ? 880 : 440, final ? 0.5 : 0.15, 'square', 0.2);
  }

  brakeClick(): void {
    this.beep(180, 0.06, 'square', 0.15);
  }

  /** 踏板断裂：高频金属裂音 + 噪声 */
  snap(): void {
    this.beep(1400, 0.12, 'sawtooth', 0.3);
    this.beep(720, 0.3, 'sawtooth', 0.2);
    this.noiseBurst(0.35, 0.35, 3200);
    this.beep(90, 0.5, 'sine', 0.3); // 闷响
  }

  /** 撞击（strength 0~1） */
  impact(strength: number): void {
    this.noiseBurst(0.3 + strength * 0.3, 0.3 + strength * 0.4, 500 + strength * 1500);
    this.beep(70, 0.4, 'sine', 0.35);
  }

  success(): void {
    this.beep(523, 0.14, 'sine', 0.22);
    window.setTimeout(() => this.beep(659, 0.14, 'sine', 0.22), 130);
    window.setTimeout(() => this.beep(784, 0.3, 'sine', 0.24), 260);
  }

  fail(): void {
    this.beep(220, 0.4, 'sawtooth', 0.2);
    window.setTimeout(() => this.beep(160, 0.5, 'sawtooth', 0.2), 200);
  }

  warn(): void {
    this.beep(300, 0.1, 'square', 0.15);
  }

  uiClick(): void {
    this.beep(600, 0.04, 'sine', 0.12);
  }

  /**
   * 起步前空踩点：一次短促 spool blip（涡扇预转），
   * 不是内燃机「轰油门」——音高抬升由 spool 惯性自然带出。
   */
  revBlip(): void {
    this.blip = BLIP_LEVEL;
    if (!this.ctx) return;
    this.spool = spoolStep(this.spool, Math.max(this.spool, BLIP_LEVEL), 1 / 60, true);
    this.applySpool(this.ctx.currentTime);
  }

  setMuted(muted: boolean): boolean {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.6;
    return this.muted;
  }

  dispose(): void {
    try {
      this.windSrc?.stop();
      this.squealSrc?.stop();
      this.roarSrc?.stop();
      this.whineOsc?.stop();
      this.whineDetOsc?.stop();
      this.bladeOsc?.stop();
      this.rumbleOsc?.stop();
    } catch {
      /* 节点未启动时忽略 */
    }
    const nodes: (AudioNode | null)[] = [
      this.windSrc,
      this.windFilter,
      this.windGain,
      this.squealSrc,
      this.squealFilter,
      this.squealGain,
      this.roarSrc,
      this.roarFilter,
      this.roarGain,
      this.whineOsc,
      this.whineDetOsc,
      this.bladeOsc,
      this.whineOscGain,
      this.whineDetGain,
      this.bladeGain,
      this.whineFilter,
      this.bladeFilter,
      this.rumbleOsc,
      this.rumbleFilter,
      this.rumbleGain
    ];
    for (const n of nodes) {
      try {
        n?.disconnect();
      } catch {
        /* 已断开则忽略 */
      }
    }
    this.windSrc = null;
    this.windFilter = null;
    this.windGain = null;
    this.squealSrc = null;
    this.squealFilter = null;
    this.squealGain = null;
    this.roarSrc = null;
    this.roarFilter = null;
    this.roarGain = null;
    this.whineOsc = null;
    this.whineDetOsc = null;
    this.bladeOsc = null;
    this.whineOscGain = null;
    this.whineDetGain = null;
    this.bladeGain = null;
    this.whineFilter = null;
    this.bladeFilter = null;
    this.rumbleOsc = null;
    this.rumbleFilter = null;
    this.rumbleGain = null;
    this.master = null;
    this.spool = 0;
    this.blip = 0;
    this.lastEngineT = 0;
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** 震动反馈（移动端） */
export function vibrate(pattern: number | number[]): void {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}
