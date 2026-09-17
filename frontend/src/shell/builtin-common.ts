// builtin-common.ts — 内置 UI 条目注册(桌面与嵌入两种形态共用)。
// 注册发生在模块 import 时;三方对内置条目的 hide/show/add/remove 走
// registry 同一 API(见 registry/registry.ts)。
import { html, nothing } from 'lit';
import { registry } from '../registry/registry';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import '../panels/sessions/session-list';
import '../panels/settings/settings-nav';
import '../panels/settings/settings-page';
import '../panels/inspector/browser';

/** 会话列表导航设置分区的状态类型(shell 经 grf-nav-state 持有)。 */
export type SettingsSection = 'appearance' | 'models' | 'harness' | 'plugins' | 'mcp' | 'skills';

let registered = false;

// 模块加载即注册(import 副作用;幂等,重复 import 不重复注册)
registerBuiltinCommon();

/** 注册内置通用条目(幂等)。 */
export function registerBuiltinCommon(): void {
  if (registered) return;
  registered = true;

  // ---------- 左栏导航 ----------
  registry.nav.add({
    id: 'sessions',
    label: '会话',
    icon: icon.chat,
    order: 10,
    view: (ctx) => html`<grf-session-list scope=${ctx.scope}></grf-session-list>`,
  });

  registry.nav.add({
    id: 'settings',
    label: '设置',
    icon: icon.settings,
    order: 90,
    exitTo: 'sessions',
    // 设置分区状态由 settings-nav 冒泡 grf-nav-state 上来,shell 下发回
    // view(当前分区高亮)与 center(设置工作面板)
    view: (ctx, state) =>
      html`<grf-settings-nav
        scope=${ctx.scope}
        .section=${(state as SettingsSection) ?? 'appearance'}
      ></grf-settings-nav>`,
    center: (ctx, state) =>
      html`<grf-settings-page
        scope=${ctx.scope}
        .section=${(state as SettingsSection) ?? 'appearance'}
        .leftToggle=${ctx.shell?.leftOn === false}
        .leftOn=${ctx.shell?.leftOn ?? true}
        .leftLights=${ctx.shell?.desktopLights ?? false}
        @grf-toggle-sessions=${() => ctx.shell?.toggleLeft()}
      ></grf-settings-page>`,
  });

  // ---------- 右栏 tab ----------
  // (详情/事件台面板仍保留:嵌入库 entries/embed.ts 单独导出,三方可自行
  // 经 registry.side.add 挂回右栏。)
  registry.side.add({
    id: 'browser',
    label: '浏览器',
    icon: icon.globe,
    width: 560,
    render: (ctx) => html`<grf-browser scope=${ctx.scope}></grf-browser>`,
  });
}
