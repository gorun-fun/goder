// titledrag.ts — 无原生标题栏窗口的头部拖拽转发。
// 原生标题栏已隐藏(MacTitleBarHidden),窗口顶排由各面板头部充当:头部
// 空白区按住拖动 = 移动窗口,双击 = 缩放。wails runtime 的
// --wails-draggable 判定读 event.target 的计算样式,而事件冒泡到 window
// 时已被 shadow DOM 重定向到最外层宿主,Lit 组件树内永远读不到该变量;
// 故由各面板在自身模板上绑定 onDown/onDbl,经此转发 wails 原生拖拽消息
// (wails:drag / wails:drag:doubleclick)。非桌面态(无 webkit 桥)静默忽略。

export interface TitleDrag {
  /** 绑定到头部元素的 mousedown */
  onDown(e: MouseEvent): void;
  /** 绑定到头部元素的 dblclick */
  onDbl(e: MouseEvent): void;
  /** 卸载 window 级监听(disconnectedCallback 时调用) */
  dispose(): void;
}

// 与 wails runtime 同语义:按下武装、松开解除,首次移动移交原生拖拽,
// 移动时不再校验按键(真实输入中按住拖动必为 mouseDragged)。
export function makeTitleDrag(nonDrag: string): TitleDrag {
  let armed = false;
  const msg = (m: string): void => {
    window.webkit?.messageHandlers?.external?.postMessage(m);
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
      msg('wails:drag:doubleclick');
    },
    dispose(): void {
      armed = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}

declare global {
  /** WKWebView 的 wails 消息桥(仅桌面态存在) */
  interface Window {
    webkit?: { messageHandlers?: { external?: { postMessage(msg: string): void } } };
  }
}
