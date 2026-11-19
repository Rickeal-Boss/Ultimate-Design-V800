/**
 * 开始菜单：玩法说明（滑条操作）+ **车型选择**（R15-4 三车玩法）+ 开始按钮。
 *
 * 选车语义：选中 → setActiveVehicle(id) 写 localStorage → location.reload()。
 * 为什么必须 reload：车模装配目前是「按活动车型构建」的（createV800CarAdapter /
 * createR7CarAdapter 二选一），运行时换整车几何/材质/批合并的代价远大于一次重载，
 * 且当前 uh指点布线由主理人在装配层完成（见 Game.createCar() 注入点）。
 */
import {
  VEHICLE_IDS,
  VEHICLE_PROFILES,
  resolveVehicleId,
  setActiveVehicle,
  type VehicleId,
  type VehicleProfile
} from '../config/vehicles';
import {
  paintChoicesFor,
  paintChoiceLabel,
  paintChoiceSwatch,
  resolvePaintChoiceFor,
  setActivePaint,
  type PaintChoice,
  type VehicleKey
} from '../config/vehiclePaint';
import {
  SHELL_TOTAL_MB,
  cancelExternalShellLoad,
  isHighDetailEnabled,
  isShellLoadCancelled,
  setHighDetailEnabled
} from '../config/highDetail';
import { isMotionBlurEnabled, setMotionBlurEnabled } from '../config/motionBlur';
import { byId, blurIfInside, el, setVisible } from './dom';

/** 差异说明：一句话讲清「这辆车为什么玩法不同」（菜单卡片正文） */
export const VEHICLE_DIFF: Record<VehicleId, string[]> = {
  v800: [
    '机械刹车会断裂：满程保持约 1.77 s 踏板力冲到 1612 N → 踏板脱开',
    '断裂后由紧急制动安全冗余以 25% 力度接管并拖停 —— 惊险获救，但判负',
    '正常打法：贴 0.97 踩（深踩不更慢），在红区（-2s 断力）前把速度吃掉'
  ],
  r7: [
    '刹车永不断裂：踏板力钳在 1612 N，怎么踩都不断',
    '代价是制动盘升温 ×50 —— 必须脉冲式点刹控温，踩满约 0.5 s 就进红区',
    '越过红区触发 2 s 热保护断力；锁定期间电回收仍在，别松滑条，让回收慢慢带'
  ],
  yangwang: [
    '半程约 650m 中途爆胎，易四方四电机稳住车身：姿态平稳、不会翻滚，仍可刹停',
    '踏板不会断裂，制动盘不过热：可放心持续踩住刹车，不会触发热保护断力',
    '彩蛋挑战：完美刹停也计 0 分（不计入本机最佳成绩）'
  ]
};

/**
 * 玩法第 ④ 条（唯一的车型相关条款），其余 ①②③⑤⑥ 三车通用。
 * V800 原文逐字保留（既有玩法文案不得回退）。
 */
export const VEHICLE_RULE: Record<VehicleId, string> = {
  v800:
    '④ 满程保持会过载爬升——踏板力达到 1612 N 踏板断裂：制动失效，紧急制动安全冗余以 25% 力度接管（判负，但车会停住）',
  r7: '④ 踏板不会断裂（踏板力钳在 1612 N），但制动盘升温 ×50：踩满约 0.5s 进红区触发 2s 热保护断力，必须脉冲点刹（红区/锁定期别松滑条，让电回收继续出力）',
  yangwang:
    '④ 半程约 650m 中途爆胎，但易四方四电机保持车身平稳、不会翻滚，仍可刹停；踏板不会断裂（力钳在 1612 N），制动盘不过热：可放心持续踩住刹车；彩蛋挑战不计分'
};

/** 卡片角标：三车各自一句定位（v800/r7 原文逐字保留） */
const VEHICLE_TAG: Record<VehicleId, string> = {
  v800: '会断踏板 · 冗余接管判负',
  r7: '不断踏板 · 热保护 2s 断力',
  yangwang: '彩蛋挑战 · 半程爆胎稳行 · 不计分'
};

