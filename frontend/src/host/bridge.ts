// bridge.ts — wails 宿主桥:仅在桌面(wails webview)内生效,纯 web 态全部
// no-op 回退。职责:配置持久化(文件)、gh server 托管(启动/停止/状态)。
import { setPersistence, type Persistence } from '../core/store/persistence';
import type { ProjectsIndex } from '../core/store/persistence';
import { setHomeDirProvider } from '../core/store/scope';
// agent 配置类 DTO 已挪至 core/api/agent-dto.ts(网页形态的 agent-api 与
// 桌面桥共用;这里 re-export 保持既有 import 路径兼容)
export type { ProviderDTO, ModelConfigDTO, DetectedModelDTO, PluginDTO, PluginsDTO, SkillDTO, SkillsDTO } from '../core/api/agent-dto';
import type { ProviderDTO, ModelConfigDTO, DetectedModelDTO, PluginsDTO, SkillsDTO } from '../core/api/agent-dto';
// wails v3 桌面态检测。注意:不能只看 window._wails —— 该属性由
// @wailsio/runtime 包加载时自设,普通浏览器懒加载后也会有;也不能依赖
// 注入 runtime(它可能跑在独立 JS world)。可靠信号是"真的调通了 wails
// 服务"(initHostBridge 探针)与桌面 origin 形态;test-serve 无头测试态
// (http://127.0.0.1:<port>)经 /goder-host-probe 标记端点识别
// (detectDesktopHost,见 main.go testserve.go)。
let wailsProbe = false;
let hostProbe = false;

export function inWails(): boolean {
  if (wailsProbe || hostProbe) return true;
  if (typeof window === 'undefined') return false;
  if (typeof location !== 'undefined') {
    if (location.protocol === 'wails:' || location.protocol === 'wails-capabilities:') return true;
    // wails.localhost/app.localhost = wails 资产服务;goder.localhost =
    // Windows 桌面态从本地真实 HTTP 服务器加载(绕过 wails 资产管道的
    // 响应整体缓冲,否则 SSE 无流式;见 main.go 的 startLocalServer)。
    if (/^(wails\.localhost|app\.localhost|goder\.localhost)$/.test(location.hostname)) return true;
  }
  return false;
}

/** 探测当前 origin 是否 goder test-serve 宿主(无头测试形态)。
 * 命中 /goder-host-probe 标记端点(204)即视为桌面形态:界面按桌面装配
 * (终端等桌面面板),wails 调用通道就绪由 initHostBridge 的带重试探针
 * 兜底;同时启动事件 SSE 中继(无头形态没有窗口,Go 侧 ExecJS 推送不
 * 存在,事件经 /test-serve/events 回流)。
 * 注意:即便 origin 已命中桌面形态(wails://localhost、goder.localhost)
 * 也要探一次 —— 经 goder.localhost 访问 test-serve 时 inWails 虽为真,
 * 事件链同样不存在;生产形态该请求 404 即止,开销一次 HEAD。
 * 须在任何 UI 挂载前调用(entries/desktop.ts 的 mount),避免面板可见性
 * 守卫在探针完成前取到 false。 */
export async function detectDesktopHost(): Promise<boolean> {
  const originDesktop = inWails();
  try {
    const r = await fetch('/goder-host-probe', { method: 'HEAD' });
    if (r.status === 204) {
      hostProbe = true;
      startEventRelay();
      return true;
    }
  } catch {
    /* 非本地宿主:纯 web/嵌入形态 */
  }
  return originDesktop;
}

let eventRelayStarted = false;

/** test-serve 事件中继:订阅 /test-serve/events SSE,把 wails 自定义事件
 * (goder:term-* / goder:console-ui / goder:update-progress)喂回
 * window._wails.dispatchWailsEvent —— 与官方 server 模式 custom.js 的
 * WebSocket 中继同一机制,Events.On 订阅者无感复用。 */
function startEventRelay(): void {
  if (eventRelayStarted) return;
  eventRelayStarted = true;
  const es = new EventSource('/test-serve/events');
  es.onmessage = (m: MessageEvent<string>) => {
    const w = window as unknown as {
      _wails?: { dispatchWailsEvent?: (ev: unknown) => void };
    };
    try {
      w._wails?.dispatchWailsEvent?.(JSON.parse(m.data));
    } catch {
      /* 坏帧忽略 */
    }
  };
}

interface WailsCall {
  ByName: (name: string, ...args: unknown[]) => Promise<unknown>;
}

