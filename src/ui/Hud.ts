/**
 * HUD：速度表 / 踏板力条 / 挡位(单速 D) / 回收功率指示 / 制动温度条 /
 * 得分预览 / 切入刹车按钮 / 5 视角切换按钮组 / 倒计时 / Toast。
 */
import { BRAKE, VEHICLE } from '../config/physics';
import { resolveVehicleId, type VehicleId } from '../config/vehicles';
import type { CameraMode } from '../render/CameraRig';
import { byId, el, setVisible } from './dom';

export interface HudInput {
  speedKmh: number;
  brakeSeconds: number;
  /** 距撞击面剩余 m（R28 语义=距主殿正面；HUD 只显示纯数值，字段名可不动） */
  distanceToBarrier: number;
  pedalForce: number;
  regenPowerKw: number;
  /** 制动盘温度 0~1.5（>1 过热衰减） */
  brakeTemp: number;
  overheat: boolean;
  /**
   * 热保护剩余锁定秒数（>0 = 机械制动力被切断，显示红区倒计时条）。
   * Game.ts 接线（主理人补）：`thermalHold: vehicle.thermalHold,`
   * 未接线时按 0 处理，仅失去红区提示，物理不受影响。
   */
  thermalHold?: number;
  scorePreview: number;
  canBrake: boolean;
  braking: boolean;
  atLimiter: boolean;
  /** 踏板断裂后冗余制动已接管（踏板力条置灰 + 「踏板脱开」文案） */
  redundancy: boolean;
}

export interface HudCallbacks {
  onSelectView?: (mode: CameraMode) => void;
}

/**
 * HUD 视角按钮组（5 视角，crash 为自动机位不设按钮）。
 * V800：追随 / 机盖 / 车内 / 环绕 / 侧跟。
 */
const VIEW_BUTTONS: ReadonlyArray<readonly [CameraMode, string]> = [
  ['chase', '追随'],
  ['hood', '机盖'],
  ['cabin', '车内'],
  ['orbit', '环绕'],
  ['side', '侧跟']
];

/**
 * R7 追加三个内饰机位（智界R7 装配提供 driver/passenger/rear 眼点）。
 * 「切车不存在的按钮不渲染」：V800 下这三个按钮根本不会进 DOM，
 * 避免用户点到一台不存在的机位（CameraRig 会退回 cabin 偏移 ≡「看到 V800 车内」，
 * 那属于误导）。
 */
const VIEW_BUTTONS_R7: ReadonlyArray<readonly [CameraMode, string]> = [
  ['chase', '追随'],
  ['hood', '机盖'],
  ['cabinDriver', '主驾'],
  ['cabinPassenger', '副驾'],
  ['cabinRear', '后排'],
  ['orbit', '环绕'],
  ['side', '侧跟']
];

/** 纯函数（可单测）：按车型给出该渲染哪些视角按钮 */
export function viewButtonsFor(id: VehicleId): ReadonlyArray<readonly [CameraMode, string]> {
  return id === 'r7' ? VIEW_BUTTONS_R7 : VIEW_BUTTONS;
}

/**
 * 热保护提示文案（纯函数，可单测）。
 * 用户规格：「制动盘过热 · 冷却中 2.0s」——倒计时保留 1 位小数，0 时长不显示。
 */
export function thermalBannerText(holdSeconds: number): string {
  const clamped = Math.max(0, holdSeconds);
  return `制动盘过热 · 冷却中 ${clamped.toFixed(1)}s`;
}

/** 热保护副标题：解释「为什么踩了没力」 */
export const THERMAL_BANNER_HINT = '热保护切断机械制动 · 踏板暂时无效';

/**
 * 热保护样式（styles.css 不在本轮改动白名单内，故从 Hud 自注入；
 * 用 id 去重，HMR 重复构造不会叠加）。
 */
