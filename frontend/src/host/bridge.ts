// bridge.ts — wails 宿主桥:仅在桌面(wails webview)内生效,纯 web 态全部
// no-op 回退。职责:配置持久化(文件)、gh server 托管(启动/停止/状态)。
import { setPersistence, type Persistence } from '../core/store/persistence';
import type { ProjectsIndex } from '../core/store/persistence';

// wails v3 桌面态检测。注意:不能只看 window._wails —— 该属性由
// @wailsio/runtime 包加载时自设,普通浏览器懒加载后也会有;也不能依赖
// 注入 runtime(它可能跑在独立 JS world)。可靠信号是"真的调通了 wails
// 服务"(initHostBridge 探针)与桌面 origin 形态。
let wailsProbe = false;

export function inWails(): boolean {
  if (wailsProbe) return true;
  if (typeof window === 'undefined') return false;
  if (typeof location !== 'undefined') {
    if (location.protocol === 'wails:' || location.protocol === 'wails-capabilities:') return true;
    if (/^(wails\.localhost|app\.localhost)$/.test(location.hostname)) return true;
  }
  return false;
}

interface WailsCall {
  ByName: (name: string, ...args: unknown[]) => Promise<unknown>;
}

// wails Call.ByName 按完整 FQN(包路径.类型.方法)精确匹配;桌面服务在
// internal/desktop,与 Go 侧 module 路径保持同步。
const SVC = 'git.gorun.fun/share/goder/internal/desktop';

let runtime: WailsCall | null = null;

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
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
    12_000,
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

// ---------- 配置(AppConfig service) ----------

export interface AppConfigDTO {
  scope: string;
  serverMode: 'managed' | 'remote';
  remoteUrl: string;
  remoteToken: string;
  defaultModel: string;
  ghBinary: string;
  serverAddr: string;
}

export async function loadAppConfig(): Promise<AppConfigDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<AppConfigDTO>(`${SVC}.AppConfig.Load`);
  } catch {
    return null;
  }
}

export async function saveAppConfig(cfg: AppConfigDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.AppConfig.Save`, cfg);
}

// ---------- 模型配置(ModelConfig service,gh 的 settings.json) ----------

/** 一个模型供应商(对应 settings.json 的 providers.<name>) */
export interface ProviderDTO {
  name: string;
  /** 协议类型;空串表示 gh 默认(OpenAI 兼容) */
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ModelConfigDTO {
  /** settings.json 路径(展示用) */
  path: string;
  providers: ProviderDTO[];
  /** 默认模型(provider/model) */
  default: string;
  /** 目标文件是否可写(不可写时 UI 只读) */
  writable: boolean;
  /** gh settings 常用项;null 表示文件里没有该键,保存时原样保留 */
  maxSteps: number | null;
  mouse: boolean | null;
  policy: string;
}

/** 读取供应商与默认模型;非桌面态返回 null(纯 web 态无法访问 gh 配置)。 */
export async function loadModelConfig(): Promise<ModelConfigDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<ModelConfigDTO>(`${SVC}.ModelConfig.Load`);
  } catch {
    return null;
  }
}

/** 写回 providers 与 default;其余配置键原样保留。 */
export async function saveModelConfig(cfg: ModelConfigDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.ModelConfig.Save`, cfg);
}

/** 探测供应商可用模型(GET {baseURL}/models,OpenAI 兼容);非桌面态返回 null。 */
export async function detectModels(p: ProviderDTO): Promise<string[] | null> {
  if (!inWails()) return null;
  try {
    return await call<string[]>(`${SVC}.ModelConfig.DetectModels`, p);
  } catch {
    return null;
  }
}

// ---------- 智能体扩展(AgentConfig service,插件/MCP/技能) ----------

/** 一个插件/远程 MCP(settings.json 的 plugins 数组项)。 */
export interface PluginDTO {
  name: string;
  /** 本地 stdio 插件:可执行文件 + 参数 */
  command: string[];
  /** 远程 MCP:Streamable HTTP 端点 */
  url: string;
  /** 远程 MCP:Bearer token */
  token: string;
  /** 工具调用超时秒数;0 = 默认 */
  timeout: number;
}

export interface PluginsDTO {
  /** settings.json 路径(展示用) */
  path: string;
  /** 自动发现目录(~/.grf/plugins)路径 */
  dir: string;
  /** true = 显式列表模式;false = 自动发现(~/.grf/plugins/) */
  explicit: boolean;
  plugins: PluginDTO[];
  /** 自动发现目录下的可执行文件名 */
  discovered: string[];
  writable: boolean;
}

export interface SkillDTO {
  name: string;
  description: string;
  /** SKILL.md 绝对路径(展示用) */
  path: string;
  /** true = 已禁用(SKILL.md 改名 .disabled,内容保留) */
  disabled: boolean;
}

export interface SkillsDTO {
  /** skills 目录路径(展示用) */
  path: string;
  skills: SkillDTO[];
  writable: boolean;
}

/** 读取插件/MCP 配置;非桌面态返回 null。 */
export async function loadPlugins(): Promise<PluginsDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<PluginsDTO>(`${SVC}.AgentConfig.PluginsLoad`);
  } catch {
    return null;
  }
}

/** 写回 plugins 键(explicit=false 删键回到自动发现)。 */
export async function savePlugins(cfg: PluginsDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>(`${SVC}.AgentConfig.PluginsSave`, cfg);
}

/** 列出技能(~/.grf/skills);非桌面态返回 null。 */
export async function loadSkills(): Promise<SkillsDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<SkillsDTO>(`${SVC}.AgentConfig.SkillsLoad`);
  } catch {
    return null;
  }
}

