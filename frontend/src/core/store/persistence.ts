// persist.ts — 项目索引持久化适配器:桌面态走 wails 服务(文件),
// 纯 web 态走 localStorage。接口一致,由 host 桥探测决定。
import type { GrfSessionConfig } from '../api/types';

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  collapsed?: boolean;
  /** 本地目录路径(桌面态新建项目时选择) */
  path?: string;
  /** 新会话继承的 grf:session 配置(含 system_prompt/custom、
   * default_skill 默认技能等,经 updateProjectDefaults 开放给嵌入方) */
  defaults?: GrfSessionConfig;
  /** 'operator' = 自动化操作员分组(home 下的专属目录作工作区,
   * 会话注入操作员 system prompt;显示在左栏「自动化」类别) */
  kind?: 'operator';
}

export interface SessionRecord {
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  lastResponseId?: string;
  /** 用户最后查看会话时的 lastResponseId 基线(与之不同 = 有未查看的新回合) */
  lastSeenResponseId?: string;
  /** 本会话最后使用的模型/思考强度(新会话按同项目最近会话继承) */
  model?: string;
  effort?: string;
}

/** 自动化任务:操作员会话中沉淀的可复执行指令,入口在状态浮窗。 */
export interface AutomationTask {
  id: string;
  /** 所属操作员(项目 id):执行会话建在其下,继承工作区与记忆 */
  operatorId: string;
  name: string;
  /** 完整可独立执行的指令文本 */
  instructions: string;
  createdAt: string;
  updatedAt?: string;
  /** 最近一次执行会话 id 与时刻(状态浮窗运行态指示) */
  lastRunSid?: string;
  lastRunAt?: string;
}

export interface ProjectsIndex {
  version: 1;
  projects: ProjectRecord[];
  sessions: Record<string, SessionRecord>; // sid → 记录
  /** 上次退出时所在的会话(真实 sid;启动时恢复选中,草稿不记录) */
  lastActiveSessionId?: string;
  /** 自动化任务库(操作员沉淀的指令) */
  automation?: AutomationTask[];
}

export function emptyIndex(): ProjectsIndex {
  return { version: 1, projects: [], sessions: {} };
}

export function migrateIndex(raw: unknown): ProjectsIndex {
  if (!raw || typeof raw !== 'object') return emptyIndex();
  const idx = raw as Partial<ProjectsIndex>;
  return {
    version: 1,
    projects: Array.isArray(idx.projects) ? idx.projects : [],
    sessions: idx.sessions && typeof idx.sessions === 'object' ? idx.sessions : {},
    // 上次所在会话(启动恢复选中;漏拷会导致重开不回到之前的会话)
    lastActiveSessionId:
      typeof idx.lastActiveSessionId === 'string' ? idx.lastActiveSessionId : undefined,
    // 自动化任务库:漏拷会在 web 态重载时清空已保存的任务
    automation: Array.isArray(idx.automation) ? idx.automation : undefined,
  };
}

export interface Persistence {
  load(scope: string): Promise<ProjectsIndex | null>;
  save(scope: string, idx: ProjectsIndex): Promise<void>;
}

class LocalStoragePersistence implements Persistence {
  private key(scope: string): string {
    return `goder:${scope}:index`;
  }
  async load(scope: string): Promise<ProjectsIndex | null> {
    try {
      const raw = localStorage.getItem(this.key(scope));
      return raw ? migrateIndex(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
  async save(scope: string, idx: ProjectsIndex): Promise<void> {
    try {
      localStorage.setItem(this.key(scope), JSON.stringify(idx));
    } catch {
      /* 配额满等情况静默 */
    }
  }
}

export const localStoragePersistence = new LocalStoragePersistence();

// wails 桥就绪后替换为文件持久化(见 host/bridge.ts)。
export let persistence: Persistence = localStoragePersistence;

export function setPersistence(p: Persistence): void {
  persistence = p;
}
