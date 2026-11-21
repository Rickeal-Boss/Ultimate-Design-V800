/**
 * R119 · 城门带 2D 钳位回归护栏（fix-1 门带激活域北扩 + fix-2 x 钳近/远侧选择 + gatePier 塔基范围）。
 *
 * 【fix-1 · 门带 2D 激活域北扩】FreeDrive.step() 的 2D 门控原判据只看车心 `nz ≤ gateFrontZ`，
 * 南向车头前缘（nz − CAR_HALF_L）已伸过 −351.5、车心仍在桥段（nz ∈ (−351.5, −351.5+CAR_HALF_L]）
 * 时 2D 未激活，而 1D 桥限（10.997）不挡门墩内缘 10 ⇒ 车 OBB 前角穿门墩 0.9~2.45m（入口穿模）。
 * fix-1 把上界北扩 CAR_HALF_L（gateFrontZ → gateFrontZ + CAR_HALF_L = −348.7525），车头一入墩
 * z 带 2D 门墩钳位即接管。
 *
 * 【fix-2 改 a · x 钳近/远侧选择】clampToFootprints 对凸出宽走廊的**局部突出物**（buttressBase /
 * arcadeCol —— 飞扶壁墩、拱廊柱带，车可合法停在其与前脸之间），当车心位于其外缘侧（|x| ≥ mid）
 * 时改按**近侧界** |x| ≥ xOuter + dx 外推（车被推离突出物外缘，非硬拉回路内 ⇒ 消除恒推远侧的
 * 穿墩/柱带 yank）。必须同时通过两道防护才外推，否则回退远侧 f.xInner − dx：
 *   ① 近侧目标 ≤ 1D 车心面线走廊 corridorCenterHalfWidth(z)（不越 1D 护栏，车缘不破可见面线）；
 *   ② 近侧目标处车 OBB 不与**其它**占位盒相交（外推不落入另一实体）。
 * gatePier 漏斗恒远侧（车不可能在门墩 xOuter(17.5) 外侧 ⇒ 排除，防进洞车被弹出 +7.5m）。
 *
 * 【fix-2 改 b · gatePier 塔基范围】gatePier footprint z 区间改为门楼**塔基实体**范围
 * [GATE.z−(GATE.depth+1.2)/2=−366.1, GATE.z+(GATE.depth+1.2)/2=−350.9]（makeGate 台基
 * box(depth+1.2)，比城门带 [−365.5,−351.5] 各超 0.6m）——原 footprint 漏掉塔基 0.6m（车头/车尾
 * 入塔基漏网）。不扩 CAR_HALF_L（SAT 判交已自动覆盖「车心带外、车头/尾入塔基实体」的车）。
 *
 * 真源口径：GATE / INNER / R97_CITY_BUTTRESS / VEHICLE / BOUNDS 一律 import 派生，禁写死
 * 10 / 17.5 / 14 / 1.003 / 2.7475 / 8.997 / 12.903 等派生值。
 */
