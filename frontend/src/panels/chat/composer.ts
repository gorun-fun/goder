// composer.ts — 聊天输入框:自动增高、Enter 发送 / Shift+Enter 换行、
// 粘贴/选择图片(data URL 多模态)、运行中切换为停止按钮。
// 底部工具栏:左侧「+」附件与访问策略(弹出列表,已有会话立即生效),
// 右侧上下文占用圆环(悬停看详情)、两级模型菜单(供应商 → 模型,按钮
// 直接显示当前使用的模型)与发送按钮。
// 模型暂停提问(ask)时,输入框整体变高并在框内直接展示选项与问题,
// 点击单选选项即确认提交。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { fmtTokens } from '../../util/fmt';
import type { AskItem } from '../../core/model/chat-model';
import type { LLMStats, Usage } from '../../core/api/types';
import { getSendInterceptor } from '../../core/store/host-config';
import { translate } from '../../core/i18n';
import './ask-form';

/** 新会话访问策略(与 gh 预制策略选项一一对应) */
export type DraftPolicy = 'write-workspace' | 'off';

/** 模型菜单的供应商分组 */
export interface ModelGroup {
  name: string;
  models: string[];
}

/**
 * 浮层定位(fixed):.composer-area 是 overflow 滚动容器,向上弹出的
 * 浮层若走普通 absolute 会被裁剪,故按锚点按钮的视口坐标定位。
 */
interface PopPos {
  top: string;
  left?: string;
  right?: string;
}

/** 斜杠指令(输入 / 呼出补全;按分组展示)。
 *  指令语义全部由 gh server(grf-harness)拦截执行——前端只做输入补全
 *  与原样发送,不改写、不本地执行(与 server/commands.go 的指令表同步)。 */
interface SlashCommand {
  name: string;
  group: string;
  desc: string;
  argHint?: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  // ---------- 基础 ----------
  { name: 'init', group: '基础', desc: '初始化项目:扫描工作区生成 AGENTS.md' },
  { name: 'plan', group: '基础', desc: '计划模式开关', argHint: 'on | off(缺省开启)' },
  { name: 'compact', group: '基础', desc: '压缩当前会话上下文' },
  { name: 'goal', group: '基础', desc: '查看/设定会话目标', argHint: '目标描述(缺省查看当前 goal)' },
  // ---------- 创造 ----------
  { name: 'skill', group: '创造', desc: '按一句话描述创建技能', argHint: '技能用途描述(必填)' },
  { name: 'plugin', group: '创造', desc: '安装插件', argHint: '插件名称(官方服务器校验后自动安装)' },
];

const POLICY_OPTIONS: Array<{ value: DraftPolicy; label: string; desc: string }> = [
  {
    value: 'write-workspace',
    label: '工作区访问',
    desc: '文件工具与终端沙箱限制在工作区内',
  },
  { value: 'off', label: '完全访问', desc: '解除沙箱与读写限制' },
];

/** 思考强度:值随请求 reasoning.effort 下发,由上游模型解释;空 = 服务端默认 */
const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
];

@customElement('grf-composer')
export class GrfComposer extends LitElement {
  /** 数据域名(发送钩子等嵌入方策略按 scope 生效;宿主/chat-panel 下发) */
  @property({ type: String }) scope = 'default';
  /** 运行中(切换为停止) */
  @property({ type: Boolean }) running = false;
  /** 有暂停待应答时不允许普通发送 */
  @property({ type: Boolean }) inputRequired = false;
  /** 待应答的提问(非空时输入框内嵌问题与选项) */
  @property({ type: Array }) asks: AskItem[] = [];
  /** 排队待发消息(回合运行中发送的,显示在输入框上方,可删除) */
  @property({ type: Array }) queue: { text: string; images?: string[] }[] = [];
  @property({ type: String }) placeholder = '';
  /** 未显式给 placeholder 时的默认文案(i18n 可覆盖)。 */
  private get placeholderText(): string {
    return this.placeholder || translate(this.scope, '发送消息…(/ 指令,Enter 发送,Shift+Enter 换行)');
  }
  /** 新会话访问策略:write-workspace(工作区访问)| off(完全访问) */
  @property({ type: String }) policy: DraftPolicy = 'off';
  /** 策略可即时生效(已有会话;false = 草稿,随首条消息生效) */
  @property({ type: Boolean }) policyImmediate = false;
  /** false = 隐藏策略选择器(嵌入方全权管理会话策略,见 configure.policySelector) */
  @property({ type: Boolean }) policySelector = true;
  /** 模型菜单数据:供应商 → 模型(空 = 无法枚举) */
  @property({ type: Array }) providers: ModelGroup[] = [];
  /** 当前使用的模型('' = 未选择,按钮回落显示「选择模型」,发送被守卫拦截) */
  @property({ type: String }) model = '';
  /** 选中态模型(菜单打勾/下一回合使用;'' = 未显式选择,回落当前模型) */
  @property({ type: String }) activeModel = '';
  /** 思考强度('' = 服务端默认;low/high/max),随每个请求下发 */
  @property({ type: String }) effort = '';
  /** 本会话用量(最近一次 response 的 usage;null = 无数据) */
  @property({ type: Object }) usage: Usage | null = null;
  /** 用量详情里展示的会话模型(服务端回报;空 = 未知) */
  @property({ type: String }) usageModel = '';
  /** 会话累计统计(速度/缓存命中率;null = 未取到) */
  @property({ type: Object }) stats: { llm: LLMStats } | null = null;
  /** 当前模型的上下文窗口(token 数,估算;占用圆环分母) */
  @property({ type: Number }) contextWindow = 128_000;
  /** 分母是否来自供应商接口的真实回报(true 时 tooltip 不标「预估」) */
  @property({ type: Boolean }) ctxExact = false;
  /** 前端本地 usage 累计(跨 gh server 重启兜底;gh 会话统计是内存态) */
  @property({ attribute: false }) usageTotals: { prompt: number; completion: number } | null = null;

