// store.ts — 极简响应式基座:版本号 + 订阅通知。
export type Unsubscribe = () => void;

export class Emitter {
  private version = 0;
  private subs = new Set<() => void>();

  get rev(): number {
    return this.version;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  notify(): void {
    this.version++;
    for (const fn of this.subs) fn();
  }
}
