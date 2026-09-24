// registry.ts — UI 注册表:整个界面的四个可装配区域。
//   nav      左栏导航视图(默认:会话列表 / 设置)
//   side     右栏 tab(默认:详情 / 审查 / 终端 / 浏览器 / 文件 / 事件台)
//   bottom   底栏 tab(默认:终端)
//   settings 设置分区(默认:外观/模型/Harness/插件/MCP/技能)
//
// 内置面板与三方自定义条目走同一条注册路径 —— 三方可以 hide/show 增删
// 任意条目,或注册带自定义渲染的新条目(开放性的核心扩展点)。
// 注册表是全局单例:同页多 scope 实例共享条目定义,渲染时按 scope 区分
// 数据域(见 PanelContext)。
import type { TemplateResult } from 'lit';
import type { GrfScope } from '../core/store/scope';

/** 宿主壳(shell)下发给条目渲染的布局状态(仅 app-shell 内装配时存在;
 * 独立嵌入的面板拿不到,自定义条目需判空使用)。 */
export interface ShellState {
  /** 左栏当前展开态 */
  leftOn: boolean;
  /** macOS 桌面态:头部需为窗口红绿灯保留悬浮位 */
  desktopLights: boolean;
  /** 无边框桌面平台(Windows/Linux):窗口无边框、最小化/最大化/关闭由壳右上角自绘,
   * 头部右侧需为它留出空间(见各面板的 header.win) */
  desktopWinControls: boolean;
  /** 切换左栏展开/收起 */
  toggleLeft(): void;
}

/** 渲染上下文:内置与自定义条目拿到同一份能力。 */
export interface PanelContext {
  /** 数据域名(面板 scope 属性) */
  scope: string;
  /** 该 scope 的共享数据域(会话/事件流/连接状态) */
  store: GrfScope;
  /** 当前选中会话(草稿 id 或真实 sid;未选为 undefined) */
  sessionId?: string;
  /** 是否桌面态(wails webview):终端/本地 git 等能力仅桌面可用 */
  desktop: boolean;
  /** app-shell 内装配时的壳状态(独立嵌入为 undefined) */
  shell?: ShellState;
}

/** 左栏导航视图定义。 */
export interface NavViewDef {
  id: string;
  /** 展示名 */
  label: string;
  /** svg 字符串(可选,宿主自绘切换 UI 时用) */
  icon?: string;
  /** 排序权重,小在前;缺省按注册顺序追加在末尾 */
  order?: number;
  /** 左栏内容;state 为该导航的壳侧状态(经 grf-nav-state 事件上行,如
   * 设置分区),同一份会回灌 center */
  view: (ctx: PanelContext, state?: unknown) => TemplateResult | HTMLElement;
  /** 主体工作区(中央卡片)内容;缺省 = 聊天面板 */
  center?: (ctx: PanelContext, state: unknown) => TemplateResult | HTMLElement;
  /** 是否展示该条目(内置条目用它做形态降级,如桌面专属) */
  visible?: (ctx: PanelContext) => boolean;
  /** 从该视图返回时回到哪个导航(grf-nav-back 事件的落点);缺省 = 首个可见条目 */
  exitTo?: string;
}

/** 右栏 tab 类型定义。 */
export interface SideTabDef {
  id: string;
  label: string;
  /** svg 字符串 */
  icon: string;
  /** 默认宽度 px(用户拖拽后覆盖) */
  width?: number;
  /** 可多实例(如文件 tab):true 时打开的 tab 形如 `<id>:<key>` */
  multi?: boolean;
  /** 渲染 tab 内容。返回 HTMLElement 的内容跨 tab 开关与会话切换保活
   * (由 shell 维护元素池,适合终端等有状态内容);返回 TemplateResult
   * 则随渲染重建。多实例 tab 的 key 为实例键(如文件绝对路径)。 */
  render: (ctx: PanelContext, key?: string) => TemplateResult | HTMLElement;
  /** 多实例 tab 的标题(如文件相对路径);缺省 = label */
  titleFor?: (key?: string) => string;
  /** 被动条目:不出现在右栏手动打开入口(空态类型入口页与 tab 行「+」
   * 菜单),只在别处带 key 打开(如文件 tab 由左栏文件树/聊天工具卡点击
   * 打开才有意义,主动打开只见空态) */
  passive?: boolean;
  /** 元素跨会话共享(scope 级单例,不按会话池化):适合内容不属于某个
   * 会话、而属于整个项目/工作区的面板(嵌入方如 grf-play 的游戏面板——
   * 切会话不该动它)。默认 false = 按会话隔离(终端等会话级有状态内容
   * 的标准行为)。 */
  shared?: boolean;
  /** 是否可用(内置条目用它做形态降级,如终端仅桌面) */
  visible?: (ctx: PanelContext) => boolean;
}

