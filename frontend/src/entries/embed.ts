// embed.ts — 三方 web 集成入口(嵌入库唯一入口)。
// 用法 A(声明式):
//   <grf-app-shell panels="chat,sidebar"></grf-app-shell>
//   或独立面板:<grf-session-list> / <grf-chat> / <grf-session-detail> / <grf-console>
// 用法 B(JS 配置 + UI 定制):
//   import { configure, registry } from 'grf-harness-ui';
//   configure('myscope', { baseUrl: '/grf-api' });          // 网关模式无需 token
//   registry.side.hide('console');                          // 裁剪右栏条目
//   registry.nav.add({ id: 'help', label: '帮助', view: (ctx) => … }); // 自定义导航
// 同一 scope 的面板共享数据;不同 scope 互不干扰。
export { GrfAppShell } from '../shell/app-shell';
export { GrfChat } from '../panels/chat/chat-panel';
export { GrfSessionList } from '../panels/sessions/session-list';
export { GrfSessionDetail } from '../panels/inspector/session-detail';
export { GrfConsole } from '../panels/console/console';
export { GrfReview } from '../panels/inspector/review';
export { GrfBrowser } from '../panels/inspector/browser';
export { GrfSettingsNav } from '../panels/settings/settings-nav';
export { GrfSettingsPage } from '../panels/settings/settings-page';
export { GrfComposer } from '../panels/chat/composer';
export { GrfToolCard } from '../panels/chat/tool-card';
export { GrfAskForm } from '../panels/chat/ask-form';
export { GrfApprovalCard } from '../panels/chat/approval-card';

export { configureScope, getScope, UNGROUPED } from '../core/store/scope';
export type { GrfScope, ConnectionConfig, AuthConfig } from '../core/store/scope';
import type { AuthConfig } from '../core/store/scope';
export { settingsStore, ACCENTS } from '../core/settings/settings-store';
export type { Appearance, ThemeMode, AccentValue } from '../core/settings/settings-store';
export { GrfClient, GrfApiError } from '../core/api/client';
export * from '../core/api/types';
export { renderMarkdown } from '../util/markdown';
export { registry, sideTabId, setUser, getUser, setSideTop, getSideTop, setSettingsConfig, getSettingsConfig, setModelGuard, getModelGuard } from '../registry/registry';
export type {
  PanelContext,
  ShellState,
  NavViewDef,
  SideTabDef,
  SideTabInstance,
  BottomTabDef,
  SettingsSectionDef,
  UserConfig,
  SideTopConfig,
  SettingsConfig,
} from '../registry/registry';
import { setUser } from '../registry/registry';
import { setSideTop } from '../registry/registry';
import { setSettingsConfig } from '../registry/registry';
import { setModelGuard } from '../registry/registry';
import type { UserConfig } from '../registry/registry';
import type { SideTopConfig } from '../registry/registry';
import type { SettingsConfig } from '../registry/registry';

import { configureScope } from '../core/store/scope';
import { registerBuiltinCommon } from '../shell/builtin-common';
import '../shell/app-shell';
import '../panels/chat/chat-panel';
import '../panels/sessions/session-list';
import '../panels/inspector/session-detail';
import '../panels/console/console';
import '../panels/settings/settings-nav';
import '../panels/settings/settings-page';

// 嵌入库默认装配通用内置条目(桌面专属条目不进嵌入产物)
registerBuiltinCommon();

/** 配置一个数据域(在创建任何面板元素之前调用)。
 * 网关模式下 token 可省(服务端按登录用户注入);auth 为多用户网关的
 * 未登录处置预留(见 docs/embedding.md)。policySelector: false 供全权
 * 管理会话策略的嵌入方隐藏 composer 策略选择器(本机策略偏好也不加载)。
 * user 供自带用户体系的嵌入方注入左栏底部身份 chip 的展示名,并可给出
 * panel 让 chip 可点击、弹出嵌入方自绘的用户信息面板(chevron:false
 * 去掉尾部小箭头,hit:'content' 把可点区域收缩为图标+名字块,见
 * UserConfig)。sideTop 供嵌入方向左栏顶行(折叠侧栏按钮所在行)注入
 * 自定义元素(leading=行首/trailing=行尾,见 SideTopConfig)。
 * settings 供嵌入方裁剪设置页:agentGroup:false 隐藏「智能体」分组
 * (Harness/插件/MCP/技能,浏览器形态本就只读引导)。modelGuard: true
 * 供「模型由使用者自行配置」的嵌入方(零配置起步平台)开启启动模型
 * 守卫:gh 侧没有任何可用模型时自动进入设置-模型页引导完成配置
 * (下发过 model 的 scope 不适用)。 */
export function configure(
  scope: string,
  cfg: {
    baseUrl?: string;
    token?: string;
    model?: string;
    auth?: AuthConfig;
    policySelector?: boolean;
    user?: UserConfig;
    sideTop?: SideTopConfig;
    settings?: SettingsConfig;
    modelGuard?: boolean;
  },
): void {
  if (cfg.user !== undefined) setUser(scope, cfg.user);
  if (cfg.sideTop !== undefined) setSideTop(scope, cfg.sideTop);
  if (cfg.settings !== undefined) setSettingsConfig(scope, cfg.settings);
  if (cfg.modelGuard !== undefined) setModelGuard(scope, cfg.modelGuard);
  configureScope(scope, cfg);
}

/** 显式注册全部自定义元素(渐进增强场景; import 本模块即已注册)。 */
export function panels(): void {
  /* import 副作用已完成注册,这里仅作显式语义入口 */
}
