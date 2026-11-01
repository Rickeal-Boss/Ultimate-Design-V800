/**
 * R43-P0C 临时探针（**运行期注入，不改任何 src 源码**，扫描结束即删）
 * 用法：由 tools/r43_perf_probe.mjs 用 page.evaluate(<本文件文本>) 注入。
 *
 * 原理：DEV 下 main.ts 已经把 Game 实例挂在 window.__game，TS 的 private 只在编译期
 * 存在 ⇒ 这里可以直接拿到 renderer / sm / castle / fx / postfx 等子系统，并在
 * **实例上**覆盖方法（call site 是 `this.fx.update(...)` ⇒ 命中 own property）做计时。
 *
 * 记录口径（全部预分配 TypedArray，探针自身零分配）：
 *   t[i]      = 本帧末（qualityGovernor.update 进入时）performance.now()
 *   seg[k][i] = 本帧第 k 个子系统的**主线程 CPU 时间**（ms），逐帧清零
 *   calls/tris/prog/tex/geo = renderer.info 整帧累计（autoReset=false + 每帧手动 reset）
 *   dpr       = AdaptiveQuality.pixelRatio（变更 ⇒ composer 全 RT 重建）
 *   zones/zhi/gate = 城堡可见分区数 / 近档数 / 距最近「550m 显隐闸门」的距离
 *   fxLive    = 轮胎烟活跃粒子数（结构事件：粒子池随刹车增长）
 *   heap      = performance.memory.usedJSHeapSize（GC 锯齿）
 *   spdTarget = ladder 模式下的目标速度（challenge 模式恒 -1）
 *
 * ⚠ SwiftShader 口径：WebGL 命令提交在主线程，真正的软光栅在 GPU 进程 ⇒
 *   render 段只代表「three 侧命令提交 + uniform 写」，光栅耗时体现在
 *   frameTime − Σseg 的「未归属」里。不要把它当 GPU 时间。
 */
