/**
 * WebAudio 程序化音效框架（P3 完整版）：
 * - 电机音：锯齿+正弦叠加随速度（低通扫频），油门映射音量
 * - 风噪：循环白噪声 + 带通，随速度抬升
 * - 胎啸：制动强度超阈值时的摩擦共振音（噪声 + 高 Q 带通）
 * - 回收提示音：再生制动激活沿触发轻双音
 * - 事件音：倒计时哔、断裂脆响+闷响、撞击、成功和弦、UI/警示
 * 全部振荡器/噪声合成，零外部音频文件；循环节点统一在 dispose() 停止断开。
 */
import { VEHICLE } from '../config/physics';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private squealSrc: AudioBufferSourceNode | null = null;
  private squealGain: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
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

  private buildEngine(): void {
    if (!this.ctx || !this.master) return;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 60;
    this.engineSub = this.ctx.createOscillator();
    this.engineSub.type = 'sine';
    this.engineSub.frequency.value = 42;
    this.engineOsc.connect(this.engineFilter);
    this.engineSub.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    this.engineSub.start();
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

    // 风噪：白噪声 + 带通，音量/频率随速度
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

  /** 电机音随速度：基频随速度抬升，音量随油门/速度 */
  updateEngine(speedKmh: number, powered: boolean): void {
    if (!this.ctx || !this.engineGain || !this.engineOsc || !this.engineSub || !this.engineFilter) return;
    const t = this.ctx.currentTime;
    const norm = Math.min(1, speedKmh / VEHICLE.maxSpeedKmh);
    const base = 50 + norm * 220;
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.08);
    this.engineSub.frequency.setTargetAtTime(base * 0.5, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(500 + norm * 2200, t, 0.1);
    const target = powered ? 0.05 + norm * 0.12 : speedKmh > 1 ? 0.02 : 0.0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.12);
  }

  /** 风噪随速度（speedNorm 0~1） */
  updateWind(speedNorm: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const n = Math.min(1, Math.max(0, speedNorm));
    this.windGain.gain.setTargetAtTime(0.11 * n * n, t, 0.15);
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

  revBlip(): void {
    if (!this.ctx || !this.engineOsc) return;
    this.engineOsc.frequency.setTargetAtTime(260, this.ctx.currentTime, 0.02);
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
      this.engineOsc?.stop();
      this.engineSub?.stop();
    } catch {
      /* 节点未启动时忽略 */
    }
    this.windSrc = null;
    this.squealSrc = null;
    this.engineOsc = null;
    this.engineSub = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** 震动反馈（移动端） */
export function vibrate(pattern: number | number[]): void {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}
