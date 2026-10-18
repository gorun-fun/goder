// dock-shared.ts — 右栏/底栏 dock(side-dock/bottom-dock)的共享小件。
// dock 是壳层通用布局容器:这里只抽两栏逐字重复的「会话判活 / 外点关闭
// 菜单 / '+'下拉菜单 / tab chip 基础样式」,不含任何面板类型知识;
// 各 dock 的池化保活、受控 tabs、拖拽调宽高等逻辑不在共享范围(dock 是
// 历史 bug 高发区:池误清、振荡、塌高等修复注释见两个 dock 本体)。
import { css, html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { GoderScope } from '../core/store/scope';

/** 会话判活闭包:draft 前缀看草稿区,其余看会话索引。dock 池化清理
 * (prunePools)共用 —— 归档/服务器删除/草稿废弃的池内容据此回收。 */
export function makeSessionAlive(
  store: Pick<GoderScope, 'drafts' | 'index'>,
): (sid: string) => boolean {
  return (sid) => (sid.startsWith('draft:') ? store.drafts.has(sid) : !!store.index.sessions[sid]);
}

/** 「+」下拉菜单的外点关闭:pointerdown 落点不在菜单与触发钮
 * (keepSelectors 命中的元素)内即关闭。两个 dock 的 window 级
 * pointerdown 监听共用。 */
export function closeDockMenuOnOutside(
  e: PointerEvent,
  root: ParentNode,
  open: boolean,
  keepSelectors: string[],
  close: () => void,
): void {
  if (!open) return;
  const path = e.composedPath();
  const inside = keepSelectors.some((sel) =>
    [...root.querySelectorAll(sel)].some((el) => path.includes(el)),
  );
  if (!inside) close();
}

/** 「+」下拉菜单条目 */
export interface DockMenuItem {
  icon: string;
  label: string;
  /** 右侧小标注(如「已打开」) */
  tag?: string;
  pick: () => void;
}

/** dock「+」下拉菜单模板(两栏共用;水平定位与宽度差异由消费方
 * CSS/内联样式给出)。 */
export function dockMenuTpl(items: DockMenuItem[], styleAttr?: string): TemplateResult {
  return html`
    <div class="dock-menu" style=${styleAttr ?? nothing}>
      ${items.map(
        (it) => html`
          <div class="mi" @click=${it.pick}>
            ${unsafeHTML(it.icon)}
            <span>${it.label}</span>
            ${it.tag ? html`<span class="mitag">${it.tag}</span>` : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

/** 「+」下拉菜单样式(两栏共用;水平定位与最小宽由消费方覆写)。 */
export const dockMenuCss = css`
  .dock-menu {
    position: absolute;
    top: 100%;
    z-index: 30;
    background: var(--goder-bg-raise);
    border: 1px solid var(--goder-border);
    border-radius: var(--goder-radius);
    box-shadow: var(--goder-shadow);
    padding: 4px;
    min-width: 160px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .dock-menu .mi {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    font-size: var(--goder-font-size-xs);
    color: var(--goder-text-dim);
    border-radius: var(--goder-radius-sm);
    cursor: pointer;
    user-select: none;
  }
  .dock-menu .mi:hover {
    background: var(--goder-bg-hover);
    color: var(--goder-text);
  }
  .dock-menu .mi svg {
    width: 12px;
    height: 12px;
    flex: none;
  }
  .dock-menu .mitag {
    margin-left: auto;
    color: var(--goder-text-faint);
    font-size: 10px;
  }
`;

/** dock tab chip 基础样式(基态 + 悬停关闭钮)。tab 元素需同时挂
 * `.dock-tab` 标记类;padding/圆角/svg 尺寸/on 态等差异由消费方规则
 * 补充(共享块只收两栏逐字相同的部分)。 */
export const dockTabCss = css`
  .dock-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--goder-font-size-xs);
    color: var(--goder-text-dim);
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .dock-tab .x {
    display: none;
    border: none;
    background: transparent;
    padding: 0 0 0 2px;
    color: var(--goder-text-faint);
    cursor: pointer;
  }
  .dock-tab .x svg {
    width: 10px;
    height: 10px;
  }
  .dock-tab:hover .x {
    display: inline-flex;
  }
  .dock-tab .x:hover {
    color: var(--goder-error);
  }
`;
