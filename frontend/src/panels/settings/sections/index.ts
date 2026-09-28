// index.ts — 内置设置分区组件的 registry 绑定。六个分区组件与三方
// 自定义分区走同一条 render 通道;render 返回按 scope 池化的组件元素,
// 经 settings-page 的 HTMLElement 保活通道跨分区切换不丢内部状态
// (选中供应商、技能编辑文本等)。
import './appearance';
import './models';
import './harness';
import './plugins';
import './mcp';
import './skills';
import type { PanelContext } from '../../../registry/registry';

// 分区组件池:标签 → scope → 元素(嵌入态一页多 scope 各一份)
const pools = new Map<string, Map<string, HTMLElement>>();

function pooled(tag: string, ctx: PanelContext): HTMLElement {
  let byScope = pools.get(tag);
  if (!byScope) {
    byScope = new Map();
    pools.set(tag, byScope);
  }
  let el = byScope.get(ctx.scope);
  if (!el) {
    el = document.createElement(tag);
    byScope.set(ctx.scope, el);
  }
  (el as { scope?: string }).scope = ctx.scope;
  return el;
}

/** 内置分区的 render 工厂(池化元素;builtin-common 注册时使用)。 */
export function builtinSettingsRender(tag: string): (ctx: PanelContext) => HTMLElement {
  return (ctx) => pooled(tag, ctx);
}
