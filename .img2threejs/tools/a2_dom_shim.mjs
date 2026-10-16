/**
 * a2_ 探针 · 最小 DOM/Canvas shim（无浏览器直跑真实工厂/适配器）。
 * 只提供几何/材质探针需要的能力：canvas 2D 上下文全部方法为空操作，
 * 纹理内容不在 Node 侧核验（由 QA 实机截图负责），这里只数几何与读参数。
 * 用法：被 a2_probe_entry.ts 首行 import，side-effect 安装全局。
 */

type GradStub = { addColorStop: (_offset: number, _color: string) => void };

function make2DContext(canvas: { width: number; height: number }): CanvasRenderingContext2D {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    // 路径
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    clip: noop,
    // 绘制
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    drawImage: noop,
    // 变换
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    // 像素
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x: number, y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    createLinearGradient: (): GradStub => ({ addColorStop: noop }),
    createRadialGradient: (): GradStub => ({ addColorStop: noop }),
    createConicGradient: (): GradStub => ({ addColorStop: noop }),
    createPattern: () => null,
    measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    isPointInPath: () => false,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const shimDocument = {
  createElement: (tag: string) => {
    if (tag === 'canvas') {
      const canvas = {
        width: 300,
        height: 150,
        style: {} as Record<string, string>,
        getContext: (kind: string) => (kind === '2d' ? make2DContext(canvas) : null),
        addEventListener: () => {},
        removeEventListener: () => {},
        toDataURL: () => 'data:,',
      };
      return canvas as unknown as HTMLCanvasElement;
    }
    return { style: {}, addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement;
  },
  createElementNS: (_ns: string, tag: string) => shimDocument.createElement(tag),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: () => {}, removeChild: () => {} },
  documentElement: { style: {} },
};

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.document === 'undefined') g.document = shimDocument;
if (typeof g.window === 'undefined') {
  g.window = {
    devicePixelRatio: 2,
    location: { hash: '', search: '', href: 'http://localhost/' },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1920,
    innerHeight: 1080,
    requestAnimationFrame: () => 0,
  };
}
if (typeof g.self === 'undefined') g.self = g.window;
if (typeof g.requestAnimationFrame === 'undefined') g.requestAnimationFrame = () => 0;
if (typeof g.cancelAnimationFrame === 'undefined') g.cancelAnimationFrame = () => {};
if (typeof g.HTMLCanvasElement === 'undefined') g.HTMLCanvasElement = class {};
if (typeof g.HTMLImageElement === 'undefined') g.HTMLImageElement = class {};
if (typeof g.Image === 'undefined') g.Image = class {};
