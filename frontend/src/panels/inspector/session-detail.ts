// session-detail.ts — <goder-session-detail>:右栏会话详情:模型与用量、todo/goal 状态、
// 工具调用时间线(全部工具卡片,含子代理)、会话元信息(workspace)。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GoderPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { fmtDuration, fmtTokens, toolLabel } from '../../util/fmt';
import { displayFullModel } from '../../core/settings/settings-store';
import type { ToolItem } from '../../core/model/chat-model';

@customElement('goder-session-detail')
export class GoderSessionDetail extends GoderPanel {
  @state() private detailTab: 'timeline' | 'todos' = 'timeline';
  private detailTimer?: ReturnType<typeof setInterval>;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--goder-bg-raise);
        border-left: 1px solid var(--goder-border-soft);
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        color: var(--goder-text);
        width: 100%;
      }
      .head {
        flex: none;
        padding: 10px 12px;
        font-weight: 650;
        font-size: var(--goder-font-size);
        border-bottom: 1px solid var(--goder-border-soft);
      }
      .scroll {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: 10px 12px 16px;
        display: grid;
        gap: 14px;
        align-content: start;
      }
      .sec h4 {
        margin: 0 0 7px;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .sec h4 svg {
        width: 13px;
        height: 13px;
      }
      .kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px 12px;
        font-size: var(--goder-font-size-sm);
      }
      .kv .k {
        color: var(--goder-text-faint);
        white-space: nowrap;
      }
      .kv .v {
        color: var(--goder-text);
        text-align: right;
        word-break: break-all;
        font-variant-numeric: tabular-nums;
      }
      .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--goder-border-soft);
        margin-bottom: 2px;
      }
      .tab {
        padding: 4px 10px;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-dim);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .tab.on {
        color: var(--goder-text);
        border-bottom-color: var(--goder-accent);
      }
      .timeline {
        display: grid;
        gap: 4px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: var(--goder-font-size-xs);
        padding: 4px 6px;
        border-radius: var(--goder-radius-sm);
        cursor: default;
      }
      .row:hover {
        background: var(--goder-bg-hover);
      }
      .row .st {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
        background: var(--goder-text-faint);
      }
      .row.done .st { background: var(--goder-success); }
      .row.error .st { background: var(--goder-error); }
      .row.denied .st { background: var(--goder-warn); }
      .row.running .st {
        background: var(--goder-accent);
        animation: blink 1.2s ease-in-out infinite;
      }
      @keyframes blink {
        50% { opacity: 0.35; }
      }
      .row .nm {
        font-family: var(--goder-mono);
        color: var(--goder-text);
        flex: none;
      }
      .row .sm {
        color: var(--goder-text-faint);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }
      .row .ag {
        color: var(--goder-reasoning);
        flex: none;
        font-size: 10px;
      }
      .todo {
        display: flex;
        gap: 8px;
        align-items: baseline;
        padding: 3px 0;
        font-size: var(--goder-font-size-sm);
      }
      .todo .box {
        flex: none;
        width: 13px;
        height: 13px;
        border: 1px solid var(--goder-text-faint);
        border-radius: 3px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 2px;
      }
      .todo.completed {
        color: var(--goder-text-faint);
        text-decoration: line-through;
      }
      .todo.completed .box {
        background: var(--goder-success);
        border-color: var(--goder-success);
      }
      .todo.completed .box svg {
        width: 9px;
        height: 9px;
        color: #0c2817;
      }
      .todo.in_progress {
        color: var(--goder-text);
      }
      .todo.in_progress .box {
        border-color: var(--goder-accent);
        box-shadow: 0 0 0 2px var(--goder-accent-soft);
      }
      .empty {
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-xs);
        padding: 6px 2px;
      }
      .actions {
        display: flex;
        gap: 6px;
        margin-top: 2px;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.detailTimer = setInterval(() => this.pollDetail(), 4000);
  }

  disconnectedCallback(): void {
    if (this.detailTimer) clearInterval(this.detailTimer);
    super.disconnectedCallback();
  }

  private lastDetail?: { running: boolean; paused: boolean };

  private pollDetail(): void {
    const sid = this.store?.activeSessionId;
    if (!sid || sid.startsWith('draft:')) return;
    void this.store.syncRunningState(sid);
  }

  render() {
    const s = this.store;
    const sid = s.activeSessionId;
    if (!sid || sid.startsWith('draft:')) {
      return html`
        <div class="head">详情</div>
        <div class="scroll">
          <div class="sec"><div class="empty">未选择会话${sid ? '(草稿待发送)' : ''}</div></div>
        </div>
      `;
    }
    const rt = s.runtimes.get(sid);
    const rec = s.index.sessions[sid];
    const conv = s.conversations.get(sid);
    // ask_user_question 不计入也不展示(提问卡片本身已表达)
    const tools = (rt?.items ?? []).filter(
      (i): i is ToolItem => i.kind === 'tool' && i.name !== 'ask_user_question',
    );
    const proj = s.index.projects.find((p) => p.id === rec?.projectId);

    return html`
      <div class="head">会话详情</div>
      <div class="scroll">
        <div class="sec">
          <h4>${unsafeHTML(icon.info)} 概览</h4>
          <div class="kv">
            <span class="k">项目</span><span class="v">${proj?.name ?? '—'}</span>
            <span class="k">模型</span><span class="v">${displayFullModel(rt?.model ?? s.model ?? '') || '—'}</span>
            <span class="k">状态</span>
            <span class="v">
              ${s.isRunning(sid) ? '运行中' : (rt?.pendingRequests.length ?? 0) > 0 ? '等待输入' : '空闲'}
            </span>
          </div>
        </div>

        ${rt?.usage
          ? html`
              <div class="sec">
                <h4>${unsafeHTML(icon.db)} 用量(本进程)</h4>
                <div class="kv">
                  <span class="k">输入</span><span class="v">${fmtTokens(rt.usage.input_tokens)}</span>
                  <span class="k">输出</span><span class="v">${fmtTokens(rt.usage.output_tokens)}</span>
                  ${rt.usage.input_tokens_details?.cached_tokens
                    ? html`<span class="k">缓存命中</span><span class="v">${fmtTokens(rt.usage.input_tokens_details.cached_tokens)}</span>`
                    : nothing}
                </div>
              </div>
            `
          : nothing}

        <div class="sec">
          <h4>${unsafeHTML(icon.wrench)} 工具 / 任务</h4>
          <div class="tabs">
            <span class="tab ${this.detailTab === 'timeline' ? 'on' : ''}" @click=${() => (this.detailTab = 'timeline')}>
              时间线 ${tools.length ? `(${tools.length})` : ''}
            </span>
            <span class="tab ${this.detailTab === 'todos' ? 'on' : ''}" @click=${() => (this.detailTab = 'todos')}>
              Todo ${rt?.todos?.length ? `(${rt.todos.length})` : ''}
            </span>
          </div>
          ${this.detailTab === 'timeline' ? this.renderTimeline(tools) : this.renderTodos(rt?.todos ?? null)}
        </div>

        <div class="sec">
          <h4>${unsafeHTML(icon.folder)} 元信息</h4>
          <div class="kv">
            <span class="k">会话 ID</span><span class="v" style="font-family:var(--goder-mono);font-size:var(--goder-font-size-xs)">${sid}</span>
            <span class="k">创建</span><span class="v">${new Date(rec?.createdAt ?? conv?.created_at ?? Date.now()).toLocaleString()}</span>
          </div>
          ${conv?.workspace
            ? html`<div class="kv" style="margin-top:4px"><span class="k">Workspace</span><span class="v" style="font-family:var(--goder-mono);font-size:var(--goder-font-size-xs)">${conv.workspace}</span></div>`
            : nothing}
          <div class="actions">
            <button title="压缩上下文" ?disabled=${!rt?.lastResponseId} @click=${() => void s.compactActive()}>
              ${unsafeHTML(icon.compact)} 压缩
            </button>
            <button title="重载历史" @click=${() => void s.loadHistoryFresh(sid)}>${unsafeHTML(icon.refresh)} 重载</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderTimeline(tools: ToolItem[]) {
    // ask_user_question 不展示(提问卡片本身已表达);标题不再挂参数 JSON。
    const shown = tools.filter((t) => t.name !== 'ask_user_question');
    if (!shown.length) return html`<div class="empty">暂无工具调用</div>`;
    return html`
      <div class="timeline">
        ${[...shown].reverse().map(
          (t) => html`
            <div class="row ${t.status}">
              <span class="st"></span>
              <span class="nm">${toolLabel(t.name)}</span>
              <span class="sm">${this.sm(t)}</span>
              ${t.agentId && t.agentId !== 'agent_root' ? html`<span class="ag">${t.label || t.agentId}</span>` : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  private sm(t: ToolItem): string {
    if (t.status === 'running') return '执行中…';
    const dur = t.endedAt ? fmtDuration(t.endedAt - t.startedAt) : '';
    const out = (t.output || t.err || '').split('\n')[0]?.slice(0, 60) ?? '';
    return `${dur ? `${dur} · ` : ''}${out}`;
  }

  private renderTodos(todos: { content: string; status: string }[] | null) {
    if (!todos?.length) return html`<div class="empty">暂无任务列表(todo_write 后出现)</div>`;
    return html`
      ${todos.map(
        (t) => html`
          <div class="todo ${t.status}">
            <span class="box">
              ${t.status === 'completed'
                ? html`<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>`
                : nothing}
            </span>
            <span>${t.content}</span>
          </div>
        `,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-session-detail': GoderSessionDetail;
  }
}
