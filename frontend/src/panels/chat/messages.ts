// messages.ts — 聊天消息流的渲染函数(从 chat-panel 拆出的纯模板逻辑)。
// 消息条目(用户/助手/思考/工具/通知/ask/审批/错误/状态)、左侧消息导航
// 波浪条;样式随 chat-panel 的 static styles 提供。
import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdown } from '../../util/markdown';
import { truncate, fmtDuration } from '../../util/fmt';
import { icon } from '../../util/icons';
import type { ChatItem } from '../../core/model/chat-model';
import { hasSkillBlock, hasTaskBlock, parseGrfSkillBlocks, parseGrfTaskBlocks, type TaskSegment } from '../../core/store/automation';
import './tool-card';
import './ask-form';
import './approval-card';
import './task-card';
import './skill-card';

/** 消息渲染依赖的宿主状态与回调(由 chat-panel 实现)。 */
export interface MessageViewProps {
  /** 编辑中的用户消息 id 与草稿 */
  editingId?: string;
  editDraft: string;
  /** 刚复制成功的消息 id(图标短暂变为 ✓) */
  copiedId?: string;
  /** 显式展开过的思考块 id */
  reasoningOpen: Set<string>;
  onEditDraft(v: string): void;
  onCommitEdit(): void;
  onCancelEdit(): void;
  onStartEdit(it: { kind: 'user'; id: string; text: string }): void;
  onCopy(id: string, text: string): void;
  onToggleReasoning(id: string): void;
  onAskAnswer(e: Event): void;
  onAskDismiss(e: Event): void;
  onApprove(e: Event): void;
  /** 任务卡保存(操作员输出的 <grf-task> 块 → 自动化任务库) */
  onSaveTask(name: string, instructions: string): void;
  /** 任务是否已保存(当前会话所属操作员名下同名同指令) */
  isTaskSaved(name: string, instructions: string): boolean;
  /** 技能卡保存(执行会话输出的 <grf-skill> 块 → 桌面 bridge 落盘技能) */
  onSaveSkill(name: string, content: string): void;
  /** 技能是否已保存(本会话内已点过保存的技能名) */
  isSkillSaved(name: string): boolean;
}

/** 渲染单条消息(ask 待答态返回 nothing:交互控件在底部输入框内)。
 * items 为整条消息列表:点击类工具要向前找最近的截图,供「查看」定位圈点。 */
