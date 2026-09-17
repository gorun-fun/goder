// platform.ts — 桌面平台检测的唯一出处。
// 三平台窗口装饰策略(main.go):macOS 隐藏原生标题栏但保留红绿灯
// (系统窗口控制);Windows/Linux 整窗无边框,最小化/最大化/关闭由前端
// 顶栏自绘(host/winctl.ts 的 .winctl)。检测集中在此,平台行为调整时
// 只改这一处;纯 web/嵌入态一律返回 false。
import { inWails } from './bridge';

/** 当前是 macOS 桌面态(窗口控制用系统红绿灯,无自绘 .winctl)。 */
export function isMacDesktop(): boolean {
  if (!inWails()) return false;
  return /mac/i.test(navigator.platform || navigator.userAgent);
}
