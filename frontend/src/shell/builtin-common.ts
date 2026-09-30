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
import '../panels/inspector/session-detail';
import '../panels/console/console';
import { builtinSettingsRender } from '../panels/settings/sections';
import type { SettingsSection } from '../panels/settings/settings-nav';

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
    view: (ctx) => html`<goder-session-list scope=${ctx.scope}></goder-session-list>`,
  });

  registry.nav.add({
    id: 'settings',
    label: '设置',
    icon: icon.settings,
    order: 90,
    exitTo: 'sessions',
    // 全幅视图:进入设置收起右栏/底栏(退出恢复)、左栏锁定不可收起
    fullView: true,
    // 设置分区状态由 settings-nav 冒泡 goder-nav-state 上来,shell 下发回
    // view(当前分区高亮)与 center(设置工作面板)
    view: (ctx, state) =>
      html`<goder-settings-nav
        scope=${ctx.scope}
        .section=${(state as SettingsSection) ?? 'appearance'}
      ></goder-settings-nav>`,
    center: (ctx, state) =>
      html`<goder-settings-page
        scope=${ctx.scope}
        .section=${(state as SettingsSection) ?? 'appearance'}
        .leftToggle=${ctx.shell?.leftOn === false}
        .leftOn=${ctx.shell?.leftOn ?? true}
        .leftLights=${ctx.shell?.desktopLights ?? false}
        .winControls=${ctx.shell?.desktopWinControls ?? false}
      ></goder-settings-page>`,
  });

  // ---------- 右栏 tab ----------
  // 浏览器为通用默认条目;详情/事件台同批注册(经右栏"+"菜单按需打开,
  // 嵌入方可 hide 裁剪)。
  registry.side.add({
    id: 'browser',
    label: '浏览器',
    icon: icon.globe,
    width: 560,
    // 返回 HTMLElement 池化保活 + shared 单例:浏览器持有跨渲染状态
    // (当前地址、原生 webview 绑定),且原生视图全局仅一块 —— 模板条目
    // 会在重渲时换元素、多个实例在各自连接时互相抢导航,还让壳层的
    // panelEl('browser').open(url) 编程导航(file-view 眼睛、智能体
    // open_browser)取不到元素而静默失效。
    shared: true,
    render: (ctx) => {
      const el = document.createElement('goder-browser');
      el.setAttribute('scope', ctx.scope);
      return el;
    },
  });
  registry.side.add({
    id: 'detail',
    label: '详情',
    icon: icon.info,
    render: (ctx) => html`<goder-session-detail scope=${ctx.scope}></goder-session-detail>`,
  });
  registry.side.add({
    id: 'console',
    label: '事件台',
    icon: icon.activity,
    render: (ctx) => html`<goder-console scope=${ctx.scope}></goder-console>`,
  });

  // ---------- 设置分区 ----------
  // 内置分区与三方同一条 render 通道:render 返回按 scope 池化的分区
  // 组件元素(settings-page 的 HTMLElement 保活通道,跨分区切换不丢
  // 内部状态)。三方经 registry.settings.add 注入自定义分区(或同 id
  // 覆写内置分区页面)、hide/show 裁剪,与导航/右栏/底栏同一套 API。
  registry.settings.add({
    id: 'appearance', label: '外观', icon: icon.palette, group: '基础设置', order: 10,
    render: builtinSettingsRender('goder-settings-appearance'),
  });
  registry.settings.add({
    id: 'models', label: '模型', icon: icon.brain, group: '基础设置', order: 20, wide: true,
    render: builtinSettingsRender('goder-settings-models'),
  });
  registry.settings.add({
    id: 'harness', label: 'Harness', icon: icon.settings, group: '智能体', order: 30,
    render: builtinSettingsRender('goder-settings-harness'),
  });
  registry.settings.add({
    id: 'plugins', label: '插件', icon: icon.zap, group: '智能体', order: 40,
    render: builtinSettingsRender('goder-settings-plugins'),
  });
  registry.settings.add({
    id: 'mcp', label: 'MCP', icon: icon.db, group: '智能体', order: 50,
    render: builtinSettingsRender('goder-settings-mcp'),
  });
  registry.settings.add({
    id: 'skills', label: '技能', icon: icon.wrench, group: '智能体', order: 60,
    render: builtinSettingsRender('goder-settings-skills'),
  });
}
