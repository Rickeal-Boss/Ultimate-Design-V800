/**
 * R29 · T1 无头仿真：制动单调性扫掠（同源物理，不依赖浏览器）。
 *
 * 运行：
 *   npx vite-node tools/r29_thermal_sweep.ts
 *
 * 口径：
 *  - 入口 200 km/h（VEHICLE.maxSpeedKmh），单把刹停，滑条恒定 b
 *  - 踏板走 BrakeModel.stepPedal（b≥0.98 过载爬升 → 1.77s 断裂 → 冗余 1/4 接管）
 *  - 车辆走 Vehicle.stepVehicle，第 4 参传档位 profile（升温倍率生效）
 *  - 判停：speed ≤ BRAKE.stopSpeed(0.08 m/s)
 *
 * 输出：停稳用时 t(s) / 制动距离 d(m) / 峰值盘温 T / 热切断次数与位置。
 * 判定：stopTime(b) 在 [0.5, 0.97] 单调不增（允许 ≤0.5% 数值抖动）。
 */
import { BRAKE, MS_TO_KMH, VEHICLE } from '../src/config/physics';
import { VEHICLE_PROFILES, type VehicleProfile } from '../src/config/vehicles';
import { createPedalState, redundancyDecel, stepPedal } from '../src/physics/BrakeModel';
import { createVehicleState, stepVehicle } from '../src/physics/Vehicle';

const DT = 1 / 120;
const SWEEP = [0.5, 0.7, 0.85, 0.9, 0.95, 0.97];

export interface SweepRow {
  b: number;
  t: number;
  dist: number;
  maxTemp: number;
  locks: number;
  lockAtPct: number | null;
  lockSpeedKmh: number | null;
  snapped: boolean;
}

/** 单把刹停仿真（profile 决定升温倍率；不传 = 基线 ×1） */
export function brakeRun(b: number, profile?: VehicleProfile): SweepRow {
  const v = createVehicleState();
  v.speed = VEHICLE.maxSpeedKmh / MS_TO_KMH;
  const p = createPedalState();
  const d0 = v.distance;
  let t = 0;
  let seen = 0;
  let maxTemp = 0;
  let lockAtPct: number | null = null;
  let lockSpeedKmh: number | null = null;
  let guard = 0;
  while (v.speed > BRAKE.stopSpeed && t < 120 && guard++ < 120 * 120) {
    stepPedal(p, DT, b, t, profile?.brakeBreakable ?? true);
    stepVehicle(
      v,
      DT,
      {
        throttle: 0,
        brake: b,
        powerCut: true,
        pedalForce: p.pedalForce,
        redundancyDecel: redundancyDecel(p)
      },
      profile
    );
    t += DT;
    maxTemp = Math.max(maxTemp, v.brakeTemp);
    if (v.thermalLocks > seen) {
      seen = v.thermalLocks;
      lockAtPct = (v.distance - d0) / Math.max(1e-9, v.distance - d0); // 占位，循环外重算
      lockSpeedKmh = v.speed * MS_TO_KMH;
      // 锁定里程占比需要总里程，先记分子
      (v as unknown as { __lockDist?: number }).__lockDist = v.distance - d0;
    }
  }
  const total = v.distance - d0;
  const lockDist = (v as unknown as { __lockDist?: number }).__lockDist;
  return {
    b,
    t,
    dist: total,
    maxTemp,
    locks: seen,
    lockAtPct: lockDist == null ? null : lockDist / Math.max(1e-9, total),
    lockSpeedKmh,
    snapped: p.snapped
  };
}

function fmt(x: number | null, n = 2): string {
  return x == null ? '—' : x.toFixed(n);
}

function table(title: string, rows: SweepRow[]): void {
  console.log(`\n=== ${title} ===`);
  console.log('   b  |  用时 s | 距离 m | 峰值T | 热切断 | 切断点 | 切断车速 | 断裂');
  console.log('------+---------+--------+-------+--------+--------+----------+------');
  for (const r of rows) {
    console.log(
      ` ${r.b.toFixed(2)} |  ${fmt(r.t, 3)}  | ${fmt(r.dist, 1)}  | ${fmt(r.maxTemp, 3)} |` +
        `   ${String(r.locks).padStart(2)}   | ${(r.lockAtPct == null ? '—' : (r.lockAtPct * 100).toFixed(0) + '%').padStart(6)} |` +
        ` ${fmt(r.lockSpeedKmh, 1).padStart(7)}  | ${r.snapped ? 'Y' : 'n'}`
    );
  }
}

/** 单调性判定：允许 ≤0.5% 抖动 */
export function checkMonotonic(rows: SweepRow[], tol = 0.005): { ok: boolean; worst: number; at: string } {
  let worst = 0;
  let at = '';
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].t;
    const cur = rows[i].t;
    const slack = prev * tol;
    if (cur - prev > worst) {
      worst = cur - prev;
      at = `b ${rows[i - 1].b} → ${rows[i].b}`;
    }
    if (cur > prev + slack) {
      return { ok: false, worst: cur - prev, at: `b ${rows[i - 1].b} → ${rows[i].b}` };
    }
  }
  return { ok: true, worst, at };
}

function main(): void {
  const v800 = VEHICLE_PROFILES.v800;
  const r7 = VEHICLE_PROFILES.r7;
  console.log(
    `常量：brakeTempGain=${BRAKE.brakeTempGain.toExponential(4)} · ` +
      `V800.brakeTempGainScale=${v800.brakeTempGainScale} · R7.brakeTempGainScale=${r7.brakeTempGainScale}`
  );

  const base = SWEEP.map((b) => brakeRun(b, undefined));
  table('基线（升温 ×1，即不传 profile 的旧语义）', base);
  const m0 = checkMonotonic(base);
  console.log(`单调性：${m0.ok ? 'PASS' : 'FAIL'}（最大增量 ${m0.worst.toFixed(4)}s @ ${m0.at}）`);

  const v800Rows = SWEEP.map((b) => brakeRun(b, v800));
  table('V800 档（profile.brakeTempGainScale 生效）', v800Rows);
  const m1 = checkMonotonic(v800Rows);
  console.log(`单调性：${m1.ok ? 'PASS' : 'FAIL'}（最大增量 ${m1.worst.toFixed(4)}s @ ${m1.at}）`);
  const r90 = v800Rows.find((r) => r.b === 0.9)!;
  const r97 = v800Rows.find((r) => r.b === 0.97)!;
  console.log(`比值 t(0.97)/t(0.90) = ${(r97.t / r90.t).toFixed(4)}（契约 ≤1.02）`);

  const r7Rows = SWEEP.map((b) => brakeRun(b, r7));
  table('R7 档（回归：不得被本次改动波及）', r7Rows);
}

main();
