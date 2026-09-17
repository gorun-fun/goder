// titledrag.ts — 无原生标题栏窗口的头部拖拽转发。
// 原生标题栏已隐藏(mac: MacTitleBarHidden;Windows/Linux: 整窗无边框),窗口
// 顶排由各面板头部充当:头部空白区按住拖动 = 移动窗口,双击 = 缩放。
// wails runtime 的 --wails-draggable 判定读 event.target 的计算样式,而事件
// 冒泡到 window 时已被 shadow DOM 重定向到最外层宿主,Lit 组件树内永远读不到
// 该变量;故由各面板在自身模板上绑定 onDown/onDbl,经此转发 wails 原生拖拽
// 消息(wails:drag / wails:drag:doubleclick)。
//
// 消息桥按平台选,与 runtime 的 system.invoke 同源:Windows 走 WebView2 的
// chrome.webview.postMessage,macOS/Linux 走 WKWebView/WebKitGTK 的
// webkit.messageHandlers.external.postMessage,兜底 window.wails.invoke ——
// 旧实现只发 webkit 桥,Windows 上等于静默丢弃(拖动/双击全失效)。
// 非桌面态(各桥都不存在)静默忽略。
import { isFramelessDesktop, toggleMaximiseWindow } from '../host/winctl';

export interface TitleDrag {
  /** 绑定到头部元素的 mousedown */
  onDown(e: MouseEvent): void;
  /** 绑定到头部元素的 dblclick */
  onDbl(e: MouseEvent): void;
  /** 卸载 window 级监听(disconnectedCallback 时调用) */
  dispose(): void;
}

type Bridge = (msg: string) => void;

/** 取当前平台的 wails 消息桥;不存在(纯 web 态)返回 null。 */
function pickBridge(): Bridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    chrome?: { webview?: { postMessage?: (m: string) => void } };
    webkit?: { messageHandlers?: { external?: { postMessage?: (m: string) => void } } };
    wails?: { invoke?: (m: string) => void };
  };
  const wv = w.chrome?.webview;
  if (wv?.postMessage) return (m) => wv.postMessage?.(m);
  const wk = w.webkit?.messageHandlers?.external;
  if (wk?.postMessage) return (m) => wk.postMessage?.(m);
  if (w.wails?.invoke) return (m) => w.wails?.invoke?.(m);
  return null;
}

// 与 wails runtime 同语义:按下武装、松开解除,首次移动移交原生拖拽,
// 移动时不再校验按键(真实输入中按住拖动必为 mouseDragged)。
export function makeTitleDrag(nonDrag: string): TitleDrag {
  let armed = false;
  let bridge: Bridge | null | undefined; // undefined = 尚未探测
  const msg = (m: string): void => {
    if (bridge === undefined) bridge = pickBridge();
    bridge?.(m);
  };
  const onMove = (): void => {
    if (!armed) return;
    armed = false;
    msg('wails:drag');
  };
  const onUp = (): void => {
    armed = false;
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return {
    onDown(e: MouseEvent): void {
      armed = e.button === 0 && !(e.target as HTMLElement | null)?.closest(nonDrag);
    },
    onDbl(e: MouseEvent): void {
      if ((e.target as HTMLElement | null)?.closest(nonDrag)) return;
      // Windows/Linux:wails:drag:doubleclick 由系统偏好决定行为,而该偏好
      // 只有 macOS 有(非 darwin 恒为 "None",双击什么都不做);这里直接
      // 缩放,与用户预期一致。
      if (isFramelessDesktop()) {
        toggleMaximiseWindow();
        return;
      }
      msg('wails:drag:doubleclick');
    },
    dispose(): void {
      armed = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}