/** 读取技能全文;失败返回 null。 */
export async function getSkillContent(name: string): Promise<string | null> {
  if (!inWails()) return null;
  try {
    return await call<string>(`${SVC}.AgentConfig.SkillGet`, name);
  } catch {
    return null;
  }
}

/** 新建/覆盖技能;失败返回错误信息。 */
export async function saveSkill(name: string, content: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可管理技能';
  try {
    await call<void>(`${SVC}.AgentConfig.SkillSave`, name, content);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 删除技能目录;失败返回错误信息。 */
export async function deleteSkill(name: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可管理技能';
  try {
    await call<void>(`${SVC}.AgentConfig.SkillDelete`, name);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 官方下载服务器上一个版本的可用产物列表。 */
export interface RemoteReleaseDTO {
  version: string;
  files: string[];
}

/** 官方服务器可安装的插件列表;非桌面态/无产物返回 null/空。 */
export async function pluginRemoteList(): Promise<RemoteReleaseDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<RemoteReleaseDTO>(`${SVC}.AgentConfig.PluginRemoteList`);
  } catch {
    return null;
  }
}

/** 在线安装插件(下载到 ~/.grf/plugins,显式模式下自动入列);返回错误信息或 null。 */
export async function pluginInstall(name: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可安装插件';
  try {
    await call<void>(`${SVC}.AgentConfig.PluginInstall`, name);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 删除插件(内置浏览器/电脑操作不可删);返回错误信息或 null。 */
export async function pluginDelete(name: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可删除插件';
  try {
    await call<void>(`${SVC}.AgentConfig.PluginDelete`, name);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 官方服务器可安装的技能列表(暂无产物返回空)。 */
export async function skillRemoteList(): Promise<RemoteReleaseDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<RemoteReleaseDTO>(`${SVC}.AgentConfig.SkillRemoteList`);
  } catch {
    return null;
  }
}

/** 在线安装技能(x.md → skills/<name>/SKILL.md);返回错误信息或 null。 */
export async function skillInstall(file: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可安装技能';
  try {
    await call<void>(`${SVC}.AgentConfig.SkillInstall`, file);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 启用/禁用技能(SKILL.md ↔ SKILL.md.disabled);返回错误信息或 null。 */
export async function skillSetEnabled(name: string, enabled: boolean): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可操作';
  try {
    await call<void>(`${SVC}.AgentConfig.SkillSetEnabled`, name, enabled);
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 从任意 URL 拉取 SKILL.md 安装为技能;返回错误信息或 null。 */
export async function skillInstallFromURL(name: string, url: string): Promise<string | null> {
  if (!inWails()) return '仅桌面形态可安装技能';
  try {
    await call<void>(`${SVC}.AgentConfig.SkillInstallFromURL`, name, url);
    return null;
  } catch (e) {
    return String(e);
  }
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

export async function serverStatus(): Promise<ServerStatusDTO | null> {
  if (!inWails()) return null;
  try {
    return await call<ServerStatusDTO>(`${SVC}.ServerManager.Status`);
  } catch {
    return null;
  }
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
  if (!inWails()) return null;
  try {
    const p = await call<string>(`${SVC}.Desktop.PickFolder`);
    return p || null;
  } catch {
    return null;
  }
}

/** 在系统文件管理器中显示该路径(仅桌面态)。 */
export async function revealPath(path: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>(`${SVC}.Desktop.Reveal`, path);
  } catch {
    /* 静默 */
  }
}

/** 当前系统用户名(左栏底部身份展示用);非桌面态返回空串。 */
export async function desktopUserName(): Promise<string> {
  if (!inWails()) return '';
  try {
    return (await call<string>(`${SVC}.Desktop.UserName`)) || '';
  } catch {
    return '';
  }
}

// ---------- 目录浏览(左栏文件列表;仅桌面) ----------

export interface FileEntryDTO {
  name: string;
  isDir: boolean;
  size: number;
  modTime: number; // Unix 毫秒
}

/** 列出目录一级条目(目录在前、名称升序,隐藏条目已滤除);非桌面态/失败返回 null。 */
export async function listDir(path: string): Promise<FileEntryDTO[] | null> {
  if (!inWails()) return null;
  try {
    return await call<FileEntryDTO[]>(`${SVC}.Desktop.ListDir`, path);
  } catch {
    return null;
  }
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
export async function writeTerm(id: string, data: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>(`${SVC}.TerminalManager.WriteTerm`, id, data);
  } catch {
    /* 会话可能已退出 */
  }
}

/** 调整终端会话尺寸。 */
export async function resizeTerm(id: string, cols: number, rows: number): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>(`${SVC}.TerminalManager.ResizeTerm`, id, cols, rows);
  } catch {
    /* 静默 */
  }
}

/** 终止终端会话。 */
export async function killTerm(id: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>(`${SVC}.TerminalManager.KillTerm`, id);
  } catch {
    /* 静默 */
  }
}

interface WailsEvents {
  On: (name: string, cb: (ev: { name: string; data?: unknown }) => void) => () => void;
}

/** 订阅终端输出/退出事件(kind: data=base64 输出块 / exit=退出码);返回取消订阅。非桌面态为 no-op。 */
export function onTermEvent(id: string, kind: 'data' | 'exit', cb: (payload: string) => void): () => void {
  if (!inWails()) return () => {};
  const name = `grf:term-${kind}:${id}`;
  let off: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    try {
      const mod = (await import('@wailsio/runtime')) as unknown as { Events: WailsEvents };
      if (cancelled) return;
      off = mod.Events.On(name, (ev) => {
        const raw = ev?.data;
        const v = Array.isArray(raw) ? raw[0] : raw;
        cb(v === undefined || v === null ? '' : String(v));
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
