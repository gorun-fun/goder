// embed/index.ts — 三方 web 集成入口。
// 用法 A(声明式):
//   <grf-app-shell panels="chat,sidebar" server="http://127.0.0.1:7400" token="…"></grf-app-shell>
//   或独立面板:<grf-session-list> / <grf-chat> / <grf-sidebar> / <grf-console>
// 用法 B(JS 配置):
//   import { configure, panels } from 'grf-harness-ui';
//   configure('myscope', { baseUrl, token, model }); panels(); // 注册自定义元素
// 同一 scope 的面板共享数据;不同 scope 互不干扰。
export { GrfAppShell } from '../shell/app-shell';
export { GrfChat } from '../panels/chat/chat-panel';
export type { SidePanelTab } from '../panels/chat/chat-panel';
export { GrfSessionList } from '../panels/session-list';
export { GrfSidebar } from '../panels/sidebar';
export { GrfConsole } from '../panels/console';
export { GrfReview } from '../panels/review';
export { GrfBrowser } from '../panels/browser';
export { GrfSettingsNav } from '../panels/settings-nav';
export { GrfSettingsPage } from '../panels/settings-page';
export { GrfComposer } from '../panels/chat/composer';
export { GrfToolCard } from '../panels/chat/tool-card';
export { GrfAskForm } from '../panels/chat/ask-form';
export { GrfApprovalCard } from '../panels/chat/approval-card';

export { configureScope, getScope, UNGROUPED } from '../state/scope';
export type { GrfScope } from '../state/scope';
export { settingsStore, ACCENTS } from '../state/settings';
export type { Appearance, ThemeMode, AccentKey, FontSizeMode } from '../state/settings';
export { GrfClient, GrfApiError } from '../api/client';
export * from '../api/types';
export { renderMarkdown } from '../util/markdown';

import { configureScope } from '../state/scope';
import '../shell/app-shell';
import '../panels/chat/chat-panel';
import '../panels/session-list';
import '../panels/sidebar';
import '../panels/console';
import '../panels/review';
import '../panels/browser';
import '../panels/settings-nav';
import '../panels/settings-page';

/** 配置一个数据域(在创建任何面板元素之前调用)。 */
export function configure(scope: string, cfg: { baseUrl?: string; token?: string; model?: string }): void {
  configureScope(scope, cfg);
}

/** 显式注册全部自定义元素(渐进增强场景; import 本模块即已注册)。 */
export function panels(): void {
  /* import 副作用已完成注册,这里仅作显式语义入口 */
}
