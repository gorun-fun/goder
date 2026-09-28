// emitter.ts — 极简响应式基座:版本号 + 订阅通知。
// 两种订阅粒度:
//   subscribe()         全量通知(结构变化:会话列表/连接态/会话切换等低频点)
//   subscribeSession()  会话定向通知(高频流式 delta;只有订阅该会话的
//                       监听者收到,避免流式期间全页面板重渲染)
// notifySession 不递增全局版本号以外的状态、不惊动全量订阅者;低频结构
// 变化一律走 notify()(全量 + 版本号递增,定向订阅者不因全量通知重复收到
// ——sessionSubs 只在 notifySession 里触发)。
export type Unsubscribe = () => void;

export class Emitter {
  private version = 0;
  private subs = new Set<() => void>();
  private sessionSubs = new Map<string, Set<() => void>>();

  get rev(): number {
    return this.version;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** 订阅某个会话的定向通知(高频流式 delta;嵌入方多会话编排、单会话
   *  面板用它避免被其他会话的流量唤醒)。 */
  subscribeSession(sid: string, fn: () => void): Unsubscribe {
    let set = this.sessionSubs.get(sid);
    if (!set) {
      set = new Set();
      this.sessionSubs.set(sid, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.sessionSubs.delete(sid);
    };
  }

  /** 全量通知(低频结构变化)。 */
  notify(): void {
    this.version++;
    for (const fn of this.subs) fn();
  }

  /** 会话定向通知(高频 delta):只唤醒订阅该会话的监听者。 */
  notifySession(sid: string): void {
    this.version++;
    const set = this.sessionSubs.get(sid);
    if (set) for (const fn of set) fn();
  }
}