import { describe, expect, it } from 'vitest';
import { FreeDrive, BOUNDS, corridorCenterHalfWidth } from '../src/core/FreeDrive';
import { clampToFootprints, getCityFootprints } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { GATE, INNER } from '../src/render/scene/r28Layout';
import { R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

const DT = 1 / 120;
/** 车半长 / 半宽（physics.ts 真源，勿写死 2.7475 / 1.003） */
const HALF_L = VEHICLE.lengthM / 2;
const HALF_W = VEHICLE.widthM / 2;
/** 门墩内缘 |x|（= 门洞净半宽，GATE.openW/2 = 10） */
const GATE_PIER_INNER = GATE.openW / 2;
/** 门楼塔基实体 z 范围（makeGate 台基 box(depth+1.2)，zMid=GATE.z，半深 (depth+1.2)/2=7.6） */
const GATE_PIER_Z_MIN = GATE.z - (GATE.depth + 1.2) / 2; // −366.1
const GATE_PIER_Z_MAX = GATE.z + (GATE.depth + 1.2) / 2; // −350.9
/** 飞扶壁连墙墩外缘 = faceHalf − reach = 11.9（近侧界基准，真源派生非写死） */
const BUTTRESS_LINK_OUTER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach;

/** 主殿前排飞扶壁内墩（广场域 z<plazaZ，z≈−1294.3，R105 唯一非漂移也穿缺陷） */
const PLAZA_BUTT = getCityFootprints().find(
  (f) => f.kind === 'buttressBase' && f.zMin < BOUNDS.plazaZ
)!;
const PLAZA_BUTT_Z = (PLAZA_BUTT.zMin + PLAZA_BUTT.zMax) / 2; // 内墩世界 z

describe('R119 ① fix-1 门带入口：车心窗口 z∈(−351.5,−348.7525] 时 gatePier 已激活，车缘不穿门墩内缘 10', () => {
  it('车心在桥段北扩窗口：clampToFootprints 按 gatePier 收紧（hit=true），车缘不越 10', () => {
    // fix-1 北扩：2D 激活域上界 gateFrontZ → gateFrontZ+CAR_HALF_L=−348.7525。车心落在此窗口
    //   （车头前缘已伸过 −351.5 门脸、车心仍在桥段）时 2D 门墩钳位接管，替代 1D 桥限（10.997）
    //   漏洞（1D 桥限不挡门墩内缘 10 ⇒ 车 OBB 前角穿门墩 0.9~2.45m）。
    const winMin = BOUNDS.gateFrontZ; // −351.5
    const winMax = BOUNDS.gateFrontZ + HALF_L; // −348.7525
    for (const z of [winMin + 0.5, winMin + 1.5, winMin + 2.5, winMax - 0.5, winMax]) {
      // 车心 x=9.6（车缘 10.603 真嵌门墩内缘 10 0.6m）⇒ 2D gatePier 真相交 ⇒ clamp 收紧
      const fp = clampToFootprints(9.6, z, 0);
      expect(fp.hit).toBe(true);
      expect(fp.kind).toBe('gatePier'); // 门墩漏斗激活（非 1D 桥限漏洞）
      // 车 OBB 前缘不穿门墩内缘 10（maxGatePen=0）：clamp 后车缘 = 8.997+1.003 = 10.0 恰贴墩内缘
      const edge = Math.abs(fp.x) + HALF_W;
      expect(edge).toBeLessThanOrEqual(GATE_PIER_INNER + 1e-9);
    }
  });

  it('step() 集成：车南向穿门带（z−340→−380）车心窗口内车缘不越门墩内缘 10（maxGatePen=0）', () => {
    const fd = new FreeDrive({ start: { x: 9.6, z: -340, heading: 0 } });
    fd.state.speed = 31.4;
    fd.press('KeyW', true);
    const winMin = BOUNDS.gateFrontZ;
    const winMax = BOUNDS.gateFrontZ + HALF_L;
    let framesInWin = 0;
    let maxEdge = 0;
    for (let i = 0; i < 200 && fd.snapshot().z > -380; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      if (s.z > winMin && s.z <= winMax) {
        framesInWin += 1;
        maxEdge = Math.max(maxEdge, Math.abs(s.x) + HALF_W);
      }
    }
    expect(framesInWin).toBeGreaterThan(0); // 车心确实穿过北扩窗口
    // 车心窗口内车缘不越门墩内缘 10（fix-1 已激活 gatePier 钳位，替代 1D 桥限漏洞）
    expect(maxEdge).toBeLessThanOrEqual(GATE_PIER_INNER + 1e-6);
  });
});

describe('R119 ② fix-1 门墩急转：车不再持久卡死（末态穿透 0、门墩接触非持久）', () => {
  it('h=90° x0=9.6 z≈−349.5 v=20 跑 200 帧：末态不穿模、车穿过门洞非卡死', () => {
    const fd = new FreeDrive({ start: { x: 9.6, z: -349.5, heading: Math.PI / 2 } });
    fd.state.speed = 20;
    fd.press('KeyW', true);
    let gatePenFrames = 0;
    for (let i = 0; i < 200; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      const fp = clampToFootprints(s.x, s.z, s.heading);
      if (fp.hit && fp.kind === 'gatePier') gatePenFrames += 1;
    }
    const sEnd = fd.snapshot();
    // 末态穿透 0：车 OBB 与所有城内占位盒分离（hit=false）
    expect(clampToFootprints(sEnd.x, sEnd.z, sEnd.heading).hit).toBe(false);
    // 不再持久卡死：门墩接触非持久（≤2 帧瞬时转角接触，非持续嵌死），车仍可动（v>0）
    expect(gatePenFrames).toBeLessThanOrEqual(2);
    expect(sEnd.speed).toBeGreaterThan(0);
    // 车已穿过门洞（x < −5，西行越过门洞中心），非卡死在门墩
    expect(sEnd.x).toBeLessThan(-5);
  });
});

describe('R119 ③ fix-2 广场墩外隙近侧外推：clamp 目标=近侧 xOuter+dx 而非远侧收紧', () => {
  it('x0=13.4/14.0 南向广场墩：近侧外推 xOuter+dx，车缘不破 1D 面线', () => {
    // 广场域主殿前排飞扶壁内墩（z≈−1294.3）是局部突出物（buttressBase）。车心 13.4/14.0 ≥
    //   墩带中点（(10.35+13.15)/2=11.75）⇒ R119 改 a 按**近侧界** xOuter+dx 外推（车被推离墩
    //   外缘），非远侧收紧（xInner−dx）。近侧界 ≤ 1D 车心面线走廊（防护①）且不与其它占位盒
    //   相交（防护②）⇒ 合法。旧行为恒远侧收紧会让车被硬拉回路内（穿墩/柱带 yank）。
    for (const x0 of [13.4, 14.0]) {
      const fp = clampToFootprints(x0, PLAZA_BUTT_Z, 0);
      expect(fp.hit).toBe(true);
      expect(fp.kind).toBe('buttressBase');
      // 近侧界 = 墩外缘 + 半宽（直行 θ=0 dx=半宽 1.003）：13.15 + 1.003 = 14.153
      const nearBound = PLAZA_BUTT.xOuter + HALF_W;
      expect(fp.x).toBeCloseTo(nearBound, 9);
      // 车不穿模：clamp 后位置再喂回 ⇒ 车 OBB 与所有占位盒分离（hit=false）
      expect(clampToFootprints(fp.x, fp.z, 0).hit).toBe(false);
      // 近侧防护①：近侧目标 ≤ 1D 车心面线走廊 corridorCenterHalfWidth(z)（= 14.497 广场）
      expect(fp.x).toBeLessThanOrEqual(corridorCenterHalfWidth(PLAZA_BUTT_Z) + 1e-9);
      // 车缘不破 1D 可见面线（15.5 = 建筑前脸）：车心 + 半宽 ≤ 可见面线
      expect(fp.x + HALF_W).toBeLessThanOrEqual(BOUNDS.cityOpenHalfW + 1e-9);
    }
  });
});

describe('R119 ④ fix-2 柱带 yank：单帧 x 横移受近侧外推平滑，无穿模', () => {
  it('x=12.5 柱带（z=−384.1）直行：单帧 x 横移 ≤ 0.35（旧 0.600 yank → 新 0.223）', () => {
    // 拱廊柱带（arcadeCol 内缘 11.12 / 外缘 11.72）是局部突出物。车心 12.5 ≥ 柱带中点 11.42
    //   ⇒ R119 改 a 近侧外推到 11.72+1.003=12.723（车被推离柱外缘，非硬拉回路内 10.117）。
    //   旧版恒推远侧 10.117 会让车单帧 yank 0.600m（瞬移内推）；近侧外推后单帧 x 横移
    //   = clamp(12.723−12.5, ±maxStepX) = 0.223 ≤ 0.35（近侧界目标近，位移小、平滑无 yank）。
    const fd = new FreeDrive({ start: { x: 12.5, z: -384.1, heading: 0 } });
    fd.press('KeyW', true);
    let maxXStep = 0;
    let prevX = fd.snapshot().x;
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      maxXStep = Math.max(maxXStep, Math.abs(s.x - prevX));
      prevX = s.x;
    }
    // 单帧 x 横移 ≤ 0.35（远小于旧 0.600 yank；亦 ≤ WALL_2D_MAX_LATERAL_STEP 平滑护栏）
    expect(maxXStep).toBeLessThanOrEqual(0.35);
    // 末态车不穿模：车 OBB 与所有占位盒分离
    const sEnd = fd.snapshot();
    expect(clampToFootprints(sEnd.x, sEnd.z, sEnd.heading).hit).toBe(false);
    // 车已达近侧外推目标（柱外缘 + 半宽），非被拉回路内
    expect(sEnd.x).toBeGreaterThan(11.72);
  });
});

