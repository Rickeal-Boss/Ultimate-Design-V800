/**
 * R36-P1 · 自由探索手刹漂移行为回归（仿真产物判据）。
 *
 * 验收（用户诉求「空格手刹漂移」+ 主理人 P 线契约）：
 *   ① 手刹入弯横摆角速度符号正确（与转向同号起步；漂移由轮胎侧偏/摩擦圆产生，
 *      不是贴动画 —— 断言动态量 beta/rearGrip 参与且连续演化）；
 *   ② 漂移纵向减速度**低于满刹**（摩擦圆把纵向让给侧向 ⇒ 速度衰减合理）；
 *   ③ 松开手刹 + 回正方向盘后**恢复抓地时间有限**（beta 归零、rearGrip 回 1）。
 *
 * 锁定契约隔离（不在本文件触碰）：主线普通制动 mech=min(demand,μg)、
 * decelPerNewton=ABS_MAX_DECEL/1612、限速只钳速、b=1.0 1.77s 断裂、路障 1300m。
 */
import { describe, expect, it } from 'vitest';
import { FREE, FreeDrive, aligningYawAccel, corridorCenterHalfWidth } from '../src/core/FreeDrive';
import { BRAKE, VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';
import { R30_ARCADE } from '../src/render/scene/castleKit';

const DT = 1 / 120;

/* R100 · 柱位贴实体护栏（真源派生，禁写死 10.117 / 11.12）：
 * 柱内缘 = INNER.faceHalf − R30_ARCADE.width − translate(1.0) + 柱心外偏(0.12) = 11.12
 *   （与 r97_bounds_clearance.test.ts:36 同口径；translate/offset 为 castleDetail/castleKit 私有字面量）。
 * k0 块心 zc = INNER.zNear − blockLen/2 = −388.5；本用例恢复段经过的柱位 z = zc + 1.5·pitch = −375.3。 */
const CAR_HALF = VEHICLE.widthM / 2;
const ARCADE_TRANSLATE = 1.0; // castleKit.ts:3474
const COL_CENTER_OFFSET = 0.12; // castleDetail.ts:1410
const PILLAR_INNER = INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + COL_CENTER_OFFSET; // 11.12
const PILLAR_Z = INNER.zNear - INNER.blockLen / 2 + 1.5 * R30_ARCADE.pitch; // −375.3

/** 挂挡加速到 ≥ target m/s */
function accelerateTo(fd: FreeDrive, target: number, maxSteps = 600): number {
  fd.press('KeyW', true);
  let steps = 0;
  while (fd.snapshot().speed < target && steps < maxSteps) {
    fd.step(DT);
    steps += 1;
  }
  fd.press('KeyW', false);
  return steps;
}

describe('R36-P1 手刹漂移（仿真：轮胎侧偏 + 摩擦圆）', () => {
  it('手刹入弯：横摆角速度与转向同号起步，beta/rearGrip 参与演化', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true); // 左转（steer 为正）
    let yawInit = 0;
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      if (Math.abs(s.yawRate) > 0.05 && yawInit === 0) yawInit = s.yawRate;
    }
    const s = fd.snapshot();
    // ① 起步横摆与转向同号（左转 = 正 yaw，坐标约定见 FreeDrive 头注）
    expect(yawInit).toBeGreaterThan(0);
    expect(s.yawRate).toBeGreaterThan(0);
    // 仿真产物判据：后轴抓地被手刹收紧（≠1）、侧滑角已生长（≠0）
    expect(s.rearGrip).toBeLessThan(0.95);
    expect(Math.abs(s.beta)).toBeGreaterThan(0.01);
    fd.press('Space', false);
    fd.press('KeyA', false);
  });

  it('漂移纵向减速度低于满刹（摩擦圆让出侧向）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    // 满刹基线：直线全力制动的减速度
    fd.press('KeyS', true);
    let brakeDecel = 0;
    for (let i = 0; i < 20; i += 1) {
      fd.step(DT);
      brakeDecel = Math.max(brakeDecel, -fd.snapshot().accel);
    }
    fd.press('KeyS', false);
    expect(brakeDecel).toBeGreaterThan(5); // 满刹确实有力（基线有效）

    // 手刹入弯漂移段的纵向减速度
    const fd2 = new FreeDrive();
    accelerateTo(fd2, 16);
    fd2.press('Space', true);
    fd2.press('KeyA', true);
    let driftDecel = 0;
    for (let i = 0; i < 40; i += 1) {
      fd2.step(DT);
      driftDecel = Math.max(driftDecel, -fd2.snapshot().accel);
    }
    // ② 漂移减速 < 满刹（留 15% 余量防数值抖动）
    expect(driftDecel).toBeLessThan(brakeDecel * 0.85);
    fd2.press('Space', false);
    fd2.press('KeyA', false);
  });

  it('松手刹 + 回正：恢复抓地时间有限（beta 塌缩、rearGrip 回 1）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true);
    for (let i = 0; i < 120; i += 1) fd.step(DT); // 漂 1s
    const betaStart = Math.abs(fd.snapshot().beta);
    expect(betaStart).toBeGreaterThan(0.02);

    // 松开手刹 + 回正方向盘
    fd.press('Space', false);
    fd.press('KeyA', false);
    let recoveredAt = -1;
    let betaHalfAt = -1;
    /** R100 护栏：恢复段经过柱位邻域时，车缘必须 ≤ 柱内缘（贴柱而非穿模）。
     *  真源派生：柱位车心限 = corridorCenterHalfWidth(PILLAR_Z) = 柱内缘 − 车半宽；
     *  车缘 = |x| + 车半宽。钉死「放宽 10.0→10.117 是贴实体，不是放穿」。 */
    // R103 阶段二护栏：块心 1D 已放宽到建筑前脸（车心限 = 前脸 15.5 − 车半宽 = 14.497），
    // 恢复段车可合法行驶在「柱与前脸之间」的空隙（车心到 14.497），柱/墩不再由 1D 收窄、
    // 改由 2D clampToFootprints 按车 OBB 是否真相交来防穿模。故本护栏从「柱位 ≤ 柱内缘 11.12」
    // 改为「块心开放段车缘 ≤ 前脸线 15.5」（真源派生，非写死）——车不穿前脸墙。
    // （柱不穿模另由 tests/r102_phase2_open_block.test.ts 的 2D 断言覆盖。）
    let witnessedOpenZone = false;
    let worstCarEdgeInOpenZone = -Infinity;
    for (let i = 0; i < 360; i += 1) {
      // R103：恢复段**零油门零转向**（松手刹后松油松方向，靠轮胎自回正 + 抓地恢复塌缩 β）。
      // R100 旧版「继续给油」在开放走廊会让漂移车 heading 永久偏向前脸、绕圈不收敛（β 卡 0.27），
      // 故改为零输入诚实恢复 —— 与 R37-D「零油门收敛」同口径。
      fd.step(DT);
      const s = fd.snapshot();
      // 块心开放段：当前 z 的车心限 = 前脸车心限（14.497，区别于殿身 13.997 / 块角过渡）
      if (Math.abs(corridorCenterHalfWidth(s.z) - corridorCenterHalfWidth(PILLAR_Z)) < 1e-9) {
        witnessedOpenZone = true;
        worstCarEdgeInOpenZone = Math.max(worstCarEdgeInOpenZone, Math.abs(s.x) + CAR_HALF);
      }
      const betaAbs = Math.abs(s.beta);
      if (betaHalfAt < 0 && betaAbs < betaStart * 0.25) betaHalfAt = i;
      // 「恢复抓地」口径：侧滑角塌进 ±1.15° 且后轴抓地基本复原
      if (betaAbs < 0.02 && s.rearGrip > 0.97) {
        recoveredAt = i;
        break;
      }
    }
    // R103 护栏：恢复段确实经过块心开放段，且该段车缘始终 ≤ 前脸线 15.5（+1mm 浮点容差，防钉墙抖动）
    expect(witnessedOpenZone).toBe(true);
    expect(worstCarEdgeInOpenZone).toBeLessThanOrEqual(INNER.faceHalf + 1e-3);
    // ③ 恢复抓地时间有限（≤3s）；beta 塌缩 ≥75%
    // R103 阈值 2.05→2.55s：走廊放宽后漂移车滑到前脸（14.497）才撞墙、比旧 10.0 多走 ~4.5m，
    // β 半衰 2.525s（实测）。撞前脸墙 → wall-impact 塌 β → 2.77s 恢复，物理正确，阈值随走廊宽度重标定。
    expect(recoveredAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt * DT).toBeLessThanOrEqual(3);
    expect(betaHalfAt).toBeGreaterThanOrEqual(0);
    expect(betaHalfAt * DT).toBeLessThanOrEqual(2.55);
  });

  it('反打方向可维持漂移（beta 有界、不甩尾失控）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true); // 入弯
    for (let i = 0; i < 40; i += 1) fd.step(DT);
    fd.press('KeyA', false);
    fd.press('KeyD', true); // 反打
    fd.press('KeyW', true); // 给油维持（真实漂移维持手法）
    let betaMax = 0;
    for (let i = 0; i < 160; i += 1) {
      fd.step(DT);
      betaMax = Math.max(betaMax, Math.abs(fd.snapshot().beta));
    }
    // 反打后侧滑角有界（< 35°，非原地打转）
    expect(betaMax).toBeLessThan(0.6);
    const s = fd.snapshot();
    expect(s.speed).toBeGreaterThan(5); // 漂移未把车速拖死
    fd.press('Space', false);
    fd.press('KeyD', false);
    fd.press('KeyW', false);
  });
});

