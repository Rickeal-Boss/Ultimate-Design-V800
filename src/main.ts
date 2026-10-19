/** 入口：装配 Game 并启动（质量档 auto 检测在此完成） */
import './ui/styles.css';
import type { WebGLRenderer } from 'three';
import { createQualitySettings } from './config/quality';
import { Game } from './core/Game';
import { byId } from './ui/dom';

const container = byId('app');
const quality = createQualitySettings();
const game = new Game(container, quality, () => {
  byId('loading').classList.add('done');
});

// QA 钩子出口（DEV only）：headless 截图脚本读不到 Game 私有状态，暴露到 window 供
// puppeteer evaluate 直驱 rig.setMode + 遮挡切换（与 frame 内 wantHide 同路径）。
if (import.meta.env.DEV) {
  (window as unknown as { __game?: unknown }).__game = game;
  // QA 射线定罪：动态引 three（不进生产 bundle），供 headless 探针精确命中遮挡件
  void import('three').then((THREE) => {
    (window as unknown as { __THREE?: unknown }).__THREE = THREE;
  });
}

// 开发期热更新支持
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}

/**
 * QA 钩子（仅 DEV + URL hash 含 perfhud 时启用，构建产物不含）：
 * 屏幕角标显示实测 FPS / draw call / 三角面数（renderer.info），供性能验收截图用。
 */
if (import.meta.env.DEV && window.location.hash.includes('perfhud')) {
  const renderer = (game as unknown as { renderer: WebGLRenderer }).renderer;
  // 关键：EffectComposer 一帧内多次 renderer.render()，autoReset 会让 info 只剩最后一个 pass。
  // 关闭 autoReset、由本钩子每帧末尾读取后手动清零 → 读数为「整帧累计」
  // （含阴影 pass 与 Bloom/SpeedBlur/Output 等后处理全屏 pass 的全部 draw call）。
  renderer.info.autoReset = false;
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.7);color:#7fff9f;' +
    'font:12px/1.6 monospace;padding:6px 10px;border-radius:6px;pointer-events:none;white-space:pre';
  document.body.appendChild(hud);
  let frames = 0;
  let fps = 0;
  let last = performance.now();
  let calls = 0;
  let tris = 0;
  const tick = (now: number): void => {
    frames++;
    calls = Math.max(calls, renderer.info.render.calls);
    tris = Math.max(tris, renderer.info.render.triangles);
    if (now - last >= 500) {
      fps = Math.round((frames * 1000) / (now - last));
      frames = 0;
      last = now;
      const prog = performance.now() / 1000;
      const text =
        `FPS ${fps} | DPR ${renderer.getPixelRatio().toFixed(2)} | ` +
        `calls(frame) ${calls} | tris(frame) ${tris} | t=${prog.toFixed(1)}s`;
      hud.textContent = text;
      // 同步写标题：QA 自动化可经 tab_title 读取（无 JS eval 通道时的实测出口）
      document.title = `[${text}]`;
      calls = 0;
      tris = 0;
    }
    renderer.info.reset();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