// wails Call.ByName 按完整 FQN(包路径.类型.方法)精确匹配;桌面服务在
// internal/desktop,与 Go 侧 module 路径保持同步。
const SVC = 'github.com/gorun-fun/goder/internal/desktop';

let runtime: WailsCall | null = null;

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return callSlow<T>(12_000, method, ...args);
}

// callSlow 带(更长)超时的调用:耗时操作(更新检查要访问下载服务器、
// 应用更新的启动确认)不能套默认 12s。
async function callSlow<T>(ms: number, method: string, ...args: unknown[]): Promise<T> {
  // 整链路超时(含动态 import):加载初期通道可能挂起,不能让上层永久阻塞。
  return withTimeout(
    (async () => {
      if (!runtime) {
        // 动态加载,避免把 runtime 打进嵌入产物;失败即纯 web 态。
        const mod = (await import('@wailsio/runtime')) as unknown as { Call: WailsCall };
        runtime = mod.Call;
      }
      return (await runtime.ByName(method, ...args)) as T;
    })(),
    ms,
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}


// ---------- 调用形态收敛(三种同构样板的工厂) ----------
// 探测类(quiet*/失败回落)、尽力类(silent/失败静默)、保存类(errStr/
// 失败返回错误串)。方法名字面量保持完整可 grep:internal/desktop 的
// bridge_fqn_test.go 靠完整方法名与 Go 服务反射对齐,不要改成动态拼接。

/** 探测类调用:非桌面态/失败一律回落 null。 */
async function quiet<T>(method: string, ...args: unknown[]): Promise<T | null> {
  if (!inWails()) return null;
  try {
    return await call<T>(method, ...args);
  } catch {
    return null;
  }
}

/** 空串回落类调用(身份/路径展示);返回值归一为非空串。 */
async function quietStr(method: string, ...args: unknown[]): Promise<string> {
  if (!inWails()) return '';
  try {
    return (await call<string>(method, ...args)) || '';
  } catch {
    return '';
  }
}

/** 布尔回落类调用(能力探测);严格 === true 才算真。 */
async function quietBool(method: string, ...args: unknown[]): Promise<boolean> {
  if (!inWails()) return false;
  try {
    return (await call<boolean>(method, ...args)) === true;
  } catch {
    return false;
  }
}

/** 尽力调用(展示态切换/上报类):无返回值,失败静默。 */
async function silent(method: string, ...args: unknown[]): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>(method, ...args);
  } catch {
    /* 静默:尽力调用 */
  }
}

/** 保存/安装类调用:成功返回 null,失败返回错误信息串;非桌面态返回
 * webFallback(「仅桌面形态可…」提示)。 */
async function errStr(webFallback: string, method: string, ...args: unknown[]): Promise<string | null> {
  if (!inWails()) return webFallback;
  try {
    await call<void>(method, ...args);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** wails 事件订阅工厂:动态加载 runtime(嵌入产物不含它)、防竞态取消
 * (取消先于 On 返回时丢弃订阅),非桌面态 no-op。事件订阅点
 * (console-ui/终端输出/更新进度)的同构样板收敛;decode 返回
 * undefined 表示丢弃本次载荷。 */
function wailsEvent<T>(name: string, decode: (raw: unknown) => T | undefined, cb: (v: T) => void): () => void {
  if (!inWails()) return () => {};
  let off: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    try {
      const mod = (await import('@wailsio/runtime')) as unknown as { Events: WailsEvents };
      if (cancelled) return;
      off = mod.Events.On(name, (ev) => {
        const v = decode(Array.isArray(ev?.data) ? ev.data[0] : ev?.data);
        if (v !== undefined) cb(v);
      });
    } catch {
      /* 桥不可达:保持 no-op */
    }
  })();
  return () => {
    cancelled = true;
    off?.();
  };
}

// ---------- 配置(AppConfig service) ----------

export interface AppConfigDTO {
  scope: string;
  serverMode: 'managed' | 'remote';
  remoteUrl: string;
  remoteToken: string;
  ghBinary: string;
  serverAddr: string;
}

export function loadAppConfig(): Promise<AppConfigDTO | null> {
  return quiet<AppConfigDTO>(`${SVC}.AppConfig.Load`);
}

