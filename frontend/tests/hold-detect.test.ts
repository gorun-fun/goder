// hold-detect.test.ts — 按住说话手势状态机:成局阈值、位移放奔、
// 上滑取消区、松开收尾、系统打断(pointercancel)与普通点击放行。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldDetector } from '../src/util/hold-detect';

describe('HoldDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('按住超过阈值成局,原位松开正常收尾(不取消)', () => {
    const ev = { onHoldStart: vi.fn(), onHoldEnd: vi.fn(), onTap: vi.fn() };
    const d = new HoldDetector({ holdMs: 350 }, ev);
    d.pointerdown(100, 200);
    vi.advanceTimersByTime(349);
    expect(ev.onHoldStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ev.onHoldStart).toHaveBeenCalledTimes(1);
    d.pointerup();
    expect(ev.onHoldEnd).toHaveBeenCalledWith(false);
    expect(ev.onTap).not.toHaveBeenCalled();
  });

  it('未到阈值松开 = 普通点击(onTap),不触发长按', () => {
    const ev = { onHoldStart: vi.fn(), onHoldEnd: vi.fn(), onTap: vi.fn() };
    const d = new HoldDetector({ holdMs: 350 }, ev);
    d.pointerdown(0, 0);
    vi.advanceTimersByTime(200);
    d.pointerup();
    expect(ev.onTap).toHaveBeenCalledTimes(1);
    expect(ev.onHoldStart).not.toHaveBeenCalled();
    expect(ev.onHoldEnd).not.toHaveBeenCalled();
  });

  it('成局前位移超过 slop = 拖动,放弃判定且不打任何回调', () => {
    const ev = { onHoldStart: vi.fn(), onHoldEnd: vi.fn(), onTap: vi.fn() };
    const d = new HoldDetector({ holdMs: 350, slop: 10 }, ev);
    d.pointerdown(0, 0);
    d.pointermove(30, 5); // 水平拖动 30px
    vi.advanceTimersByTime(500);
    d.pointerup();
    expect(ev.onHoldStart).not.toHaveBeenCalled();
    expect(ev.onTap).not.toHaveBeenCalled();
    expect(ev.onHoldEnd).not.toHaveBeenCalled();
  });

  it('成局后上滑进入取消区,松开按取消收尾', () => {
    const ev = { onHoldStart: vi.fn(), onHoldMove: vi.fn(), onHoldEnd: vi.fn() };
    const d = new HoldDetector({ holdMs: 350, cancelRise: 80 }, ev);
    d.pointerdown(100, 300);
    vi.advanceTimersByTime(350);
    expect(d.inCancelZone).toBe(false);
    d.pointermove(100, 240); // 上滑 60px,未过阈
    expect(d.inCancelZone).toBe(false);
    expect(ev.onHoldMove).toHaveBeenCalledWith(-60);
    d.pointermove(100, 210); // 上滑 90px,过阈
    expect(d.inCancelZone).toBe(true);
    d.pointerup();
    expect(ev.onHoldEnd).toHaveBeenCalledWith(true);
  });

  it('成局后下滑/回位退出取消区,松开恢复正常转写', () => {
    const ev = { onHoldEnd: vi.fn() };
    const d = new HoldDetector({ holdMs: 350, cancelRise: 80 }, ev);
    d.pointerdown(100, 300);
    vi.advanceTimersByTime(350);
    d.pointermove(100, 200); // 上滑 100px 入取消区
    d.pointermove(100, 320); // 滑回下方,退出取消区
    expect(d.inCancelZone).toBe(false);
    d.pointerup();
    expect(ev.onHoldEnd).toHaveBeenCalledWith(false);
  });

  it('pointercancel(系统打断)成局态按取消收尾;pending 态静默', () => {
    const ev = { onHoldEnd: vi.fn(), onTap: vi.fn() };
    const d1 = new HoldDetector({ holdMs: 350 }, ev);
    d1.pointerdown(0, 0);
    vi.advanceTimersByTime(350);
    d1.pointercancel();
    expect(ev.onHoldEnd).toHaveBeenCalledWith(true);
    const d2 = new HoldDetector({ holdMs: 350 }, ev);
    d2.pointerdown(0, 0);
    d2.pointercancel();
    expect(ev.onTap).not.toHaveBeenCalled();
    expect(ev.onHoldEnd).toHaveBeenCalledTimes(1);
  });

  it('成局前再次 pointerdown 重置计时(以最后一次按压为准)', () => {
    const ev = { onHoldStart: vi.fn() };
    const d = new HoldDetector({ holdMs: 350 }, ev);
    d.pointerdown(0, 0);
    vi.advanceTimersByTime(200);
    d.pointerdown(50, 50);
    vi.advanceTimersByTime(200);
    expect(ev.onHoldStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(ev.onHoldStart).toHaveBeenCalledTimes(1);
  });
});
