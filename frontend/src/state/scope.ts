// scope.ts — 核心编排器:一个 scope 聚合连接配置、项目索引、会话运行态与
// 事件日志;面板(会话列表/聊天/右栏/底栏)通过 scope 名共享同一份数据。
// 嵌入态多个 scope 互不干扰,桌面态只用 "app"。
import { GrfApiError, GrfClient } from '../api/client';
import { friendlyError, isToolChoiceUnsupported } from '../util/fmt';
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
  genId,
  historyToItems,
  applySavedDurs,
  markRequestAnswered,
  materializeRequest,
  newRuntime,
  todosFromItems,
  type SessionRuntime,
} from './chat-model';
import { emptyIndex, persistence, type ProjectsIndex, type ProjectRecord } from './persist';
import { Emitter } from './store';

export const UNGROUPED = '__ungrouped';

export interface ConsoleEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'event';
  text: string;
}

export interface ConnectionConfig {
  baseUrl: string;
  token: string;
  model?: string;
}

export type ConnState = 'unknown' | 'checking' | 'ok' | 'error';

export interface DraftInfo {
  projectId: string;
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
   * gh 的 policy 只随会话首条消息落定,故此值影响下一个新建的会话。 */
  draftPolicy?: string;

  console: ConsoleEntry[] = [];
  consolePaused = false;
  private consoleMax = 800;

  private refreshTimer?: ReturnType<typeof setInterval>;
  private inflightSends = new Set<string>(); // 运行中的 sid
  private activeAborts = new Map<string, AbortController>(); // sid → 当前流的中断器
  private streamDoneAt = new Map<string, number>(); // sid → 服务器已结束的时刻
  private watchdogHits = new Set<string>(); // 看门狗掐断的 sid(非用户取消)

  constructor(name: string, cfg: ConnectionConfig) {
    super();
    this.name = name;
    this.client = new GrfClient({ baseUrl: cfg.baseUrl, token: cfg.token });
    this.model = cfg.model;
    this.draftPolicy = loadPolicyLocal(name);
  }

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

  /** 设置随请求发送的模型('' = 服务端默认);本地持久化,不动连接状态。 */
  setModel(m: string): void {
    this.model = m || undefined;
    saveConnLocal(this.name, {
      baseUrl: this.client.config.baseUrl,
      token: this.client.config.token,
      ...(this.model ? { model: this.model } : {}),
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
    if (cfg.model !== undefined) this.model = cfg.model;
    saveConnLocal(this.name, { baseUrl: this.client.config.baseUrl, token: this.client.config.token, ...(this.model ? { model: this.model } : {}) });
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
    }
    this.notify();
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
    this.activeSessionId = did;
    this.activeProjectId = projectId;
    this.notify();
    return did;
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
  private async requestWithRetry(rt: SessionRuntime, opts: SendOptions): Promise<ResponseResource> {
    const max = 3;
    for (let attempt = 0; ; attempt++) {
      const final = await this.client.send(opts);
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

  async send(text: string, images?: string[], opts?: { editOf?: string }): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid) return;
    const rt = this.ensureRuntime(sid);
    if (this.inflightSends.has(sid) || rt.running) {
      this.log('warn', '会话忙(同会话串行),请等待当前回合结束');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && !images?.length) return;

    // 暂停中的提问被新输入顶掉:卡片标记失效,避免遗留 stale 的
    // input_result(服务端会拒:回合已不在暂停态)。
    if (rt.pendingRequests.length > 0) {
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

    rt.items.push({
      kind: 'user',
      id: genId('u'),
      text: trimmed,
      images: images?.length ? images : undefined,
    });
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
    // 让 agent 的文件/终端工具直接落在项目里;无路径的项目用服务端默认)。
    // composer 的策略选择(draftPolicy)优先于项目默认。
    const grfSession = isDraft
      ? {
          workspace: draftProject?.path,
          ...draftProject?.defaults,
          ...(this.draftPolicy ? { policy: this.draftPolicy } : {}),
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
    };

    try {
      const final = await this.requestWithRetry(rt, {
        model: this.model,
        input: [parts],
        previousResponseId: previous,
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
        this.persistIndex();
      }
      // 用户仍停在该会话:完成即视为已查看;已切走则保留未读标记。
      if (this.activeSessionId === realSid) this.markSessionSeen(realSid);
    } catch (err) {
      const watchdog = this.watchdogHits.has(realSid) || this.watchdogHits.has(sid);
      this.watchdogHits.delete(sid);
      this.watchdogHits.delete(realSid);
      if (ac.signal.aborted && !watchdog) {
        rt.items.push({ kind: 'status', id: genId('s'), text: '已请求中断…' });
      } else {
        rt.error = errText(err);
        this.log('error', `发送失败:${errText(err)}`);
        // 中途断流:请求可能已被服务端受理,按会话终态对账自愈,不盲报错。
        const recovered = await this.recoverAfterStreamBreak(realSid, rt);
        if (!recovered) {
          rt.items.push({ kind: 'error', id: genId('e'), text: `发送失败:${errText(err)}` });
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
      setTimeout(() => void this.syncRunningState(realSid), 300);
      this.notify();
    }
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
        const snap = await this.client.retrieveResponse(last);
        if (snap) {
          applyResponseSnapshot(rt, snap);
          this.notify();
          return true;
        }
      }
    } catch {
      /* 恢复失败走原错误展示 */
    }
    return false;
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
      const final = await this.requestWithRetry(rt, {
        model: this.model,
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
      setTimeout(() => void this.syncRunningState(sid), 300);
      this.notify();
    }
  }

  async cancelActive(): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid || sid.startsWith('draft:')) return;
    const rt = this.ensureRuntime(sid);
    const respId = rt.lastResponseId;
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
    const model = rt.model ?? this.model;
    if (!model) {
      this.log('warn', '压缩需要 model,请先在连接配置里设置默认模型');
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
    localStorage.setItem(connKey(name), JSON.stringify(cfg));
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
      ...(saved?.model ? { model: saved.model } : {}),
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
    ...(saved?.model ? { model: saved.model } : {}),
  };
  const merged = { ...base, ...cfg };
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
  // 默认假定 gh server 与页面同源(桌面态由 Go 侧代理/本地回环)。
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    return `${location.protocol}//${location.hostname}:7400`;
  }
  return 'http://127.0.0.1:7400';
}
