// registry.ts — UI 注册表:整个界面的三个可装配区域。
//   nav    左栏导航视图(默认:会话列表 / 设置)
//   side   右栏 tab(默认:详情 / 审查 / 终端 / 浏览器 / 文件 / 事件台)
//   bottom 底栏 tab(默认:终端)
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

  subscribe(fn: Listener): () => void {
    const offs = [this.nav.subscribe(fn), this.side.subscribe(fn), this.bottom.subscribe(fn)];
    return () => offs.forEach((off) => off());
  }
}

export const registry = new GrfRegistry();
