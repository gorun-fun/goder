// scope.ts — 核心编排器:一个 scope 聚合连接配置、项目索引、会话运行态与
// 事件日志;面板(会话列表/聊天/右栏/底栏)通过 scope 名共享同一份数据。
// 嵌入态多个 scope 互不干扰,桌面态只用 "app"。
import { GrfApiError, GrfClient } from '../api/client';
import { friendlyError, isToolChoiceUnsupported } from '../../util/fmt';
import type {
  Conversation,
  GrfSessionConfig,
  HistMessage,
  InputItem,
  ResponseResource,
  SendOptions,
  SSEEvent,
} from '../api/types';
import {
  applyEvent,
  applyResponseSnapshot,
  restoreLocalUsage,
  forgetUsage,
  genId,
  goalFromItems,
  historyToItems,
  isScreenshotTool,
  imagesOfOutput,
  shotUrlsOfFile,
  applySavedDurs,
  markRequestAnswered,
  materializeRequest,
  newRuntime,
  todosFromItems,
  textOfContent,
  type SessionRuntime,
} from '../model/chat-model';
import { emptyIndex, persistence, type AutomationTask, type ProjectsIndex, type ProjectRecord } from './persistence';
import { operatorSystemPrompt, runnerSystemPrompt, runnerMessage } from './automation';
import { desktopHomeDir, ensureHomeDir } from '../../host/bridge';
import { Emitter } from './emitter';

export const UNGROUPED = '__ungrouped';

export interface ConsoleEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'event';
  text: string;
}

/** 鉴权预留:多用户网关模式下 401 的处置。职责边界 —— 登录体系属于
 * 部署方/集成方;这里只提供"未登录时该做什么"的挂钩。 */
export interface AuthConfig {
  /** 未登录时跳转的登录入口(如 /grf-api/auth/login);优先于 onUnauthorized */
  loginUrl?: string;
  /** 未登录回调(宿主自定义跳转/弹窗);设置后不再自动跳 loginUrl */
  onUnauthorized?: (scope: string) => void;
}

export interface ConnectionConfig {
  baseUrl: string;
  token: string;
  model?: string;
  /** 思考强度(low/high/max;空 = 服务端默认) */
  reasoningEffort?: string;
  auth?: AuthConfig;
  /** false = 隐藏 composer 策略选择器且不加载本机 draftPolicy 偏好。
   * 嵌入方经项目 defaults/grf:session 全权管理会话策略时置 false,
   * 防止使用者在 UI 上放宽宿主下发的策略。 */
  policySelector?: boolean;
}

export type ConnState = 'unknown' | 'checking' | 'ok' | 'error';

export interface DraftInfo {
  projectId: string;
  /** 'run' = 点击自动化任务触发的执行会话(注入执行版 prompt) */
  variant?: 'run';
}

export class GrfScope extends Emitter {
  readonly name: string;
  client: GrfClient;
  model?: string;
  connState: ConnState = 'unknown';
  connError?: string;

  index: ProjectsIndex = emptyIndex();
  conversations = new Map<string, Conversation>();
  runtimes = new Map<string, SessionRuntime>();
  drafts = new Map<string, DraftInfo>(); // draft:<id> → 归属项目

  activeProjectId?: string;
  activeSessionId?: string; // 真实 sid 或 draft id

  /** 新会话访问策略偏好('write-workspace' | 'off';undefined = 跟随项目默认)。
   * gh 的 policy 只随会话首条消息落定,故此值影响下一个新建的会话。
   * policySelector 禁用时恒为 undefined(策略全权归项目默认)。 */
  draftPolicy?: string;

  /** 是否展示 composer 策略选择器(configure 的 policySelector;false =
   * 嵌入方全权管理策略,UI 不提供切换入口,本机偏好也不加载)。 */
  policySelector = true;

  console: ConsoleEntry[] = [];
  consolePaused = false;
  private consoleMax = 800;

  private refreshTimer?: ReturnType<typeof setInterval>;
  private inflightSends = new Set<string>(); // 运行中的 sid
  private activeAborts = new Map<string, AbortController>(); // sid → 当前流的中断器
  private streamDoneAt = new Map<string, number>(); // sid → 服务器已结束的时刻
  private watchdogHits = new Set<string>(); // 看门狗掐断的 sid(非用户取消)
  /** sid → 排队待发消息(回合运行中用户发送的,回合结束自动发出) */
  private sendQueues = new Map<
    string,
    { text: string; images?: string[]; resumeCallOutputs?: { call_id: string; output: string }[] }[]
  >();
  /** 已做过"暂停卡死自动修复"的会话(每会话只修一次,防循环吞掉新暂停) */
  private pauseRepaired = new Set<string>();

  private authCfg?: AuthConfig;

  constructor(name: string, cfg: ConnectionConfig) {
    super();
    this.name = name;
    this.client = new GrfClient({ baseUrl: cfg.baseUrl, token: cfg.token });
    this.model = fullModelName(cfg.model);
    // 思考强度无可继承记录/未选择时默认高(goder 约定,不依赖服务端默认)
    this.reasoningEffort = cfg.reasoningEffort ?? 'high';
    this.authCfg = cfg.auth;
    this.policySelector = cfg.policySelector !== false;
    this.draftPolicy = this.policySelector ? loadPolicyLocal(name) : undefined;
    // 桌面态的用户主目录:未选工作区时新会话 workspace 的默认值
    // (纯 web 态为空串,workspace 保持 undefined 走服务端默认)。
    void desktopHomeDir().then((h) => (this.homeDir = h));
  }

  /** 用户主目录(桌面态;未选工作区时新会话的默认 workspace)。 */
  private homeDir = '';

  /** 设置新会话策略偏好并持久化(localStorage,双形态通用)。 */
  setDraftPolicy(p: string): void {
    if (p !== 'write-workspace' && p !== 'off') return;
    this.draftPolicy = p;
    try {
      localStorage.setItem(policyKey(this.name), p);
    } catch {
      /* 忽略 */
    }
    this.notify();
  }

  /** 设置随请求发送的模型('' = 服务端默认);一律归一为 "provider/model"
   * 全名 —— gh 的 trySwitchModel 只认全名,裸名会被静默忽略、沿用当前模型。
   * 裸名按当前供应商表补全,补不出视为未选(走服务端默认)。本地持久化,
   * 不动连接状态。 */
  setModel(m: string): void {
    this.model = fullModelName(m);
    saveConnLocal(this.name, {
      baseUrl: this.client.config.baseUrl,
      token: this.client.config.token,
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    });
    this.notify();
  }

  /** 思考强度(low/high/max);无可继承/未选择时默认 high,随每个请求
   * 下发。本地持久化(localStorage),新会话按项目继承策略覆盖。 */
  reasoningEffort?: string;
  setReasoningEffort(e: string): void {
    this.reasoningEffort = e || undefined;
    saveConnLocal(this.name, {
      baseUrl: this.client.config.baseUrl,
      token: this.client.config.token,
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    });
    this.notify();
  }

  /**
   * 运行时变更已有会话的访问策略:立即生效、仅本会话、不落盘(与 gh
   * set_policy 批准后同一落地路径)。旧 server 无此端点时报错提示。
   */
  async setSessionPolicy(sid: string, policy: string): Promise<boolean> {
    try {
      const applied = await this.client.setConversationPolicy(sid, policy);
      const rt = this.runtimes.get(sid);
      if (rt) rt.policy = applied;
      this.log('info', `访问策略已切换为 ${applied}(本会话生效)`);
      return true;
    } catch (err) {
      this.log('warn', `策略变更失败:${errText(err)}`);
      return false;
    }
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    await this.reloadIndex();
    await this.refreshConversations();
    this.maybeRestoreSession();
    void this.probeHealth();
    this.refreshTimer = setInterval(() => {
      void this.tick();
    }, 5_000);
  }

  // maybeRestoreSession 恢复上次所在会话(仅真实 sid;草稿/已不存在的忽略)。
  // 只在当前未选中任何会话时执行:桌面态启动有竞态 —— start() 先于
  // host 桥就绪跑 reloadIndex(此时还是 localStorage 持久化,读到空索引),
  // 桥就绪换文件持久化重载后需再补跑一次;5 秒轮询也会反复进入,
  // 用户已手动选过会话则不再打扰。
  private maybeRestoreSession(): void {
    if (this.activeSessionId) return;
    const last = this.index.lastActiveSessionId;
    if (last && this.conversations.has(last)) this.selectSession(last);
  }

