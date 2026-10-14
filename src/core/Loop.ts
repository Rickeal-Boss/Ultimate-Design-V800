/**
 * 固定步长累加器：物理 1/120s，渲染 rAF + 插值。
 * tick 固定步进；frame 每渲染帧调用（dt 为实际帧时长，alpha 为插值系数）。
 */
export interface LoopCallbacks {
  tick: (step: number) => void;
  frame: (dt: number, alpha: number) => void;
}

export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private readonly step: number;

  constructor(
    private callbacks: LoopCallbacks,
    stepHz = 120,
    private maxFrameTime = 0.1
  ) {
    this.step = 1 / stepHz;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const frame = (now: number): void => {
      if (!this.running) return;
      // 限制单帧时长，避免切后台回来后追帧卡死
      const dt = Math.min(this.maxFrameTime, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.accumulator += dt;
      while (this.accumulator >= this.step) {
        this.accumulator -= this.step;
        this.callbacks.tick(this.step);
      }
      this.callbacks.frame(dt, this.accumulator / this.step);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    this.stop();
  }
}
