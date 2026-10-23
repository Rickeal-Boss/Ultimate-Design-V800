/**
 * 结算：成功 / 踏板断裂 / 撞主殿三种文案 + 曲线图（踏板力/速度/距离）
 * + 本机最佳成绩（localStorage）。
 * 曲线图移植原版 $g（新增距离曲线）。
 * R28：内部 CrashReason 仍冻结为 'barrier'（tests 断言），用户文案已换皮「撞上主殿」。
 */
import { BRAKE } from '../config/physics';
import { getVehicleProfile, resolveVehicleId, type VehicleId } from '../config/vehicles';
import type { RunResult } from '../core/StateMachine';
import { byId, el, setVisible } from './dom';

const COLOR_SPEED = '#f1dcae';
const COLOR_FORCE = '#ff6a3d';
const COLOR_DIST = '#5fe0a0';
const COLOR_LINE = 'rgba(255,255,255,0.08)';
const COLOR_LABEL = 'rgba(245,239,230,0.55)';

const BEST_KEY = 'brake-v800:best';
/**
 * 本机最佳成绩按车型分桶（R15-4）：V800 沿用原 key 保住历史记录，
 * R7 物理完全不同（60 倍以上的制动距离差），混在一张榜上没有可比性。
 */
export function bestKeyFor(id: VehicleId): string {
  return id === 'v800' ? BEST_KEY : `${BEST_KEY}:${id}`;
}