export function renderItem(it: ChatItem, p: MessageViewProps, items?: ChatItem[]): TemplateResult | typeof nothing {
  switch (it.kind) {
    case 'user': {
      // 编辑态:气泡原位变输入框,改完作为新消息重新发送
      if (p.editingId === it.id) {
        return html`
          <div class="msg-user">
            <div class="edit-box">
              <textarea
                .value=${p.editDraft}
                @input=${(e: InputEvent) => p.onEditDraft((e.target as HTMLTextAreaElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) p.onCommitEdit();
                  else if (e.key === 'Escape') p.onCancelEdit();
                }}
              ></textarea>
              <div class="edit-ops">
                <span class="hint">⌘/Ctrl+Enter 重新发送 · Esc 取消</span>
                <button class="primary" @click=${p.onCommitEdit}>重新发送</button>
                <button @click=${p.onCancelEdit}>取消</button>
              </div>
            </div>
          </div>
        `;
      }
      return html`
        <div class="msg-user" data-mid=${it.id}>
          <div class="body">${it.text}</div>
          <div class="bops">
            <button class="bop" title="复制" @click=${() => p.onCopy(it.id, it.text)}>
              ${unsafeHTML(p.copiedId === it.id ? icon.check : icon.copy)}
            </button>
            <button class="bop" title="编辑后重新发送" @click=${() => p.onStartEdit(it)}>
              ${unsafeHTML(icon.edit)}
            </button>
          </div>
          ${it.images?.length
            ? html`<div class="imgs">${it.images.map((u) => html`<img src=${u} alt="图片" />`)}</div>`
            : nothing}
        </div>
      `;
    }
    case 'assistant':
      return html`
        <div class="msg-assistant">
          <div class="md">
            ${renderAssistantBody(it, p)}
            ${it.streaming && !it.text ? html`<span class="cursor"></span>` : nothing}
          </div>
        </div>
      `;
    case 'reasoning':
      return renderReasoning(it, p);
    case 'tool': {
      // ask_user_question 单独成提问卡片,工具行无信息量,不展示
      if (it.name === 'ask_user_question') return nothing;
      // 点击类工具:向前找最近一张截图(限定窗口,避免长会话全量扫),
      // 供工具卡「查看」链接打开时在图上圈出点击位置;截图结果文本里的
      // 坐标 meta(覆盖起点/scale)用于把全局坐标换算回图上像素。
      let ctxShot: string | undefined;
      let ctxMeta: string | undefined;
      const idx = items ? items.indexOf(it) : -1;
      for (let j = idx - 1; j >= 0 && j >= idx - 40; j--) {
        const prev = items![j];
        if (prev.kind === 'tool' && prev.images?.length) {
          ctxShot = prev.images[prev.images.length - 1];
          ctxMeta = prev.output;
          break;
        }
      }
      return html`<grf-tool-card .item=${it} .ctxShot=${ctxShot} .ctxMeta=${ctxMeta}></grf-tool-card>`;
    }
    case 'notice':
      return html`
        <div class="notice ${it.noticeKind}">
          <span class="k">${it.noticeKind}</span><span>${truncate(it.detail, 300)}</span>
        </div>
      `;
    case 'ask':
      // 待答提问的交互控件在底部输入框内(点击选项即提交);
      // 消息流只保留已应答/已取消的记录卡。
      if (it.state === 'pending') return nothing;
      return html`<grf-ask-form .item=${it} @answer=${p.onAskAnswer} @dismiss=${p.onAskDismiss}></grf-ask-form>`;
    case 'approval':
      return html`<grf-approval-card .item=${it} @approve=${p.onApprove}></grf-approval-card>`;
    case 'error':
      return html`<div class="err">${it.text}</div>`;
    case 'status':
      return html`<div class="status">— ${it.text} —</div>`;
    default:
      return nothing;
  }
}

/** assistant 正文:含 <grf-task>/<grf-skill> 协议块时拆段渲染 —— 普通
 * 段照常走 markdown(段内再拆技能块),完整闭合的任务/技能块渲染为
 * grf-task-card / grf-skill-card(流式未闭合块由解析层丢弃,闭合后成卡)。 */
function renderAssistantBody(it: { text: string }, p: MessageViewProps): (TemplateResult | typeof nothing)[] {
  const segs: TaskSegment[] = hasTaskBlock(it.text)
    ? parseGrfTaskBlocks(it.text)
    : [{ type: 'text', text: it.text }];
  return segs.flatMap((seg) => {
    if (seg.type === 'task') {
      return [
        html`<grf-task-card
          .name=${seg.name}
          .instructions=${seg.instructions}
          .saved=${p.isTaskSaved(seg.name, seg.instructions)}
          @save=${(e: CustomEvent<{ name: string; instructions: string }>) =>
            p.onSaveTask(e.detail.name, e.detail.instructions)}
        ></grf-task-card>`,
      ];
    }
    // 文本段内继续拆技能块(执行会话只出技能块,任务段与技能块不会混出)
    if (seg.type !== 'text') return [];
    const parts: TaskSegment[] = hasSkillBlock(seg.text)
      ? parseGrfSkillBlocks(seg.text)
      : [{ type: 'text', text: seg.text }];
    return parts.map((part) =>
      part.type === 'skill'
        ? html`<grf-skill-card
            .name=${part.name}
            .content=${part.content}
            .saved=${p.isSkillSaved(part.name)}
            @save=${(e: CustomEvent<{ name: string; content: string }>) =>
              p.onSaveSkill(e.detail.name, e.detail.content)}
          ></grf-skill-card>`
        : part.type === 'text'
          ? html`${unsafeHTML(renderMarkdown(part.text))}`
          : nothing,
    );
  });
}