describe('R119 ⑤ fix-2 改 b gatePier 塔基范围 + 块0 北缘合法位车不误钳', () => {
  it('getCityFootprints() 中 gatePier 恰 1 条，z∈[GATE.z±(depth+1.2)/2]，z 带长=depth+1.2', () => {
    const piers = getCityFootprints().filter((f) => f.kind === 'gatePier');
    expect(piers.length).toBe(1);
    const p = piers[0];
    expect(p.xInner).toBeCloseTo(GATE_PIER_INNER, 12); // 10
    expect(p.xOuter).toBeCloseTo(GATE.halfW, 12); // 17.5
    // 塔基实体范围（比城门带 [−365.5,−351.5] 各超 0.6m，覆盖车头/车尾入塔基漏网）
    expect(p.zMin).toBeCloseTo(GATE_PIER_Z_MIN, 12); // −366.1
    expect(p.zMax).toBeCloseTo(GATE_PIER_Z_MAX, 12); // −350.9
    expect(p.zMax - p.zMin).toBeCloseTo(GATE.depth + 1.2, 12); // 15.2
  });

  it('块 0 北缘 x≥10 合法位车不被 gatePier 误钳：clamp(12.0,−368.9) 不再被硬拉到 8.997', () => {
    // 改 b 前 gatePier z 区间 [−365.5,−351.5]（城门带）或扩 CAR_HALF_L 会让块 0 北缘合法位车
    //   （z∈[−368.25,−365.5]，x≥10）车 OBB 与门墩 footprint 相交而被硬拉到 8.997（单帧 2.006m）。
    //   改 b 塔基范围 zMin=−366.1 不含 −368.9 车心（车 OBB z 伸展 [−371.65,−366.15] 亦不触
    //   −366.1）⇒ gatePier 不再误钳；该处由连墙墩（buttressBase）近侧外推接管（12.903）。
    const fp = clampToFootprints(12.0, -368.9, 0);
    expect(fp.hit).toBe(true);
    // 不是 gatePier 硬拉（恒远侧 8.997），而是连墙墩近侧外推
    expect(fp.kind).not.toBe('gatePier');
    expect(fp.kind).toBe('buttressBase');
    // 车不被硬拉到 8.997（单帧 2.006m 突跳），而是近侧外推到 11.9+1.003=12.903
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_OUTER + HALF_W, 9); // 12.903
    expect(Math.abs(fp.x)).toBeGreaterThan(10);
    // 车不穿模：clamp 后位置再喂回 ⇒ 分离
    expect(clampToFootprints(fp.x, fp.z, 0).hit).toBe(false);
  });
});

