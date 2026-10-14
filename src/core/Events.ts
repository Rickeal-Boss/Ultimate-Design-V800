/** 轻量事件总线：on / off / emit，解耦物理 / 渲染 / UI */
export type EventHandler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<EventHandler<never>>>();

  on<K extends keyof Events>(key: K, handler: EventHandler<Events[K]>): void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler as EventHandler<never>);
  }

  off<K extends keyof Events>(key: K, handler: EventHandler<Events[K]>): void {
    this.handlers.get(key)?.delete(handler as EventHandler<never>);
  }

  emit<K extends keyof Events>(key: K, payload: Events[K]): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const handler of set) (handler as EventHandler<Events[K]>)(payload);
  }
}