/** 一个已打开的右栏 tab 实例(多实例 tab 带 key,如 file:<绝对路径>)。 */
export interface SideTabInstance {
  defId: string;
  /** 多实例键(文件绝对路径等);单例 tab 为 undefined */
  key?: string;
  /** tab 标题覆写(如文件相对路径);缺省用 def.label / titleFor */
  title?: string;
}

/** tab 实例的稳定 id(事件与激活态都用它)。 */
export function sideTabId(t: SideTabInstance): string {
  return t.key !== undefined ? `${t.defId}:${t.key}` : t.defId;
}

/** 底栏 tab 类型定义(每个 tab 一个独立实例元素,常驻保活)。 */
export interface BottomTabDef {
  id: string;
  label: string;
  /** svg 字符串 */
  icon: string;
  /** 每开一个 tab 新建一个实例元素(有状态内容:终端/日志流等) */
  create: (ctx: PanelContext) => HTMLElement;
  /** 第 n 个实例的标题;缺省 = `${label} n` */
  titleFor?: (index: number) => string;
  /** 是否可用(内置条目用它做形态降级) */
  visible?: (ctx: PanelContext) => boolean;
}

/** 设置分区定义:设置左栏导航的一级条目 + 设置页中央的一个分区页面。
 * 内置分区(外观/模型/Harness/插件/MCP/技能)在 builtin-common 注册且
 * render 留空(由 settings-page 内部实现);三方条目给出 render 即自绘
 * 分区页面,同 id 重复 add 可整体覆写内置分区(含页面)。 */
export interface SettingsSectionDef {
  id: string;
  /** 展示名(左栏条目与设置页标题) */
  label: string;
  /** svg 字符串(缺省用通用设置图标) */
  icon?: string;
  /** 左栏分组标题;缺省归入「扩展」。内置分组为「基础设置」「智能体」,
   * 三方条目可复用内置分组名并入其中 */
  group?: string;
  /** 排序权重,小在前;缺省按注册顺序追加在末尾(内置:外观 10 / 模型
   * 20 / Harness 30 / 插件 40 / MCP 50 / 技能 60) */
  order?: number;
  /** 分区页面用宽画布(与内置模型分区同款 880px;默认 620px) */
  wide?: boolean;
  /** 分区页面内容。返回 HTMLElement 跨分区切换保活(由 settings-page
   * 维护元素池);返回 TemplateResult 随渲染重建 */
  render?: (ctx: PanelContext) => TemplateResult | HTMLElement;
  /** 是否展示该分区(按上下文动态显隐,如仅桌面) */
  visible?: (ctx: PanelContext) => boolean;
}

type Listener = () => void;

/** Zone:一个区域内的条目定义集合 + 显隐覆写(带变更通知)。 */
class Zone<T extends { id: string; order?: number; visible?: (ctx: PanelContext) => boolean }> {
  private defs: T[] = [];
  private hidden = new Set<string>();
  private seq = 0;
  private listeners = new Set<Listener>();