export async function saveAppConfig(cfg: AppConfigDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.AppConfig.Save`, cfg);
}

// ---------- 模型配置(ModelConfig service,gh 的 settings.json) ----------

/** 一个模型供应商(对应 settings.json 的 providers.<name>) */


/** 读取供应商与默认模型;非桌面态返回 null(纯 web 态无法访问 gh 配置)。 */
export function loadModelConfig(): Promise<ModelConfigDTO | null> {
  return quiet<ModelConfigDTO>(`${SVC}.ModelConfig.Load`);
}

/** 写回 providers 与 default;其余配置键原样保留。 */
export async function saveModelConfig(cfg: ModelConfigDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.ModelConfig.Save`, cfg);
}

/** DetectModels 的单条结果:id + 上游回报的上下文窗口(0 = 未回报)。 */

/** 探测供应商可用模型(GET {baseURL}/models,OpenAI 兼容,含模型元数据);
 * 非桌面态返回 null。 */
export function detectModels(p: ProviderDTO): Promise<DetectedModelDTO[] | null> {
  return quiet<DetectedModelDTO[]>(`${SVC}.ModelConfig.DetectModels`, p);
}

// ---------- 智能体扩展(AgentConfig service,插件/MCP/技能) ----------

/** 一个插件/远程 MCP(settings.json 的 plugins 数组项)。 */




/** 读取插件/MCP 配置;非桌面态返回 null。 */
export function loadPlugins(): Promise<PluginsDTO | null> {
  return quiet<PluginsDTO>(`${SVC}.AgentConfig.PluginsLoad`);
}

