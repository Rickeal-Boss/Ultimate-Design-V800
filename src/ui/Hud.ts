/**
 * HUD：速度表 / 踏板力条 / 挡位(单速 D) / 回收功率指示 / 制动温度条 /
 * 得分预览 / 切入刹车按钮 / 5 视角切换按钮组 / 倒计时 / Toast。
 */
import { BRAKE, VEHICLE } from '../config/physics';
import type { CameraMode } from '../render/CameraRig';
import { byId, el, setVisible } from './dom';

export interface HudInput {
  speedKmh: number;
  brakeSeconds: number;
  distanceToBarrier: number;
  pedalForce: number;
  regenPowerKw: number;
  /** 制动盘温度 0~1.5（>1 过热衰减） */
  brakeTemp: number;
  overheat: boolean;
  scorePreview: number;
  canBrake: boolean;
  braking: boolean;
  atLimiter: boolean;
}

export interface HudCallbacks {
  onSelectView?: (mode: CameraMode) => void;
}

/** HUD 视角按钮组（5 视角，crash 为自动机位不设按钮） */
const VIEW_BUTTONS: ReadonlyArray<readonly [CameraMode, string]> = [
  ['chase', '追随'],
  ['hood', '机盖'],
  ['cabin', '车内'],
  ['orbit', '环绕'],
  ['side', '侧跟']
];

export class Hud {
  readonly root: HTMLElement;
  readonly cutInButton: HTMLButtonElement;
  private speed: HTMLElement;
  private gear: HTMLElement;
  private timer: HTMLElement;
  private distance: HTMLElement;
  private regen: HTMLElement;
  private score: HTMLElement;
  private forceFill: HTMLElement;
  private forceValue: HTMLElement;
  private forceBox: HTMLElement;
  private tempFill: HTMLElement;
  private tempValue: HTMLElement;
  private tempBox: HTMLElement;
  private countdown: HTMLElement;
  private toast: HTMLElement;
  private viewButtons = new Map<CameraMode, HTMLButtonElement>();
  private toastTimer = 0;
  private lastSpeedText = '';
  private lastTempText = '';
  /** P4 性能：无门控的 textContent/style 写入会让浏览器做无效排版，
   *  按「值未变则跳过」门控（静态相位/稳态时几乎零 DOM 写入） */
  private textCache = new Map<HTMLElement, string>();
  private lastForceHeight = '';

  private setText(node: HTMLElement, text: string): void {
    if (this.textCache.get(node) !== text) {
      node.textContent = text;
      this.textCache.set(node, text);
    }
  }

  constructor(callbacks: HudCallbacks = {}) {
    this.root = byId('hud');

    const left = el('div', 'hud-left');
    this.speed = el('div', 'hud-speed mono', '0');
    const speedUnit = el('div', 'hud-unit', 'km/h');
    this.gear = el('div', 'hud-gear', 'D');

    // 制动温度条（读 brakeTemp，>1 过热警示「制动衰减」）
    const tempWrap = el('div', 'btemp');
    const tempLabel = el('div', 'btemp-label', '制动温度');
    const tempTrack = el('div', 'btemp-track');
    this.tempFill = el('div', 'btemp-fill');
    this.tempValue = el('div', 'btemp-value mono', '');
    tempTrack.appendChild(this.tempFill);
    tempWrap.append(tempLabel, tempTrack, this.tempValue);
    this.tempBox = tempWrap;

    left.append(this.speed, speedUnit, this.gear, tempWrap);

    const mid = el('div', 'hud-mid');
    this.timer = el('div', 'hud-timer mono', '0.000s');
    this.distance = el('div', 'hud-distance mono', '0m');
    this.regen = el('div', 'hud-regen mono', '回收 0 kW');
    this.score = el('div', 'hud-score mono', '');
    mid.append(this.timer, this.distance, this.regen, this.score);

    const forceWrap = el('div', 'force');
    const forceLabel = el('div', 'force-label', `踏板力（断裂 ${BRAKE.breakForceN} N）`);
    this.forceValue = el('div', 'force-value mono', '0 N');
    const track = el('div', 'force-track');
    this.forceFill = el('div', 'force-fill');
    track.append(this.forceFill);
    forceWrap.append(forceLabel, track, this.forceValue);
    this.forceBox = forceWrap;

    // 视角按钮组（顶部居中）
    const viewGroup = el('div', 'view-group');
    for (const [mode, label] of VIEW_BUTTONS) {
      const btn = el('button', 'view-btn') as HTMLButtonElement;
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.view = mode;
      btn.addEventListener('click', () => callbacks.onSelectView?.(mode));
      viewGroup.appendChild(btn);
      this.viewButtons.set(mode, btn);
    }

    this.countdown = el('div', 'countdown');
    this.toast = el('div', 'toast');

    this.cutInButton = el('button', 'cutin-btn') as HTMLButtonElement;
    this.cutInButton.type = 'button';
    this.cutInButton.textContent = '切入刹车';
    this.cutInButton.disabled = true;

    this.root.append(left, mid, viewGroup, forceWrap, this.countdown, this.toast, this.cutInButton);
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }

  /** 视角高亮同步（V 键循环与结算自动切机位共用） */
  setActiveView(mode: CameraMode): void {
    for (const [m, btn] of this.viewButtons) {
      btn.classList.toggle('active', m === mode);
    }
  }

  update(data: HudInput): void {
    const speedText = `${Math.round(data.speedKmh)}`;
    if (speedText !== this.lastSpeedText) {
      this.speed.textContent = speedText;
      this.lastSpeedText = speedText;
    }
    this.setText(this.timer, `${data.brakeSeconds.toFixed(3)}s`);
    this.setText(this.distance, `${Math.max(0, Math.round(data.distanceToBarrier))}m`);
    this.setText(this.regen, `回收 ${Math.round(data.regenPowerKw)} kW`);
    this.setText(
      this.score,
      data.braking && data.scorePreview > 0 ? `得分预览 ${data.scorePreview}` : ''
    );
    const ratio = Math.min(1, data.pedalForce / BRAKE.breakForceN);
    // 力条高度按 0.5% 步进量化（肉眼不可辨），进一步减少 style 写入
    const height = `calc(${Math.round((ratio * 94) / 0.5) * 0.5}% - 2px)`;
    if (height !== this.lastForceHeight) {
      this.forceFill.style.height = height;
      this.lastForceHeight = height;
    }
    this.setText(this.forceValue, `${Math.round(data.pedalForce)} N`);
    this.forceBox.classList.toggle('danger', ratio > 0.85);
    this.forceBox.classList.toggle('overheat', ratio > 0.7);

    // 制动温度条
    const tempRatio = Math.min(1, data.brakeTemp / 1.5);
    this.tempFill.style.width = `${tempRatio * 100}%`;
    this.tempBox.classList.toggle('hot', data.overheat);
    const tempText = data.overheat ? '制动衰减' : '';
    if (tempText !== this.lastTempText) {
      this.tempValue.textContent = tempText;
      this.lastTempText = tempText;
    }

    this.cutInButton.disabled = !(data.canBrake || data.braking);
    this.cutInButton.classList.toggle('ready', data.canBrake && !data.braking);
    this.cutInButton.classList.toggle('limit', data.atLimiter);
    this.gear.classList.toggle('braking', data.braking);
  }

  showCountdown(text: string | null): void {
    if (text === null) {
      setVisible(this.countdown, false);
      return;
    }
    this.countdown.textContent = text;
    setVisible(this.countdown, false);
    void this.countdown.offsetWidth; // 重启动画
    setVisible(this.countdown, true);
  }

  showToast(text: string, alert = false, duration = 1400): void {
    this.toast.textContent = text;
    this.toast.classList.toggle('alert', alert);
    setVisible(this.toast, true);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => setVisible(this.toast, false), duration);
  }

  hideToast(): void {
    window.clearTimeout(this.toastTimer);
    setVisible(this.toast, false);
  }
}

/** 电子限速提示文案 */
export const LIMIT_HINT = `电子限速 ${VEHICLE.maxSpeedKmh} km/h`;