  /** 注册条目;同 id 覆盖。无 order 的条目按注册顺序排在有 order 的之后。 */
  add(def: T): void {
    const existing = this.defs.findIndex((d) => d.id === def.id);
    if (existing >= 0) {
      this.defs[existing] = def;
    } else {
      if (def.order === undefined) (def as { order?: number }).order = 1000 + this.seq++;
      this.defs.push(def);
      this.defs.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000));
    }
    this.notify();
  }

  /** 移除条目定义。 */
  remove(id: string): void {
    this.defs = this.defs.filter((d) => d.id !== id);
    this.hidden.delete(id);
    this.notify();
  }

  /** 隐藏(保留定义,可再 show;等效于三方"裁剪"某个内置条目)。 */
  hide(id: string): void {
    this.hidden.add(id);
    this.notify();
  }

  /** 取消隐藏。 */
  show(id: string): void {
    this.hidden.delete(id);
    this.notify();
  }

  get(id: string): T | undefined {
    return this.defs.find((d) => d.id === id);
  }

  /** 全部已注册定义(注册顺序)。 */
  items(): readonly T[] {
    return this.defs;
  }

  /** 当前上下文可见的定义(未隐藏且 visible() 通过),按 order 排序。 */
  visible(ctx: PanelContext): T[] {
    return this.defs.filter((d) => !this.hidden.has(d.id) && (d.visible?.(ctx) ?? true));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

/** UI 注册表(全局单例)。 */
class GrfRegistry {
  /** 左栏导航视图 */
  readonly nav = new Zone<NavViewDef>();
  /** 右栏 tab */
  readonly side = new Zone<SideTabDef>();
  /** 底栏 tab */
  readonly bottom = new Zone<BottomTabDef>();
  /** 设置分区(设置左栏条目 + 设置页分区) */
  readonly settings = new Zone<SettingsSectionDef>();

  subscribe(fn: Listener): () => void {
    const offs = [this.nav.subscribe(fn), this.side.subscribe(fn), this.bottom.subscribe(fn), this.settings.subscribe(fn)];
    return () => offs.forEach((off) => off());
  }
}

export const registry = new GrfRegistry();

// ---------- 宿主身份注入(embed.configure 的 user 落点) ----------

/** 宿主注入身份:左栏底部身份 chip 的展示信息与可选的自定义用户面板。
 * 嵌入方自带用户体系(SSO 等)时经 configure(scope, { user }) 注入;
 * 未注入时 chip 回落系统用户名(桌面)或「本地用户」,且不可点击。 */
export interface UserConfig {
  /** 展示名 */
  name: string;
  /** 补充信息(如 uid),拼进 chip 悬浮提示 */
  detail?: string;
  /** 点击 chip 弹出的宿主自绘用户面板(chip 上方弹出)。返回的
   * HTMLElement 跨开关保活;未配置时 chip 仅展示、不可点击。 */
  panel?: (ctx: PanelContext) => HTMLElement;
  /** chip 尾部小箭头提示(默认 true:收起朝上/展开朝下);false 时不渲染 */
  chevron?: boolean;
  /** chip 可点与悬停区域:'full'=整行(默认) | 'content'=仅图标与名字块 */
  hit?: 'full' | 'content';
}

const userConfigs = new Map<string, UserConfig>();
const userListeners = new Set<Listener>();

/** 配置某 scope 的注入身份(undefined = 清除,回落默认身份)。 */
export function setUser(scope: string, cfg: UserConfig | undefined): void {
  if (cfg) userConfigs.set(scope, cfg);
  else userConfigs.delete(scope);
  for (const fn of userListeners) fn();
}

/** 读取某 scope 的注入身份。 */
export function getUser(scope: string): UserConfig | undefined {
  return userConfigs.get(scope);
}

/** 订阅注入身份变更(身份 chip 等展示方刷新用)。 */
export function onUserChange(fn: Listener): () => void {
  userListeners.add(fn);
  return () => userListeners.delete(fn);
}

// ---------- 宿主左栏顶行注入(embed.configure 的 sideTop 落点) ----------

/** 宿主对左栏顶行(.side-top,折叠侧栏按钮所在行)的注入。返回的
 * HTMLElement 渲染在 shell 的 shadow DOM 内(宿主样式表进不去,样式须
 * 内联),跨重渲保活,配置变更时丢弃重建。典型用途:嵌入平台在左上角
 * 放返回自家站点的入口按钮。 */
export interface SideTopConfig {
  /** 注入行首(折叠侧栏按钮之前) */
  leading?: () => HTMLElement;
  /** 注入行尾 */
  trailing?: () => HTMLElement;
}

const sideTopConfigs = new Map<string, SideTopConfig>();
const sideTopListeners = new Set<Listener>();

/** 配置某 scope 的左栏顶行注入(undefined = 清除)。 */
export function setSideTop(scope: string, cfg: SideTopConfig | undefined): void {
  if (cfg) sideTopConfigs.set(scope, cfg);
  else sideTopConfigs.delete(scope);
  for (const fn of sideTopListeners) fn();
}

/** 读取某 scope 的左栏顶行注入。 */
export function getSideTop(scope: string): SideTopConfig | undefined {
  return sideTopConfigs.get(scope);
}

/** 订阅左栏顶行注入变更(shell 等展示方刷新用)。 */
export function onSideTopChange(fn: Listener): () => void {
  sideTopListeners.add(fn);
  return () => sideTopListeners.delete(fn);
}

// ---------- 宿主设置页裁剪(embed.configure 的 settings 落点) ----------

/** 宿主对设置页的裁剪(configure 的 settings)。「智能体」分组
 * (Harness/插件/MCP/技能)管理的是 gh 运行机的本地配置,浏览器形态
 * 仅显示引导文案——嵌入方平台不开放这些管理入口时可整组隐藏,
 * 只留基础设置(外观/模型)。 */
export interface SettingsConfig {
  /** false = 隐藏「智能体」分组(Harness/插件/MCP/技能) */
  agentGroup?: boolean;
}

const settingsConfigs = new Map<string, SettingsConfig>();
const settingsListeners = new Set<Listener>();

/** 配置某 scope 的设置页裁剪(undefined = 清除,恢复默认全量分区)。 */
export function setSettingsConfig(scope: string, cfg: SettingsConfig | undefined): void {
  if (cfg) settingsConfigs.set(scope, cfg);
  else settingsConfigs.delete(scope);
  for (const fn of settingsListeners) fn();
}

/** 读取某 scope 的设置页裁剪。 */
export function getSettingsConfig(scope: string): SettingsConfig | undefined {
  return settingsConfigs.get(scope);
}

/** 订阅设置页裁剪变更(settings-nav 等展示方刷新用)。 */
export function onSettingsChange(fn: Listener): () => void {
  settingsListeners.add(fn);
  return () => settingsListeners.delete(fn);
}

// ---------- 宿主模型守卫(embed.configure 的 modelGuard 落点) ----------

/** 嵌入方声明「模型由使用者自行配置」(grf-play 类零配置起步的平台):
 * 开启后嵌入壳(app-shell)启动时检查 gh 侧可用模型,没有任何可用模型
 * 则自动进入设置-模型页引导完成配置。宿主经 configure 下发了 model 的
 * scope 不适用。默认关闭 —— 官方嵌入约定宿主自管配置,不打扰。 */
const modelGuards = new Set<string>();
const modelGuardListeners = new Set<Listener>();

/** 开/关某 scope 的启动模型守卫。变更即通知(app-shell 守卫的唤醒源:
 * configure 可能晚于壳元素连接 —— 静态声明的 <grf-app-shell> 在嵌入库
 * 加载瞬间升级连接,而 embed.configure 在其之后才执行)。 */
export function setModelGuard(scope: string, on: boolean): void {
  if (on) modelGuards.add(scope);
  else modelGuards.delete(scope);
  for (const fn of modelGuardListeners) fn();
}

/** 读取某 scope 是否开启启动模型守卫。 */
export function getModelGuard(scope: string): boolean {
  return modelGuards.has(scope);
}

/** 订阅 modelGuard 变更。 */
export function onModelGuardChange(fn: Listener): () => void {
  modelGuardListeners.add(fn);
  return () => modelGuardListeners.delete(fn);
}

// ---------- 宿主文件打开路由(embed.configure 的 fileOpen 落点) ----------

/** 文件打开钩子:工具卡文件名/文件树/console open_file 等「点文件 → 右栏」
 * 的统一入口先问嵌入方,返回 true 表示已接管(典型如嵌入方把阶段文档
 * 路由到自己的业务面板),goder 不再打开内置「文件」tab;返回 false/
 * 未配置则走内置行为。默认无钩子 —— 行为与原生完全一致。 */
export type FileOpenHook = (f: { path: string; name?: string; rel?: string }) => boolean;

const fileOpens = new Map<string, FileOpenHook>();

/** 配置某 scope 的文件打开钩子(undefined = 清除,恢复内置路由)。 */
export function setFileOpen(scope: string, fn: FileOpenHook | undefined): void {
  if (fn) fileOpens.set(scope, fn);
  else fileOpens.delete(scope);
}

/** 读取某 scope 的文件打开钩子。 */
export function getFileOpen(scope: string): FileOpenHook | undefined {
  return fileOpens.get(scope);
}

// ---------- UI 事件总线(embed.configure 的 uiEvents 落点) ----------

/** 壳层页面变化事件:导航切换/右栏 tab 开·关·激活/左右底三栏显隐/
 *  设置分区/文件打开/文件树下钻。app-shell 在**执行变更前**先派发给
 *  集成方——一个钩子同时覆盖「消费(观测)」与「自定义行为(拦截)」。
 *  底栏(终端)tab 组、聊天面板内部状态属会话级内部细节,不在总线内。 */
export type UiEvent =
  | { type: 'nav'; id: string }
  | { type: 'side-tab-open'; tab: SideTabInstance }
  | { type: 'side-tab-activate'; id: string }
  | { type: 'side-tab-close'; id: string }
  | { type: 'sidebar'; on: boolean }
  | { type: 'bottom'; on: boolean }
  | { type: 'sessions'; on: boolean }
  | { type: 'settings-section'; section: unknown }
  | { type: 'file-open'; file: { path: string; name?: string; rel?: string } }
  | { type: 'files-view'; view: unknown };

/** 返回 true = 已接管(本次变更不再执行,集成方自定义行为);返回
 *  false/undefined = 放行,goder 按原生行为执行。 */
export type UiEventHandler = (e: UiEvent) => boolean;

const uiEventHandlers = new Map<string, UiEventHandler>();

/** 配置某 scope 的 UI 事件处理器(undefined = 清除,全部放行)。 */
export function setUiEventHandler(scope: string, fn: UiEventHandler | undefined): void {
  if (fn) uiEventHandlers.set(scope, fn);
  else uiEventHandlers.delete(scope);
}

/** 读取某 scope 的 UI 事件处理器。 */
export function getUiEventHandler(scope: string): UiEventHandler | undefined {
  return uiEventHandlers.get(scope);
}

// ---------- 宿主新建项目路由(embed.configure 的 newProject 落点) ----------

/** 新建项目钩子:左栏「新建项目」提交名称时先问嵌入方——由嵌入方创建
 *  自己的项目实体(工作区目录/服务端记录),返回项目根目录绝对路径,
 *  goder 据此登记带 path 的项目(会话/文件树/嵌入方对齐键全链路可用);
 *  返回 null/undefined = 嵌入方已自行处理或拒绝,goder 不再落原生项目
 *  (无 path 的裸项目嵌入方通常无法管理)。未配置走原生行为(裸项目)。 */
export type NewProjectHook = (name: string) => Promise<string | null> | string | null;

const newProjectHooks = new Map<string, NewProjectHook>();

/** 配置某 scope 的新建项目钩子(undefined = 清除,恢复原生行为)。 */
export function setNewProject(scope: string, fn: NewProjectHook | undefined): void {
  if (fn) newProjectHooks.set(scope, fn);
  else newProjectHooks.delete(scope);
}

/** 读取某 scope 的新建项目钩子。 */
export function getNewProject(scope: string): NewProjectHook | undefined {
  return newProjectHooks.get(scope);
}
