/**
 * ★核心新交互：油门滑条 + 刹车滑条（P3 打磨版）。
 * 指针拖动 / 键盘并行输入（W/↑=油门，S/↓/空格=刹车，V=视角）。
 * 滑条输出 0~1 连续值，Game 每帧读取；显示值做 ~10Hz 惯性阻尼，
 * 填充渐变 + 百分比（油门）/当前踏板力 N（刹车，= b×1612）。
 * 所有事件监听进入 cleanup 列表，dispose() 全解绑。
 */
import { BRAKE } from '../config/physics';
import { clamp, damp } from '../util/math';
import { el } from './dom';

export interface SliderCallbacks {
  onCutInBrake: () => void;
  onCameraSwitch: () => void;
}

export class Sliders {
  readonly root: HTMLElement;
  private throttleFill: HTMLElement;
  private brakeFill: HTMLElement;
  private throttlePct: HTMLElement;
  private brakePct: HTMLElement;
  private throttleValue = 0;
  private brakeValue = 0;
  /** 阻尼平滑后的输出值（~10Hz） */
  private smoothThrottle = 0;
  private smoothBrake = 0;
  /** perf-r13：填充高度按「值未变则跳过」门控（稳态时避免逐帧无效 CSSOM 写入） */
  private lastThrottleH = '';
  private lastBrakeH = '';
  private keyThrottle = 0; // 0/1 键盘油门
  private keyBrake = 0; // 0/1 键盘刹车
  private cutInButton: HTMLButtonElement;
  /** 事件解绑清单 */
  private cleanup: Array<() => void> = [];

  constructor(private callbacks: SliderCallbacks) {
    this.root = el('div', 'sliders');

    this.throttleFill = this.buildSlider('油门', 'throttle');
    this.brakeFill = this.buildSlider('刹车', 'brake');
    this.throttlePct = el('div', 'slider-pct mono', '0%');
    this.brakePct = el('div', 'slider-pct mono', '0 N');
    const throttleWrap = this.throttleFill.parentElement!;
    const brakeWrap = this.brakeFill.parentElement!;
    throttleWrap.appendChild(this.throttlePct);
    brakeWrap.appendChild(this.brakePct);

    this.cutInButton = el('button', 'cutin-btn2') as HTMLButtonElement;
    this.cutInButton.type = 'button';
    this.cutInButton.textContent = '切入刹车';
    this.cutInButton.addEventListener('click', () => {
      callbacks.onCutInBrake();
    });

    const hint = el('div', 'slider-hint', 'W/↑ 油门 · S/↓/空格 刹车 · V 视角');
    this.root.append(throttleWrap, brakeWrap, this.cutInButton, hint);
    document.body.appendChild(this.root);

    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => {
      this.keyThrottle = 0;
      this.keyBrake = 0;
    });
  }

  /** 统一登记监听，便于 dispose 全解绑 */
  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.cleanup.push(() => target.removeEventListener(type, fn));
  }

  private buildSlider(label: string, kind: 'throttle' | 'brake'): HTMLElement {
    const wrap = el('div', `slider slider-${kind}`);
    const fill = el('div', 'slider-fill');
    const text = el('div', 'slider-label', label);
    wrap.append(fill, text);
    const onPointer = (e: PointerEvent): void => {
      e.preventDefault();
      // 用滑条自身 rect 归一化（不用 window 尺寸）
      const rect = wrap.getBoundingClientRect();
      const value = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      if (kind === 'throttle') this.throttleValue = value;
      else this.brakeValue = value;
    };
    this.listen(wrap, 'pointerdown', (e) => {
      const pe = e as PointerEvent;
      wrap.setPointerCapture(pe.pointerId);
      onPointer(pe);
    });
    this.listen(wrap, 'pointermove', (e) => {
      const pe = e as PointerEvent;
      if (wrap.hasPointerCapture(pe.pointerId)) onPointer(pe);
    });
    this.listen(wrap, 'pointerup', (e) => {
      const pe = e as PointerEvent;
      if (wrap.hasPointerCapture(pe.pointerId)) wrap.releasePointerCapture(pe.pointerId);
      if (kind === 'throttle') this.throttleValue = 0;
      else this.brakeValue = 0;
    });
    this.listen(wrap, 'pointercancel', () => {
      if (kind === 'throttle') this.throttleValue = 0;
      else this.brakeValue = 0;
    });
    return fill;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keyThrottle = down ? 1 : 0;
        break;
      case 'KeyS':
      case 'ArrowDown':
      case 'Space':
        this.keyBrake = down ? 1 : 0;
        e.preventDefault();
        break;
      case 'KeyV':
        if (down && !e.repeat) this.callbacks.onCameraSwitch();
        break;
    }
  }

  setCutInEnabled(enabled: boolean, highlight: boolean): void {
    this.cutInButton.disabled = !enabled;
    this.cutInButton.classList.toggle('ready', highlight);
  }

  hideCutIn(): void {
    this.cutInButton.style.display = 'none';
  }

  showCutIn(): void {
    this.cutInButton.style.display = '';
  }

  get throttle(): number {
    return Math.max(this.smoothThrottle, this.keyThrottle);
  }

  get brake(): number {
    return Math.max(this.smoothBrake, this.keyBrake);
  }

  get brakePressed(): boolean {
    return this.brake > 0.01;
  }

  /** 刹车段开始后锁定油条显示为 0 */
  lockThrottle(): void {
    this.throttleValue = 0;
  }

  /** 每帧刷新：先做 ~10Hz 阻尼平滑，再更新填充与数值文本 */
  render(dt: number): void {
    this.smoothThrottle = damp(this.smoothThrottle, this.throttleValue, 10, dt);
    this.smoothBrake = damp(this.smoothBrake, this.brakeValue, 10, dt);
    const th = `${this.smoothThrottle * 100}%`;
    if (th !== this.lastThrottleH) {
      this.throttleFill.style.height = th;
      this.lastThrottleH = th;
    }
    const bh = `${this.smoothBrake * 100}%`;
    if (bh !== this.lastBrakeH) {
      this.brakeFill.style.height = bh;
      this.lastBrakeH = bh;
    }
    const tPct = `${Math.round(this.smoothThrottle * 100)}%`;
    if (this.throttlePct.textContent !== tPct) this.throttlePct.textContent = tPct;
    const bN = `${Math.round(this.smoothBrake * BRAKE.breakForceN)} N`;
    if (this.brakePct.textContent !== bN) this.brakePct.textContent = bN;
  }

  reset(): void {
    this.throttleValue = 0;
    this.brakeValue = 0;
    this.keyThrottle = 0;
    this.keyBrake = 0;
    this.smoothThrottle = 0;
    this.smoothBrake = 0;
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.root.remove();
  }
}
