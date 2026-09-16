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
  defaults?: GrfSessionConfig; // 新会话继承的 grf:session 配置
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

export interface ProjectsIndex {
  version: 1;
  projects: ProjectRecord[];
  sessions: Record<string, SessionRecord>; // sid → 记录
  /** 上次退出时所在的会话(真实 sid;启动时恢复选中,草稿不记录) */
  lastActiveSessionId?: string;
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
  };
}

export interface Persistence {
  load(scope: string): Promise<ProjectsIndex | null>;
  save(scope: string, idx: ProjectsIndex): Promise<void>;
}

class LocalStoragePersistence implements Persistence {
  private key(scope: string): string {
    return `grf-ui:${scope}:index`;
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