  @state() private images: string[] = [];
  @state() private text = '';
  /** 策略弹出列表(非 null = 展开,携带锚点坐标) */
  @state() private policyPos: PopPos | null = null;
  /** 模型菜单(非 null = 展开,携带锚点坐标) */
  @state() private modelPos: PopPos | null = null;
  @state() private effortPos: PopPos | null = null;
  /** 上下文圆环 tooltip(非 null = 悬停中,携带锚点坐标) */
  @state() private tipPos: PopPos | null = null;
  /** 斜杠指令菜单:选中项索引(菜单是否展开由 text 派生,见 slashOpen) */
  @state() private slashIdx = 0;
  /** 斜杠菜单被关闭(Esc/补全/点击外部),输入变化后复位 */
  @state() private slashDismissed = false;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .wrap {
        position: relative;
        border: 1px solid var(--grf-border);
        border-radius: 12px;
        /* 背景与卡片同黑拉通,仅以描边勾勒输入框 */
        background: transparent;
        padding: 8px 10px;
        display: grid;
        gap: 6px;
        transition: border-color 0.15s;
        /* 容器查询锚点:按输入框实际宽度增减工具栏项(见下方 @container) */
        container-type: inline-size;
      }
      .wrap:focus-within {
        border-color: var(--grf-border-hover);
      }
      /* 应答态:输入框整体变高,内嵌问题与选项 */
      .wrap.asking {
        border-color: var(--grf-accent);
        background: var(--grf-accent-soft);
        padding: 14px 16px;
      }
      .ask-wrap {
        display: grid;
        gap: 12px;
      }
      .ask-head {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--grf-accent-text);
        font-size: var(--grf-font-size-sm);
        font-weight: 600;
      }
      .ask-head svg {
        width: 15px;
        height: 15px;
      }
      textarea {
        background: transparent;
        border: none;
        padding: 0;
        font-size: var(--grf-font-size);
        line-height: 1.6;
        resize: none;
        min-height: 24px;
        max-height: 200px;
        font-family: var(--grf-font);
        color: var(--grf-text);
        outline: none;
        width: 100%;
        box-sizing: border-box;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      /* 宽度不足时按优先级隐藏工具栏项:显示优先级 思考强度 > 用量圆环 >
       * 添加附件 > 访问策略 > 模型,低者优先隐藏;发送/停止按钮始终显示。
       * 按钮自身可收缩截断(.bar-btn flex 0 1 auto),这些阈值是收缩到
       * 不可读后的兜底 —— 未发生重叠时不隐藏。
       * 选择器限定 .bar-btn/按钮本身 —— 弹出菜单(.pop)同名类不受影响 */
      @container (max-width: 420px) {
        .bar .bar-btn.model-ctl {
          display: none;
        }
      }
      @container (max-width: 340px) {
        .bar .bar-btn.policy-ctl {
          display: none;
        }
      }
      @container (max-width: 300px) {
        .bar button.attach {
          display: none;
        }
      }
      @container (max-width: 270px) {
        .bar .ctx {
          display: none;
        }
      }
      @container (max-width: 220px) {
        .bar .bar-btn.effort-ctl {
          display: none;
        }
      }
      .hint {
        flex: 1;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .imgs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      /* 排队待发消息:输入框上方逐条列出,发送前可删 */
      .queue {
        display: grid;
        gap: 6px;
      }
      .queue-item {
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px dashed var(--grf-border);
        border-radius: var(--grf-radius-sm);
        background: var(--grf-bg-raise);
        padding: 6px 10px;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .queue-item .badge {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .queue-item .txt {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 3.2em;
      }
      .queue-item button {
        flex: none;
        padding: 2px 5px;
        line-height: 1;
        color: var(--grf-text-faint);
      }
      .queue-item button:hover {
        color: var(--grf-danger, #d33);
      }
      .queue-item button svg {
        width: 12px;
        height: 12px;
      }
      .img-chip {
        position: relative;
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius-sm);
        overflow: hidden;
        width: 64px;
        height: 64px;
      }
      .img-chip img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .img-chip button {
        position: absolute;
        top: 2px;
        right: 2px;
        padding: 1px 3px;
        background: rgba(0, 0, 0, 0.65);
        border: none;
        border-radius: 4px;
        color: #fff;
        line-height: 1;
      }
      .img-chip button svg {
        width: 10px;
        height: 10px;
      }
      /* 发送/停止:仅图标按钮(无文字),统一 30×30 方形 */
      .send,
      .stop {
        padding: 0;
        width: 30px;
        height: 30px;
        flex: none;
        justify-content: center;
      }
      .send svg,
      .stop svg {
        width: 15px;
        height: 15px;
      }
      /* 发送/停止:统一白底黑图标,悬停轻微变暗 */
      .send,
      .stop {
        background: #fff;
        border-color: #fff;
        color: #111;
      }
      .send:hover:not(:disabled),
      .stop:hover:not(:disabled) {
        filter: brightness(0.9);
      }
      .attach {
        color: var(--grf-text-dim);
      }
      input[type='file'] {
        display: none;
      }
      /* ---------- 工具栏文字按钮(策略/模型) ---------- */
      .bar-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: none; /* 策略/模型/思考强度:融入输入框,不加外框 */
        border-radius: var(--grf-radius-sm);
        background: transparent;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
        font-family: var(--grf-font);
        line-height: 1;
        padding: 5px 8px;
        cursor: pointer;
        flex: 0 1 auto; /* 允许收缩(.cur 省略号截断),不够放才按优先级隐藏 */
        min-width: 0;
      }
      .bar-btn:hover,
      .bar-btn.open {
        border-color: var(--grf-border-hover);
        color: var(--grf-text);
      }
      .bar-btn svg {
        width: 1em; /* 与按钮文字同高(策略盾牌/思考大脑/下拉箭头) */
        height: 1em;
        flex: none;
        /* 图标盒与文字 em 盒居中会略偏上,下移半个像素对齐视觉中线 */
        transform: translateY(0.5px);
      }
      .bar-btn .cur {
        min-width: 0; /* 作为 flex 子项允许收缩,配合省略号 */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* ---------- 弹出列表(策略/模型)与圆环 tooltip ----------
         fixed 定位:escape .composer-area 的 overflow 裁剪,坐标在
         打开/悬停时按锚点按钮的视口矩形计算(见 anchorPos)。 */
      .pop,
      .tip {
        position: fixed;
        transform: translateY(-100%);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius-sm);
        background: var(--grf-card);
        box-shadow: var(--grf-shadow);
        z-index: 80;
      }
      .pop {
        min-width: 210px;
        max-width: 320px;
        padding: 4px;
        display: grid;
        gap: 1px;
      }
      .pop.scrolly {
        max-height: 320px;
        overflow-y: auto;
      }
      .pop-title {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        padding: 5px 8px 4px;
      }
      .pop-group {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        padding: 6px 8px 2px;
        border-top: 1px solid var(--grf-border-soft);
        margin-top: 3px;
      }
      .pop-item {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        color: var(--grf-text-dim);
        border-radius: var(--grf-radius-sm);
        padding: 6px 8px;
        cursor: pointer;
        font-size: var(--grf-font-size-sm);
        font-family: var(--grf-font);
      }
      .pop-item:hover,
      .pop-item.sel {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .pop-item .check {
        width: 13px;
        flex: none;
        color: var(--grf-accent-text);
        padding-top: 2px;
      }
      .pop-item .check svg {
        width: 13px;
        height: 13px;
        display: block;
      }
      .pop-item .tx {
        min-width: 0;
      }
      .pop-item .tx b {
        display: block;
        font-weight: 500;
        color: var(--grf-text);
        font-size: var(--grf-font-size-sm);
        overflow-wrap: anywhere; /* 模型 ID 可能很长:换行完整显示,不省略截断 */
      }
      .pop-item .tx i {
        display: block;
        font-style: normal;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        margin-top: 1px;
      }
      /* 指令菜单:与输入框同宽,一条指令一行,说明跟在指令名后面 */
      .pop.slash-ctl {
        min-width: 0;
        max-width: none;
        width: 100%;
      }
      .pop.slash-ctl .pop-item .tx {
        display: flex;
        align-items: baseline;
        gap: 8px;
        width: 100%;
      }
      .pop.slash-ctl .pop-item .tx b {
        display: inline;
        flex: none;
      }
      .pop.slash-ctl .pop-item .tx i {
        display: inline;
        margin-top: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* ---------- 上下文占用圆环 ---------- */
      .ctx {
        position: relative;
        display: inline-flex;
        align-items: center;
        flex: none;
        padding: 3px;
        cursor: default;
      }
      .ctx svg {
        width: 18px;
        height: 18px;
        display: block;
      }
      .ctx .track {
        fill: none;
        stroke: var(--grf-border);
        stroke-width: 2.5;
      }
      .ctx .fill {
        fill: none;
        stroke: var(--grf-accent);
        stroke-width: 2.5;
        stroke-linecap: round;
        transform: rotate(-90deg);
        transform-origin: center;
        transition: stroke-dashoffset 0.3s;
      }
      .ctx.warn .fill {
        stroke: #e0a23c;
      }
      .ctx.hot .fill {
        stroke: #e05c5c;
      }
      .tip {
        min-width: 230px;
        max-width: 300px;
        padding: 10px 12px;
        display: grid;
        gap: 8px;
      }
      .tip .row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
      }
      .tip .row b {
        font-weight: 500;
        color: var(--grf-text);
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tip .row.head {
        color: var(--grf-text);
        padding-bottom: 4px;
        border-bottom: 1px solid var(--grf-border-soft);
        margin-bottom: 2px;
      }
    `,
  ];

  render() {
    const asking = this.asks.length > 0;
    return html`
      <div class="wrap ${asking ? 'asking' : ''}">
        ${asking
          ? html`
              <div class="ask-wrap">
                <div class="ask-head">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                    <path d="M2.5 3.5h11v7.5h-6L4 13.5V11H2.5z" stroke-linejoin="round" />
                  </svg>
                  模型需要你的回答
                </div>
                ${this.asks.map(
                  (a) => html`
                    <grf-ask-form flat .item=${a} show-dismiss></grf-ask-form>
                  `,
                )}
              </div>
            `
          : nothing}
        ${asking
          ? nothing
          : html`
              ${this.queue.length
                ? html`
                    <div class="queue">
                      ${this.queue.map(
                        (m, i) => html`
                          <div class="queue-item">
                            <span class="badge">排队 ${i + 1}</span>
                            <span class="txt">${m.text || (m.images?.length ? `[${m.images.length} 张图片]` : '')}</span>
                            <button title="删除这条排队消息" @click=${() => this.fire('queue-remove', { index: i })}>
                              <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : nothing}
              ${this.images.length
                ? html`
                    <div class="imgs">
                      ${this.images.map(
                        (u, i) => html`
                          <div class="img-chip">
                            <img src=${u} alt="附件" />
                            <button @click=${() => this.removeImage(i)} title="移除">
                              <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : nothing}
              <textarea
                .value=${this.text}
                placeholder=${this.inputRequired ? translate(this.scope, '等待应答上方问题…') : this.placeholderText}
                rows="1"
                spellcheck="false"
                @input=${this.onInput}
                @keydown=${this.onKeydown}
                @paste=${this.onPaste}
              ></textarea>
              ${this.slashOpen ? this.renderSlashPop() : nothing}
                <div class="bar">
                  <button class="ghost attach" title="添加附件(图片)" ?disabled=${this.running} @click=${this.pickImage}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M8 3v10M3 8h10" stroke-linecap="round" />
                    </svg>
                  </button>
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple @change=${this.onFile} />
                ${this.policySelector
                  ? html`<button
                      class="bar-btn policy-ctl ${this.policyPos ? 'open' : ''}"
                      title=${this.policyImmediate
                        ? '本会话的文件/终端访问策略(选择后立即生效)'
                        : '新会话的文件/终端访问策略(随首条消息生效)'}
                      @click=${(e: MouseEvent) => this.togglePop('policy', e)}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M8 1.8l4.8 1.8v3.2c0 3.1-2 5.6-4.8 6.7-2.8-1.1-4.8-3.6-4.8-6.7V3.6L8 1.8z" stroke-linejoin="round" />
                      </svg>
                      <span class="cur">${this.policy === 'write-workspace' ? '工作区访问' : '完全访问'}</span>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    ${this.policyPos ? this.renderPolicyPop(this.policyPos) : nothing}`
                  : nothing}
                <span class="hint">${this.hint()}</span>
                ${this.usage ? this.renderCtxRing() : nothing}
                <button
                  class="bar-btn model-ctl ${this.modelPos ? 'open' : ''}"
                  title=${this.model || '选择模型(未选择时无法发送)'}
                  @click=${(e: MouseEvent) => this.togglePop('model', e)}
                >
                  <span class="cur">${this.model || '选择模型'}</span>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                ${this.modelPos ? this.renderModelPop(this.modelPos) : nothing}
                <button
                  class="bar-btn effort-ctl ${this.effortPos ? 'open' : ''}"
                  title="思考强度(随每个请求下发;未选择 = 服务端默认)"
                  @click=${(e: MouseEvent) => this.togglePop('effort', e)}
                >
                  ${unsafeHTML(icon.brain)}
                  <span class="cur">${EFFORT_OPTIONS.find((o) => o.value === this.effort)?.label ?? '思考'}</span>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                ${this.effortPos ? this.renderEffortPop(this.effortPos) : nothing}
                ${this.running
                  ? html`<button class="stop" title="停止" aria-label="停止" @click=${this.stop}>
                      <svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>
                    </button>`
                  : html`<button
                      class="send"
                      title="发送"
                      aria-label="发送"
                      ?disabled=${this.inputRequired}
                      @click=${this.submit}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9">
                        <path d="M8 13V3.8" stroke-linecap="round" />
                        <path d="M4 7.8L8 3.8l4 4" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>`}
              </div>
            `}
      </div>
    `;
  }

  // ---------- 斜杠指令 ----------

  /** 首个单词(含 /),作为指令名补全的过滤词 */
  private get slashWord(): string {
    return this.text.split(/\s/, 1)[0];
  }

  /** 按前缀过滤出的指令项 */
  private get slashItems(): SlashCommand[] {
    if (!this.text.startsWith('/')) return [];
    const w = this.slashWord.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(w));
  }

  /** 菜单展开:以 / 开头、尚未输入空格/换行、有匹配项且未被关闭 */
  private get slashOpen(): boolean {
    return (
      !this.slashDismissed &&
      this.text.startsWith('/') &&
      this.slashWord.length === this.text.length &&
      this.slashItems.length > 0
    );
  }

  // 指令菜单:锚定输入框左缘向上弹出,按分组展示;↑↓ 选择、Tab/Enter 补全、Esc 关闭
  private renderSlashPop() {
    const ta = this.renderRoot.querySelector('textarea');
    if (!ta) return nothing;
    const items = this.slashItems;
    const sel = items[Math.min(this.slashIdx, items.length - 1)];
    // 分组保持 SLASH_COMMANDS 顺序;↑↓ 的索引是展平后的 items 索引
    const byGroup = new Map<string, SlashCommand[]>();
    for (const c of items) {
      const g = byGroup.get(c.group) ?? [];
      g.push(c);
      byGroup.set(c.group, g);
    }
    // 锚定可见输入框(.wrap 含边框内边距),与输入框同宽左对齐;
    // top 留 10px 间隙(anchorPos 默认 8px)。
    const box = ta.closest('.wrap') ?? ta;
    const r = box.getBoundingClientRect();
    return html`
      <div
        class="pop slash-ctl"
        style=${`top:${Math.round(r.top - 10)}px;left:${Math.round(r.left)}px;width:${Math.round(r.width)}px`}
      >
        ${[...byGroup.entries()].map(
          ([group, cmds]) => html`
            <div class="pop-group">${group}</div>
            ${cmds.map(
              (c) => html`
                <button
                  class="pop-item ${c === sel ? 'sel' : ''}"
                  @click=${() => this.completeSlash(c.name)}
                >
                  <span class="tx"><b>/${c.name}</b><i>${c.desc}${c.argHint ? ` · ${c.argHint}` : ''}</i></span>
                </button>
              `,
            )}
          `,
        )}
      </div>
    `;
  }

  /** 补全指令名:填入 "/name " 并关闭菜单(焦点回输入框) */
  private completeSlash(name: string): void {
    this.text = `/${name} `;
    this.slashDismissed = true;
    const ta = this.renderRoot.querySelector('textarea');
    if (ta) {
      ta.value = this.text;
      this.autosize(ta);
      ta.focus();
      ta.setSelectionRange(this.text.length, this.text.length);
    }
  }

  /** 回填草稿:发送被上层拦截(如模型守卫带去设置页)时恢复输入,
   * 避免用户回来后文本/图片丢失。焦点回输入框。 */
  setDraft(text: string, images?: string[]): void {
    this.text = text;
    this.images = images?.length ? [...images] : [];
    this.slashDismissed = false;
    this.slashIdx = 0;
    const ta = this.renderRoot.querySelector('textarea');
    if (ta) {
      ta.value = text;
      this.autosize(ta);
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    }
  }

  // 策略弹出列表:两个预制选项(与 gh set_policy 一致)
  private renderPolicyPop(pos: PopPos) {
    return html`
      <div class="pop policy-ctl" style=${posStyle(pos)}>
        <div class="pop-title">${this.policyImmediate ? '访问策略(立即生效)' : '访问策略(随新会话首条消息生效)'}</div>
        ${POLICY_OPTIONS.map(
          (o) => html`
            <button class="pop-item" @click=${() => this.pickPolicy(o.value)}>
              <span class="check">${o.value === this.policy ? CHECK_SVG : nothing}</span>
              <span class="tx"><b>${o.label}</b><i>${o.desc}</i></span>
            </button>
          `,
        )}
      </div>
    `;
  }

  // 模型菜单:供应商分组 → 模型(两级);选中态(下一回合使用)打勾
  private renderModelPop(pos: PopPos) {
    const empty = this.providers.length === 0 && !this.model;
    const active = this.activeModel || this.model;
    return html`
      <div class="pop scrolly model-ctl" style=${posStyle(pos)}>
        ${empty
          ? html`<div class="pop-title">暂无模型列表(桌面态读取 gh 设置)</div>`
          : nothing}
        ${this.providers.map(
          (g) => html`
            <div class="pop-group">${g.name}</div>
            ${g.models.map(
              (m) => html`
                <button class="pop-item" @click=${() => this.pickModel(m)}>
                  <span class="check">${m === active ? CHECK_SVG : nothing}</span>
                  <span class="tx"><b title=${m}>${shortModel(m)}</b></span>
                </button>
              `,
            )}
          `,
        )}
      </div>
    `;
  }

  // 思考强度弹出列表
  private renderEffortPop(pos: PopPos) {
    return html`
      <div class="pop effort-ctl" style=${posStyle(pos)}>
        <div class="pop-title">思考强度</div>
        ${EFFORT_OPTIONS.map(
          (o) => html`
            <button class="pop-item" @click=${() => this.pickEffort(o.value)}>
              <span class="check">${o.value === this.effort ? CHECK_SVG : nothing}</span>
              <span class="tx"><b>${o.label}</b></span>
            </button>
          `,
        )}
      </div>
    `;
  }

  private pickEffort(v: string): void {
    this.effortPos = null;
    this.fire('effort-change', v);
  }

  // 上下文占用圆环 + 悬停详情
  private renderCtxRing() {
    const u = this.usage!;
    // 下一回合的近似上下文 = 上回合输入 + 输出
    const ctxTokens = u.input_tokens + u.output_tokens;
    const win = Math.max(this.contextWindow, 1);
    const pct = Math.min(ctxTokens / win, 1);
    const C = 2 * Math.PI * 8; // r=8 周长
    const cls = pct >= 0.85 ? 'hot' : pct >= 0.6 ? 'warn' : '';
    return html`
      <span
        class="ctx ${cls}"
        title="上下文占用 ${Math.round(pct * 100)}%"
        @mouseenter=${(e: MouseEvent) => this.onTipEnter(e)}
        @mouseleave=${() => (this.tipPos = null)}
      >
        <svg viewBox="0 0 20 20">
          <circle class="track" cx="10" cy="10" r="8" />
          <circle class="fill" cx="10" cy="10" r="8" stroke-dasharray=${C.toFixed(2)} stroke-dashoffset=${(C * (1 - pct)).toFixed(2)} />
        </svg>
        ${this.tipPos ? this.renderCtxTip(ctxTokens, win, pct, this.tipPos) : nothing}
      </span>
    `;
  }

  private renderCtxTip(ctxTokens: number, win: number, pct: number, pos: PopPos) {
    const u = this.usage!;
    const llm = this.stats?.llm;
    // 缓存命中率:会话累计(stats)优先,退化为上回合 usage 推算
    let cache = '—';
    if (llm && llm.CachePct >= 0) cache = `${llm.CachePct}%`;
    else if (u.input_tokens_details?.cached_tokens && u.input_tokens > 0) {
      cache = `${Math.round((u.input_tokens_details.cached_tokens / u.input_tokens) * 100)}%`;
    }
    // 生成速度:完成 tokens / 纯生成耗时(会话累计)
    let speed = '—';
    if (llm && llm.CompletionTokens > 0 && llm.GenerationTime > 0) {
      speed = `${Math.round(llm.CompletionTokens / (llm.GenerationTime / 1e9))} tok/s`;
    }
    // 总输入/总输出:gh 会话累计优先(服务端权威,多窗口准),gh 重启丢
    // 数据时与前端本地累计取大——保证重开后不归零、数值单调不减
    const ghIn = llm?.UsageSeen ? llm.PromptTokens : 0;
    const ghOut = llm?.UsageSeen ? llm.CompletionTokens : 0;
    const inTot = Math.max(ghIn, this.usageTotals?.prompt ?? 0);
    const outTot = Math.max(ghOut, this.usageTotals?.completion ?? 0);
    // 模型行:统计属最近一次实际调用(usageModel);当前选择(model)与
    // 之不同 = 已切换待下回合生效,展示「旧 → 新」让切换状态可见
    const lastModel = this.usageModel;
    const nextModel = this.model;
    const modelLabel =
      lastModel && nextModel && lastModel !== nextModel ? `${lastModel} → ${nextModel}` : (lastModel || nextModel || '');
    return html`
      <div class="tip" style=${posStyle(pos)}>
        <div class="row head"><span>上下文容量</span><b>${fmtTokens(ctxTokens)} / ${fmtTokens(win)}${this.ctxExact ? '' : '(预估)'} · ${Math.round(pct * 100)}%</b></div>
        <div class="row"><span>总输入</span><b>${inTot > 0 ? fmtTokens(inTot) : '—'}</b></div>
        <div class="row"><span>总输出</span><b>${outTot > 0 ? fmtTokens(outTot) : '—'}</b></div>
        <div class="row"><span>输出</span><b>${fmtTokens(u.output_tokens)}</b></div>
        <div class="row"><span>缓存命中率</span><b>${cache}</b></div>
        <div class="row"><span>生成速度</span><b>${speed}</b></div>
        ${modelLabel
          ? html`<div class="row"><span>模型</span><b title=${modelLabel}>${modelLabel}</b></div>`
          : nothing}
      </div>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onDocPointerDown);
  }

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onDocPointerDown);
    super.disconnectedCallback();
  }

  // 弹出列表:点击对应控件(按钮/列表)之外的任意处关闭
  private onDocPointerDown = (e: PointerEvent): void => {
    if (!this.policyPos && !this.modelPos && !this.effortPos && !this.slashOpen) return;
    const path = e.composedPath() as EventTarget[];
    const inside = (cls: string) =>
      path.some((t) => t instanceof Element && t.classList.contains(cls));
    if (this.policyPos && !inside('policy-ctl')) this.policyPos = null;
    if (this.modelPos && !inside('model-ctl')) this.modelPos = null;
    if (this.effortPos && !inside('effort-ctl')) this.effortPos = null;
    // 斜杠菜单:点击菜单项或输入框内保持展开
    if (this.slashOpen && !inside('slash-ctl') && !path.some((t) => t instanceof HTMLTextAreaElement)) {
      this.slashDismissed = true;
    }
  };

  // 按锚点按钮的视口矩形计算浮层位置;left 对齐左缘 / right 对齐右缘
  private anchorPos(el: Element, align: 'left' | 'right'): PopPos {
    const r = el.getBoundingClientRect();
    return {
      top: `${Math.round(r.top - 8)}px`,
      ...(align === 'left' ? { left: `${Math.round(r.left)}px` } : { right: `${Math.round(window.innerWidth - r.right)}px` }),
    };
  }

  // 弹出列表互斥
  private togglePop(which: 'policy' | 'model' | 'effort', e: MouseEvent): void {
    const el = e.currentTarget as HTMLElement;
    if (which === 'policy') {
      this.policyPos = this.policyPos ? null : this.anchorPos(el, 'left');
      this.modelPos = null;
      this.effortPos = null;
    } else if (which === 'model') {
      this.modelPos = this.modelPos ? null : this.anchorPos(el, 'right');
      this.policyPos = null;
      this.effortPos = null;
    } else {
      this.effortPos = this.effortPos ? null : this.anchorPos(el, 'right');
      this.policyPos = null;
      this.modelPos = null;
    }
  }

  /** 打开模型选择弹层(未选模型发送被拦时引导,一步到位)。 */
  openModelPicker(): void {
    if (this.modelPos) return;
    const btn = this.renderRoot.querySelector('.bar-btn.model-ctl');
    if (btn) {
      this.modelPos = this.anchorPos(btn, 'right');
      this.policyPos = null;
      this.effortPos = null;
    }
  }

  // 圆环 tooltip:右对齐圆环
  private onTipEnter(e: MouseEvent): void {
    this.tipPos = this.anchorPos(e.currentTarget as Element, 'right');
  }

  private pickPolicy(v: DraftPolicy): void {
    this.policyPos = null;
    this.fire('policy-change', v);
  }

  private pickModel(v: string): void {
    this.modelPos = null;
    this.fire('model-change', v);
  }

  private hint(): string {
    if (this.running) return '回合运行中,发送的消息将排队等候';
    if (this.inputRequired) return '模型在等待上面的交互应答';
    return '';
  }

  private onInput(e: InputEvent): void {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    this.slashIdx = 0;
    this.slashDismissed = false;
    this.autosize(ta);
  }

  private autosize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (this.slashOpen) {
      const items = this.slashItems;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.slashIdx = (Math.min(this.slashIdx, items.length - 1) + 1) % items.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.slashIdx = (Math.min(this.slashIdx, items.length - 1) - 1 + items.length) % items.length;
        return;
      }
      if (e.key === 'Escape') {
        this.slashDismissed = true;
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.completeSlash(items[Math.min(this.slashIdx, items.length - 1)].name);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // 菜单展开且高亮项未输全:Enter 先补全指令名
      if (this.slashOpen) {
        const word = this.slashWord.slice(1);
        const sel = this.slashItems[Math.min(this.slashIdx, this.slashItems.length - 1)];
        if (sel && sel.name !== word) {
          this.completeSlash(sel.name);
          return;
        }
      }
      this.submit();
    }
  }

  private onPaste(e: ClipboardEvent): void {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void this.addFile(file);
        }
      }
    }
  }

  // 附件仅图片:ORS 线格式 ContentPart 只有 input_text/input_image(与
  // gh server dto.go 对齐),任意文件无协议通道 —— 双形态评估结论:不做
  // 非图片附件,文本内容让用户自行粘贴。
  private pickImage(): void {
    this.renderRoot.querySelector<HTMLInputElement>('input[type=file]')?.click();
  }

  private onFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    for (const f of input.files ?? []) void this.addFile(f);
    input.value = '';
  }

  private async addFile(f: File): Promise<void> {
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(f);
    });
    this.images = [...this.images, url];
  }

  private removeImage(i: number): void {
    this.images = this.images.filter((_, x) => x !== i);
  }

  private submit(): void {
    // 运行中不再拦截:消息进 scope 发送队列,当前回合结束后自动发出。
    if (this.inputRequired) return;
    if (!this.text.trim() && !this.images.length) return;
    // 嵌入方发送钩子(configure 的 onBeforeSend):dispatch 前消费 ——
    // 返回 null 取消发送且输入保留在框内;返回改写载荷按改写值发出。
    // 异步钩子等结果再 dispatch(期间输入不清空)。
    const hook = getSendInterceptor(this.scope);
    if (hook) {
      void Promise.resolve(hook({ text: this.text, images: this.images })).then((r) => {
        if (!r) return;
        if (!r.text.trim() && !r.images?.length) return;
        this.dispatchSend(r.text, r.images ?? []);
      });
      return;
    }
    this.dispatchSend(this.text, this.images);
  }

  /** 派发 send 事件并清空输入。事件可取消:宿主(事件监听)调
   *  preventDefault 时输入保留在框内,由拦截方决定后续。 */
  private dispatchSend(text: string, images: string[]): void {
    const ok = this.dispatchEvent(
      new CustomEvent('send', { detail: { text, images }, bubbles: true, composed: true, cancelable: true }),
    );
    if (!ok) return;
    this.clearInput();
    this.images = [];
  }

  private clearInput(): void {
    this.text = '';
    this.slashDismissed = false;
    this.slashIdx = 0;
    const ta = this.renderRoot.querySelector('textarea');
    if (ta) {
      ta.value = '';
      this.autosize(ta);
    }
  }

  private stop(): void {
    this.fire('stop', {});
  }

  private fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

const CHECK_SVG = html`
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 8.5l3.2 3.2L13 5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

/** PopPos → 内联 style(左缘或右缘对齐 + 顶边)。 */
function posStyle(pos: PopPos): string {
  return `top:${pos.top};${pos.left ? `left:${pos.left}` : `right:${pos.right ?? '0'}`}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-composer': GrfComposer;
  }
}

/** 菜单项去掉 provider 前缀(分组标题已显示 provider)。 */
function shortModel(m: string): string {
  const i = m.indexOf('/');
  return i >= 0 ? m.slice(i + 1) : m;
}