describe('R119 ⑥ R112/R117 回归：静止态深穿 clamp 与多盒收敛 final 与 R118 一致（无 1.787m/0.263m 残留）', () => {
  it('R112 多盒收敛：x=14.30/z=−508/h=−0.6 深穿，clamp 收敛到不穿模位（无 1.787m 残留）', () => {
    // R112 诊断：入参 x=14.30 时连墙墩恰在 x 轴分离边缘，单次 clamp 只看到 frontBase
    //   （bound=12.421），把车推到 12.421 时车 OBB 扫过墩带落入其中 ⇒ 车局部横向轴（lx）穿透
    //   1.787m 残留。R112 迭代复查（上限 4 次）让车继续收敛到更紧界（墩 8.971）⇒ 残留 0。
    //   R119 改 a 近/远侧选择不改此收敛语义（此场景车心 14.30 ≥ 墩带中点 ⇒ 近侧外推，仍收敛）。
    const h = -0.6;
    const fp = clampToFootprints(14.30, -508, h);
    expect(fp.hit).toBe(true);
    // 车不穿模：clamp 后位置再喂回 ⇒ 车 OBB 与所有占位盒分离（hit=false，无 1.787m 残留）
    expect(clampToFootprints(fp.x, fp.z, h).hit).toBe(false);
  });

  it('R112 静止贴墩：x=8.971/z=−508/h=−0.6 已在最紧界，不再有 z/lx 穿透残留', () => {
    // R112 静止场景：车停在 buttress 贴边（x=8.971，h=−0.6）时 z/lx 穿透 1.787m 永久残留
    //   （x 钳已到最紧界 8.971，无法再推）。R112 迭代复查 + R119 近/远侧选择后该静止态
    //   车 OBB 应与占位盒分离（hit=false），不再持续可见穿模。
    const h = -0.6;
    const fp = clampToFootprints(8.971, -508, h);
    expect(clampToFootprints(fp.x, fp.z, h).hit).toBe(false);
  });

  it('R117 多盒收敛 xPen：广场墩静止态深穿收敛 final 不穿模（无 0.263m 残留）', () => {
    // R117-A：h=2.62 场景单帧 0.2633m 残留（min 轴 lx，az=−0.205<0.45，z 钳不触发），R117 xPen
    //   改「到目标距离」根治。用 R117 探针 B 主殿前排飞扶壁内墩静止态（x=−8/z=−1296.2/h=1.38）
    //   复测：clamp 收敛 final 车 OBB 与占位盒分离（无残留），不重演 0.263m/0.5126m 单帧瞬态。
    const h = 1.38;
    const fp = clampToFootprints(-8.0, -1296.2, h);
    expect(fp.hit).toBe(true);
    expect(clampToFootprints(fp.x, fp.z, h).hit).toBe(false);
  });
});