/** 思考块:流式单行高亮(内容跟随输出滚动),完成后折叠头部可展开。 */function renderReasoning(
  it: { kind: 'reasoning'; id: string; text: string; streaming: boolean; startedAt?: number; endedAt?: number },
  p: MessageViewProps,
): TemplateResult {
  const open = p.reasoningOpen.has(it.id);
  // 流式思考中:单行高亮"正在思考: …";内容不满一行时从左显示,
  // 超出后跟随模型输出滚动(chat-panel updated 里推到末尾)
  if (it.streaming && !open) {
    return html`
      <div class="reasoning live" @click=${() => p.onToggleReasoning(it.id)} title="点击展开思考全文">
        ${unsafeHTML(icon.brain)}
        <span class="rlabel">正在思考:</span>
        <span class="rscroll"><span class="rtext">${it.text.trim() || '…'}</span></span>
      </div>
    `;
  }
  // 完成后:折叠头部显示"思考 · 时长"(有起止时刻才显示时长)
  const dur = it.startedAt && it.endedAt ? ` · ${fmtDuration(it.endedAt - it.startedAt)}` : '';
  return html`
    <div class="reasoning">
      <div class="rhead" @click=${() => p.onToggleReasoning(it.id)}>
        ${unsafeHTML(icon.brain)}
        <span>思考${dur}</span>
        <svg
          class="chev ${open ? 'open' : ''}"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      ${open ? html`<pre>${it.text}</pre>` : nothing}
    </div>
  `;
}

// ---------- 左侧消息导航(波浪条) ----------

interface ChatNavAnchor {
  id: string;
  user: string;
  reply: string;
}

/** 渲染左侧消息导航:每条用户消息一根小横线,集中在纵向中部紧凑排列。 */
export function renderChatNav(items: ChatItem[], onMove: (e: PointerEvent) => void, onLeave: (e: PointerEvent) => void, onJump: (id: string) => void): TemplateResult | typeof nothing {
  const anchors: ChatNavAnchor[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'user') continue;
    // 回复简介:其后(下一条用户消息前)的第一条助手文本
    let reply = '';
    for (let j = i + 1; j < items.length; j++) {
      const nx = items[j];
      if (nx.kind === 'user') break;
      if (nx.kind === 'assistant' && nx.text.trim()) {
        reply = nx.text.trim().replace(/\s+/g, ' ');
        break;
      }
    }
    anchors.push({ id: it.id, user: it.text.trim(), reply });
  }
  const n = anchors.length;
  if (!n) return nothing;
  // 横线紧凑排在纵向中部;消息很多时缩小间距,避免撑出消息区
  const gap = n > 40 ? Math.max(3, Math.floor(360 / n)) : 7;
  return html`
    <div class="cnav" style="gap:${gap}px" @pointermove=${onMove} @pointerleave=${onLeave}>
      ${anchors.map(
        (a) => html`
          <span class="tick" @click=${() => onJump(a.id)}>
            <span class="tip">
              <span class="u">${truncate(a.user, 140)}</span>
              ${a.reply ? html`<span class="a">${truncate(a.reply, 180)}</span>` : nothing}
            </span>
          </span>
        `,
      )}
    </div>
  `;
}

/** 波浪交互:与鼠标齐平的横线最长(波峰 = 选中态),长度只向两侧各传递
 * 两级邻居;命令式改宽度,不触发 Lit 重渲染,过渡交给 CSS transition。 */
export function cnavWave(e: PointerEvent): void {
  const cnav = e.currentTarget as HTMLElement;
  const ticks = [...cnav.querySelectorAll<HTMLElement>('.tick')];
  const y = e.clientY;
  let peak = -1;
  let peakDist = Infinity;
  ticks.forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - y);
    if (d < peakDist) {
      peakDist = d;
      peak = i;
    }
  });
  const half = [1, 0.5, 0.25]; // 波峰 / ±1 / ±2 的伸长比例
  ticks.forEach((t, i) => {
    const k = half[Math.abs(i - peak)] ?? 0;
    t.style.width = `${(12 + 20 * k).toFixed(1)}px`;
    t.classList.toggle('peak', i === peak);
  });
}

/** 鼠标离开:横线收回基础长度,清除波峰高亮。 */
export function cnavReset(e: PointerEvent): void {
  const cnav = e.currentTarget as HTMLElement;
  for (const t of cnav.querySelectorAll<HTMLElement>('.tick')) {
    t.style.width = '';
    t.classList.remove('peak');
  }
}