  // tick 周期对齐:空闲时同步会话列表;运行中时探测服务器终态,
  // 发现流挂死(server 已结束而本地仍在等)则主动中断触发自愈。
  private async tick(): Promise<void> {
    for (const sid of [...this.inflightSends]) {
      try {
        const detail = await this.client.getConversation(sid);
        // 运行中也让统计(速度/缓存命中率/上下文占用)跟着服务器走,
        // 不等回合结束才刷新。
        const rt = this.runtimes.get(sid);
        if (rt && detail.stats) {
          const next = JSON.stringify(detail.stats);
          if (next !== JSON.stringify(rt.stats ?? null)) {
            rt.stats = detail.stats;
            this.notify();
          }
        }
        if (!detail.running) {
          // 服务器已结束:给流一点收尾时间,仍挂着就掐断走对账。
          const since = Date.now() - (this.streamDoneAt.get(sid) ?? 0);
          if (!this.streamDoneAt.has(sid)) this.streamDoneAt.set(sid, Date.now());
          else if (since > 4000 && this.activeAborts.has(sid)) {
            this.log('warn', '检测到事件流挂死,从服务器终态恢复');
            this.watchdogHits.add(sid);
            this.activeAborts.get(sid)?.abort();
          }
        } else {
          this.streamDoneAt.delete(sid);
        }
      } catch {
        /* 探测失败忽略 */
      }
    }
    if (this.inflightSends.size === 0) this.refreshConversations().catch(() => {});
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async reloadIndex(): Promise<void> {
    const idx = await persistence.load(this.name);
    this.index = idx ?? emptyIndex();
    // 旧索引迁移:补 lastSeenResponseId 基线,历史回合一律视为已读,
    // 避免升级后所有存量会话都被标成"完成未查看"。
    let migrated = false;
    for (const rec of Object.values(this.index.sessions)) {
      if (!('lastSeenResponseId' in rec)) {
        rec.lastSeenResponseId = rec.lastResponseId ?? '';
        migrated = true;
      }
    }
    if (!this.index.projects.find((p) => p.id === UNGROUPED)) {
      this.index.projects.push({
        id: UNGROUPED,
        name: '未分组会话',
        createdAt: new Date().toISOString(),
      });
    }
    if (migrated) this.persistIndex();
    // 桥就绪后重载(桌面态文件持久化)补跑会话恢复
    this.maybeRestoreSession();
    this.notify();
  }

  private persistIndex(): void {
    void persistence.save(this.name, this.index);
  }

  // ---------- 连接 ----------

  setConnection(cfg: Partial<ConnectionConfig>): void {
    this.client.setConfig({ baseUrl: cfg.baseUrl ?? this.client.config.baseUrl, token: cfg.token ?? this.client.config.token });
    if (cfg.model !== undefined) this.model = fullModelName(cfg.model);
    if (cfg.reasoningEffort !== undefined) this.reasoningEffort = cfg.reasoningEffort;
    if (cfg.policySelector !== undefined) {
      this.policySelector = cfg.policySelector !== false;
      if (!this.policySelector) this.draftPolicy = undefined;
    }
    if (cfg.auth !== undefined) {
      this.authCfg = cfg.auth;
      this.authPrompted = false; // 换了鉴权配置后重新允许触发
    }
    saveConnLocal(this.name, {
      baseUrl: this.client.config.baseUrl,
      token: this.client.config.token,
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    });
    this.connState = 'unknown';
    this.notify();
    void this.probeHealth();
    void this.refreshConversations();
  }

  async probeHealth(): Promise<void> {
    this.connState = 'checking';
    this.notify();
    try {
      await this.client.health();
      this.connState = 'ok';
      this.connError = undefined;
    } catch (err) {
      this.connState = 'error';
      this.connError = err instanceof Error ? err.message : String(err);
      this.maybeHandleUnauthorized(err);
    }
    this.notify();
  }

  /** maybeHandleUnauthorized 网关判定未登录:触发配置的登录流程(幂等防抖)。 */
  private authPrompted = false;
  private maybeHandleUnauthorized(err: unknown): void {
    if (!(err instanceof GrfApiError) || !err.isUnauthorized()) return;
    if (this.authPrompted) return;
    const auth = this.authCfg;
    if (!auth) return;
    this.authPrompted = true;
    if (auth.onUnauthorized) auth.onUnauthorized(this.name);
    else if (auth.loginUrl && typeof location !== 'undefined') location.href = auth.loginUrl;
  }

  // ---------- 会话列表 ----------

  async refreshConversations(): Promise<void> {
    let list: Conversation[];
    try {
      list = await this.client.listConversations();
    } catch (err) {
      if (this.connState !== 'error') {
        this.connState = 'error';
        this.connError = err instanceof Error ? err.message : String(err);
        this.notify();
      }
      return;
    }
    if (this.connState !== 'ok') {
      this.connState = 'ok';
      this.connError = undefined;
    }
    const next = new Map<string, Conversation>();
    for (const c of list) {
      if (c.archived) continue;
      next.set(c.id, c);
    }
    this.conversations = next;

    // 索引里已不存在的会话清掉;服务器新会话补进索引(未分组)。
    let indexDirty = false;
    for (const sid of Object.keys(this.index.sessions)) {
      if (!next.has(sid)) {
        delete this.index.sessions[sid];
        indexDirty = true;
      }
    }
    for (const [sid, c] of next) {
      if (!this.index.sessions[sid]) {
        this.index.sessions[sid] = {
          projectId: UNGROUPED,
          title: `会话 ${sid.slice(0, 6)}`,
          createdAt: c.created_at,
          lastResponseId: c.last_response_id,
        };
        indexDirty = true;
      } else if (c.last_response_id) {
        const rec = this.index.sessions[sid];
        if (rec.lastResponseId !== c.last_response_id) {
          rec.lastResponseId = c.last_response_id;
          indexDirty = true;
        }
      }
    }
    if (indexDirty) this.persistIndex();

    // 运行态里的 lastResponseId 与运行标记跟服务器对齐(跨窗口/重启场景)。
    for (const [sid, rt] of this.runtimes) {
      if (!this.inflightSends.has(sid) && rt.loaded) {
        void this.syncRunningState(sid);
      }
    }
    // 会话列表就绪后补跑"恢复上次会话"(索引先到、列表后到的时序)
    this.maybeRestoreSession();
    this.notify();
  }

  async syncRunningState(sid: string): Promise<void> {
    try {
      const detail = await this.client.getConversation(sid);
      const rt = this.ensureRuntime(sid);
      rt.running = detail.running;
      // 服务器已结束而本地还有排队消息(多窗口结束/挂死自愈后):自动发出。
      if (!detail.running && !this.inflightSends.has(sid)) this.flushSendQueue(sid);
      // 会话累计统计(速度/缓存命中率)与当前访问策略(composer 圆环/策略按钮用)
      if (detail.stats) rt.stats = detail.stats;
      if (detail.policy) rt.policy = detail.policy;
      // 暂停中(等待交互):物化待答卡片(重开会话/多窗口场景)。
      if (detail.paused && !this.inflightSends.has(sid)) {
        if (detail.last_response_id) rt.lastResponseId = detail.last_response_id;
        await this.materializePaused(rt, sid);
      }
      if (detail.last_response_id) {
        // 服务器终态比本地新(流中断/多窗口/重启):按快照对账自愈。
        if (
          !this.inflightSends.has(sid) &&
          rt.lastResponseId &&
          detail.last_response_id !== rt.lastResponseId
        ) {
          await this.reconcileResponse(rt, detail.last_response_id);
        } else if (!rt.lastResponseId) {
          rt.lastResponseId = detail.last_response_id;
        }
      }
      this.notify();
    } catch {
      /* 会话可能刚归档 */
    }
  }

  // reconcileResponse 拉取某个 response 终态快照并应用到运行时。
  private async reconcileResponse(rt: SessionRuntime, respId: string): Promise<void> {
    try {
      const snap = await this.client.retrieveResponse(respId);
      if (!snap) return;
      if (applyResponseSnapshot(rt, snap)) this.notify();
    } catch {
      /* 拉不到就算了,下次轮询再试 */
    }
  }

  // ---------- 项目 ----------

  createProject(name: string, path?: string): ProjectRecord {
    const p: ProjectRecord = {
      id: genId('p'),
      name: name.trim() || '未命名项目',
      createdAt: new Date().toISOString(),
      ...(path ? { path } : {}),
    };
    this.index.projects.push(p);
    this.persistIndex();
    this.notify();
    return p;
  }

  renameProject(pid: string, name: string): void {
    const p = this.index.projects.find((x) => x.id === pid);
    if (p && name.trim()) {
      p.name = name.trim();
      this.persistIndex();
      this.notify();
    }
  }

  deleteProject(pid: string, archiveSessions: boolean): void {
    if (pid === UNGROUPED) return;
    const sids = Object.entries(this.index.sessions)
      .filter(([, s]) => s.projectId === pid)
      .map(([sid]) => sid);
    for (const sid of sids) {
      if (archiveSessions) {
        void this.archiveSession(sid, { silent: true });
      } else {
        const rec = this.index.sessions[sid];
        if (rec) {
          rec.projectId = UNGROUPED;
        }
      }
    }
    this.index.projects = this.index.projects.filter((p) => p.id !== pid);
    if (this.activeProjectId === pid) this.activeProjectId = undefined;
    this.persistIndex();
    this.notify();
  }

  updateProjectDefaults(pid: string, defaults: GrfSessionConfig | undefined): void {
    const p = this.index.projects.find((x) => x.id === pid);
    if (p) {
      p.defaults = defaults;
      this.persistIndex();
      this.notify();
    }
  }

  // ---------- 自动化操作员 ----------

  /** 新建自动化操作员:在用户主目录下建同名专属目录作工作区,落一个
   * kind:'operator' 项目并立即开出第一个会话草稿。目录名非法/创建失败
   * 时 log 提示、不落项目;非桌面态无桥可用,同样拦下。返回草稿 id。 */
  async createOperator(name: string): Promise<string | undefined> {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    let path: string;
    try {
      const dir = await ensureHomeDir(trimmed);
      if (!dir) {
        this.log('warn', '操作员仅桌面态支持(需要在主目录创建工作区)');
        return undefined;
      }
      path = dir;
    } catch (err) {
      this.log('warn', `创建操作员目录失败:${errText(err)}`);
      return undefined;
    }
    const p: ProjectRecord = {
      id: genId('op'),
      name: trimmed,
      createdAt: new Date().toISOString(),
      path,
      kind: 'operator',
    };
    this.index.projects.push(p);
    this.persistIndex();
    this.log('info', `操作员已创建:${trimmed}(${path})`);
    return this.newDraft(p.id);
  }

  /** 操作员分组列表(左栏「自动化」类别用):kind:'operator' 项目,
   * 按创建时间正序。 */
  operatorGroups(): ProjectRecord[] {
    return this.index.projects
      .filter((p) => p.kind === 'operator')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** 某操作员名下的自动化任务。 */
  automationTasksOf(operatorId: string): AutomationTask[] {
    return (this.index.automation ?? []).filter((t) => t.operatorId === operatorId);
  }

  /** 会话所属的操作员项目 id(真实 sid 与草稿 id 均可);非操作员会话
   * 返回 undefined。任务卡的保存/已保存判定用。 */
  sessionOperatorId(sid: string | undefined): string | undefined {
    if (!sid) return undefined;
    const pid = sid.startsWith('draft:')
      ? this.drafts.get(sid)?.projectId
      : this.index.sessions[sid]?.projectId;
    if (!pid) return undefined;
    return this.index.projects.find((p) => p.id === pid)?.kind === 'operator' ? pid : undefined;
  }

  /** 保存自动化任务(同一操作员内同名 upsert:改指令不增条目)。
   * 返回落库后的任务;名字/指令为空不落。 */
  saveAutomationTask(operatorId: string, name: string, instructions: string): AutomationTask | undefined {
    const n = name.trim();
    const ins = instructions.trim();
    if (!n || !ins) return undefined;
    const list = this.index.automation ?? [];
    const exist = list.find((t) => t.operatorId === operatorId && t.name === n);
    let task: AutomationTask;
    if (exist) {
      exist.instructions = ins;
      exist.updatedAt = new Date().toISOString();
      task = exist;
    } else {
      task = {
        id: genId('a'),
        operatorId,
        name: n,
        instructions: ins,
        createdAt: new Date().toISOString(),
      };
      list.push(task);
    }
    this.index.automation = list;
    this.persistIndex();
    this.log('info', `自动化任务已保存:${n}(状态浮窗可执行)`);
    this.notify();
    return task;
  }

  deleteAutomationTask(id: string): void {
    const list = this.index.automation;
    if (!list) return;
    if (!list.some((t) => t.id === id)) return;
    this.index.automation = list.filter((t) => t.id !== id);
    this.persistIndex();
    this.notify();
  }

  /** 在状态浮窗点击任务:在其所属操作员下新建执行会话(run 变体,注入
   * 执行版 prompt 继承工作区与记忆),自动发送任务指令并切换过去。 */
  runAutomationTask(id: string): void {
    const task = this.index.automation?.find((t) => t.id === id);
    if (!task) return;
    if (task.lastRunSid && this.isRunning(task.lastRunSid)) {
      this.log('info', `任务「${task.name}」正在执行中`);
      return;
    }
    const op = this.index.projects.find((p) => p.id === task.operatorId);
    if (!op) {
      this.log('warn', `任务「${task.name}」所属的操作员已删除,无法执行`);
      return;
    }
    if (!this.model && !this.activeRuntime?.model) {
      this.log('warn', '尚未选择模型:请在输入框下方「模型」中选择后再执行任务');
      return;
    }
    const startedAt = new Date().toISOString();
    const did = this.newDraft(op.id);
    this.drafts.get(did)!.variant = 'run';
    task.lastRunAt = startedAt;
    this.notify();
    void this.send(runnerMessage(task), undefined, { sid: did }).then(() => {
      // 草稿转正后的真实 sid:取该操作员下、本次执行开始后新建的会话
      // (执行会话是刚建的草稿转正,时间窗内必然唯一)。
      const hit = Object.entries(this.index.sessions)
        .filter(([, r]) => r.projectId === op.id && r.createdAt >= startedAt)
        .sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1))[0];
      if (hit) task.lastRunSid = hit[0];
      this.persistIndex();
      this.notify();
    });
  }

