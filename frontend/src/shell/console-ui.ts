// console-ui.ts — goder-console 智能体的前端接线(shell 装配期调用)。
// Go 侧经 wails 事件 'grf:console-ui' 下发界面操作(goder_ui_do 工具),
// 这里映射为 app-shell 的既有 API;界面状态由快照函数按需生成、节流
// 上报(reportConsoleUi → ConsoleMCP.ReportUIState,goder_ui_state 工具读)。
// 桌面专属能力:纯 web/嵌入态下订阅为 no-op、上报自动跳过。
// 本模块同时注册 goder-console 全部工具的展示名(registry.chat 工具
// 元数据)—— 工具定义在 Go 侧 plugins/console/tools.go,展示知识与
// 前端接线同源维护;双形态都注册(消息历史里的工具卡要有中文名)。
import { inWails, consoleUiListen, consoleUiReport } from '../host/bridge';
import { registry, type SideTabInstance } from '../registry/registry';

// goder-console 工具展示名(与 plugins/console/tools.go 的工具面同步)。
const GODER_TOOL_LABELS: Record<string, string> = {
  goder_browser_navigate: '面板浏览器·打开网页',
  goder_browser_back: '面板浏览器·后退',
  goder_browser_forward: '面板浏览器·前进',
  goder_browser_reload: '面板浏览器·刷新',
  goder_browser_state: '面板浏览器·状态',
  goder_browser_snapshot: '面板浏览器·页面快照',
  goder_browser_click: '面板浏览器·点击',
  goder_browser_type: '面板浏览器·输入',
  goder_browser_press_key: '面板浏览器·按键',
  goder_browser_hover: '面板浏览器·悬停',
  goder_browser_select_option: '面板浏览器·选择选项',
  goder_browser_scroll: '面板浏览器·滚动',
  goder_browser_evaluate: '面板浏览器·执行脚本',
  goder_browser_get_text: '面板浏览器·获取文本',
  goder_browser_screenshot: '面板浏览器·截图',
  goder_browser_console: '面板浏览器·控制台日志',
  goder_browser_network: '面板浏览器·网络请求',
  goder_browser_wait_for: '面板浏览器·等待',
  goder_terminal_list: '面板终端·列表',
  goder_terminal_new: '面板终端·新建',
  goder_terminal_send: '面板终端·输入',
  goder_terminal_read: '面板终端·读取',
  goder_terminal_kill: '面板终端·关闭',
  goder_ui_state: '界面·状态',
  goder_ui_do: '界面·操作',
};
for (const [name, label] of Object.entries(GODER_TOOL_LABELS)) {
  registry.chat.addToolMeta({ name, label });
}

/** app-shell 暴露给智能体的界面操作面(与用户手动操作同一入口)。 */
export interface ConsoleUiActions {
  navTo(id: string): void;
  openSideTab(tab: SideTabInstance): void;
  activateSideTab(id: string): void;
  setSidebar(on: boolean): void;
  setBottom(on: boolean): void;
  setSessions(on: boolean): void;
  openFile(f: { path: string; name?: string; rel?: string }): void;
  focusSession(id: string): void;
  openBrowser(url: string): void;
}

/** 界面状态快照生成器(app-shell 提供;含终端会话等跨模块状态)。 */
export type ConsoleUiSnapshot = () => unknown;

let actions: ConsoleUiActions | null = null;
let snapshot: ConsoleUiSnapshot | null = null;
let started = false;

/** initConsoleUi 绑定 shell 操作面/状态快照并订阅智能体事件(幂等;
 * 仅桌面态生效)。 */
export function initConsoleUi(a: ConsoleUiActions, snap: ConsoleUiSnapshot): void {
  actions = a;
  snapshot = snap;
  if (started || !inWails()) return;
  started = true;
  consoleUiListen((p) => handleAction(p.action, p.params ?? {}));
}

function handleAction(action: string, params: Record<string, unknown>): void {
  const a = actions;
  if (!a) return;
  const str = (k: string): string => (typeof params[k] === 'string' ? (params[k] as string) : '');
  const bool = (k: string, dflt: boolean): boolean =>
    typeof params[k] === 'boolean' ? (params[k] as boolean) : dflt;
  switch (action) {
    case 'nav_activate':
      if (str('id')) a.navTo(str('id'));
      break;
    case 'side_tab_open': {
      const defId = str('defId');
      if (!defId) break;
      const tab: SideTabInstance = { defId };
      if (str('key')) tab.key = str('key');
      if (str('title')) tab.title = str('title');
      a.openSideTab(tab);
      break;
    }
    case 'side_tab_activate':
      if (str('id')) a.activateSideTab(str('id'));
      break;
    case 'show_sidebar':
      a.setSidebar(bool('on', true));
      break;
    case 'show_bottom':
      a.setBottom(bool('on', true));
      break;
    case 'show_sessions':
      a.setSessions(bool('on', true));
      break;
    case 'open_file':
      if (str('path')) a.openFile({ path: str('path'), name: str('name') || undefined, rel: str('rel') || undefined });
      break;
    case 'open_browser':
      a.openBrowser(str('url'));
      break;
    case 'focus_session':
      if (str('id')) a.focusSession(str('id'));
      break;
    case 'terminal_open': {
      // 智能体新建了终端会话:打开终端 tab + 入接管队列/广播(组件在
      // 挂载即接管显示,回放缓冲后接续事件流)。
      a.openSideTab({ defId: 'terminal' });
      pushPendingTerm(str('id'));
      break;
    }
    default:
      break; // 未知 action 静默(Go 侧已白名单,防旧前端配新端)
  }
}

// ---------- 终端会话接管(goder_terminal_new → 界面终端显示智能体会话) ----------

/** 界面上挂载的终端会话 id(状态上报携带,goder_terminal_new 据此复用)。 */
const visibleTerms = new Set<string>();

export function registerVisibleTerm(id: string): void {
  visibleTerms.add(id);
  reportNow(); // 终端挂载不触发 shell 重渲染,主动刷一版状态
}

export function unregisterVisibleTerm(id: string): void {
  visibleTerms.delete(id);
  reportNow();
}

export function visibleTermIds(): string[] {
  return [...visibleTerms];
}

/** 待接管的智能体终端会话队列 + 实时监听(组件可能已挂载)。 */
const pendingTerms: string[] = [];
const termListeners = new Set<(id: string) => void>();

function pushPendingTerm(id: string): void {
  if (!id) return;
  if (termListeners.size > 0) {
    // 有终端组件在听:直接派发(组件自行决定是否接管)
    for (const cb of termListeners) cb(id);
    return;
  }
  pendingTerms.push(id);
}

/** 终端组件启动时取走一个待接管会话(无则 undefined,走正常新建)。 */
export function consumePendingTerm(): string | undefined {
  return pendingTerms.shift();
}

/** 订阅智能体新建终端事件(挂载中的终端组件用;返回取消订阅)。 */
export function onConsoleTerm(cb: (id: string) => void): () => void {
  termListeners.add(cb);
  return () => termListeners.delete(cb);
}

// ---------- 界面状态上报 ----------

let reportTimer = 0;

/** reportConsoleUi 节流上报状态快照(频繁的渲染更新不打爆服务端)。 */
export function reportConsoleUi(snap: unknown): void {
  if (!inWails()) return;
  window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    void consoleUiReport(JSON.stringify(snap));
  }, 500);
}

/** reportNow 用最新快照立即(仍经节流)上报。 */
function reportNow(): void {
  if (snapshot) reportConsoleUi(snapshot());
}
