// winctl.ts — Windows 无边框窗口的窗口控制。
//
// Windows 上没有 macOS 那种"隐藏标题栏但保留红绿灯"的能力:窗口只能整窗
// 无边框(main.go 的 applyWindowDecorations 置 Frameless),原生最小化/
// 最大化/关闭按钮一并消失,改由 app-shell 右上角自绘(.winctl),这里封装
// 对应的 wails runtime 窗口调用。macOS 用系统红绿灯、Linux 保留原生边框,
// 都不经过本模块。
//
// runtime 是动态 import:非桌面态与嵌入产物都不会把它打进包(同 host/bridge)。
import { inWails } from './bridge';

/** 当前是 Windows 桌面态:窗口整窗无边框,窗口控制需前端自绘。 */
export function isWindowsDesktop(): boolean {
  if (!inWails()) return false;
  return /windows/i.test(navigator.userAgent || '');
}

interface WindowAPI {
  Minimise(): Promise<void>;
  ToggleMaximise(): Promise<void>;
  Close(): Promise<void>;
  IsMaximised(): Promise<boolean>;
}

let api: Promise<WindowAPI | null> | null = null;

function windowAPI(): Promise<WindowAPI | null> {
  if (!api) {
    api = (async () => {
      try {
        const mod = (await import('@wailsio/runtime')) as unknown as { Window?: WindowAPI };
        return mod.Window ?? null;
      } catch {
        return null;
      }
    })();
  }
  return api;
}

/** 最小化窗口。 */
export function minimiseWindow(): void {
  void windowAPI().then((w) => w?.Minimise());
}

/** 最大化 / 还原窗口。 */
export function toggleMaximiseWindow(): void {
  void windowAPI().then((w) => w?.ToggleMaximise());
}

/** 关闭窗口(等价原生 ×;主窗口关闭即退出应用)。 */
export function closeWindow(): void {
  void windowAPI().then((w) => w?.Close());
}

/** 当前是否最大化(切换按钮图标用);桥不可达返回 null。 */
export async function isWindowMaximised(): Promise<boolean | null> {
  const w = await windowAPI();
  if (!w) return null;
  try {
    return await w.IsMaximised();
  } catch {
    return null;
  }
}