  toggleProjectCollapsed(pid: string): void {
    const p = this.index.projects.find((x) => x.id === pid);
    if (p) {
      p.collapsed = !p.collapsed;
      this.persistIndex();
      this.notify();
    }
  }

  moveSession(sid: string, projectId: string): void {
    const rec = this.index.sessions[sid];
    if (rec) {
      rec.projectId = projectId;
      this.persistIndex();
      this.notify();
    }
  }

  renameSession(sid: string, title: string): void {
    const rec = this.index.sessions[sid];
    if (rec && title.trim()) {
      rec.title = title.trim();
      this.persistIndex();
      this.notify();
    }
  }

  // ---------- 会话 ----------

  ensureRuntime(sid: string): SessionRuntime {
    let rt = this.runtimes.get(sid);
    if (!rt) {
      rt = newRuntime();
      this.runtimes.set(sid, rt);
    }
    rt.sid = sid; // 工具耗时本地持久化按键用
    restoreLocalUsage(rt, sid); // 前端 usage 累计回填(跨 gh 重启兜底)
    return rt;
  }

  sessionTitle(sid: string): string {
    if (sid.startsWith('draft:')) return '新会话';
    return this.index.sessions[sid]?.title ?? `会话 ${sid.slice(0, 6)}`;
  }

  newDraft(projectId: string): string {
    const did = `draft:${genId('d')}`;
    this.drafts.set(did, { projectId });
    this.runtimes.set(did, newRuntime());
    const rt = this.runtimes.get(did)!;
    rt.loaded = true; // 草稿无需加载历史
    this.inheritProjectPrefs(projectId);
    this.activeSessionId = did;
    this.activeProjectId = projectId;
    this.notify();
    return did;
  }

