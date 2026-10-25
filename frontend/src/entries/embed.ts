// embed.ts — 三方 web 集成入口(嵌入库唯一入口)。
// 用法 A(声明式):
//   <goder-app-shell panels="chat,sidebar"></goder-app-shell>
//   或独立面板:<goder-session-list> / <goder-chat> / <goder-session-detail> / <goder-console>
// 用法 B(JS 配置 + UI 定制):
//   import { configure, registry, html } from 'goder-ui';
//   configure('myscope', { baseUrl: '/goder-api' });          // 网关模式无需 token
//   registry.side.hide('console');                          // 裁剪右栏条目
//   registry.nav.add({ id: 'help', label: '帮助', view: (ctx) => html`…` }); // 自定义导航
//   registry.chat.addRenderer({ id: 'mytool', toolName: 'mcp__mine__q', render: … }); // 定制消息
// 同一 scope 的面板共享数据;不同 scope 互不干扰。
// html/nothing 从本库导出(与内部同源的 lit html 标签),自定义条目的
// render 返回 TemplateResult 时直接用,无需自带 lit。
// 版本:GODER_UI_VERSION 常量(与构建产物同源),升级前可做特性协商。
export { GoderAppShell } from '../shell/app-shell';
export type { PanelName } from '../shell/app-shell';
export { GoderChat } from '../panels/chat/chat-panel';
export { GoderSessionList } from '../panels/sessions/session-list';
export { GoderSessionDetail } from '../panels/inspector/session-detail';
export { GoderConsole } from '../panels/console/console';
export { GoderReview } from '../panels/inspector/review';
export { GoderBrowser } from '../panels/inspector/browser';
export { GoderSettingsNav } from '../panels/settings/settings-nav';
export { GoderSettingsPage } from '../panels/settings/settings-page';
export { GoderComposer } from '../panels/chat/composer';
export { GoderToolCard } from '../panels/chat/tool-card';
export { GoderAskForm } from '../panels/chat/ask-form';
export { GoderApprovalCard } from '../panels/chat/approval-card';

export { configureScope, getScope, acquireScope, releaseScope, UNGROUPED, savedConn, setSessionDefaults, setUngroupedSessions, setSendInterceptor, setApprovalHook, setDisableDefaultPrompt, setModelNameResolver } from '../core/store/scope';
export type { GoderScope, ConnectionConfig, AuthConfig } from '../core/store/scope';
export type { SendPayload, SendInterceptor, ApprovalRequest, ApprovalDecision, ApprovalHook } from '../core/store/host-config';
import type { AuthConfig } from '../core/store/scope';
import type { GrfSessionConfig } from '../core/api/types';
import type { SendInterceptor, ApprovalHook } from '../core/store/host-config';
export { settingsStore, ACCENTS } from '../core/settings/settings-store';
export type { Appearance, ThemeMode, AccentValue, ResolvedTheme } from '../core/settings/settings-store';
import { settingsStore } from '../core/settings/settings-store';
export { GoderClient, GoderApiError } from '../core/api/client';
export * from '../core/api/types';
export { renderMarkdown } from '../util/markdown';
// lit html 标签(与内部渲染同源):自定义 nav/side/bottom/chat 条目的
// render 返回 TemplateResult 时使用;嵌入方零外部依赖即可拼模板。
// 返回 HTMLElement 的条目不需要它。lit 本就打包在产物内,导出零增量。
export { html, nothing } from 'lit';
// 键值存储注入(嵌入方整体替换 core 的本地持久化落点)
export { setKeyValueStorage, keyValueStorage, MemoryStorage } from '../core/store/storage';
export type { KeyValueStorage } from '../core/store/storage';
// 项目索引持久化注入(桌面态换文件持久化用;默认 localStorage)
export { setPersistence } from '../core/store/persistence';
export type { Persistence } from '../core/store/persistence';
// 测试装具:传输层注入 + 可编程 gh server 假后端(AI 自动化测试数据面,
// 用法见 docs/integration-testing.md;不注入则一切走真实网络,生产零影响)
export { setApiFetch, getApiFetch } from '../core/api/fetch';
export { createScriptedApi, ScriptedApi } from '../core/api/scripted-api';
export type {
  RecordedRequest,
  SendMatcher,
  ScriptFrame,
  FailureSpec,
  SeedConversation,
  ScenarioName,
  ScriptedApiState,
} from '../core/api/scripted-api';
// 恢复策略注入(流断重试判定/上限/退避)
export { setRetryPolicy, resetRetryPolicy, getRetryPolicy, defaultRetryPolicy } from '../core/store/retry-policy';
export type { RetryPolicy } from '../core/store/retry-policy';
// i18n(文案定制:key 即中文默认文案)
export { setI18n, getI18n, translate, tFor } from '../core/i18n';
export type { I18nConfig, I18nMessages } from '../core/i18n';