/**
 * 资产表 key 收窄：vehiclePaint（VEHICLE_VARIANTS / DEFAULT_VARIANT /
 * STORAGE_KEY_BY_VEHICLE）与 highDetail（SHELL_TOTAL_MB）的 key 仍是 'v800'|'r7'，
 * 且不在本轮白名单内。仰望暂无独立资产条目 ——
 *  · 高精度壳容量文案借 V800 口径（纯显示，无写盘副作用）；
 *  · 车漆不开放切换（见 constructor），绝不写进 v800.paint ——
 *    守住 R37 P2-9「在 B 车选色写进 A 车 key，改掉 A 车玩家选择」的既有教训。
 * 资产表扩 key 后可直接删掉本函数并把调用点改回传 VehicleId。
 */
function assetKeyFor(id: VehicleId): VehicleKey {
  return id === 'yangwang' ? 'v800' : id;
}

const SELECT_STYLE_ID = 'menu-vehicle-style';

/** 车型选择卡片样式（styles.css 不在本轮白名单，故自注入；id 去重防 HMR 叠加） */
function ensureSelectStyle(): void {
  if (document.getElementById(SELECT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SELECT_STYLE_ID;
  style.textContent = `
.menu-rules-label {
  font-size: 12px;
  letter-spacing: 2px;
  opacity: .75;
  margin-bottom: 6px;
}
.vehicle-pick {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.vehicle-card {
  flex: 1;
  text-align: left;
  font-family: inherit;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--line, rgba(255,255,255,0.08));
  background: rgba(255, 255, 255, 0.04);
  color: var(--cream, #f1dcae);
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease;
}
.vehicle-card:hover { background: rgba(255, 255, 255, 0.08); }
.vehicle-card.active {
  border-color: var(--orange, #ff6a3d);
  background: rgba(210, 60, 30, 0.22);
}
.vehicle-card .vc-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 1px;
}
.vehicle-card .vc-sub {
  margin: 2px 0 6px;
  font-size: 11px;
  opacity: .72;
  line-height: 1.5;
}
.vehicle-card .vc-diff {
  margin: 0;
  padding-left: 14px;
  font-size: 11.5px;
  line-height: 1.65;
  opacity: .9;
  /* R98: 差异列表按字断行，长英文/数字串不顶破卡片（不动布局/颜色/字号） */
  overflow-wrap: anywhere;
  word-break: normal;
  white-space: normal;
  line-break: strict;
}
.vehicle-card .vc-diff li {
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: normal;
}
.vehicle-card .vc-tag {
  display: inline-block;
  margin-top: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: .5px;
  background: rgba(255, 106, 61, .22);
  border: 1px solid rgba(255, 106, 61, .5);
}
/* ═══ R37-P1 矮屏首屏保 CTA ═══════════════════════════════════════════════════
 * 背景（落地审查 P1 阻断）：R37-C 新增「选择车漆」label + 色块行 44px 后，
 * 1280×760 下 .menu-panel 内容高 847px、可视区只有 718px（溢出 129px）⇒
 * 「开始挑战」被挤出可视区（实测可见 5.9%、elementFromPoint 命中 null）。
 *
 * 量到的区块高度（1280×900，全放得下时）：车型卡片 258.8 / 规则区 223.5 /
 * 色块行 28+label16 / 按钮行 47×2。⇒ 真正吃高的是**车型卡片 + 规则区**，
 * 色块行只占 44px（用户本轮明确要的功能，**不许为腾位置藏起来**）。
 *
 * 处置（两条，都不牺牲信息）：
 *   ① **整体瘦身 ~45px**：面板 padding 28→20、副标题/规则/色块行的外边距各收一档、
 *      规则行高 1.9→1.62（9 行文案 ≈ −25px）。规则文案**一行不删**。
 *   ② **矮屏规则区内部滚动**：@media (max-height: 800px) 时给 .menu-rules
 *      限高 + 自身滚动 —— 与 styles.css 里 max-height: 560px 那套
 *      「规则区内部滚动」的既有先例同策略。900 高不触发 ⇒ 不产生突兀空白。
 *
 * ⚠⚠ 本段整体位于 **CSS 模板字符串内部**：注释里**绝不能出现反引号**，
 *   否则模板串提前闭合 ⇒ esbuild 报 "Expected ; but found @"，页面一片空白。
 *   （已踩：tsc 只在部分行报错，看着像类型错误，实际是字符串被截断。）
 * ⚠ 选择器一律带 .menu-panel 提特异性：本段是**运行时注入**的 style，
 *   不能靠"后加载"压过 styles.css，必须靠特异性赢。
 * ⚠ 只影响开始菜单面板；结算面板/其它 .panel 完全不受影响。 */
.panel.menu-panel {
  padding: 20px 26px;
}
.menu-panel .menu-sub {
  margin: 6px 0 12px;
}
.menu-panel .menu-rules {
  line-height: 1.62;
  margin-bottom: 14px;
  padding: 9px 0;
}
.menu-panel .menu-rules-label {
  margin-bottom: 4px;
}
.menu-panel .paint-pick {
  margin-bottom: 12px;
}
@media (max-height: 800px) {
  .menu-panel .menu-rules {
    max-height: 120px;
    overflow-y: auto;
  }
}

/* ---- R37-C 车漆色块（与 .vehicle-card 同族视觉：同圆角/同边框/同 hover 语义）---- */
.paint-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.paint-swatch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  padding: 5px 10px 5px 6px;
  border-radius: 10px;
  border: 1px solid var(--line, rgba(255,255,255,0.08));
  background: rgba(255, 255, 255, 0.04);
  color: var(--cream, #f1dcae);
  font-size: 11.5px;
  letter-spacing: .5px;
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease;
}
.paint-swatch:hover { background: rgba(255, 255, 255, 0.08); }
.paint-swatch.active {
  border-color: var(--orange, #ff6a3d);
  background: rgba(210, 60, 30, 0.22);
}
.paint-swatch .ps-chip {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.35);
}
/* 仰望车漆资产未登记：占位说明与色块行等高（28px），不推高「开始挑战」（R37-P1） */
.menu-panel .paint-note {
  font-size: 11.5px;
  opacity: .72;
  line-height: 28px;
}

/* ---- R46 LOAD-A 停止下载高精度模型 ----
 * 复用既有 .btn ghost 骨架（styles.css:626），只收字号/字距：不新增行高、
 * 不改变 btn-row 之前任何内容的高度 —— R37-P1 矮屏 1280x760 下
 * 「开始挑战」曾被挤出可视区（实测可见 5.9%），本轮不得回归。
 * 本段位于 CSS 模板字符串内部：注释里绝不能出现反引号。 */
.menu-panel .hd-toggle {
  font-size: 11.5px;
  letter-spacing: .2px;
  white-space: nowrap;
}
`;
  document.head.appendChild(style);
}

function buildCard(id: VehicleId, active: VehicleId, onPick: (id: VehicleId) => void): HTMLElement {
  const p: VehicleProfile = VEHICLE_PROFILES[id];
  const card = el('button', 'vehicle-card' + (id === active ? ' active' : '')) as HTMLButtonElement;
  card.type = 'button';
  card.dataset.vehicle = id;
  card.append(el('div', 'vc-name', p.name), el('div', 'vc-sub', p.subtitle));
  const ul = el('ul', 'vc-diff');
  for (const line of VEHICLE_DIFF[id]) ul.append(el('li', undefined, line));
  card.append(ul);
  card.append(el('span', 'vc-tag', VEHICLE_TAG[id]));
  card.addEventListener('click', () => onPick(id));
  return card;
}

/** 单个车漆色块按钮（type/aria-pressed 与既有 vehicle-card 同风格） */
function buildSwatch(
  choice: PaintChoice,
  active: PaintChoice,
  onPick: (c: PaintChoice) => void
): HTMLButtonElement {
  const btn = el(
    'button',
    'paint-swatch' + (choice === active ? ' active' : '')
  ) as HTMLButtonElement;
  btn.type = 'button';
  btn.dataset.paint = choice;
  const label = paintChoiceLabel(choice);
  btn.title = `车漆：${label}`;
  btn.setAttribute('aria-label', `车漆 ${label}`);
  // B6 a11y（同 R30-D2 判据）：选中态走 aria-pressed，读屏能报出「已选中」
  btn.setAttribute('aria-pressed', choice === active ? 'true' : 'false');
  const chip = el('span', 'ps-chip');
  chip.style.background = paintChoiceSwatch(choice);
  btn.append(chip, el('span', 'ps-name', label));
  btn.addEventListener('click', () => onPick(choice));
  return btn;
}

export class Menu {
  readonly root: HTMLElement;
  private startButton: HTMLButtonElement;
  private readonly cards = new Map<VehicleId, HTMLElement>();
  private readonly swatches = new Map<PaintChoice, HTMLButtonElement>();
  /** R46 LOAD-A：停止/恢复高精度车模按钮 + 当前车型（文案按车显示资产总量） */
  private hdButton: HTMLButtonElement;
  private hdVehicle: VehicleId;
  /** R47：动态模糊开关（默认关；即时生效，不 reload） */
  private blurButton: HTMLButtonElement;

  /**
   * @param onStart 开始挑战
   * @param onToggleMute 音效开关
   * @param onFreeExplore 自由探索（R29 可选入口；结算页的同名按钮是主入口）
   */
  constructor(onStart: () => void, onToggleMute: () => boolean, onFreeExplore?: () => void) {
    this.root = byId('menu');

    const panel = el('div', 'panel menu-panel');
    const title = el('h1', 'menu-title', '极限刹车挑战');
    const active = resolveVehicleId();
    const subtitle = el(
      'div',
      'menu-sub',
      `${VEHICLE_PROFILES[active].name} · ${VEHICLE_PROFILES[active].subtitle}`
    );
    this.startButton = el('button', 'btn primary') as HTMLButtonElement;

    // ---- 车型选择（三张卡片 + 差异说明）----
    ensureSelectStyle();
    const pick = el('div', 'vehicle-pick');
    const pickLabel = el('div', 'menu-rules-label', '选择车型');
    for (const id of VEHICLE_IDS) {
      const card = buildCard(id, active, (next) => this.pick(next));
      this.cards.set(id, card);
      pick.append(card);
    }

    // ---- 车漆选择（色块一排；R7 多一个「原厂墨绿」在首位）----
    // 仰望资产表未登记（见 assetKeyFor）：不渲染色块、不落盘，避免污染 v800.paint。
    const paintKey = active === 'yangwang' ? null : assetKeyFor(active);
    const paintActive = paintKey ? resolvePaintChoiceFor(paintKey) : '';
    const paintPick = el('div', 'paint-pick');
    if (paintKey) {
      for (const choice of paintChoicesFor(paintKey)) {
        const sw = buildSwatch(choice, paintActive, (next) => this.pickPaint(next));
        this.swatches.set(choice, sw);
        paintPick.append(sw);
      }
    } else {
      paintPick.append(el('span', 'paint-note', '车漆随车型装配（暂不可选）'));
    }

    const rules = el('div', 'menu-rules');
    rules.append(
      el('p', undefined, '① 倒计时后，向上拖动【油门滑条】（或按住 W/↑）全力加速'),
      el('p', undefined, '② 车速达到 100 km/h，【切入刹车】按钮亮起；达到限速会自动切入'),
      el('p', undefined, '③ 刹车段：向上拖动【刹车滑条】（或按住 S/↓/空格）施加踏板力'),
      el('p', undefined, VEHICLE_RULE[active]),
      el('p', undefined, '⑤ 在主殿（1300m）前刹停即成功，得分 = 初速² ÷ 用时；紧贴主殿再切入会撞上去'),
      el('p', undefined, '⑥ 拖动画面转视角 · 滚轮/捏合缩放 · 双击回正（V 键循环机位）')
    );
    const btnRow = el('div', 'btn-row');
    this.startButton.type = 'button';
    this.startButton.textContent = '开始挑战';
    const muteButton = el('button', 'btn') as HTMLButtonElement;
    muteButton.type = 'button';
    muteButton.textContent = '音效：开';
    muteButton.addEventListener('click', () => {
      muteButton.textContent = onToggleMute() ? '音效：关' : '音效：开';
    });
    btnRow.append(this.startButton, muteButton);
    panel.append(
      title,
      subtitle,
      pickLabel,
      pick,
      el('div', 'menu-rules-label', '选择车漆'),
      paintPick,
      rules,
      btnRow
    );
    // 次级入口行（R29 自由探索 + R46 停止下载）：位于 btnRow【之后】，
    // 不推高「开始挑战」之前任何内容 ⇒ 守住 R37-P1 矮屏首屏保 CTA 约束。
    // 复用同一行：默认（有自由探索时）新增按钮零额外行高。
    const subRow = el('div', 'btn-row btn-row-sub');
    if (onFreeExplore) {
      const freeButton = el('button', 'btn ghost') as HTMLButtonElement;
      freeButton.type = 'button';
      freeButton.textContent = '自由探索';
      freeButton.addEventListener('click', () => onFreeExplore());
      subRow.append(freeButton);
    }
    // R46 LOAD-A：只放 #menu 起始菜单（绝不放 #loading 屏 —— main.ts 首帧即给
    // #loading 加 done、styles.css 随即 pointer-events:none，可点窗口约 1 帧，
    // 而 45MB 下载要数分钟）。菜单常驻期正是下载在途窗口。
    this.hdVehicle = active;
    this.hdButton = el('button', 'btn ghost hd-toggle') as HTMLButtonElement;
    this.hdButton.type = 'button';
    this.hdButton.dataset.highDetail = 'toggle';
    this.hdButton.addEventListener('click', () => this.onHighDetailToggle());
    this.updateHdButton();
    subRow.append(this.hdButton);
    // R47 动态模糊选项：与「停止下载」同排、复用 .hd-toggle 小字号骨架，
    // 位于 btnRow 之后 ⇒ 不推高「开始挑战」之前任何内容（R37-P1 矮屏约束）。
    this.blurButton = el('button', 'btn ghost hd-toggle') as HTMLButtonElement;
    this.blurButton.type = 'button';
    this.blurButton.dataset.motionBlur = 'toggle';
    this.blurButton.addEventListener('click', () => this.onMotionBlurToggle());
    this.updateBlurButton();
    subRow.append(this.blurButton);
    panel.append(subRow);
    this.root.append(panel);

    this.startButton.addEventListener('click', onStart);
  }

  /** 选车 → 落盘 → 重载（装配态由 Game.createCar() 按新车型重建） */
  private pick(id: VehicleId): void {
    if (id === resolveVehicleId()) return;
    setActiveVehicle(id);
    for (const [key, card] of this.cards) card.classList.toggle('active', key === id);
    this.startButton.disabled = true;
    location.reload();
  }

  /**
   * 选车漆 → 落盘 → 重载（与选车同机制）。
   * 为什么不运行时换色：车漆材质在装配期就被合批/克隆（batch/paint-*、内舱暗面克隆），
   * 运行时改基色要同时同步这些派生实例，代价与风险都高于一次重载。
   */
  private pickPaint(choice: PaintChoice): void {
    const vehicle = resolveVehicleId();
    // 仰望无独立资产 key：菜单不渲染其色块，这里兜底早退，绝不写进 v800.paint。
    if (vehicle === 'yangwang') return;
    const assetKey = assetKeyFor(vehicle);
    if (choice === resolvePaintChoiceFor(assetKey)) return;
    // R37 P2-9：**必须显式传当前车型** —— 车漆 key 已按车型隔离，
    // 在 R7 选色若写进 V800 的 key，就会把 V800 的玩家选择改掉。
    setActivePaint(choice, assetKey);
    for (const [key, sw] of this.swatches) {
      const on = key === choice;
      sw.classList.toggle('active', on);
      sw.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.startButton.disabled = true;
    location.reload();
  }

  /** 外部壳是否已就绪（读 window.__r44Shell 台账；Node / 无探针时恒 false） */
  private shellReady(): boolean {
    if (typeof window === 'undefined') return false;
    const status = (window as unknown as {
      __r44Shell?: Record<VehicleId, { state?: string }>;
    }).__r44Shell;
    return status?.[this.hdVehicle]?.state === 'ready';
  }

  /** 三态文案：允许高精度(未就绪) / 允许高精度(已就绪) / 已停止或偏好关闭 */
  private hdButtonLabel(): string {
    const total = SHELL_TOTAL_MB[assetKeyFor(this.hdVehicle)];
    if (!isHighDetailEnabled() || isShellLoadCancelled()) {
      return `恢复高精度车模（约 ${total} MB）`;
    }
    return this.shellReady()
      ? '下次启动使用默认车模'
      : '停止下载高精度模型（使用默认车模）';
  }

  private updateHdButton(): void {
    const label = this.hdButtonLabel();
    this.hdButton.textContent = label;
    this.hdButton.title = label;
    this.hdButton.setAttribute('aria-label', label);
    // B6 a11y（同 buildSwatch）：切换态走 aria-pressed，读屏能报「已选中」
    this.hdButton.setAttribute(
      'aria-pressed',
      !isHighDetailEnabled() || isShellLoadCancelled() ? 'true' : 'false'
    );
  }

  /**
   * R46 LOAD-A 点击语义：
   *  · 停止 = 中止在途 fetch（cancelExternalShellLoad → AbortController）+ 落盘 off；
   *    loadExternalShell 返回 null ⇒ 两个 Adapter 的 `if (!shell) return` 保持
   *    程序化外观完整（R45 已线上验证的 #r44ext=off 回退路径），运行时零感知。
   *  · 壳已就绪态**不热卸载**（dispose + 恢复 setExteriorHidden 属独立变更）：
   *    只落盘，下次启动生效。
   *  · 恢复 = 写 on + location.reload()（与选车/换色同机制；abort 过的请求
   *    无法断点续传，重载最稳且能复位模块级取消状态）。
   */
  private onHighDetailToggle(): void {
    if (!isHighDetailEnabled() || isShellLoadCancelled()) {
      setHighDetailEnabled(true);
      this.startButton.disabled = true;
      this.hdButton.disabled = true;
      location.reload();
      return;
    }
    if (!this.shellReady()) {
      cancelExternalShellLoad('user');
    }
    setHighDetailEnabled(false);
    this.updateHdButton();
  }

  /** R47：动态模糊开关文案 / a11y（与 buildSwatch、hdButton 同口径） */
  private updateBlurButton(): void {
    const on = isMotionBlurEnabled();
    const label = `动态模糊：${on ? '开' : '关'}`;
    this.blurButton.textContent = label;
    this.blurButton.title = label;
    this.blurButton.setAttribute('aria-label', label);
    this.blurButton.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** 点按切换：setMotionBlurEnabled 会刷新 config 的模块级缓存 ⇒ 无需重载 */
  private onMotionBlurToggle(): void {
    setMotionBlurEnabled(!isMotionBlurEnabled());
    this.updateBlurButton();
  }

  show(visible: boolean): void {
    // B6 a11y（R30-D2）：隐藏时撤掉面板内焦点 —— 「开始挑战」等按钮隐藏后若
    // 保持焦点，进行段按空格会重新触发其 click（startRun 重开一局），
    // 判据与推导见 dom.ts blurIfInside 注释。
    if (!visible) blurIfInside(this.root);
    setVisible(this.root, visible);
    // R46：菜单重新显示时壳可能已就绪，刷新按钮三态（label / aria-pressed）
    if (visible) this.updateHdButton();
  }
}