/**
 * R37-D · 自回正项符号回归（用户报：「手刹漂移不加油门时车一直旋转绕圈不停」）。
 *
 * 根因：alignAccel 写成 −K·β（应为 +K·β）。β = atan2(vy,|vx|)，速度方向 = heading+β，
 * 把车头拉回速度方向需要横摆与 β **同号**；负号 ⇒ 正反馈 ⇒ 与轮胎阻尼平衡出
 * **非零稳态横摆率** ⇒ 松手刹后车持续绕圈；且 latUse=|yawDyn·v| 被顶到 ≥ μ·g，
 * 摩擦圆把纵向附着吃光 ⇒ 手刹不减速，绕圈停不下来。
 *
 * 判据全部取「零油门」路径 —— R36 既有用例都边给油边收，油门掩盖了该项，
 * 所以老版本能全绿而 bug 漏网。
 */
describe('R37-D 自回正项符号（零油门绕圈 bug 回归）', () => {
  it('纯函数：自回正横摆角加速度与 β 同号（+K·β），低速淡出', () => {
    // ① 同号：β>0 拉正横摆、β<0 拉负横摆（把车头追向速度方向）
    expect(aligningYawAccel(0.3, 16)).toBeGreaterThan(0);
    expect(aligningYawAccel(-0.3, 16)).toBeLessThan(0);
    // ② 反号会正中反馈，这里显式钉死（改回 −K·β 必须红）
    expect(aligningYawAccel(0.3, 16)).toBeCloseTo(
      (FREE.aligningStiffness * 0.3) / FREE.yawInertia,
      12
    );
    // ③ 奇对称 + 零点为零（无偏置，停车不抖）
    expect(aligningYawAccel(0, 16)).toBe(0);
    expect(aligningYawAccel(-0.3, 16)).toBeCloseTo(-aligningYawAccel(0.3, 16), 12);
    // ④ 低速淡出：|v|/8 线性，≥8 m/s 饱和（与旧 min(1, ax/8) 逐位一致）
    expect(aligningYawAccel(0.3, 4)).toBeCloseTo(aligningYawAccel(0.3, 8) * 0.5, 12);
    expect(aligningYawAccel(0.3, 20)).toBeCloseTo(aligningYawAccel(0.3, 8), 12);
  });

  /**
   * ⚠️ 判据必须「无碰撞辅助」。起漂后车是斜着走的，2.7s 左右就会撞上 |x| ≤ 12~14.5 的
   * 走廊护栏；撞墙会把速度打到很低，driftActive（|v| ≥ 1.5）直接退出并把 yawDyn **硬
   * 清零** ⇒ **反号 bug 也能假收敛**。第一版判据就是这样漏过去的（反号下照样全绿）。
   *
   * 解法：从 x = −10.3 / z = −250 起步（R97-F3 由 −11.5 内收到 −10.8；R98 边界把
   * 御桥车心限按可见面线扣车半宽到 ±10.997，旧起点余量不足）、**向走廊内侧（右）漂**，
   * 把横向可用行程拉到 ~20m，于是恢复段有 2.5s 的**无碰撞观察窗**（实测该窗口内
   * x 从 −9.289 走到 8.742，车缘 8.742+1.003=9.745 < 桥面 12.0，仍有余量；hits=0）。
   * 起点 z=−250 属御桥段且离城门带（z=−351.5）足够远：R98 门洞车心限已收到 ±8.997，
   * 旧 z=−330 的恢复段会跨进该带并撞侧墙 ⇒ 假收敛；禁改起点 x=0/z=−600（空档半宽
   * 15.5 下右漂仅 14.497m < 18.1m 需求）。
   * 窗口内直接看横摆率有没有掉下来：
   *   正号（修后）0.900 → 0.510  反号（旧）全程钉死 0.900（= maxYawRate 限幅值）
   */
  it('起漂 → 松手刹 → 零油门零转向：横摆率在无碰撞观察窗内真实衰减（非撞墙假收敛）', () => {
    const fd = new FreeDrive({ start: { x: -10.3, z: -250, heading: 0 } });
    let hits = 0;
    fd.onEvent = (e) => {
      if (e === 'wall' || e === 'hall') hits += 1;
    };
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyD', true); // 右漂（朝走廊内侧，买横向行程）
    for (let i = 0; i < 90; i += 1) fd.step(DT); // 漂 0.75s
    const drift = fd.snapshot();
    expect(Math.abs(drift.yawRate)).toBeGreaterThan(0.85); // 已漂到限幅（轮胎饱和，判据有效）

    // 松手刹、松开转向、**零油门**（关键：不给油，老版本在此暴露绕圈）
    fd.press('Space', false);
    fd.press('KeyD', false);
    const trace: number[] = [];
    for (let i = 0; i < 240; i += 1) {
      fd.step(DT);
      trace.push(Math.abs(fd.snapshot().yawRate));
    }
    // ① 观察窗内 0 次碰撞 ⇒ 衰减不可能来自撞墙
    expect(hits).toBe(0);
    // ② 2s 内横摆率必须掉到限幅值的 78% 以下（修后 0.510；反号恒为 0.900 ⇒ 必红）
    expect(trace[trace.length - 1]).toBeLessThan(FREE.maxYawRate * 0.78);
    // ③ 全程单调不增（同时挡住「把 K 调过头导致自回正振荡」这类反向回归）
    for (let i = 1; i < trace.length; i += 1) {
      expect(trace[i]).toBeLessThanOrEqual(trace[i - 1] + 1e-9);
    }
    // ④ 速度仍在漂移层内（|v| ≥ 1.5 ⇒ 不是低速退出短路）
    expect(Math.abs(fd.snapshot().speed)).toBeGreaterThan(1.5);
  });

  it('零油门收敛：4s 内 yawDyn/β 归零，且收敛时仍有车速（非低速短路）', () => {
    for (const v0 of [16, 20]) {
      const fd = new FreeDrive({ start: { x: -10.3, z: -250, heading: 0 } });
      accelerateTo(fd, v0);
      fd.press('Space', true);
      fd.press('KeyD', true);
      for (let i = 0; i < 90; i += 1) fd.step(DT);
      fd.press('Space', false);
      fd.press('KeyD', false);
      let settledAt = -1;
      let speedAtSettle = 0;
      for (let i = 0; i <= 480; i += 1) {
        fd.step(DT);
        const s = fd.snapshot();
        // 收敛口径与 driftActive 退出门限同族：|yaw|<0.02 rad/s 且 |beta|<0.002 rad
        if (Math.abs(s.yawRate) < 0.02 && Math.abs(s.beta) < 0.002) {
          settledAt = i;
          speedAtSettle = Math.abs(s.speed);
          break;
        }
      }
      // ① 4s 内必须收敛（反号时 yawDyn 钉在 0.9 上不衰减）
      expect(settledAt, `v0=${v0}`).toBeGreaterThanOrEqual(0);
      expect(settledAt * DT, `v0=${v0}`).toBeLessThanOrEqual(4);
      // ② 收敛时仍有车速（> 1.5 m/s 的 driftActive 退出门限 ⇒ 不是低速硬清零）
      expect(speedAtSettle, `v0=${v0}`).toBeGreaterThan(1.5);
    }
  });

  it('起漂路径不受符号修正影响：后轴抓地落到下限、后轴侧向力饱和', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true);
    for (let i = 0; i < 90; i += 1) fd.step(DT);
    const s = fd.snapshot();
    // ① 后轴抓地被手刹收紧到下限附近（driftGripFloor=0.32 契约不动）
    expect(s.rearGrip).toBeLessThan(FREE.driftGripFloor + 0.05);
    expect(s.rearGrip).toBeGreaterThanOrEqual(FREE.driftGripFloor - 1e-9);
    // ② 横摆与转向同号起步（左转 = 正），车尾外滑 β≠0
    expect(s.yawRate).toBeGreaterThan(0);
    expect(Math.abs(s.beta)).toBeGreaterThan(0.02);
    fd.press('Space', false);
    fd.press('KeyA', false);
  });

  it('零油门纯滑行（从未漂移）不触发漂移层：beta/rearGrip 恒为初始值', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 24);
    // 松开一切输入，纯滑行 8s
    for (let i = 0; i < 960; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      // 漂移层三条状态逐位不动（R29 正常驾驶运动学路径零风险）
      expect(s.beta).toBe(0);
      expect(s.rearGrip).toBe(1);
      expect(s.handbrake).toBe(false);
    }
    // 直线滑行：位移只在 z 上、heading 不动
    expect(fd.snapshot().heading).toBeCloseTo(0, 12);
    expect(fd.snapshot().x).toBeCloseTo(0, 12);
    expect(fd.snapshot().speed).toBeGreaterThan(0);
  });
});