  /** 新会话继承偏好:模型与思考强度优先取同项目最近一次会话的取值;
   * 该项目尚无记录时回落到全部项目里最近一次对话的会话(新开项目沿用
   * 用户最近在用的模型)。都没有时:模型保持当前值(localStorage 里上次
   * 的选择,无选择由发送守卫引导),思考强度回落默认高。
   * 写回 scope 级配置,composer 即时显示。 */
  private inheritProjectPrefs(projectId: string): void {
    const withModel = Object.values(this.index.sessions).filter((r) => r.model || r.effort !== undefined);
    const inProject = withModel.filter((r) => r.projectId === projectId);
    const latest = (inProject.length ? inProject : withModel)
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))[0];
    if (!latest) {
      this.reasoningEffort = this.reasoningEffort ?? 'high';
      return;
    }
    if (latest.model !== undefined) this.model = fullModelName(latest.model);
    // effort 空串 = 旧版本记录未选(现恒有值),视同无可继承回落默认高
    this.reasoningEffort = latest.effort !== undefined ? latest.effort || 'high' : this.reasoningEffort ?? 'high';
    saveConnLocal(this.name, {
      baseUrl: this.client.config.baseUrl,
      token: this.client.config.token,
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    });
  }

  selectSession(sid: string): void {
    this.activeSessionId = sid;
    const rec = this.index.sessions[sid];
    if (rec) this.activeProjectId = rec.projectId;
    if (!sid.startsWith('draft:')) {
      this.index.lastActiveSessionId = sid; // 记住上次所在会话(启动恢复用)
      this.markSessionSeen(sid);
      this.persistIndex(); // markSessionSeen 同值时跳过,这里保证落盘
      void this.loadHistoryIfNeeded(sid);
      void this.syncRunningState(sid);
    }
    this.notify();
    this.emitDom('grf:session-selected', { sessionId: sid });
  }

  async loadHistoryIfNeeded(sid: string): Promise<void> {
    const rt = this.ensureRuntime(sid);
    if (rt.loaded) return;
    rt.loaded = true;
    try {
      const hist = await this.client.conversationItems(sid);
      // 已有 live 物品的会话(本进程刚聊过)不重放历史。
      if (rt.items.length === 0) {
        rt.items = historyToItems(hist);
        // 回填本地记录的工具耗时(线格式历史不带时间戳,见 chat-model)
        applySavedDurs(sid, rt.items);
        // 回填任务列表(从最后一个 todo_write 调用还原;详情栏/状态浮窗用)
        rt.todos = todosFromItems(rt.items);
        // 回填当前目标(按序重放 goal 工具调用;状态浮窗「目标」区块用)
        rt.goal = goalFromItems(rt.items);
        // 恢复暂停卡片:从最新终态 response 拿 grf_requests。
        // 打开会话时 rt.lastResponseId 可能尚未同步(与 syncRunningState
        // 竞态),用索引里记录的 lastResponseId 兜底,保证暂停态可恢复。
        const rid = rt.lastResponseId ?? this.index.sessions[sid]?.lastResponseId;
        if (rid) {
          rt.lastResponseId = rid;
          await this.materializePaused(rt, sid);
        }
      }
    } catch (err) {
      rt.loaded = false;
      this.log('warn', `加载会话历史失败:${errText(err)}`);
    }
    this.notify();
  }

  /** 截图类工具的图片不随 SSE 下发(只在会话历史的工具消息 image_url part
   * 里):回合结束后从服务端补取一次,按 call_id 回填到工具卡。已有图片的
   * 卡不覆盖,避免重复传输大 base64;失败静默——截图展示是增强能力。 */
  private async attachScreenshotImages(rt: SessionRuntime, sid: string): Promise<void> {
    const missing = rt.items.some(
      (i) => i.kind === 'tool' && isScreenshotTool(i.name) && !i.images && i.callId,
    );
    if (!missing) return;
    try {
      const hist = await this.client.conversationItems(sid);
      // gh server 对截图工具的结果有两种记录形态:role=tool(文本),或
      // "[tool result: <名>]" 的 user 消息(带 image_url part,截图走这条)。
      // live 工具卡有 callId 但历史不带,对不上 —— 改按"名字 + 先来先配"
      // 的顺序回填。
      const byCall = new Map<string, string[]>();
      const byName: { name: string; urls: string[] }[] = [];
      for (const msg of hist) {
        if (msg.role === 'tool' && msg.tool_call_id) {
          const text = textOfContent(msg.content);
          const urls = Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'image_url' && p.image_url?.url)
                .map((p) => p.image_url!.url)
            : [];
          const fallback = [...imagesOfOutput(text), ...shotUrlsOfFile(text)];
          if (urls.length || fallback.length) byCall.set(msg.tool_call_id, urls.length ? urls : fallback);
          continue;
        }
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const text = textOfContent(msg.content);
          const tr = text.match(/^\[tool result: ([^\]]+)\]/);
          if (!tr) continue;
          const urls = msg.content
            .filter((p) => p.type === 'image_url' && p.image_url?.url)
            .map((p) => p.image_url!.url);
          if (urls.length) byName.push({ name: tr[1], urls });
        }
      }
      let changed = false;
      // 按名顺序配对:每张同名截图卡都占一个队列位置(已有图片的跳过但
      // 也占位),否则全量重建队列后,后来的截图会配到最早的图(全部错位
      // 成同一张)。
      const seqNo = new Map<string, number>();
      rt.items = rt.items.map((i) => {
        if (i.kind !== 'tool' || !isScreenshotTool(i.name)) return i;
        const idx = seqNo.get(i.name) ?? 0;
        seqNo.set(i.name, idx + 1);
        if (i.images) return i;
        const byId = byCall.get(i.callId);
        const imgs = byId?.length ? byId : byName.filter((b) => b.name === i.name)[idx]?.urls;
        if (!imgs?.length) return i;
        changed = true;
        return { ...i, images: imgs };
      });
      if (changed) this.notify();
    } catch {
      /* 补取失败忽略 */
    }
  }

  private async materializePaused(rt: SessionRuntime, sid: string): Promise<void> {
    if (!rt.lastResponseId) return;
    try {
      const snap = await this.client.retrieveResponse(rt.lastResponseId);
      // 线格式历史不带 usage/model:从终态快照回填(composer 用量统计/详情栏)。
      if (snap?.usage) rt.usage = snap.usage;
      if (snap?.model) rt.model = snap.model;
      if (snap?.status === 'incomplete' && snap.incomplete_details?.reason === 'grf:input_required') {
        rt.pendingRequests = snap.incomplete_details.grf_requests ?? [];
        for (const req of rt.pendingRequests) {
          const exists = rt.items.find(
            (i) => (i.kind === 'ask' || i.kind === 'approval') && i.callId === req.call_id,
          );
          if (!exists) materializeRequest(rt, req);
        }
      }
    } catch {
      /* 探测失败忽略 */
    }
  }

  async archiveSession(sid: string, opts?: { silent?: boolean }): Promise<void> {
    try {
      await this.client.archiveConversation(sid);
    } catch (err) {
      if (!opts?.silent) this.log('warn', `归档失败:${errText(err)}`);
    }
    delete this.index.sessions[sid];
    this.runtimes.delete(sid);
    this.sendQueues.delete(sid);
    forgetUsage(sid); // 前端 usage 累计随会话清理
    if (this.index.lastActiveSessionId === sid) this.index.lastActiveSessionId = undefined;
    if (this.activeSessionId === sid) this.activeSessionId = undefined;
    this.persistIndex();
    await this.refreshConversations();
    this.emitDom('grf:session-archived', { sessionId: sid });
  }

  // ---------- 发送 ----------

  get activeRuntime(): SessionRuntime | undefined {
    return this.activeSessionId ? this.runtimes.get(this.activeSessionId) : undefined;
  }

  isRunning(sid: string): boolean {
    const rt = this.runtimes.get(sid);
    return !!rt?.running || this.inflightSends.has(sid);
  }

  /** 当前项目的本地目录路径(桌面态新建项目时选择;web 项目可能没有)。 */
  activeProjectPath(): string | undefined {
    return this.index.projects.find((p) => p.id === this.activeProjectId)?.path;
  }

  // ---------- 未读(等待用户查看) ----------

  /** 标记会话已查看:记录查看时刻的 lastResponseId 基线。 */
  markSessionSeen(sid: string): void {
    const rec = this.index.sessions[sid];
    if (!rec) return;
    const rid = rec.lastResponseId ?? '';
    if (rec.lastSeenResponseId !== rid) {
      rec.lastSeenResponseId = rid;
      this.persistIndex();
    }
  }

  /**
   * 会话是否"等待用户查看":有未查看的新完成回合,或等待用户输入
   * (ask/审批)。当前选中的会话不算(用户正看着);运行中不算。
   */
  needsAttention(sid: string): boolean {
    if (sid === this.activeSessionId) return false;
    if (this.isRunning(sid)) return false;
    const rt = this.runtimes.get(sid);
    if ((rt?.pendingRequests.length ?? 0) > 0) return true;
    const rec = this.index.sessions[sid];
    if (!rec?.lastResponseId) return false;
    return rec.lastResponseId !== (rec.lastSeenResponseId ?? '');
  }

  // requestWithRetry 针对"上游 vLLM 未开启工具调用"的瞬时 400 做有限重试:
  // 上游网关按后端负载均衡,部分后端没带 --enable-auto-tool-choice,重发通常
  // 会落到正常后端。该失败发生在生成之前(终态无输出),重发无副作用;重试
  // 前清掉这次失败物化的错误条目。超过上限仍失败则原样返回,由调用方展示。
  private async requestWithRetry(rt: SessionRuntime, sid: string, opts: SendOptions): Promise<ResponseResource> {
    const max = 3;
    for (let attempt = 0; ; attempt++) {
      const final = await this.sendWithStreamRetry(rt, sid, opts);
      const msg = final.error?.message ?? '';
      if (
        final.status !== 'failed' ||
        (final.output?.length ?? 0) > 0 ||
        attempt >= max ||
        !isToolChoiceUnsupported(msg)
      ) {
        return final;
      }
      rt.items = rt.items.filter(
        (i) => !(i.kind === 'error' && isToolChoiceUnsupported(i.text)),
      );
      this.log('warn', `模型服务瞬时不可用(后端未开启工具调用),自动重试 ${attempt + 1}/${max}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // sendWithStreamRetry 连接层自愈,两类输入都覆盖:
  //  1. 浏览器侧 fetch 抛错(事件流中断/静默断流/网络失败);
  //  2. SSE 流正常结束但终态是 failed 且错误为连接类(如 gh 报
  //     "llm: read stream: unexpected EOF" / "context deadline exceeded")。
  // 先尝试从服务器终态对账(回合其实已完成或已暂停的情况直接拿快照),
  // 否则退避后原样重发,最多 STREAM_RETRY_MAX 次;用户主动取消不重试。
  // 重发可能造成模型重复生成,但比把会话卡死可取——服务端按会话串行,
  // 幂等性由 lastResponseId 链保证。
  private async sendWithStreamRetry(rt: SessionRuntime, sid: string, opts: SendOptions): Promise<ResponseResource> {
    let sendOpts = opts;
    for (let attempt = 0; ; attempt++) {
      let final: ResponseResource | null = null;
      try {
        final = await this.client.send(sendOpts);
      } catch (err) {
        if (opts.signal?.aborted || attempt >= STREAM_RETRY_MAX || !isRetryableStreamError(err)) throw err;
        this.log('warn', `连接中断(${errText(err)}),自动重试 ${attempt + 1}/${STREAM_RETRY_MAX}`);
        // 服务器可能已受理并完成该回合:拿终态快照直接用,不盲目重发。
        const snapped = await this.tryRecoverFinal(rt, sid);
        if (snapped) {
          this.log('info', '已从服务器终态恢复回合(连接中断重试期间)');
          return snapped;
        }
        await new Promise((r) => setTimeout(r, Math.min(800 * (attempt + 1), 4000)));
        continue;
      }
      // failed 终态且为连接类错误:清掉本次物化的错误条目,挂到失败
      // response 之后重发一次(不挂链会分叉出新会话)。
      const failMsg = final.error?.message ?? '';
      if (
        final.status === 'failed' &&
        isRetryableStreamFailure(failMsg) &&
        !opts.signal?.aborted &&
        attempt < STREAM_RETRY_MAX
      ) {
        this.log('warn', `上游连接错误(${friendlyError(failMsg)}),自动重试 ${attempt + 1}/${STREAM_RETRY_MAX}`);
        rt.items = rt.items.filter(
          (i) => !(i.kind === 'error' && isRetryableStreamFailure(i.text.replace(/^(发送|应答)失败:/, ''))),
        );
        if (final.id) sendOpts = { ...sendOpts, previousResponseId: final.id };
        await new Promise((r) => setTimeout(r, Math.min(800 * (attempt + 1), 4000)));
        continue;
      }
      return final;
    }
  }

  // tryRecoverFinal 查会话终态:服务器已推进到本地未见过的 response 且已到
  // 终态,则对账并返回该快照(作为本轮 send 的结果);否则返回 null。
  private async tryRecoverFinal(rt: SessionRuntime, sid: string): Promise<ResponseResource | null> {
    try {
      const detail = await this.client.getConversation(sid);
      const last = detail.last_response_id;
      if (!last || last === rt.lastResponseId) return null;
      const snap = await this.client.retrieveResponse(last);
      if (!snap) return null;
      const status = snap.status;
      if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'incomplete') {
        return null; // 仍在跑:对账无意义,等退避后重发
      }
      if (applyResponseSnapshot(rt, snap)) this.notify();
      return snap;
    } catch {
      return null;
    }
  }

  async send(
    text: string,
    images?: string[],
    opts?: {
      editOf?: string;
      sid?: string;
      /** 会话恢复:随本次输入一起下发的 function_call_output(解锁"暂停
       * 等待交互"的卡死会话;由 paused 错误的自动修复路径填充) */
      resumeCallOutputs?: { call_id: string; output: string }[];
    },
  ): Promise<void> {
    let sid = opts?.sid ?? this.activeSessionId;
    if (!sid) {
      // 无激活会话时直接发送不再静默丢弃:自动落一个草稿(当前项目,
      // 未选则未分组)接住输入,随首条消息转正为真实会话。
      if (!text.trim() && !images?.length) return;
      sid = this.newDraft(this.activeProjectId || UNGROUPED);
    }
    const rt = this.ensureRuntime(sid);
    if (this.inflightSends.has(sid) || rt.running) {
      // 回合进行中:入队等本回合结束自动发出,不打断也不丢弃。
      this.enqueueSend(sid, text, images);
      return;
    }
    const trimmed = text.trim();
    // 恢复请求:只含 function_call_output、不带用户消息(gh server 对暂停
    // 会话只接受纯 resume 输入);先解锁,原消息随后经发送队列重发。
    const resumeOnly = !trimmed && !images?.length && !!opts?.resumeCallOutputs?.length;
    if (!trimmed && !images?.length && !resumeOnly) return;

    // 暂停中的提问被新输入顶掉:卡片标记失效,避免遗留 stale 的
    // input_result(服务端会拒:回合已不在暂停态)。
    if (rt.pendingRequests.length > 0 && !resumeOnly) {
      for (const req of rt.pendingRequests) markRequestAnswered(rt, req.call_id, { dismiss: true });
      this.log('info', '已放弃未应答的提问,按新输入继续');
    }

    // 编辑重发:本地视图截断到被编辑消息之前,并取服务端历史同位置
    // 前缀随请求下发(grf:history),服务端校验后替换历史。
    let grfHistory: HistMessage[] | undefined;
    if (opts?.editOf && !sid.startsWith('draft:')) {
      const idx = rt.items.findIndex((i) => i.id === opts.editOf);
      if (idx >= 0) {
        try {
          const hist = await this.client.conversationItems(sid);
          // 被编辑消息 = 视图里第 nth 条用户消息 → 截到服务端历史同一条之前
          let nth = 0;
          for (let i = 0; i < idx; i++) if (rt.items[i].kind === 'user') nth++;
          let seen = 0;
          let cut = hist.length;
          for (let i = 0; i < hist.length; i++) {
            if (hist[i].role === 'user') {
              if (seen === nth) {
                cut = i;
                break;
              }
              seen++;
            }
          }
          grfHistory = hist.slice(0, cut);
          rt.items = rt.items.slice(0, idx);
        } catch {
          grfHistory = undefined;
          this.log('warn', '读取会话历史失败,本次编辑重发退化为追加发送');
        }
      }
    }

    const parts: InputItem = {
      type: 'message',
      role: 'user',
      content: [
        ...(trimmed ? [{ type: 'input_text', text: trimmed }] : []),
        ...(images ?? []).map((u) => ({ type: 'input_image', image_url: u })),
      ],
    };

    // 发送时才把用户条目放进视图(排队中的消息显示在输入框上方,不进消息流)
    const localUserId = genId('u');
    if (!resumeOnly) {
      rt.items.push({
        kind: 'user',
        id: localUserId,
        text: trimmed,
        images: images?.length ? images : undefined,
      });
    }
    rt.running = true;
    rt.error = undefined;
    this.notify();

    // 草稿 → 真实会话:首条消息落定标题与项目归属。
    let realSid = sid;
    const isDraft = sid.startsWith('draft:');
    const draftInfo = isDraft ? this.drafts.get(sid) : undefined;
    const projectId = isDraft ? (draftInfo?.projectId ?? UNGROUPED) : this.index.sessions[sid]?.projectId;
    const draftProject = this.index.projects.find((p) => p.id === projectId);
    const previous = isDraft ? undefined : rt.lastResponseId ?? this.index.sessions[sid]?.lastResponseId;
    // 首条消息携带 grf:session:项目默认配置 + 工作区(项目根目录,
    // 让 agent 的文件/终端工具直接落在项目里;未选工作区时默认用户
    // 主目录 —— 直接聊天不必先建项目)。
    // composer 的策略选择(draftPolicy)优先于项目默认。
    // 操作员项目额外注入操作员/执行版 system_prompt(放最后,覆盖
    // defaults 里的同名字段)。
    const grfSession = isDraft
      ? {
          workspace: draftProject?.path || this.homeDir || undefined,
          ...draftProject?.defaults,
          ...(this.draftPolicy ? { policy: this.draftPolicy } : {}),
          ...(draftProject?.kind === 'operator'
            ? {
                system_prompt:
                  draftInfo?.variant === 'run'
                    ? runnerSystemPrompt()
                    : operatorSystemPrompt(this.automationTasksOf(draftProject.id)),
              }
            : {}),
        }
      : undefined;

    const ac = new AbortController();
    this.inflightSends.add(sid);
    this.activeAborts.set(sid, ac);
    this.streamDoneAt.delete(sid);
    let migrated = false;
    const migrate = (newSid: string) => {
      if (migrated || !isDraft) return;
      migrated = true;
      realSid = newSid;
      this.drafts.delete(sid);
      this.runtimes.delete(sid);
      this.runtimes.set(newSid, rt);
      // 排队消息跟随迁移(入队时用的还是草稿 id 的极端竞态)
      const queued = this.sendQueues.get(sid);
      if (queued) {
        this.sendQueues.set(newSid, queued);
        this.sendQueues.delete(sid);
      }
      this.index.sessions[newSid] = {
        projectId,
        title: deriveTitle(trimmed),
        createdAt: new Date().toISOString(),
        lastResponseId: undefined,
      };
      this.activeSessionId = newSid;
      this.index.lastActiveSessionId = newSid; // 草稿转正:接管"上次会话"
      this.persistIndex();
    };

    const onEvent = (ev: SSEEvent) => {
      this.logEvent(ev);
      const sidFromEvent = ev.response?.['grf:session_id'];
      if (sidFromEvent) migrate(sidFromEvent);
      const changed = applyEvent(rt, ev);
      if (changed) this.notify();
      // 截图类工具完成即回填图片:SSE 不带 base64,但工具结果已即时写入
      // 服务端内存历史(conversationItems 实时可读),不用等整回合结束。
      const toolName = ev.item?.name ?? ev.kind;
      if (ev.type === 'grf:tool_call.completed' && toolName && isScreenshotTool(toolName)) {
        const target = realSid;
        setTimeout(() => void this.attachScreenshotImages(rt, target), 150);
      }
    };

    try {
    const resumeInputs: InputItem[] = (opts?.resumeCallOutputs ?? []).map((o) => ({
      type: 'function_call_output',
      call_id: o.call_id,
      output: o.output,
    }));
    // 恢复请求的 previous 必须是服务端当前链尾(可能比本地记录新)。
    let previousFinal = previous;
    if (resumeOnly) {
      const d = await this.client.getConversation(realSid).catch(() => null);
      if (d?.last_response_id) previousFinal = d.last_response_id;
    }

    const final = await this.requestWithRetry(rt, realSid, {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      // 恢复请求只含 function_call_output(暂停会话拒绝混入用户消息)。
      input: resumeOnly ? resumeInputs : [parts],
        previousResponseId: previousFinal,
        grfSession: isDraft ? grfSession : undefined,
        grfHistory,
        signal: ac.signal,
        onEvent,
      });
      if (final['grf:session_id']) migrate(final['grf:session_id']);
      rt.lastResponseId = final.id;
      const rec = this.index.sessions[realSid];
      if (rec) {
        rec.lastResponseId = final.id;
        rec.updatedAt = new Date().toISOString();
        // 记录本会话最后使用的模型/思考强度,新会话按同项目最近会话继承。
        // 模型必须记请求时下发的全名(provider/model):服务端回报的
        // final.model 是裸名,裸名再下发会被 gh 的 trySwitchModel 忽略、
        // 静默回落服务端默认,继承就形同虚设。本端未选模型时记空串,
        // 新会话继承为"未选"、继续走服务端默认,与原会话语义一致。
        rec.model = this.model ?? '';
        rec.effort = this.reasoningEffort ?? '';
        this.persistIndex();
      }
      // 用户仍停在该会话:完成即视为已查看;已切走则保留未读标记。
      if (this.activeSessionId === realSid) this.markSessionSeen(realSid);
    } catch (err) {
      // 会话卡死自愈:服务端判定"暂停等待交互"(getConversation paused=true)
      // 但本 UI 没有任何可应答卡片 —— 典型是 App 重启丢掉了进行中客户端
      // 工具调用的结果。两阶段修复:先发一条只含 function_call_output 的
      // 恢复请求(服务端据此续跑暂停的回合),再经发送队列重发原消息。
      // 每会话只自动修一次,避免把真实的新暂停(提问/审批)吞掉。
      if (
        err instanceof GrfApiError &&
        /paused awaiting interaction/i.test(err.message) &&
        !opts?.resumeCallOutputs &&
        !this.pauseRepaired.has(realSid)
      ) {
        const detail = await this.client.getConversation(realSid).catch(() => null);
        if (detail?.paused) {
          const ids = await this.danglingToolCallIds(realSid);
          if (ids.length) {
            this.pauseRepaired.add(realSid);
            this.log('warn', `会话暂停且有 ${ids.length} 个未闭合工具调用,自动补结果解锁`);
            rt.items = rt.items.filter((i) => i.id !== localUserId);
            this.enqueueSend(realSid, '', undefined, [
              ...ids.map((call_id) => ({
                call_id,
                output: '[error] 会话恢复:该工具调用未能在上次会话中完成,已跳过。',
              })),
            ]);
            this.enqueueSend(realSid, text, images);
            return;
          }
        }
      }
      const watchdog = this.watchdogHits.has(realSid) || this.watchdogHits.has(sid);
      this.watchdogHits.delete(sid);
      this.watchdogHits.delete(realSid);
      if (ac.signal.aborted && !watchdog) {
        rt.items.push({ kind: 'status', id: genId('s'), text: '已请求中断…' });
      } else {
        rt.error = errText(err);
        this.maybeHandleUnauthorized(err);
        this.log('error', `发送失败:${errText(err)}`);
        // 中途断流:请求可能已被服务端受理,按会话终态对账自愈,不盲报错。
        const recovered = await this.recoverAfterStreamBreak(realSid, rt);
        if (!recovered) {
          rt.items.push({ kind: 'error', id: genId('e'), text: `发送失败:${friendlyError(errText(err))}` });
        }
      }
      // 历史前缀被服务端拒绝(多窗口并发改写等):视图已本地截断,
      // 重新拉取服务器历史对齐。
      if (err instanceof GrfApiError && /grf:history/.test(err.message)) {
        await this.loadHistoryFresh(realSid);
      }
    } finally {
      this.inflightSends.delete(sid);
      this.inflightSends.delete(realSid);
      this.activeAborts.delete(sid);
      this.activeAborts.delete(realSid);
      this.streamDoneAt.delete(sid);
      this.streamDoneAt.delete(realSid);
      rt.running = false;
      // 流结束后短暂等待服务器落定,再同步一次状态。
      setTimeout(() => {
        void this.syncRunningState(realSid);
        this.flushSendQueue(realSid);
        void this.attachScreenshotImages(rt, realSid);
      }, 300);
      this.notify();
    }
  }

  // ---------- 发送队列(回合运行中的输入排队,结束后自动发出) ----------

  /** 入队:消息显示在输入框上方的排队区(composer 渲染),回合结束后按 FIFO 发出。 */
  private enqueueSend(
    sid: string,
    text: string,
    images?: string[],
    resumeCallOutputs?: { call_id: string; output: string }[],
  ): void {
    const trimmed = text.trim();
    if (!trimmed && !images?.length && !resumeCallOutputs?.length) return;
    const q = this.sendQueues.get(sid) ?? [];
    q.push({ text: trimmed, images, resumeCallOutputs });
    this.sendQueues.set(sid, q);
    this.log('info', `会话运行中,消息已排队(第 ${q.length} 条),回合结束后自动发送`);
    this.notify();
  }

  /** 排队中的消息(composer 输入框上方排队区用)。 */
  queuedSends(sid: string): { text: string; images?: string[] }[] {
    return this.sendQueues.get(sid) ?? [];
  }

  /** 删除一条排队消息(发送前用户可撤销);返回被删的消息或 null。 */
  removeQueuedSend(sid: string, index: number): { text: string; images?: string[] } | null {
    const q = this.sendQueues.get(sid);
    if (!q || index < 0 || index >= q.length) return null;
    const [removed] = q.splice(index, 1);
    if (!q.length) this.sendQueues.delete(sid);
    this.notify();
    return removed ?? null;
  }

  /** 出队一条并发送;无队列或会话仍在跑时跳过(finally 路径串行调用)。 */
  private flushSendQueue(sid: string): void {
    const q = this.sendQueues.get(sid);
    if (!q?.length) return;
    if (sid.startsWith('draft:')) return; // 草稿不会是运行态,防御
    const rt = this.runtimes.get(sid);
    if (!rt || this.inflightSends.has(sid) || rt.running) return;
    const { text, images, resumeCallOutputs } = q.shift()!;
    if (!q.length) this.sendQueues.delete(sid);
    // 发出时才进消息流视图;sid 指定目标会话,切走后仍按原会话发出
    void this.send(text, images, { sid, resumeCallOutputs });
  }

  // recoverAfterStreamBreak 断流自愈:查会话终态,若服务器已推进到更新的
  // response,用快照对账(含暂停卡片);返回是否恢复成功。
  private async recoverAfterStreamBreak(sid: string, rt: SessionRuntime): Promise<boolean> {
    try {
      const detail = await this.client.getConversation(sid);
      const last = detail.last_response_id;
      if (last && last !== rt.lastResponseId) {
        await this.reconcileResponse(rt, last);
        this.log('info', '已从服务器终态恢复回合(流中断)');
        return true;
      }
      if (last && last === rt.lastResponseId) {
        // 服务器没有产生新 response(请求被拒,如会话暂停等待交互):不能
        // 整帧重放旧快照 —— 会把历史里已有的输出再复制成新条目。只在确有
        // 暂停的交互请求时恢复 ask/审批卡片,并返回 false 让真实错误展示。
        const snap = await this.client.retrieveResponse(last);
        if (snap?.status === 'incomplete' && snap.incomplete_details?.reason === 'grf:input_required') {
          rt.pendingRequests = snap.incomplete_details.grf_requests ?? [];
          let changed = false;
          for (const req of rt.pendingRequests) changed = materializeRequest(rt, req) || changed;
          if (changed) this.notify();
        }
        return false;
      }
    } catch {
      /* 恢复失败走原错误展示 */
    }
    return false;
  }

  // danglingToolCallIds 镜像 gh server 的暂停判定(agent/history.go
  // pausedCalls):只看最后一条带 tool_calls 的 assistant 消息,且只认
  // role=tool 的结果闭合(截图类 "[tool result]" 伪 user 消息不闭合)。
  // 返回未闭合调用的 id,供 function_call_output 补结果解锁。
  private async danglingToolCallIds(sid: string): Promise<string[]> {
    try {
      const hist = await this.client.conversationItems(sid);
      let calls: { id: string }[] = [];
      for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (m.role === 'assistant' && m.tool_calls?.length) {
          calls = m.tool_calls.map((tc) => ({ id: tc.id }));
          for (let j = i + 1; j < hist.length; j++) {
            const r = hist[j];
            if (r.role === 'tool' && r.tool_call_id) {
              calls = calls.filter((c) => c.id !== r.tool_call_id);
            }
          }
          break;
        }
      }
      return calls.map((c) => c.id);
    } catch {
      return [];
    }
  }

  async answerAsk(callId: string, answers: Record<string, unknown>): Promise<void> {
    await this.submitInputResult(callId, { answers });
  }

  async dismissAsk(callId: string): Promise<void> {
    await this.submitInputResult(callId, { dismiss: true });
  }

  async answerApproval(callId: string, approved: boolean, feedback?: string): Promise<void> {
    await this.submitInputResult(callId, { approved, feedback });
  }

  private async submitInputResult(
    callId: string,
    payload: { answers?: Record<string, unknown>; approved?: boolean; feedback?: string; dismiss?: boolean },
  ): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid || sid.startsWith('draft:')) return;
    const rt = this.ensureRuntime(sid);
    if (this.inflightSends.has(sid) || rt.running) return;
    markRequestAnswered(rt, callId, payload);
    rt.running = true;
    this.notify();
    this.inflightSends.add(sid);
    const ac = new AbortController();
    this.activeAborts.set(sid, ac);
    this.streamDoneAt.delete(sid);
    const input: InputItem = { type: 'grf:input_result', call_id: callId, ...payload };
    try {
      const final = await this.requestWithRetry(rt, sid, {
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        input: [input],
        previousResponseId: rt.lastResponseId ?? this.index.sessions[sid]?.lastResponseId,
        signal: ac.signal,
        onEvent: (ev) => {
          this.logEvent(ev);
          if (applyEvent(rt, ev)) this.notify();
        },
      });
      rt.lastResponseId = final.id;
      const rec = this.index.sessions[sid];
      if (rec) {
        rec.lastResponseId = final.id;
        // 同 send():只记请求全名,不记服务端回报的裸名(见上文说明)。
        rec.model = this.model ?? rec.model;
        rec.effort = this.reasoningEffort ?? '';
        this.persistIndex();
      }
      if (this.activeSessionId === sid) this.markSessionSeen(sid);
    } catch (err) {
      const watchdog = this.watchdogHits.has(sid);
      this.watchdogHits.delete(sid);
      const msg = errText(err);
      if (/no paused tool calls/i.test(msg)) {
        // 回合已不在暂停态(被新输入顶掉/多窗口已应答):静默收尾,
        // 不再报错——卡片已标记为已应答。
        rt.pendingRequests = [];
        this.log('warn', '提问已失效(回合不在暂停态),已忽略');
      } else {
        this.log('error', `应答失败:${msg}`);
        const recovered = watchdog ? await this.recoverAfterStreamBreak(sid, rt) : false;
        if (!recovered && !ac.signal.aborted) {
          rt.items.push({ kind: 'error', id: genId('e'), text: `应答失败:${msg}` });
        }
      }
    } finally {
      this.inflightSends.delete(sid);
      this.activeAborts.delete(sid);
      this.streamDoneAt.delete(sid);
      rt.running = false;
      setTimeout(() => {
        void this.syncRunningState(sid);
        this.flushSendQueue(sid);
        void this.attachScreenshotImages(rt, sid);
      }, 300);
      this.notify();
    }
  }

  async cancelActive(): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid || sid.startsWith('draft:')) return;
    const rt = this.ensureRuntime(sid);
    // 回合进行中 lastResponseId 还停留在上一回合(当前回合的 id 要等回合
    // 结束才写入),直接用它取消的是已结束的旧 response——表现为点停止
    // 没反应。运行中优先用当前流的 response id(curRespId,SSE 事件随到
    // 随记);流刚建立还没有 id 时,先掐断本地流让 UI 收口,等下一次
    // tick 探测到服务器终态再对账。
    let respId = rt.lastResponseId;
    if (this.inflightSends.has(sid)) {
      respId = rt.curRespId ?? rt.lastResponseId;
      if (!respId) {
        this.log('info', '回合尚未建立,已中断本地事件流');
        this.activeAborts.get(sid)?.abort();
        return;
      }
    }
    if (!respId) return;
    try {
      await this.client.cancelResponse(respId);
      this.log('info', '已发送中断请求');
    } catch (err) {
      // 404 = 回合已结束或蒸发,视为成功。
      if (err instanceof GrfApiError && err.status === 404) return;
      this.log('warn', `中断失败:${errText(err)}`);
    }
  }

  async compactActive(): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid || sid.startsWith('draft:')) return;
    const rt = this.ensureRuntime(sid);
    const respId = rt.lastResponseId;
    if (!respId) {
      this.log('warn', '会话尚无回合,无法压缩');
      return;
    }
    // 压缩模型同样必须全名:rt.model 是服务端回报的裸名,直接下发会被 gh
    // 的 trySwitchModel 忽略。本端已选模型优先;未选时补全会话实际模型
    // (九天式自带 / 的裸名补不出、原样下发被忽略,gh 沿用会话当前模型,
    // 行为不劣于旧版)。
    const model = this.model ?? fullModelName(rt.model ?? '');
    if (!model) {
      this.log('warn', '压缩需要先选择模型(输入框下方「模型」)');
      return;
    }
    try {
      await this.client.compact(model, respId);
      rt.items.push({ kind: 'status', id: genId('s'), text: '上下文已压缩' });
      await this.loadHistoryFresh(sid);
      this.notify();
    } catch (err) {
      this.log('error', `压缩失败:${errText(err)}`);
    }
  }

  async loadHistoryFresh(sid: string): Promise<void> {
    const rt = this.ensureRuntime(sid);
    rt.items = [];
    rt.loaded = false;
    await this.loadHistoryIfNeeded(sid);
  }

  // ---------- 控制台 ----------

  log(level: ConsoleEntry['level'], text: string): void {
    if (this.consolePaused) return;
    this.console.push({ ts: Date.now(), level, text });
    if (this.console.length > this.consoleMax) this.console.splice(0, this.console.length - this.consoleMax);
    this.notify();
  }

  private logEvent(ev: SSEEvent): void {
    let text = ev.type;
    if (ev.type === 'grf:notice') text = `notice:${ev.kind} ${ev.detail ?? ''}`;
    else if (ev.type.startsWith('grf:tool_call') && ev.item?.name) {
      text = `${ev.type} ${ev.item.name}(${(ev.item.call_id ?? '').slice(0, 10)})`;
    } else if (ev.type === 'response.output_text.delta') return; // 高频噪声不入日志
    else if (ev.type === 'response.output_item.added' && ev.item) {
      text = `item+ ${ev.item.type}${ev.item.name ? ` ${ev.item.name}` : ''}`;
    }
    this.log('event', text);
  }

  clearConsole(): void {
    this.console = [];
    this.notify();
  }

  // ---------- DOM 事件(嵌入宿主监听用) ----------

  private emitDom(type: string, detail: unknown): void {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail, composed: true, bubbles: true }));
    }
  }
}

function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 42 ? `${t.slice(0, 42)}…` : t || '新会话';
}

// ---------- 裸模型名补全 ----------

// 旧索引记录里的 model 可能是裸名(服务端回报不带 provider 前缀的历史
// 遗留)。裸名作为请求模型下发会被 gh 的 trySwitchModel 忽略,继承时须
// 补全成 "provider/model" 全名;补全需要供应商列表,由设置层注入解析器
// (store 层不反向依赖 settings,避免循环依赖)。
let resolveBareModel: ((bare: string) => string | undefined) | undefined;

/** 注册裸模型名补全器(settings 层注入;按 providers 的模型表匹配)。 */
export function setModelNameResolver(fn: (bare: string) => string | undefined): void {
  resolveBareModel = fn;
}

/** 归一为可下发的模型全名:含 "/" 视为已带 provider 前缀原样返回(来源
 * 限于 UI 全名菜单、gh default、本端持久化,可信);纯裸名尝试按供应商表
 * 补全,补不出返回 undefined(视同未选模型,走服务端默认 —— 强于留一个
 * 显示与实际不符、发送时被服务端静默忽略的值)。
 * 已知局限:九天等供应商的模型名自带 /(如 qwen/qwen3.8-27b),其裸名
 * 回报也含 /、会被当作全名原样放行 —— 下发后 gh 按 provider=qwen 解析
 * 失败而忽略,沿用会话当前模型(行为不劣化,仅"换模型压缩"不生效)。 */
function fullModelName(m: string | undefined): string | undefined {
  if (!m) return undefined;
  if (m.includes('/')) return m;
  return resolveBareModel?.(m);
}

/** 流断连自动重试上限(事件流中断/静默超时/网络错误)。 */
const STREAM_RETRY_MAX = 10;

/** 可重试的连接类错误:事件流中断、流静默超时、网络层失败(fetch 抛 TypeError)。 */
function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof GrfApiError) {
    return err.code === 'stream_interrupted' || err.code === 'stream_idle_timeout' || err.status === 0;
  }
  return err instanceof TypeError; // fetch 网络失败(连接拒绝/断网/代理断)
}

/** 可重试的"上游连接类失败终态":gh/上游 llm 读取流断开的报错特征。
 * 只匹配连接类,业务错误(鉴权/参数/配额)不重试——重试也一样失败。 */
function isRetryableStreamFailure(msg: string): boolean {
  return /unexpected eof|context deadline exceeded|client\.timeout|read stream|connection reset|broken pipe|eof/i.test(
    msg,
  );
}

export function errText(err: unknown): string {
  const raw =
    err instanceof GrfApiError || err instanceof Error ? err.message : String(err);
  return friendlyError(raw);
}

// ---------- scope 注册表 ----------

const scopes = new Map<string, GrfScope>();
export const scopeConfigs = new Map<string, ConnectionConfig>();

// 连接配置持久化(纯 web 态;桌面态由 wails AppConfig 托管,但本地副本
// 也能让 webview 冷启动更快连上)。
const connKey = (name: string) => `grf-ui:${name}:conn`;

// 新会话策略偏好持久化(随 scope 隔离;仅接受预制两值)。
const policyKey = (name: string) => `grf-ui:${name}:policy`;

function loadPolicyLocal(name: string): string | undefined {
  try {
    const v = localStorage.getItem(policyKey(name));
    return v === 'write-workspace' || v === 'off' ? v : undefined;
  } catch {
    return undefined;
  }
}

function saveConnLocal(name: string, cfg: ConnectionConfig): void {
  try {
    // policySelector 是宿主代码的配置项(非用户偏好),随每次 configure 给出,不持久化
    const { policySelector: _host, ...rest } = cfg;
    localStorage.setItem(connKey(name), JSON.stringify(rest));
  } catch {
    /* 忽略 */
  }
}

function loadConnLocal(name: string): Partial<ConnectionConfig> | null {
  try {
    const raw = localStorage.getItem(connKey(name));
    return raw ? (JSON.parse(raw) as Partial<ConnectionConfig>) : null;
  } catch {
    return null;
  }
}

/** 读取某 scope 已持久化的连接(设置页 web 态初始化用;未配置返回 null)。 */
export function savedConn(name: string): Partial<ConnectionConfig> | null {
  return loadConnLocal(name);
}

export function getScope(name = 'default'): GrfScope {
  let s = scopes.get(name);
  if (!s) {
    const saved = loadConnLocal(name);
    const cfg = {
      baseUrl: saved?.baseUrl ?? locationDefaultBase(),
      token: saved?.token ?? '',
      // localStorage 旧数据可能是裸名(下发会被 gh 忽略),恢复时归一
      ...(saved?.model ? { model: fullModelName(saved.model) } : {}),
      ...(saved?.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
    };
    scopeConfigs.set(name, cfg);
    s = new GrfScope(name, cfg);
    scopes.set(name, s);
    void s.start();
  }
  return s;
}

export function configureScope(name: string, cfg: Partial<ConnectionConfig>): GrfScope {
  // 兜底 base 保留已保存的 model:启动期 initWebConn 会带着仅 baseUrl/token
  // 的补丁进来,若 base 丢掉 model 会把已选模型从本地存储里抹掉。
  const saved = loadConnLocal(name);
  const base = scopeConfigs.get(name) ?? {
    baseUrl: saved?.baseUrl ?? locationDefaultBase(),
    token: saved?.token ?? '',
    ...(saved?.model ? { model: fullModelName(saved.model) } : {}),
    ...(saved?.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
  };
  const merged = { ...base, ...cfg };
  // 进来的 model 一律归一为全名再落 localStorage(settings 页手填、宿主
  // configure 均可能给裸名;gh 的 trySwitchModel 忽略裸名)
  if (merged.model) merged.model = fullModelName(merged.model);
  scopeConfigs.set(name, merged);
  saveConnLocal(name, merged);
  const existing = scopes.get(name);
  if (existing) {
    existing.setConnection(merged);
    return existing;
  }
  return getScope(name);
}

export function locationDefaultBase(): string {
  // web 形态默认走同源网关(/grf-api,由 grf-web-serve 或三方后端提供;
  // 多用户网关按登录用户注入令牌,浏览器无需配置)。非 http 环境
  // (桌面 wails 自定义 scheme)由桌面入口显式配置,不会走到这里。
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    return '/grf-api';
  }
  return 'http://127.0.0.1:7400';
}