/** 写回 plugins 键(explicit=false 删键回到自动发现)。 */
export async function savePlugins(cfg: PluginsDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.AgentConfig.PluginsSave`, cfg);
}

/** 列出技能(~/.grf/skills);非桌面态返回 null。 */
export function loadSkills(): Promise<SkillsDTO | null> {
  return quiet<SkillsDTO>(`${SVC}.AgentConfig.SkillsLoad`);
}

/** 读取技能全文;失败返回 null。 */
export function getSkillContent(name: string): Promise<string | null> {
  return quiet<string>(`${SVC}.AgentConfig.SkillGet`, name);
}

/** 新建/覆盖技能;失败返回错误信息。 */
export function saveSkill(name: string, content: string): Promise<string | null> {
  return errStr('仅桌面形态可管理技能', `${SVC}.AgentConfig.SkillSave`, name, content);
}

/** 删除技能目录;失败返回错误信息。 */
export function deleteSkill(name: string): Promise<string | null> {
  return errStr('仅桌面形态可管理技能', `${SVC}.AgentConfig.SkillDelete`, name);
}

/** 官方下载服务器上一个版本的可用产物列表。 */
export interface RemoteReleaseDTO {
  version: string;
  files: string[];
}

/** 官方服务器可安装的插件列表;非桌面态/无产物返回 null/空。 */
export function pluginRemoteList(): Promise<RemoteReleaseDTO | null> {
  return quiet<RemoteReleaseDTO>(`${SVC}.AgentConfig.PluginRemoteList`);
}

/** 在线安装插件(下载到 ~/.grf/plugins,显式模式下自动入列);返回错误信息或 null。 */
export function pluginInstall(name: string): Promise<string | null> {
  return errStr('仅桌面形态可安装插件', `${SVC}.AgentConfig.PluginInstall`, name);
}

/** 删除插件(内置浏览器/电脑操作不可删);返回错误信息或 null。 */
export function pluginDelete(name: string): Promise<string | null> {
  return errStr('仅桌面形态可删除插件', `${SVC}.AgentConfig.PluginDelete`, name);
}

/** 官方服务器可安装的技能列表(暂无产物返回空)。 */
export function skillRemoteList(): Promise<RemoteReleaseDTO | null> {
  return quiet<RemoteReleaseDTO>(`${SVC}.AgentConfig.SkillRemoteList`);
}

/** 在线安装技能(x.md → skills/<name>/SKILL.md);返回错误信息或 null。 */
export function skillInstall(file: string): Promise<string | null> {
  return errStr('仅桌面形态可安装技能', `${SVC}.AgentConfig.SkillInstall`, file);
}

/** 启用/禁用技能(SKILL.md ↔ SKILL.md.disabled);返回错误信息或 null。 */
export function skillSetEnabled(name: string, enabled: boolean): Promise<string | null> {
  return errStr('仅桌面形态可操作', `${SVC}.AgentConfig.SkillSetEnabled`, name, enabled);
}

/** 从任意 URL 拉取 SKILL.md 安装为技能;返回错误信息或 null。 */
export function skillInstallFromURL(name: string, url: string): Promise<string | null> {
  return errStr('仅桌面形态可安装技能', `${SVC}.AgentConfig.SkillInstallFromURL`, name, url);
}

// ---------- server 托管(ServerManager service) ----------

export interface ServerStatusDTO {
  running: boolean;
  addr: string;
  dataDir: string;
  token: string;
  pid: number;
  lastError: string;
}

export function serverStatus(): Promise<ServerStatusDTO | null> {
  return quiet<ServerStatusDTO>(`${SVC}.ServerManager.Status`);
}

export async function serverStart(): Promise<ServerStatusDTO | null> {
  if (!inWails()) return null;
  return call<ServerStatusDTO>(`${SVC}.ServerManager.Start`);
}

export async function serverStop(): Promise<ServerStatusDTO | null> {
  if (!inWails()) return null;
  return call<ServerStatusDTO>(`${SVC}.ServerManager.Stop`);
}

// ---------- 桌面能力(Desktop service) ----------

/** 原生目录选择器;返回所选目录,取消/非桌面态返回 null。 */
export async function pickFolder(): Promise<string | null> {
  return (await quiet<string>(`${SVC}.Desktop.PickFolder`)) || null;
}

/** 在系统文件管理器中显示该路径(仅桌面态)。 */
export function revealPath(path: string): Promise<void> {
  return silent(`${SVC}.Desktop.Reveal`, path);
}

/** 当前系统用户名(左栏底部身份展示用);非桌面态返回空串。 */
export async function desktopUserName(): Promise<string> {
  return quietStr(`${SVC}.Desktop.UserName`);
}

/** 用户主目录(未选工作区时聊天/终端的默认目录);非桌面态返回空串。 */
export async function desktopHomeDir(): Promise<string> {
  return quietStr(`${SVC}.Desktop.HomeDir`);
}

// ---------- 目录浏览(左栏文件列表;仅桌面) ----------

export interface FileEntryDTO {
  name: string;
  isDir: boolean;
  size: number;
  modTime: number; // Unix 毫秒
}

/** 列出目录一级条目(目录在前、名称升序,隐藏条目已滤除);非桌面态/失败返回 null。 */
export function listDir(path: string): Promise<FileEntryDTO[] | null> {
  return quiet<FileEntryDTO[]>(`${SVC}.Desktop.ListDir`, path);
}

/** 读取文本文件内容(右栏预览,上限 2MB);失败抛带信息的 Error,非桌面态抛不支持。 */
export async function readFileText(path: string): Promise<string> {
  if (!inWails()) throw new Error('仅桌面态支持文件预览');
  return call<string>(`${SVC}.Desktop.ReadFile`, path);
}

/** 读取图片文件为 data URL(右栏预览,上限 10MB);失败抛带信息的 Error。 */
export async function readImageDataUrl(path: string): Promise<string> {
  if (!inWails()) throw new Error('仅桌面态支持图片预览');
  return call<string>(`${SVC}.Desktop.ReadImage`, path);
}

// ---------- 终端(TerminalManager service,仅桌面) ----------

export interface TermSessionDTO {
  id: string;
}

/** 在 cwd 启动交互终端(PTY)会话;非桌面态返回 null,启动失败抛错。 */
export async function startTerm(cwd: string, cols: number, rows: number): Promise<TermSessionDTO | null> {
  if (!inWails()) return null;
  return call<TermSessionDTO>(`${SVC}.TerminalManager.StartTerm`, cwd, cols, rows);
}

/** 向终端会话写入键盘输入(会话已退出时静默)。 */
export function writeTerm(id: string, data: string): Promise<void> {
  return silent(`${SVC}.TerminalManager.WriteTerm`, id, data);
}

/** 调整终端会话尺寸。 */
export function resizeTerm(id: string, cols: number, rows: number): Promise<void> {
  return silent(`${SVC}.TerminalManager.ResizeTerm`, id, cols, rows);
}

/** 终止终端会话。 */
export function killTerm(id: string): Promise<void> {
  return silent(`${SVC}.TerminalManager.KillTerm`, id);
}

/** 终端输出增量读取结果(data 为 base64;from/to 为绝对字节游标)。 */
export interface TermReadDTO {
  from: number;
  to: number;
  data: string;
}

/** 增量读取终端会话输出(goder-console 智能体接管会话时回放缓冲)。 */
export function readTerm(id: string, from: number): Promise<TermReadDTO | null> {
  return quiet<TermReadDTO>(`${SVC}.TerminalManager.ReadTerm`, id, from);
}

// ---------- goder-console 智能体控制面(ConsoleMCP service,仅桌面) ----------

/** Go 侧下发的界面操作载荷(goder:console-ui 事件)。 */
export interface ConsoleUiPayload {
  action: string;
  params?: Record<string, unknown>;
}

/** 订阅智能体界面操作事件;返回取消订阅。非桌面态为 no-op。 */
export function consoleUiListen(cb: (p: ConsoleUiPayload) => void): () => void {
  return wailsEvent<ConsoleUiPayload>(
    'goder:console-ui',
    (raw) => (raw && typeof raw === 'object' ? (raw as ConsoleUiPayload) : undefined),
    cb,
  );
}

/** 上报界面状态 JSON(goder_ui_state 工具读;非桌面态静默)。 */
export function consoleUiReport(state: string): Promise<void> {
  return silent(`${SVC}.ConsoleMCP.ReportUIState`, state);
}

interface WailsEvents {
  On: (name: string, cb: (ev: { name: string; data?: unknown }) => void) => () => void;
}

/** 订阅终端输出/退出事件(kind: data=base64 输出块 / exit=退出码);返回取消订阅。非桌面态为 no-op。 */
export function onTermEvent(id: string, kind: 'data' | 'exit', cb: (payload: string) => void): () => void {
  // 事件名须与 Go 侧 terminal.go 的 Emit 一致(goder: 前缀;grf→goder
  // 更名时此处漏改,订阅名与发射名不匹配会让终端收不到任何输出)
  return wailsEvent<string>(
    `goder:term-${kind}:${id}`,
    (raw) => (raw === undefined || raw === null ? '' : String(raw)),
    cb,
  );
}

// ---------- 浏览器(BrowserManager service,仅桌面) ----------
// 内嵌浏览器面板的原生 webview(macOS:自建 WKWebView 子视图;Windows:
// Wails 窗口 HWND 重父级成 WS_CHILD 子窗口)。不支持的平台 Available
// 返回 false、Navigate 返回 false,前端面板用 iframe 回退。

/** 本平台能否内嵌原生 webview;非桌面态/失败返回 false(→ iframe)。 */
export function browserAvailable(): Promise<boolean> {
  return quietBool(`${SVC}.BrowserManager.Available`);
}

/** 导航(必要时创建原生视图);空 url 仅确保视图存在。返回是否有原生
 * 内容可用(false = 平台不支持内嵌或创建失败,面板应回退 iframe)。 */
export function browserNavigate(url: string): Promise<boolean> {
  return quietBool(`${SVC}.BrowserManager.Navigate`, url);
}

/** 展示/隐藏原生内容(随面板激活状态)。 */
export function browserShow(): Promise<void> {
  return silent(`${SVC}.BrowserManager.Show`);
}

export function browserHide(): Promise<void> {
  return silent(`${SVC}.BrowserManager.Hide`);
}

/** 上报浏览器面板 rect(视口相对 CSS 像素,getBoundingClientRect)。 */
export function browserSetRect(x: number, y: number, w: number, h: number): Promise<void> {
  return silent(`${SVC}.BrowserManager.SetRect`, x, y, w, h);
}

/** 上报原生 webview 底色(CSS 颜色串,如 #13151b / rgb(...)):边缘发丝缝
 * 露出这个颜色而不是 WebKit 默认白。 */
export function browserSetBackground(color: string): Promise<void> {
  return silent(`${SVC}.BrowserManager.SetBackground`, color);
}

/** 后退/前进/刷新原生 webview 自身的导航历史。 */
export function browserBack(): Promise<void> {
  return silent(`${SVC}.BrowserManager.Back`);
}

export function browserForward(): Promise<void> {
  return silent(`${SVC}.BrowserManager.Forward`);
}

export function browserReload(): Promise<void> {
  return silent(`${SVC}.BrowserManager.Reload`);
}

// ---------- git(Desktop service,审查面板用;仅桌面) ----------

export interface GitEntryDTO {
  path: string;
  origPath: string;
  index: string;
  work: string;
}

export interface GitStatusDTO {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: GitEntryDTO[];
  /** 行级变更(+/-)：工作区+暂存 vs HEAD */
  additions: number;
  deletions: number;
}

/** 读取仓库状态;非桌面态返回 null,git 失败抛错(如"不是 git 仓库")。 */
export async function gitStatus(cwd: string): Promise<GitStatusDTO | null> {
  if (!inWails()) return null;
  return call<GitStatusDTO>(`${SVC}.Desktop.GitStatus`, cwd);
}

/** 读取单文件 diff 文本;非桌面态/失败返回 null。 */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<string | null> {
  if (!inWails()) return null;
  try {
    return await call<string>(`${SVC}.Desktop.GitDiff`, cwd, path, staged);
  } catch {
    return null;
  }
}

/** 在用户主目录下确保存在同名子目录(自动化操作员工作区),返回绝对
 * 路径;非桌面态返回 null,名字非法/建目录失败抛错。 */
export async function ensureHomeDir(name: string): Promise<string | null> {
  if (!inWails()) return null;
  return call<string>(`${SVC}.Desktop.EnsureHomeDir`, name);
}

// 主目录通道注入 core 的 scope(模块加载即接线,GoderScope 构造器取到的
// 就是桥实现,时序与此前直接 import 时一致);core 由此不再反向依赖
// host/bridge,可整体拷出独立成包。inWails 的回落语义在两个函数内部。
setHomeDirProvider({ homeDir: desktopHomeDir, ensureHomeDir });

// ---------- 自动更新(Updater service,仅桌面) ----------
// goder 自身与 gh(grf-harness)的更新检查/应用;进度经 goder:update-progress
// 事件下发(下载耗时数分钟,Apply 只做启动确认)。

/** 单个组件(goder/gh)的版本对比;与 Go 侧 UpdateCompDTO 对齐。 */
export interface UpdateCompDTO {
  current: string;
  latest: string;
  update: boolean;
}

/** 一次检查的结果;与 Go 侧 UpdateInfoDTO 对齐。 */
export interface UpdateInfoDTO {
  goder: UpdateCompDTO;
  gh: UpdateCompDTO;
  /** gh 是否由本程序托管(远程模式/手动配置路径时不提供自动更新) */
  ghManaged: boolean;
  /** 新版本说明(尽力而为,可能为空) */
  goderNote: string;
  ghNote: string;
  /** 检查完成时间(Unix 毫秒) */
  checkedAt: number;
}

/** 更新进度事件载荷;与 Go 侧 UpdateProgressDTO 对齐。 */
export interface UpdateProgressDTO {
  which: 'goder' | 'gh';
  phase: 'download' | 'install' | 'restart' | 'done' | 'error';
  pct: number;
  msg: string;
}

/** 检查更新(要访问下载服务器,允许较长超时);非桌面态/失败返回 null。 */
export async function checkUpdate(): Promise<UpdateInfoDTO | null> {
  if (!inWails()) return null;
  try {
    return await callSlow<UpdateInfoDTO>(60_000, `${SVC}.Updater.Check`);
  } catch {
    return null;
  }
}

/** 启动更新应用(which = 'goder' | 'gh',异步执行,进度走事件);
 * 返回错误信息或 null(仅表示"已开始")。 */
export async function applyUpdate(which: 'goder' | 'gh'): Promise<string | null> {
  if (!inWails()) return '仅桌面形态支持更新';
  try {
    await callSlow<void>(20_000, `${SVC}.Updater.Apply`, which);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 订阅更新进度事件;返回取消订阅。非桌面态为 no-op。 */
export function onUpdateProgress(cb: (p: UpdateProgressDTO) => void): () => void {
  return wailsEvent<UpdateProgressDTO>(
    'goder:update-progress',
    (raw) => (raw && typeof raw === 'object' ? (raw as UpdateProgressDTO) : undefined),
    cb,
  );
}

// ---------- 桥初始化:桌面态把项目索引换成文件持久化 ----------

class WailsPersistence implements Persistence {
  async load(scope: string): Promise<ProjectsIndex | null> {
    try {
      const raw = await call<string>(`${SVC}.AppConfig.LoadIndex`, scope);
      return raw ? (JSON.parse(raw) as ProjectsIndex) : null;
    } catch {
      return null;
    }
  }
  async save(scope: string, idx: ProjectsIndex): Promise<void> {
    try {
      await call<void>(`${SVC}.AppConfig.SaveIndex`, scope, JSON.stringify(idx));
    } catch {
      /* 静默 */
    }
  }
}

export async function initHostBridge(): Promise<boolean> {
  // 探针带重试:页面加载初期 wails 调用通道可能尚未就绪(传输握手)。
  for (let i = 0; i < 8; i++) {
    try {
      await withTimeout(call(`${SVC}.AppConfig.Load`), 1500);
      wailsProbe = true;
      setPersistence(new WailsPersistence());
      return true;
    } catch {
      wailsProbe = false;
      runtime = null;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}
