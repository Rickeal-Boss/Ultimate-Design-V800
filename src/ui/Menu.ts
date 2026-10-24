/**
 * 开始菜单：玩法说明（滑条操作）+ **车型选择**（R15-4 双车玩法）+ 开始按钮。
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
import { byId, blurIfInside, el, setVisible } from './dom';

/** 差异说明：一句话讲清「这辆车为什么玩法不同」（菜单卡片正文） */
const VEHICLE_DIFF: Record<VehicleId, string[]> = {
  v800: [
    '机械刹车会断裂：满程保持约 1.77 s 踏板力冲到 1612 N → 踏板脱开',
    '断裂后由紧急制动安全冗余以 25% 力度接管并拖停 —— 惊险获救，但判负',
    '正常打法：贴 0.97 踩（深踩不更慢），在红区（-2s 断力）前把速度吃掉'
  ],
  r7: [
    '刹车永不断裂：踏板力钳在 1612 N，怎么踩都不断',
    '代价是制动盘升温 ×50 —— 必须脉冲式点刹控温，踩满约 0.5 s 就进红区',
    '越过红区触发 2 s 热保护断力；锁定期间电回收仍在，别松滑条，让回收慢慢带'
  ]
};

/**
 * 玩法第 ④ 条（唯一的车型相关条款），其余 ①②③⑤⑥ 两车通用。
 * V800 原文逐字保留（既有玩法文案不得回退）。
 */
const VEHICLE_RULE: Record<VehicleId, string> = {
  v800:
    '④ 满程保持会过载爬升——踏板力达到 1612 N 踏板断裂：制动失效，紧急制动安全冗余以 25% 力度接管（判负，但车会停住）',
  r7: '④ 踏板不会断裂（踏板力钳在 1612 N），但制动盘升温 ×50：踩满约 0.5s 进红区触发 2s 热保护断力，必须脉冲点刹（红区/锁定期别松滑条，让电回收继续出力）'
};

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
  card.append(
    el(
      'span',
      'vc-tag',
      id === 'v800' ? '会断踏板 · 冗余接管判负' : '不断踏板 · 热保护 2s 断力'
    )
  );
  card.addEventListener('click', () => onPick(id));
  return card;
}

export class Menu {
  readonly root: HTMLElement;
  private startButton: HTMLButtonElement;
  private readonly cards = new Map<VehicleId, HTMLElement>();

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

    // ---- 车型选择（两张卡片 + 差异说明）----
    ensureSelectStyle();
    const pick = el('div', 'vehicle-pick');
    const pickLabel = el('div', 'menu-rules-label', '选择车型');
    for (const id of VEHICLE_IDS) {
      const card = buildCard(id, active, (next) => this.pick(next));
      this.cards.set(id, card);
      pick.append(card);
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
    panel.append(title, subtitle, pickLabel, pick, rules, btnRow);
    // 自由探索（R29 次级入口）：与开始挑战同排的次级按钮，不抢主按钮视觉权重
    if (onFreeExplore) {
      const freeButton = el('button', 'btn ghost') as HTMLButtonElement;
      freeButton.type = 'button';
      freeButton.textContent = '自由探索';
      freeButton.addEventListener('click', () => onFreeExplore());
      const freeRow = el('div', 'btn-row btn-row-sub');
      freeRow.append(freeButton);
      panel.append(freeRow);
    }
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

  show(visible: boolean): void {
    // B6 a11y（R30-D2）：隐藏时撤掉面板内焦点 —— 「开始挑战」等按钮隐藏后若
    // 保持焦点，进行段按空格会重新触发其 click（startRun 重开一局），
    // 判据与推导见 dom.ts blurIfInside 注释。
    if (!visible) blurIfInside(this.root);
    setVisible(this.root, visible);
  }
}
