// bridge.ts — wails 宿主桥:仅在桌面(wails webview)内生效,纯 web 态全部
// no-op 回退。职责:配置持久化(文件)、gh server 托管(启动/停止/状态)。
import { setPersistence, type Persistence } from '../state/persist';
import type { ProjectsIndex } from '../state/persist';

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
    return await call<AppConfigDTO>('main.AppConfig.Load');
  } catch {
    return null;
  }
}

export async function saveAppConfig(cfg: AppConfigDTO): Promise<void> {
  if (!inWails()) return;
  await call<void>('main.AppConfig.Save', cfg);
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
    return await call<ServerStatusDTO>('main.ServerManager.Status');
  } catch {
    return null;
  }
}

export async function serverStart(): Promise<ServerStatusDTO | null> {
  if (!inWails()) return null;
  return call<ServerStatusDTO>('main.ServerManager.Start');
}

export async function serverStop(): Promise<ServerStatusDTO | null> {
  if (!inWails()) return null;
  return call<ServerStatusDTO>('main.ServerManager.Stop');
}

// ---------- 桌面能力(Desktop service) ----------

/** 原生目录选择器;返回所选目录,取消/非桌面态返回 null。 */
export async function pickFolder(): Promise<string | null> {
  if (!inWails()) return null;
  try {
    const p = await call<string>('main.Desktop.PickFolder');
    return p || null;
  } catch {
    return null;
  }
}

/** 在系统文件管理器中显示该路径(仅桌面态)。 */
export async function revealPath(path: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>('main.Desktop.Reveal', path);
  } catch {
    /* 静默 */
  }
}

/** 当前系统用户名(左栏底部身份展示用);非桌面态返回空串。 */
export async function desktopUserName(): Promise<string> {
  if (!inWails()) return '';
  try {
    return (await call<string>('main.Desktop.UserName')) || '';
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
    return await call<FileEntryDTO[]>('main.Desktop.ListDir', path);
  } catch {
    return null;
  }
}

/** 读取文本文件内容(右栏预览,上限 2MB);失败抛带信息的 Error,非桌面态抛不支持。 */
export async function readFileText(path: string): Promise<string> {
  if (!inWails()) throw new Error('仅桌面态支持文件预览');
  return call<string>('main.Desktop.ReadFile', path);
}

/** 读取图片文件为 data URL(右栏预览,上限 10MB);失败抛带信息的 Error。 */
export async function readImageDataUrl(path: string): Promise<string> {
  if (!inWails()) throw new Error('仅桌面态支持图片预览');
  return call<string>('main.Desktop.ReadImage', path);
}

// ---------- 终端(TerminalManager service,仅桌面) ----------

export interface TermSessionDTO {
  id: string;
}

/** 在 cwd 启动交互终端(PTY)会话;非桌面态返回 null,启动失败抛错。 */
export async function startTerm(cwd: string, cols: number, rows: number): Promise<TermSessionDTO | null> {
  if (!inWails()) return null;
  return call<TermSessionDTO>('main.TerminalManager.StartTerm', cwd, cols, rows);
}

/** 向终端会话写入键盘输入(会话已退出时静默)。 */
export async function writeTerm(id: string, data: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>('main.TerminalManager.WriteTerm', id, data);
  } catch {
    /* 会话可能已退出 */
  }
}

/** 调整终端会话尺寸。 */
export async function resizeTerm(id: string, cols: number, rows: number): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>('main.TerminalManager.ResizeTerm', id, cols, rows);
  } catch {
    /* 静默 */
  }
}

/** 终止终端会话。 */
export async function killTerm(id: string): Promise<void> {
  if (!inWails()) return;
  try {
    await call<void>('main.TerminalManager.KillTerm', id);
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
  return call<GitStatusDTO>('main.Desktop.GitStatus', cwd);
}

/** 读取单文件 diff 文本;非桌面态/失败返回 null。 */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<string | null> {
  if (!inWails()) return null;
  try {
    return await call<string>('main.Desktop.GitDiff', cwd, path, staged);
  } catch {
    return null;
  }
}

// ---------- 桥初始化:桌面态把项目索引换成文件持久化 ----------

class WailsPersistence implements Persistence {
  async load(scope: string): Promise<ProjectsIndex | null> {
    try {
      const raw = await call<string>('main.AppConfig.LoadIndex', scope);
      return raw ? (JSON.parse(raw) as ProjectsIndex) : null;
    } catch {
      return null;
    }
  }
  async save(scope: string, idx: ProjectsIndex): Promise<void> {
    try {
      await call<void>('main.AppConfig.SaveIndex', scope, JSON.stringify(idx));
    } catch {
      /* 静默 */
    }
  }
}

export async function initHostBridge(): Promise<boolean> {
  // 探针带重试:页面加载初期 wails 调用通道可能尚未就绪(传输握手)。
  for (let i = 0; i < 8; i++) {
    try {
      await withTimeout(call('main.AppConfig.Load'), 1500);
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