/** 网格步长（原版 Qg） */
function niceStep(range: number, targetTicks: number): number {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

function drawChart(canvas: HTMLCanvasElement, samples: RunResult['samples'], snapped: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0 || samples.length < 2) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const margin = { l: 34, r: 46, t: 10, b: 20 };
  const plotW = w - margin.l - margin.r;
  const plotH = h - margin.t - margin.b;
  const tMax = Math.max(0.5, samples[samples.length - 1].t);
  const speedMax = Math.max(50, Math.ceil(Math.max(...samples.map((s) => s.speedKmh)) / 50) * 50);
  const forceMax = Math.ceil(BRAKE.breakForceN * 1.08 / 100) * 100;
  const distMax = Math.max(10, Math.ceil(samples[samples.length - 1].distance * 1.08));

  const x = (t: number): number => margin.l + (t / tMax) * plotW;
  const ySpeed = (v: number): number => margin.t + plotH - (v / speedMax) * plotH;
  const yForce = (v: number): number => margin.t + plotH - (v / forceMax) * plotH;
  const yDist = (v: number): number => margin.t + plotH - (v / distMax) * plotH;

  ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
  ctx.lineWidth = 1;
  const speedStep = niceStep(speedMax, 4);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= speedMax + 1e-6; v += speedStep) {
    ctx.strokeStyle = COLOR_LINE;
    ctx.beginPath();
    ctx.moveTo(margin.l, ySpeed(v));
    ctx.lineTo(margin.l + plotW, ySpeed(v));
    ctx.stroke();
    ctx.fillStyle = COLOR_SPEED;
    ctx.globalAlpha = 0.75;
    ctx.fillText(`${v}`, margin.l - 5, ySpeed(v));
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'left';
  for (const [v, color] of [
    [forceMax, COLOR_FORCE],
    [distMax, COLOR_DIST]
  ] as const) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.fillText(`${v}`, margin.l + plotW + 5, (v === forceMax ? yForce : yDist)(v));
    ctx.globalAlpha = 1;
  }
  const tStep = niceStep(tMax, 5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR_LABEL;
  for (let t = 0; t <= tMax + 1e-6; t += tStep) {
    ctx.fillText(`${Number(t.toFixed(2))}s`, x(t), margin.t + plotH + 5);
  }

  const fillArea = (fy: (s: (typeof samples)[number]) => number, color: string): void => {
    const grad = ctx.createLinearGradient(0, margin.t, 0, margin.t + plotH);
    grad.addColorStop(0, `${color}55`);
    grad.addColorStop(1, `${color}00`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x(samples[0].t), margin.t + plotH);
    for (const s of samples) ctx.lineTo(x(s.t), fy(s));
    ctx.lineTo(x(samples[samples.length - 1].t), margin.t + plotH);
    ctx.closePath();
    ctx.fill();
  };
  const stroke = (fy: (s: (typeof samples)[number]) => number, color: string, width: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    samples.forEach((s, i) => (i === 0 ? ctx.moveTo(x(s.t), fy(s)) : ctx.lineTo(x(s.t), fy(s))));
    ctx.stroke();
  };

  fillArea((s) => yDist(s.distance), COLOR_DIST);
  fillArea((s) => yForce(s.force), COLOR_FORCE);
  fillArea((s) => ySpeed(s.speedKmh), COLOR_SPEED);
  stroke((s) => yDist(s.distance), COLOR_DIST, 1.4);
  stroke((s) => yForce(s.force), COLOR_FORCE, 1.8);
  stroke((s) => ySpeed(s.speedKmh), COLOR_SPEED, 2.2);

  // 终点标记：断裂打叉 / 成功打点
  const last = samples[samples.length - 1];
  if (snapped) {
    const px = x(last.t);
    const py = yForce(last.force);
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(px - 5, py - 5);
    ctx.lineTo(px + 5, py + 5);
    ctx.moveTo(px + 5, py - 5);
    ctx.lineTo(px - 5, py + 5);
    ctx.stroke();
  } else {
    ctx.fillStyle = COLOR_DIST;
    ctx.beginPath();
    ctx.arc(x(last.t), ySpeed(0), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export class Result {
  readonly root: HTMLElement;
  private lastResult: RunResult | null = null;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private statsGrid: HTMLElement;
  private chartCanvas: HTMLCanvasElement;
  private bestLabel: HTMLElement;
  private retryButton: HTMLButtonElement;
  /** 当前车型（结算文案 + 最佳成绩分桶） */
  readonly vehicleId: VehicleId;
  /** 窗口事件句柄（dispose 时统一解绑，避免 HMR 累积泄漏——审查 B-2） */
  private readonly onResize = (): void => this.redraw();

  constructor(onRetry: () => void, onClick: () => void) {
    this.root = byId('result');
    this.vehicleId = resolveVehicleId();
    const panel = el('div', 'panel result-panel');
    this.title = el('h2', 'result-title', '');
    this.subtitle = el('div', 'result-sub', '');
    this.statsGrid = el('div', 'result-stats');
    const chartBox = el('div', 'chart-box');
    const chartLabel = el('div', 'chart-label', '制动过程曲线：速度 / 踏板力 / 距离');
    this.chartCanvas = el('canvas', 'chart') as HTMLCanvasElement;
    chartBox.append(chartLabel, this.chartCanvas);
    this.bestLabel = el('div', 'best-label mono', '');
    this.retryButton = el('button', 'btn primary') as HTMLButtonElement;
    this.retryButton.type = 'button';
    this.retryButton.textContent = '再来一次';
    panel.append(this.title, this.subtitle, this.statsGrid, chartBox, this.bestLabel, this.retryButton);
    this.root.append(panel);
    this.retryButton.addEventListener('click', () => {
      onClick();
      onRetry();
    });
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    window.addEventListener('resize', this.onResize);
  }

  /** 解绑窗口监听（Game.dispose 调用；HMR 时不累积泄漏） */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  show(result: RunResult): void {
    this.lastResult = result;
    const carName = getVehicleProfile(this.vehicleId).name;
    if (result.success) {
      this.title.textContent = '刹停成功';
      this.title.className = 'result-title ok';
      this.subtitle.textContent = `稳稳停住，${carName} 毫发无损`;
    } else if (result.reason === 'brake_pedal_failed') {
      // 决策①：冗余刹停 = 判负（制动系统已失效，「侥幸逃生」≠ 成功刹停）
      this.title.textContent = '踏板断裂 · 冗余刹停';
      this.title.className = 'result-title warn';
      this.subtitle.textContent = `踏板在 ${BRAKE.breakForceN} N 处断裂，紧急制动安全冗余以 25% 力度把车拖停 —— 判负`;
    } else {
      this.title.textContent = '撞上主殿';
      this.title.className = 'result-title fail';
      this.subtitle.textContent = '没能在主殿前刹停，再果断一点';
    }
    const hasRun = result.v0Kmh > 0;
    const stats: Array<[string, string]> = [
      ['初速度', hasRun ? `${result.v0Kmh.toFixed(1)} km/h` : '-'],
      ['制动用时', hasRun ? `${result.stopSeconds.toFixed(3)} s` : '-'],
      ['制动距离', hasRun ? `${result.stopDistance.toFixed(1)} m` : '-'],
      ['峰值踏板力', hasRun ? `${Math.round(result.peakForce)} N` : '-'],
      ['得分', result.degraded ? `${result.score}（判负）` : `${result.score}`]
    ];
    if (result.degraded) {
      stats.push(
        ['断裂时刻', result.snapTime !== null ? `${result.snapTime.toFixed(2)} s` : '-'],
        [
          '冗余制动距离',
          result.redundancyDistance !== null ? `${result.redundancyDistance.toFixed(1)} m` : '-'
        ]
      );
    }
    this.statsGrid.innerHTML = '';
    for (const [label, value] of stats) {
      const cell = el('div', 'stat');
      cell.append(el('div', 'stat-label', label), el('div', 'stat-value mono', value));
      this.statsGrid.append(cell);
    }

    // 本机最佳（仅成功计）。localStorage 容错：Safari 无痕/禁用存储时静默降级不崩结算
    const key = bestKeyFor(this.vehicleId);
    const readBest = (): number => {
      try {
        return Number(window.localStorage.getItem(key) ?? 0);
      } catch {
        return 0;
      }
    };
    const writeBest = (v: number): void => {
      try {
        window.localStorage.setItem(key, `${v}`);
      } catch {
        /* 存储不可用时忽略 */
      }
    };
    if (result.success) {
      const prev = readBest();
      if (result.score > prev) writeBest(result.score);
      const best = Math.max(prev, result.score);
      this.bestLabel.textContent = best > 0 ? `本机最佳 ${best} 分` : '';
    } else {
      const best = readBest();
      this.bestLabel.textContent = best > 0 ? `本机最佳 ${best} 分` : '';
    }

    setVisible(this.root, true);
    requestAnimationFrame(() => this.redraw());
  }

  private redraw(): void {
    if (!this.lastResult || this.root.classList.contains('hidden')) return;
    if (this.lastResult.samples.length < 2) return;
    drawChart(this.chartCanvas, this.lastResult.samples, this.lastResult.degraded);
  }

  hide(): void {
    setVisible(this.root, false);
  }
}