export {
  registry,
  sideTabId,
  setUser,
  getUser,
  setSideTop,
  getSideTop,
  setSettingsConfig,
  getSettingsConfig,
  setModelGuard,
  getModelGuard,
  setFileOpen,
  getFileOpen,
  setUiEventHandler,
  getUiEventHandler,
  setNewProject,
  getNewProject,
  setMarkdownRenderer,
  getMarkdownRenderer,
  setStatusPop,
  getStatusPop,
} from '../registry/registry';
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
  FileOpenHook,
  UiEvent,
  UiEventHandler,
  NewProjectHook,
  MarkdownRenderer,
  ItemViewActions,
  ItemRenderContext,
  ItemRendererDef,
  ToolMetaDef,
} from '../registry/registry';
import { setUser } from '../registry/registry';
import { setSideTop } from '../registry/registry';
import { setSettingsConfig } from '../registry/registry';
import { setModelGuard } from '../registry/registry';
import { setFileOpen, setUiEventHandler, setNewProject, setMarkdownRenderer, setStatusPop, type FileOpenHook, type UiEventHandler, type NewProjectHook } from '../registry/registry';
import type { UserConfig } from '../registry/registry';
import type { SideTopConfig } from '../registry/registry';
import type { SettingsConfig } from '../registry/registry';
import type { MarkdownRenderer } from '../registry/registry';

import { configureScope, setSessionDefaults, setUngroupedSessions, setSendInterceptor, setApprovalHook, setDisableDefaultPrompt } from '../core/store/scope';
import { setI18n } from '../core/i18n';
import { registerBuiltinCommon } from '../shell/builtin-common';
import '../shell/app-shell';
import '../panels/chat/chat-panel';
import '../panels/sessions/session-list';
import '../panels/inspector/session-detail';
import '../panels/console/console';
import '../panels/settings/settings-nav';
import '../panels/settings/settings-page';