const THERMAL_STYLE_ID = 'hud-thermal-style';
function ensureThermalStyle(): void {
  if (document.getElementById(THERMAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = THERMAL_STYLE_ID;
  style.textContent = `
.hud-thermal {
  position: absolute;
  left: 50%;
  top: 30%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 26px;
  border-radius: 12px;
  background: rgba(120, 12, 8, 0.86);
  border: 1px solid #ff5a3c;
  box-shadow: 0 0 26px rgba(255, 60, 30, 0.55);
  animation: thermal-flash 0.7s steps(2, end) infinite;
  pointer-events: none;
}
.hud-thermal .ht-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 2px;
  color: #fff;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.65);
  font-variant-numeric: tabular-nums;
}
.hud-thermal .ht-sub {
  font-size: 12px;
  letter-spacing: 1px;
  color: #ffd9cf;
  opacity: 0.9;
}
.btemp.thermal .btemp-fill {
  background: #ff3b1f;
  box-shadow: 0 0 14px #ff3b1f;
  animation: thermal-bar 0.5s ease-in-out infinite alternate;
}
.btemp.thermal .btemp-label {
  color: #ff3b1f;
  opacity: 1;
}
@keyframes thermal-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.58; }
}
@keyframes thermal-bar {
  from { opacity: 0.5; }
  to { opacity: 1; }
}
`;
  document.head.appendChild(style);
}

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
  private redundancyBadge: HTMLElement;
  private thermalBanner: HTMLElement;
  private thermalTitle: HTMLElement;
  private viewButtons = new Map<CameraMode, HTMLButtonElement>();
  private toastTimer = 0;
  private lastSpeedText = '';
  private lastTempText = '';
  private lastTempWidth = '';
  /** 热保护提示的显示态（只在切换瞬间写 DOM） */
  private thermalActive = false;
  /** P4 性能：无门控的 textContent/style 写入会让浏览器做无效排版，
   *  按「值未变则跳过」门控（静态相位/稳态时几乎零 DOM 写入） */
  private textCache = new Map<HTMLElement, string>();
  private lastForceHeight = '';
  /** 当前车型（决定渲染哪些视角按钮；一局内不变） */
  readonly vehicleId: VehicleId;

  private setText(node: HTMLElement, text: string): void {
    if (this.textCache.get(node) !== text) {
      node.textContent = text;
      this.textCache.set(node, text);
    }
  }

  constructor(callbacks: HudCallbacks = {}) {
    this.root = byId('hud');
    this.vehicleId = resolveVehicleId();

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

    // 视角按钮组（顶部居中）；V800 5 个 / R7 7 个（多三个内饰机位）
    const viewGroup = el('div', 'view-group');
    for (const [mode, label] of viewButtonsFor(this.vehicleId)) {
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

    // 安全冗余徽标（踏板断裂后常驻，脉动提示「在刹，但不是你踩的」）
    this.redundancyBadge = el('div', 'redundancy-badge hidden', '安全冗余 25%');

    // 热保护提示（制动盘红区 → 机械制动力切断 2s，中央红条闪烁 + 倒计时）
    ensureThermalStyle();
    this.thermalBanner = el('div', 'hud-thermal hidden');
    this.thermalTitle = el('div', 'ht-title', thermalBannerText(0));
    const thermalSub = el('div', 'ht-sub', THERMAL_BANNER_HINT);
    this.thermalBanner.append(this.thermalTitle, thermalSub);

    this.root.append(
      left,
      mid,
      viewGroup,
      forceWrap,
      this.countdown,
      this.toast,
      this.redundancyBadge,
      this.thermalBanner,
      this.cutInButton
    );
  }

  /** 踏板断裂 → 冗余制动接管：徽标常驻、踏板力条置灰显示「踏板脱开」 */
  setRedundancyActive(active: boolean): void {
    setVisible(this.redundancyBadge, active);
    this.forceBox.classList.toggle('snapped', active);
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
    // 断裂后踏板力恒为 0，直接显示「0 N」会让玩家误以为没在刹车 → 改文案并置灰
    // 热保护锁定期同理：踏板力还在（demand 照记），但机械制动被切断，必须说清
    const hold = Math.max(0, data.thermalHold ?? 0);
    const thermal = hold > 0;
    if (thermal) {
      this.setText(this.forceValue, '热保护切断');
    } else if (data.redundancy) {
      this.setText(this.forceValue, '踏板脱开');
    } else {
      this.setText(this.forceValue, `${Math.round(data.pedalForce)} N`);
    }
    this.forceBox.classList.toggle('danger', !data.redundancy && !thermal && ratio > 0.85);
    this.forceBox.classList.toggle('overheat', !data.redundancy && !thermal && ratio > 0.7);

    // 制动温度条
    // 量程以红区（thermalTriggerTemp）为满格：温度条「触顶」= 热保护切断，
    // 与中央提示同帧发生；旧量程 1.5 会让条子在 67% 就锁定，玩家看不出「顶」在哪。
    const tempRatio = Math.min(1, data.brakeTemp / BRAKE.thermalTriggerTemp);
    // perf-r13：style 写入同样按「值未变则跳过」门控（加速段温度恒 0，
    // 原先每帧无条件写 width 是整条 HUD 唯一漏网的逐帧 CSSOM 写入）
    const tempWidth = `${tempRatio * 100}%`;
    if (tempWidth !== this.lastTempWidth) {
      this.tempFill.style.width = tempWidth;
      this.lastTempWidth = tempWidth;
    }
    this.tempBox.classList.toggle('hot', data.overheat);
    this.tempBox.classList.toggle('thermal', thermal);
    const tempText = thermal ? '热保护切断' : data.overheat ? '制动衰减' : '';
    if (tempText !== this.lastTempText) {
      this.tempValue.textContent = tempText;
      this.lastTempText = tempText;
    }

    // 热保护红条 + 倒计时（只在进入/退出瞬间写显隐，文字按 0.1s 步进缓存）
    if (thermal !== this.thermalActive) {
      this.thermalActive = thermal;
      setVisible(this.thermalBanner, thermal);
    }
    if (thermal) this.setText(this.thermalTitle, thermalBannerText(hold));

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
