/** DOM 工具 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

export function setVisible(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

/**
 * B6 a11y（R30-D2）：事件目标是否为可交互控件。
 *
 * 用途：游戏全局吞 Space/方向键的默认行为（防页面滚动）时，**放行聚焦控件** ——
 * 按钮/链接上的 Space 默认行为是「激活控件」，吞掉它键盘用户就没法用空格
 * 点按钮（第六轮审查 B6 原话：「游戏可豁免缩放但建议放行按钮 Space」）。
 * 只做「是否交互」判断，preventDefault 的调用方决定吞不吞；本函数不拦事件，
 * 其他监听器（FreeDrive / Sliders 的同码处理）照常收到事件。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('button, a[href], input, textarea, select, [contenteditable="true"]') !== null
  );
}

/**
 * B6 a11y（R30-D2）配套：隐藏面板时撤掉面板内的焦点。
 *
 * 为什么必须配：隐藏（display:none）的按钮**仍可持有焦点并被 Space/回车激活**。
 * 菜单点「开始挑战」后按钮不失焦 → 加速段按空格（刹车输入）会顺带重新触发
 * 按钮 click → startRun() 把进行中的一局重置（accel 相位 StateMachine 是消费
 * brakePressed 的，见 StateMachine.step；menu/stopped 相位不消费，风险集中在
 * countdown→accel→brake 进行段）。在各面板的隐藏出口统一 blur，焦点回到 body，
 * 之后 Space 只走游戏输入链（Sliders/FreeDrive），不误触 UI。
 */
export function blurIfInside(root: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && root.contains(active)) active.blur();
}