/** 嵌入库版本(vite define 注入,源 package.json;未注入时 'dev')。 */
declare const __GODER_UI_VERSION__: string | undefined;
export const GODER_UI_VERSION: string = typeof __GODER_UI_VERSION__ === 'string' ? __GODER_UI_VERSION__ : 'dev';

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
 * (下发过 model 的 scope 不适用)。sessionDefaults 供嵌入方给「项目
 * 无 defaults/未分组」的会话兜底 grf:session 配置(system_prompt/
 * host_context/default_skill/policy 等;草稿落定时展开在项目 defaults
 * 之前,逐字段被其覆盖——有 defaults 的项目不受影响)。host_context 是
 * 宿主环境简报(gh 独立拼段,不与 system_prompt 抢占):嵌入方用它让
 * 会话知道自己"运行在哪个宿主里、用户是谁、有哪些宿主专属工具",
 * 典型如 openos 的「你运行在 OpenOS 桌面…」简报。disableDefaultPrompt: true
 * 完全关闭 goder 默认身份提示词(sessionDefaults 与项目 defaults 均未给
 * system_prompt 时留空,不再兜底注入)。ungroupedSessions: false
 * 禁止未分组会话:无激活会话直接发送时兜底改绑最近使用的项目,左栏
 * 「未分组会话」分组不再渲染。fileOpen 供嵌入方接管「点文件 → 右栏」
 * 的统一路由(工具卡文件名/文件树/console open_file):钩子返回 true
 * 表示已接管(典型如把阶段文档路由到嵌入方自己的业务面板),goder 不
 * 再打开内置「文件」tab;返回 false/未配置走内置行为。uiEvents 供集成方
 * 消费壳层页面变化事件总线:导航/右栏 tab 开·关·激活/三栏显隐/设置
 * 分区/文件打开/文件下钻,在 goder 执行变更**之前**回调(返回 true =
 * 已接管自定义行为,false = 放行走原生)——一个钩子同时覆盖观测与拦截。
 * newProject 供嵌入方接管左栏「新建项目」:由嵌入方创建自己的项目实体
 * 并返回根目录绝对路径。onBeforeSend 为发送钩子(用户消息离开输入框
 * 前回调:改写载荷继续发送,返回 null 取消且输入保留)——出站审计/
 * 前置 RAG/敏感词过滤。onApproval 为审批钩子(工具审批出现时回调:
 * 返回决策即自动应答,返回 null 落默认审批卡)——接自家权限中心或
 * 策略化自动审批。markdown 覆写消息流的 markdown 渲染器(换 marked
 * 等富引擎;覆写方负责输出 HTML 的转义与安全)。locale/messages 为
 * i18n 文案定制(key 即中文默认文案,支持 {x} 插值)。persistToken:
 * true 才把连接 token 持久化到本地存储(默认不落盘,每次由宿主下发;
 * 桌面形态自身开启)。 */
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
    sessionDefaults?: Partial<GrfSessionConfig>;
    disableDefaultPrompt?: boolean;
    ungroupedSessions?: boolean;
    fileOpen?: FileOpenHook;
    uiEvents?: UiEventHandler;
    newProject?: NewProjectHook;
    onBeforeSend?: SendInterceptor;
    onApproval?: ApprovalHook;
    markdown?: MarkdownRenderer;
    locale?: string;
    messages?: Record<string, string>;
    persistToken?: boolean;
    /** false = 隐藏聊天列右上的状态浮窗(goder 特有的自动化任务/git/
     * goal 卡;不用自动化能力的嵌入方裁掉,聊天区完全干净)。 */
    statusPop?: boolean;
  },
): void {
  // 外观镜像恢复(深/浅/跟随系统 + 强调色 + 字号):嵌入形态的启动
  // 恢复入口,兼装订「跟随系统」的宿主主题监听(openos 切深浅即切
  // html.dark)。放 configure 而非模块加载,让宿主先完成
  // setKeyValueStorage 注入再读镜像(测试装具的干净起点语义不受影响)。
  settingsStore.initAppearance();
  if (cfg.user !== undefined) setUser(scope, cfg.user);
  if (cfg.sideTop !== undefined) setSideTop(scope, cfg.sideTop);
  if (cfg.settings !== undefined) setSettingsConfig(scope, cfg.settings);
  if (cfg.modelGuard !== undefined) setModelGuard(scope, cfg.modelGuard);
  if (cfg.sessionDefaults !== undefined) setSessionDefaults(scope, cfg.sessionDefaults);
  if (cfg.disableDefaultPrompt !== undefined) setDisableDefaultPrompt(scope, cfg.disableDefaultPrompt);
  if (cfg.ungroupedSessions !== undefined) setUngroupedSessions(scope, cfg.ungroupedSessions);
  if (cfg.fileOpen !== undefined) setFileOpen(scope, cfg.fileOpen);
  if (cfg.uiEvents !== undefined) setUiEventHandler(scope, cfg.uiEvents);
  if (cfg.newProject !== undefined) setNewProject(scope, cfg.newProject);
  if (cfg.onBeforeSend !== undefined) setSendInterceptor(scope, cfg.onBeforeSend);
  if (cfg.onApproval !== undefined) setApprovalHook(scope, cfg.onApproval);
  if (cfg.markdown !== undefined) setMarkdownRenderer(scope, cfg.markdown);
  if (cfg.statusPop !== undefined) setStatusPop(scope, cfg.statusPop);
  if (cfg.locale !== undefined || cfg.messages !== undefined) {
    setI18n(scope, { locale: cfg.locale, messages: cfg.messages });
  }
  configureScope(scope, cfg);
}

/** 显式注册全部自定义元素(渐进增强场景; import 本模块即已注册)。 */
export function panels(): void {
  /* import 副作用已完成注册,这里仅作显式语义入口 */
}