(() => {
  const g = window.__game;
  if (!g) return 'NO_GAME';

  const CAP = 40000;
  const SEGS = [
    'phys', 'carUpd', 'cluster', 'light', 'env', 'cshadow', 'rig', 'castle',
    'sfx', 'fx', 'hud', 'slider', 'render', 'gov', 'crash', 'zswap', 'engine'
  ];
  const S = Object.create(null);
  SEGS.forEach((k, i) => { S[k] = i; });
  const acc = new Float64Array(SEGS.length);
  const seg = Object.create(null);
  for (const k of SEGS) seg[k] = new Float32Array(CAP);

  const R = {
    n: 0,
    cap: CAP,
    t: new Float64Array(CAP),
    dt: new Float32Array(CAP),
    frameGap: new Float32Array(CAP),
    speed: new Float32Array(CAP),
    spdTarget: new Float32Array(CAP).fill(-1),
    carZ: new Float32Array(CAP),
    camZ: new Float32Array(CAP),
    phase: new Uint8Array(CAP),
    dpr: new Float32Array(CAP),
    calls: new Uint16Array(CAP),
    tris: new Uint32Array(CAP),
    prog: new Uint16Array(CAP),
    tex: new Uint16Array(CAP),
    geo: new Uint16Array(CAP),
    zones: new Uint8Array(CAP),
    zhi: new Uint8Array(CAP),
    gate: new Float32Array(CAP),
    fxLive: new Uint16Array(CAP),
    heap: new Uint32Array(CAP),
    winW: new Uint16Array(CAP),
    winH: new Uint16Array(CAP),
    label: new Uint16Array(CAP),
    steps: new Uint16Array(CAP),
    /** 本帧「分区可见性翻转」次数（跨 ZONE_VIEW_RANGE=550 闸门） */
    zEvents: new Uint8Array(CAP),
    /** 本帧 setZoneTier 调用次数（hi↔lo 换档；用计数器而非计时，避开 performance.now 100µs 量化） */
    zswapN: new Uint8Array(CAP),
    seg
  };

  const perf = performance.now.bind(performance);
  const ZONE_GATE = 550; // castle.ts ZONE_VIEW_RANGE（显隐闸门）
  const info = g.renderer.info;
  info.autoReset = false;

  /** 固定 4 形参包装：不制造 arguments/rest 数组（避免把 GC 抖动混进被测分布） */
  const wrap = (obj, key, segName) => {
    if (!obj) return false;
    const orig = obj[key];
    if (typeof orig !== 'function') return false;
    const s = S[segName];
    obj[key] = function (a1, a2, a3, a4) {
      const t0 = perf();
      const r = orig.call(this, a1, a2, a3, a4);
      acc[s] += perf() - t0;
      return r;
    };
    return true;
  };

  const wired = {};
  const PHASE = { menu: 0, countdown: 1, accel: 2, brake: 3, stopped: 4, crashed: 5 };
  let tPrev = 0;
  let zswapCount = 0;
  let stepN = 0;
  let zSwapN = 0;
  let prevZmask = 0;

  // ---- 帧边界：qualityGovernor.update 是 renderTail 里每帧最后被调用的子系统 ----
  const gov = g.qualityGovernor;
  const govOrig = gov.update;
  gov.update = function (dt) {
    const t0 = perf();
    const r = govOrig.call(this, dt);
    acc[S.gov] += perf() - t0;
    const now = perf();
    if (R.n < R.cap) {
      const i = R.n;
      R.t[i] = now;
      R.dt[i] = dt;
      R.frameGap[i] = tPrev > 0 ? now - tPrev : 0;
      tPrev = now;
      const fd = g.freeDrive;
      R.speed[i] = Math.abs(fd ? fd.state.speed : g.sm.vehicle.speed);
      R.carZ[i] = g.car.root.position.z;
      R.camZ[i] = g.rig.camera.position.z;
      R.phase[i] = PHASE[g.sm.phase] ?? 0;
      R.dpr[i] = g.qualityGovernor.pixelRatio;
      R.calls[i] = Math.min(65535, info.render.calls);
      R.tris[i] = info.render.triangles;
      R.prog[i] = Math.min(65535, info.programs ? info.programs.length : 0);
      R.tex[i] = Math.min(65535, info.memory.textures);
      R.geo[i] = Math.min(65535, info.memory.geometries);
      const zv = g.castle && g.castle.zoneViews;
      if (zv) {
        let vis = 0;
        let hi = 0;
        let gate = 1e9;
        let mask = 0;
        for (let k = 0; k < zv.length; k++) {
          const z = zv[k];
          if (z.mesh.visible) { vis += 1; if (k < 32) mask |= 1 << k; }
          if (z.tier === 'hi') hi += 1;
          const d = Math.abs(Math.abs(z.cz - R.camZ[i]) - ZONE_GATE);
          if (d < gate) gate = d;
        }
        R.zones[i] = vis;
        R.zhi[i] = hi;
        R.gate[i] = gate;
        // 可见性翻转次数 = 上一帧 mask XOR 本帧 mask 的 popcount
        let x = (mask ^ prevZmask) >>> 0;
        let bits = 0;
        while (x) { bits += x & 1; x >>>= 1; }
        R.zEvents[i] = i === 0 ? 0 : bits;
        prevZmask = mask;
      }
      R.zswapN[i] = zSwapN;
      zSwapN = 0;
      // 轮胎烟活跃粒子数（池容量 high=600）
      const life = g.fx && g.fx.smoke && g.fx.smoke.pool && g.fx.smoke.pool.life;
      if (life) {
        let live = 0;
        for (let k = 0; k < life.length; k++) if (life[k] > 0) live += 1;
        R.fxLive[i] = live;
      }
      R.spdTarget[i] = ladder.active ? ladder.target : -1;
      R.label[i] = window.__r43Label || 0;
      R.winW[i] = window.innerWidth;
      R.winH[i] = window.innerHeight;
      R.steps[i] = stepN;
      stepN = 0;
      if (performance.memory) R.heap[i] = performance.memory.usedJSHeapSize;
      for (let k = 0; k < SEGS.length; k++) seg[SEGS[k]][i] = acc[k];
      R.n = i + 1;
    }
    acc.fill(0);
    info.reset();
    return r;
  };

  // ---- 子系统计时接线 ----
  // 物理 step 单独接线：额外数「本帧跑了几个固定步」（低帧率下 tick 会被累加器跑多次）
  {
    const stepOrig = g.sm.step;
    g.sm.step = function (a1, a2) {
      const t0 = perf();
      const r = stepOrig.call(this, a1, a2);
      acc[S.phys] += perf() - t0;
      stepN += 1;
      return r;
    };
    wired.phys = true;
  }
  wired.crash = wrap(g.crashWorld, 'update', 'crash');
  wired.carUpd = wrap(g.car, 'update', 'carUpd');
  wired.cluster = wrap(g.car, 'updateCluster', 'cluster');
  wired.spin = wrap(g.car, 'spinWheels', 'engine');
  wired.light = wrap(g.lighting, 'update', 'light');
  wired.env = wrap(g.env, 'update', 'env');
  wired.cshadow = wrap(g.contactShadow, 'update', 'cshadow');
  wired.rig = wrap(g.rig, 'update', 'rig');
  wired.castle = wrap(g.castle, 'updateViewerZ', 'castle');
  wired.zswap = wrap(g.castle, 'setZoneTier', 'zswap');
  {
    const origSet = g.castle.setZoneTier;
    g.castle.setZoneTier = function (a1, a2) {
      const t0 = perf();
      const r = origSet.call(this, a1, a2);
      acc[S.zswap] += perf() - t0;
      zSwapN += 1;
      return r;
    };
  }
  wired.sfxE = wrap(g.sfx, 'updateEngine', 'sfx');
  wired.sfxW = wrap(g.sfx, 'updateWind', 'sfx');
  wired.sfxS = wrap(g.sfx, 'updateSqueal', 'sfx');
  wired.sfxR = wrap(g.sfx, 'updateRegen', 'sfx');
  wired.fx = wrap(g.fx, 'update', 'fx');
  wired.hud = wrap(g.hud, 'update', 'hud');
  wired.hudFree = wrap(g.hud, 'updateFree', 'hud');
  wired.slider = wrap(g.sliders, 'render', 'slider');
  wired.render = wrap(g.postfx, 'render', 'render');

  // ---- ladder 模式：自由探索 + 速度锁定（可钉住位置以隔离「位移流式」因素）----
  const ladder = { active: false, target: 0, pin: false, x: 0, z: -400, heading: 0 };

  const enterLadder = (pin) => {
    ladder.pin = !!pin;
    window.__v800Free.enter();
    // 与挑战路径同机位：chase（自由探索默认 free 机位，构图不同会污染 A/B）
    g.rig.setMode('chase');
    const fd = g.freeDrive;
    if (!fd) return 'NO_FREEDRIVE';
    const stepOrig = fd.step;
    fd.step = function (dt) {
      const t0 = perf();
      stepOrig.call(this, dt);
      acc[S.phys] += perf() - t0;
      stepN += 1;
      const s = this.state;
      if (ladder.active) {
        s.speed = ladder.target;
        s.accel = 0;
        s.throttle = ladder.target > 0 ? 1 : 0;
        s.brake = 0;
        s.handbrake = false;
        s.steer = 0;
        s.yawRate = 0;
        s.beta = 0;
        s.vy = 0;
        if (ladder.pin) {
          s.x = ladder.x;
          s.z = ladder.z;
          s.heading = ladder.heading;
        } else if (s.z < -1200 || s.z > 60) {
          s.x = ladder.x;
          s.z = ladder.z;
        }
      }
      return undefined;
    };
    // 自由探索每帧朝 root 写位姿 ⇒ 钉位时同步把插值前后态一起钉住（防「拉丝」分支接管）
    g.prevFreeX = 0;
    g.prevFreeZ = 0;
    return 'OK';
  };

  // ---- 成本消去法（ablation）：逐项关掉，看帧间隔掉多少 ⇒ 该项的实测单价 ----
  // 全部复位 → 只开指定项；'base' = 全开。用同一机位/同一速度（可由 ladder 钉住）。
  const inRoot = (o, root) => {
    for (let p = o; p; p = p.parent) if (p === root) return true;
    return false;
  };
  let othersCache = null;
  const othersOf = () => {
    if (othersCache) return othersCache;
    const skip = [g.castle && g.castle.group, g.car && g.car.root, g.env && g.env.sky,
      g.fx && g.fx.smoke && g.fx.smoke.object, g.fx && g.fx.skid && g.fx.skid.object,
      g.fx && g.fx.sparks && g.fx.sparks.object].filter(Boolean);
    const out = [];
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const s of skip) if (inRoot(o, s)) return;
      out.push(o);
    });
    othersCache = out;
    return out;
  };
  const fxObjs = () => [g.fx && g.fx.smoke && g.fx.smoke.object,
    g.fx && g.fx.skid && g.fx.skid.object,
    g.fx && g.fx.sparks && g.fx.sparks.object].filter(Boolean);

  let castleFrozen = false;
  let castleOrigZ = null;
  const ablate = (name) => {
    const r = g.renderer;
    const pf = g.postfx;
    // 复位
    r.shadowMap.autoUpdate = true;
    if (pf.bloomPass) pf.bloomPass.enabled = true;
    pf.blurPass.enabled = true;
    if (g.castle) g.castle.group.visible = true;
    g.car.root.visible = true;
    if (g.env && g.env.sky) g.env.sky.visible = true;
    for (const o of fxObjs()) o.visible = true;
    for (const o of othersOf()) o.visible = true;
    r.setPixelRatio(g.qualityGovernor.pixelRatio);
    pf.setPixelRatio(g.qualityGovernor.pixelRatio);
    // 远档几何还原（locastle 用过则把 updateViewerZ 恢复原样，让档位按真实机位重算）
    if (castleFrozen && g.castle) {
      g.castle.updateViewerZ = castleOrigZ;
      castleFrozen = false;
      g.castle.updateViewerZ(g.rig.camera.position.z);
    }

    switch (name) {
      case 'base':
        break;
      case 'noshadow':
        r.shadowMap.autoUpdate = false;
        break;
      case 'nobloom':
        if (pf.bloomPass) pf.bloomPass.enabled = false;
        break;
      case 'noblur':
        pf.blurPass.enabled = false;
        break;
      case 'nocastle':
        g.castle.group.visible = false;
        break;
      case 'locastle': {
        // 像素不变、只把城堡几何换成远档 lo ⇒ 分离「顶点/三角形」与「像素填充」
        if (!castleFrozen) { castleOrigZ = g.castle.updateViewerZ; castleFrozen = true; }
        g.castle.updateViewerZ = function () {};
        const zv = g.castle.zoneViews || [];
        let nlo = 0;
        for (const z of zv) { if (z.lo) { z.mesh.geometry = z.lo; z.tier = 'lo'; nlo += 1; } }
        return 'locastle:' + nlo;
      }
      case 'nocar':
        g.car.root.visible = false;
        break;
      case 'nofx':
        for (const o of fxObjs()) o.visible = false;
        break;
      case 'nosky':
        if (g.env && g.env.sky) g.env.sky.visible = false;
        break;
      case 'noother':
        for (const o of othersOf()) o.visible = false;
        break;
      case 'dprhalf':
        r.setPixelRatio(g.qualityGovernor.pixelRatio * 0.5);
        pf.setPixelRatio(g.qualityGovernor.pixelRatio * 0.5);
        break;
      case 'alloff':
        r.shadowMap.autoUpdate = false;
        if (pf.bloomPass) pf.bloomPass.enabled = false;
        pf.blurPass.enabled = false;
        g.castle.group.visible = false;
        g.car.root.visible = false;
        if (g.env && g.env.sky) g.env.sky.visible = false;
        for (const o of fxObjs()) o.visible = false;
        for (const o of othersOf()) o.visible = false;
        break;
      default:
        return 'UNKNOWN:' + name;
    }
    return name;
  };

  window.__r43 = {
    wired,
    segs: SEGS,
    install: () => Object.keys(wired).filter((k) => !wired[k]),
    ablate: (name) => ablate(name),
    ladderEnter: (pin) => enterLadder(pin),
    ladder: (v, x, z) => {
      ladder.active = v >= 0;
      if (v >= 0) ladder.target = v;
      if (x !== undefined) ladder.x = x;
      if (z !== undefined) ladder.z = z;
      if (ladder.active) {
        const fd = g.freeDrive;
        if (fd) {
          if (ladder.pin) {
            fd.state.x = ladder.x;
            fd.state.z = ladder.z;
            fd.state.heading = ladder.heading;
            g.prevFreeX = ladder.x;
            g.prevFreeZ = ladder.z;
          } else if (z !== undefined) {
            fd.state.speed = 0;
            fd.state.x = ladder.x;
            fd.state.z = ladder.z;
            g.prevFreeX = ladder.x;
            g.prevFreeZ = ladder.z;
          }
        }
      }
      return R.n;
    },
    start: () => { g.startRun(); return R.n; },
    /** 低帧率环境专用：把 Loop 的单帧累加上限从 0.1 提到 0.35（同 #autodrive 口径），
     *  否则 SwiftShader 上 0.7s/帧只会推 0.1s 模拟时间 ⇒ 一轮要跑 3.5 倍墙钟。
     *  只影响「每帧推几步」，不影响物理步长与任何被测量。 */
    setMaxFrameTime: (v) => { if (g.loop) g.loop.maxFrameTime = v; return g.loop ? g.loop.maxFrameTime : -1; },
    mark: () => R.n,
    setLabel: (n) => { window.__r43Label = n; return R.n; },
    resize: () => { g.resize(); return [window.innerWidth, window.innerHeight]; },
    n: () => R.n,
    phase: () => g.sm.phase,
    state: () => ({
      n: R.n,
      phase: g.sm.phase,
      speed: Math.abs(g.sm.vehicle.speed),
      z: g.car.root.position.z,
      dpr: g.qualityGovernor.pixelRatio,
      calls: info.render.calls,
      tris: info.render.triangles,
      prog: info.programs ? info.programs.length : 0,
      tex: info.memory.textures,
      geo: info.memory.geometries,
      heap: performance.memory ? performance.memory.usedJSHeapSize : 0
    }),
    dump: () => {
      const out = { n: R.n, cap: R.cap, segs: SEGS, head: {} };
      for (const k of Object.keys(R)) {
        if (k === 'n' || k === 'cap' || k === 'seg') continue;
        out.head[k] = Array.from(R[k].subarray(0, R.n));
      }
      // 逐子系统扁平输出（离线脚本按 segs 名字索引）
      for (const k of SEGS) out.head['seg_' + k] = Array.from(seg[k].subarray(0, R.n));
      return out;
    }
  };
  return 'OK:' + JSON.stringify(wired);
})()
