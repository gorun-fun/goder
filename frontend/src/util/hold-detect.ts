// hold-detect.ts — 按住说话手势判定(纯逻辑状态机,vitest 直测)。
// 移动端 composer 长按输入区触发语音转写的通用判定:按下后保持基本不动
// (位移 ≤ slop)持续 holdMs 即「成局」(onHoldStart,调用方开始录音);
// 成局后手指上滑超过 cancelRise 进入取消区(松开丢弃录音,微信「按住
// 说话、上滑取消」同款);未成局即松开视为普通点击(onTap,交还默认
// 行为,不吞事件)。成局前的移动超阈、多点按压直接放弃判定(静默)。
export interface HoldDetectOptions {
  /** 成局阈值(按下不动持续多久算长按) */
  holdMs?: number;
  /** 成局前允许的位移(像素,超过视为拖动而非长按) */
  slop?: number;
  /** 成局后的上滑取消阈值(像素,向上位移超过即进入取消区) */
  cancelRise?: number;
}

export interface HoldDetectEvents {
  /** 成局(长按成立):开始录音等 */
  onHoldStart?(): void;
  /** 成局后的移动:rise 为相对按点的纵向位移(负值 = 上滑);
   *  调用方据 rise 与 inCancelZone 切换「松开结束/松开取消」提示 */
  onHoldMove?(rise: number): void;
  /** 松开收尾:cancel = true 表示处于取消区(丢弃录音) */
  onHoldEnd?(cancel: boolean): void;
  /** 未成局即松开(普通点击;调用方不处理,走默认行为) */
  onTap?(): void;
}

const DEFAULT_HOLD_MS = 350;
const DEFAULT_SLOP = 10;
const DEFAULT_CANCEL_RISE = 80;

export class HoldDetector {
  private readonly opts: Required<HoldDetectOptions>;
  private readonly ev: HoldDetectEvents;
  /** 按下的起点坐标 */
  private sx = 0;
  private sy = 0;
  /** idle = 未按下;pending = 计时中;holding = 已成局 */
  private state: 'idle' | 'pending' | 'holding' = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: HoldDetectOptions = {}, ev: HoldDetectEvents = {}) {
    this.opts = { holdMs: DEFAULT_HOLD_MS, slop: DEFAULT_SLOP, cancelRise: DEFAULT_CANCEL_RISE, ...opts };
    this.ev = ev;
  }

  /** 是否已成局(录音中判定用) */
  get holding(): boolean {
    return this.state === 'holding';
  }

  /** 成局后是否处于上滑取消区 */
  get inCancelZone(): boolean {
    return this.holding && this.rise <= -this.opts.cancelRise;
  }

  /** 相对按点的纵向位移(成局后有效;负 = 上滑) */
  private rise = 0;

  pointerdown(x: number, y: number): void {
    this.reset();
    this.sx = x;
    this.sy = y;
    this.rise = 0;
    this.state = 'pending';
    this.timer = setTimeout(() => {
      if (this.state !== 'pending') return;
      this.state = 'holding';
      this.timer = null;
      this.ev.onHoldStart?.();
    }, this.opts.holdMs);
  }

  pointermove(x: number, y: number): void {
    if (this.state === 'idle') return;
    const dx = x - this.sx;
    const dy = y - this.sy;
    if (this.state === 'pending') {
      // 成局前:位移超阈 = 拖动/滚动,放弃长按判定
      if (dx * dx + dy * dy > this.opts.slop * this.opts.slop) this.reset();
      return;
    }
    this.rise = dy;
    this.ev.onHoldMove?.(dy);
  }

  pointerup(): void {
    if (this.state === 'pending') {
      this.reset();
      this.ev.onTap?.();
      return;
    }
    if (this.state === 'holding') {
      const cancel = this.inCancelZone;
      this.reset();
      this.ev.onHoldEnd?.(cancel);
    }
  }

  /** 指针取消(系统打断:来电/手势导航抢占等):一律按取消收尾 */
  pointercancel(): void {
    if (this.state === 'idle') return;
    const wasHolding = this.state === 'holding';
    this.reset();
    if (wasHolding) this.ev.onHoldEnd?.(true);
  }

  /** 清空计时与状态(不打回调) */
  private reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state = 'idle';
    this.rise = 0;
  }
}
