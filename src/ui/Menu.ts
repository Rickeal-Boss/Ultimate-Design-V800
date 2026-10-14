/** 开始菜单：玩法说明（滑条操作）+ 开始按钮 */
import { byId, el, setVisible } from './dom';

export class Menu {
  readonly root: HTMLElement;
  private startButton: HTMLButtonElement;

  constructor(onStart: () => void, onToggleMute: () => boolean) {
    this.root = byId('menu');

    const panel = el('div', 'panel menu-panel');
    const title = el('h1', 'menu-title', '极限刹车挑战');
    const subtitle = el('div', 'menu-sub', '尊界V800 · 390kW 双电机 · 电子限速 200 km/h');
    const rules = el('div', 'menu-rules');
    rules.append(
      el('p', undefined, '① 倒计时后，向上拖动【油门滑条】（或按住 W/↑）全力加速'),
      el('p', undefined, '② 车速达到 100 km/h，【切入刹车】按钮亮起；达到限速会自动切入'),
      el('p', undefined, '③ 刹车段：向上拖动【刹车滑条】（或按住 S/↓/空格）施加踏板力'),
      el('p', undefined, '④ 满程保持会过载爬升——踏板力达到 1612 N 将当场断裂翻滚'),
      el('p', undefined, '⑤ 在路障（2600m）前刹停即成功，得分 = 初速² ÷ 用时')
    );
    const btnRow = el('div', 'btn-row');
    this.startButton = el('button', 'btn primary') as HTMLButtonElement;
    this.startButton.type = 'button';
    this.startButton.textContent = '开始挑战';
    const muteButton = el('button', 'btn') as HTMLButtonElement;
    muteButton.type = 'button';
    muteButton.textContent = '音效：开';
    muteButton.addEventListener('click', () => {
      muteButton.textContent = onToggleMute() ? '音效：关' : '音效：开';
    });
    btnRow.append(this.startButton, muteButton);
    panel.append(title, subtitle, rules, btnRow);
    this.root.append(panel);

    this.startButton.addEventListener('click', onStart);
  }

  show(visible: boolean): void {
    setVisible(this.root, visible);
  }
}