describe('R119 ⑦ 门墩进洞不被弹出：x0=±8 过洞 clamp 不出现 +7.5m 外推（gatePier 恒远侧）', () => {
  it('x0=±8 门洞内直行：clamp 零收紧（车缘 |x|+1.003 < 10 不触门墩），无 +7.5m 外推弹出', () => {
    // 门墩 footprint |x|∈[10,17.5]。车 x0=±8 车缘 8+1.003=9.003 < 10（洞内走线），与门墩
    //   x 分离 ⇒ SAT 判不相交 ⇒ clamp 零收紧（hit=false）。若 gatePier 误走近侧界会把进洞车
    //   外推到 xOuter+dx = 17.5+1.003 = 18.503（+7.5m 弹出）。cityFootprints 明确排除 gatePier
    //   于近侧界（恒远侧）⇒ 车过洞不被弹出。
    for (const x0 of [8, -8]) {
      const fp = clampToFootprints(x0, GATE.z, 0); // 门楼中心 z=−358.5
      expect(fp.hit).toBe(false);
      expect(fp.x).toBeCloseTo(x0, 12); // 原样放行，无 +7.5m 外推弹出
    }
  });
});

describe('R119 ⑧ fix-5 门墩斜切平滑：车斜切入墩单帧推回平滑（旧 2.2m yank → ≤0.35）且末态不深穿', () => {
  it('h=−0.2 x=9.0 z=−340 v=10 直行 240 帧：单帧 x 横移≤0.35、无 >0.4m yank、末态车缘贴墩、z 不深入门楼', () => {
    // fix-5：车斜切（h=−0.2）入塔基时 xPen 深嵌（旧 bundle 单帧推回 2.2062m = 问题 1 号 2.3m yank）
    //   被条件限幅到 X_Z_PEN_SMOOTH_CAP=0.35 ⇒ 单帧推回平滑。旧 bundle 车瞬移 2.2m 且穿透门楼
    //   （末态 z=−363.47 深入塔基 12.5m）；fix-5 后单帧≤0.35、车停门脸附近（z 不深入）。
    const fd = new FreeDrive({ start: { x: 9.0, z: -340, heading: -0.2 } });
    fd.state.speed = 10;
    fd.press('KeyW', true);
    let maxDx = 0;
    let yankCnt = 0;
    let prevX = fd.snapshot().x;
    for (let i = 0; i < 240; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      const dx = Math.abs(s.x - prevX);
      prevX = s.x;
      if (dx > maxDx) maxDx = dx;
      if (dx > 0.4) yankCnt += 1;
    }
    const sEnd = fd.snapshot();
    // fix-5：单帧 x 推回平滑（旧 2.2062m → ≤0.35，降 78%）
    expect(maxDx).toBeLessThanOrEqual(0.35);
    // 无 >0.4m 单帧 yank（240 帧窗口内 fix-5 限幅生效，无旧版 2.2m 瞬移）
    expect(yankCnt).toBe(0);
    // 末态车 OBB 不深穿 gatePier：车缘贴门墩内缘（≤10 + 1cm 贴墩容差；fix-1 斜切边界残余 ~5.5mm）
    const edge = Math.abs(sEnd.x) + HALF_W;
    expect(edge).toBeLessThanOrEqual(GATE_PIER_INNER + 1e-2);
    // z 不持续深入：末态车停在门脸附近（z > 塔基南界 −366.1），旧 bundle 深入门楼 −363.47 残留
    expect(sEnd.z).toBeGreaterThan(GATE_PIER_Z_MIN);
  });
});

