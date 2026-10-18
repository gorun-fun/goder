// fire.ts — LitElement 直继小件(不继承 GoderPanel 的叶子卡片,如
// composer / ask-form / approval-card)的冒泡事件帮助函数。与
// GoderPanel.fire 同语义(bubbles + composed,穿 shadow DOM 上抛);
// 抽为独立函数是为三处去重,不为改继承 —— GoderPanel 的 scope 订阅
// 语义对叶子卡片不适用。
export function fireCompact(el: Element, type: string, detail?: unknown): void {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
