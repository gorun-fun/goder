// builtin-desktop.ts — 桌面(wails)形态额外注册的内置条目:右栏 git
// 审查 / 终端 / 文件预览与底栏终端,以及左栏更新按钮(自动更新)。仅
// entries/desktop.ts 引入(嵌入产物不含 xterm 等桌面依赖);条目自带
// visible 守卫,非桌面 web 直开时自动隐藏,与嵌入形态行为一致。
import { html } from 'lit';
import { registry } from '../registry/registry';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { panelRegistered } from '../ui/panel';
import '../panels/inspector/review';
import '../panels/files/file-view';
import '../panels/terminal/terminal';
import '../panels/updater/update-chip';

let registered = false;

// 模块加载即注册(import 副作用;幂等,重复 import 不重复注册)
registerBuiltinDesktop();

/** 注册桌面专属内置条目(幂等)。 */
export function registerBuiltinDesktop(): void {
  if (registered) return;
  registered = true;

  // ---------- 右栏 tab(桌面能力) ----------
  registry.side.add({
    id: 'review',
    label: '审查',
    icon: icon.gitBranch,
    width: 380,
    visible: (ctx) => ctx.desktop,
    render: (ctx) => html`<goder-review .cwd=${ctx.store.activeProjectPath() ?? ''}></goder-review>`,
  });

  registry.side.add({
    id: 'terminal',
    label: '终端',
    icon: icon.terminal,
    width: 460,
    visible: () => inWails() && panelRegistered('goder-terminal'),
    // 返回 HTMLElement:跨 tab 开关与会话切换保活(shell 维护元素池)
    render: (ctx) => {
      const el = document.createElement('goder-terminal');
      el.setAttribute('scope', ctx.scope);
      (el as unknown as { cwd: string }).cwd = ctx.store.activeProjectPath() ?? '';
      return el;
    },
  });

  registry.side.add({
    id: 'file',
    label: '文件',
    icon: icon.file,
    width: 520,
    multi: true, // 每个文件一个独立 tab:<id>:<绝对路径>
    // 被动条目:仅由外部带路径打开(左栏文件树/聊天工具卡/console 智能体),
    // 不出现在右栏手动打开入口 —— 主动打开只会得到空预览,没有意义
    passive: true,
    visible: (ctx) => ctx.desktop,
    render: (_ctx, key) => html`<goder-file-view .path=${key ?? ''}></goder-file-view>`,
    titleFor: (key) => key?.split('/').pop() || '文件',
  });

  // ---------- 底栏 tab(桌面能力) ----------
  registry.bottom.add({
    id: 'terminal',
    label: '终端',
    icon: icon.terminal,
    visible: () => inWails() && panelRegistered('goder-terminal'),
    create: (ctx) => {
      const el = document.createElement('goder-terminal');
      el.setAttribute('scope', ctx.scope);
      (el as unknown as { cwd: string }).cwd = ctx.store.activeProjectPath() ?? '';
      return el;
    },
  });
}