describe('R119 ⑨ fix-5 广场墩骑墩平滑：车骑墩单帧≤0.35、末态无穿模、v 恢复不卡死', () => {
  it('x=13.4 z0=−1260 h=0 南向 400 帧：单帧 x 横移≤0.35、末态无穿模、v 不卡死（恢复 >1.5）', () => {
    // fix-5：车骑上主殿前排飞扶壁内墩（x=13.4 南行，车角深嵌墩带）被远侧收紧 4m（9.347），
    //   单帧推回被限幅到 X_Z_PEN_SMOOTH_CAP=0.35（旧瞬移 >0.4m）⇒ 平滑。车收敛后 v 恢复
    //   （f400 v=8.21 >1.5，非永久卡死；minV≈0 是收敛期钳速瞬态）。
    const fd = new FreeDrive({ start: { x: 13.4, z: -1260, heading: 0 } });
    fd.state.speed = 10;
    fd.press('KeyW', true);
    let maxDx = 0;
    let yankCnt = 0;
    let prevX = fd.snapshot().x;
    let endHit = false;
    for (let i = 0; i < 400; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      const dx = Math.abs(s.x - prevX);
      prevX = s.x;
      if (dx > maxDx) maxDx = dx;
      if (dx > 0.4) yankCnt += 1;
      if (i === 399) endHit = clampToFootprints(s.x, s.z, s.heading).hit;
    }
    const sEnd = fd.snapshot();
    // 单帧 x 推回 ≤0.35（fix-5 限幅 X_Z_PEN_SMOOTH_CAP，float 余量 1e-3）
    expect(maxDx).toBeLessThanOrEqual(0.351);
    // 无 >0.4m 单帧 yank
    expect(yankCnt).toBe(0);
    // 末态无穿模：车 OBB 与所有占位盒分离
    expect(endHit).toBe(false);
    // v 不卡死：收敛后恢复 >1.5（f400 v≈8.21，非永久卡死）
    expect(sEnd.speed).toBeGreaterThan(1.5);
  });
});
