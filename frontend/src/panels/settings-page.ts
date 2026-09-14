// settings-page.ts — <grf-settings-page>:设置视图的主体工作面板(黑色
// 圆角大卡,与 <grf-chat> 同视觉;头部空白区同为窗口拖拽/双击缩放区)。
// 分区:常规(服务与连接)、外观(主题/强调色/字号)、模型设置(默认模型)。
// 改动即时生效并自动保存 —— 桌面态配置落 config.json,外观镜像
// localStorage;左栏导航由 app-shell 提供。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../ui/base';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { makeTitleDrag, type TitleDrag } from '../util/titledrag';
import { settingsStore, ACCENTS, type AccentKey, type ThemeMode, type FontSizeMode } from '../state/settings';
import type { ProviderDTO } from '../host/bridge';
import type { SettingsSection } from './settings-nav';

@customElement('grf-settings-page')
export class GrfSettingsPage extends GrfPanel {
  /** 当前分区(宿主下发,与左栏导航联动) */
  @property({ type: String }) section: SettingsSection = 'general';
  /** 左栏收起时头部左上角显示左边栏开关(展开时开关在左栏顶行) */
  @property({ type: Boolean, attribute: 'left-toggle' }) leftToggle = false;
  /** 左栏当前展开态 */
  @property({ type: Boolean }) leftOn = true;
  /** macOS 桌面态:左栏收起时头部为红绿灯保留悬浮位 */
  @property({ type: Boolean }) leftLights = false;

  /** 自动保存成功的瞬时提示 */
  @state() private savedFlash = false;
  private savedTimer?: ReturnType<typeof setTimeout>;
  /** 常规分区下的服务状态轮询(仅桌面态) */
  private srvTimer?: ReturnType<typeof setInterval>;
  private storeUnsub?: () => void;
  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  /** 模型设置:展开编辑的供应商名 */
  private openProvs = new Set<string>();
  /** 待二次确认删除的供应商名 */
  private pendingDelete: string | null = null;
  private deleteTimer?: ReturnType<typeof setTimeout>;
  /** 默认模型候选下拉(每实例唯一 id,避免嵌入多实例撞车) */
  private readonly dlId = `grf-models-${Math.random().toString(36).slice(2, 9)}`;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        height: 100%;
        /* 黑色圆角主面板,与聊天卡一致;底部拉通到窗口底 */
        background: var(--grf-card);
        border-radius: 12px 12px 0 0;
        overflow: hidden;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        /* 固定与左栏顶行同高(40px),分隔线对齐;内容垂直居中 */
        height: 40px;
        padding: 0 14px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--grf-border);
        user-select: none;
        font-weight: 650;
      }
      /* macOS 左栏收起时:窗口红绿灯悬浮于卡片左上,头部左侧让位 */
      header.lights {
        padding-left: 80px;
      }
      header .tg {
        background: transparent;
        border: none;
        color: var(--grf-text-faint);
        padding: 3px 5px;
        cursor: pointer;
        border-radius: 5px;
      }
      header .tg:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      header svg {
        width: 14px;
        height: 14px;
        color: var(--grf-text-faint);
      }
      header .saved {
        margin-left: auto;
        font-size: var(--grf-font-size-xs);
        font-weight: 400;
        color: var(--grf-success);
        opacity: 0;
        transition: opacity 0.2s;
      }
      header .saved.show {
        opacity: 1;
      }
      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      .body {
        max-width: 620px;
        margin: 0 auto;
        padding: 22px 24px 40px;
        display: grid;
        gap: 26px;
        align-content: start;
      }
      .sec h4 {
        margin: 0 0 12px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        text-transform: uppercase;
      }
      label {
        display: grid;
        gap: 5px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        margin-bottom: 12px;
      }
      .hint {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        line-height: 1.7;
        margin-top: 4px;
      }
      .seg {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .seg button {
        flex: 0 1 auto;
      }
      .seg button.on {
        border-color: var(--grf-accent);
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
      }
      .swatches {
        display: flex;
        gap: 10px;
        padding: 2px 0;
      }
      .swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        padding: 0;
        cursor: pointer;
        position: relative;
      }
      .swatch .c {
        position: absolute;
        inset: 3px;
        border-radius: 50%;
      }
      .swatch.on {
        box-shadow: 0 0 0 2px var(--grf-card), 0 0 0 4px var(--grf-text-dim);
      }
      .swatch:hover {
        filter: brightness(1.15);
      }
      .srv-line {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 2px 0 12px;
      }
      .srv-line .ok {
        color: var(--grf-success);
      }
      .srv-line .bad {
        color: var(--grf-error);
      }
      code.tok {
        font-family: var(--grf-mono);
        font-size: 10px;
        background: var(--grf-bg);
        padding: 1px 5px;
        border-radius: 4px;
        user-select: all;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      /* 供应商卡片 */
      .prov {
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        margin-bottom: 8px;
        overflow: hidden;
      }
      .prov-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        cursor: pointer;
        user-select: none;
      }
      .prov-head:hover {
        background: var(--grf-bg-hover);
      }
      .prov-head .caret {
        color: var(--grf-text-faint);
        font-size: 10px;
        width: 10px;
        flex: none;
      }
      .prov-head .pname {
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prov-head .tag {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        background: var(--grf-bg);
        border: 1px solid var(--grf-border);
        border-radius: 999px;
        padding: 1px 7px;
      }
      .prov-head .meta {
        margin-left: auto;
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .prov-head .meta.warn {
        color: var(--grf-warn);
      }
      .prov-body {
        border-top: 1px solid var(--grf-border-soft);
        padding: 10px;
        display: grid;
        gap: 10px;
      }
      .prov-body textarea {
        min-height: 58px;
        resize: vertical;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-sm);
      }
      .prov-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.tdrag = makeTitleDrag('button');
    this.storeUnsub = settingsStore.subscribe(() => this.requestUpdate());
    if (this.section === 'models') void settingsStore.loadModelCfg();
    this.srvTimer = setInterval(() => {
      if (inWails() && this.section === 'general') void settingsStore.refreshServerStatus();
    }, 4000);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.storeUnsub?.();
    this.storeUnsub = undefined;
    if (this.srvTimer) clearInterval(this.srvTimer);
    this.srvTimer = undefined;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = undefined;
    super.disconnectedCallback();
  }

  protected updated(props: Map<string, unknown>): void {
    super.updated(props);
    // 切到模型设置时拉取 gh 侧供应商配置(已加载则跳过)。
    if (props.has('section') && this.section === 'models') void settingsStore.loadModelCfg();
  }

  /** 通用提交:改配置 → 保存落盘 → 即时应用到当前 scope → 闪提示 */
  private commit(patch: Parameters<typeof settingsStore.patchCfg>[0]): void {
    settingsStore.patchCfg(patch);
    void settingsStore.saveCfg(this.scope).then(() => this.flashSaved());
  }

  private flashSaved(): void {
    this.savedFlash = true;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => (this.savedFlash = false), 1400);
  }

  render() {
    const titles: Record<SettingsSection, [string, string]> = {
      general: ['常规', icon.settings],
      appearance: ['外观', icon.palette],
      models: ['模型设置', icon.brain],
    };
    const [title, ic] = titles[this.section];
    return html`
      <header
        class=${this.leftLights && !this.leftOn ? 'lights' : ''}
        @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
        @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
      >
        ${this.leftToggle && !this.leftOn
          ? html`<button class="tg" title="展开会话列表" @click=${() => this.fire('grf-toggle-sessions')}>${unsafeHTML(icon.panelLeft)}</button>`
          : nothing}
        ${unsafeHTML(ic)}
        <span>${title}</span>
        <span class="saved ${this.savedFlash ? 'show' : ''}">${unsafeHTML(icon.check)} 已保存</span>
      </header>
      <div class="scroll">
        <div class="body">
          ${this.section === 'general' ? this.renderGeneral() : this.section === 'appearance' ? this.renderAppearance() : this.renderModels()}
        </div>
      </div>
    `;
  }

  // ---------- 常规:服务与连接 ----------

  private renderGeneral() {
    const cfg = settingsStore.cfg;
    if (!inWails()) {
      // 纯 web 态:无托管,允许配置直连地址(注意 gh server 无 CORS 头,
      // 浏览器直连需经同源反代,如 grf-web-serve 的 /grf-api)。
      return html`
        <div class="sec">
          <h4>连接</h4>
          <label>
            服务器地址
            <input
              type="text"
              .value=${cfg.remoteUrl}
              @change=${(e: InputEvent) => this.commit({ remoteUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label>
            Token
            <input
              type="password"
              .value=${cfg.remoteToken}
              @change=${(e: InputEvent) => this.commit({ remoteToken: (e.target as HTMLInputElement).value })}
            />
          </label>
          <div class="hint">
            浏览器模式:配置即时应用到当前页面并镜像到本地。gh server 不带
            CORS 头,直连需经同源反代(如 grf-web-serve 的 /grf-api)。
          </div>
        </div>
      `;
    }
    const srv = settingsStore.srv;
    const srvLine = srv
      ? html`
          <span class="${srv.running ? 'ok' : 'bad'}">
            ${srv.running ? `运行中 · ${srv.addr} · pid ${srv.pid}` : `未运行${srv.lastError ? ` · ${srv.lastError}` : ''}`}
          </span>
          ${srv.running && srv.token ? html`<span>token <code class="tok">${srv.token.slice(0, 12)}…</code></span>` : nothing}
        `
      : html`<span>尚未获取状态</span>`;
    return html`
      <div class="sec">
        <h4>服务</h4>
        <div class="seg" style="margin-bottom:12px">
          <button class=${cfg.serverMode === 'managed' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'managed' })}>
            托管 gh server(推荐)
          </button>
          <button class=${cfg.serverMode === 'remote' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'remote' })}>
            连接远程
          </button>
        </div>
        ${cfg.serverMode === 'managed'
          ? html`
              <label>
                gh 二进制(PATH 中的名字或绝对路径)
                <input
                  type="text"
                  .value=${cfg.ghBinary}
                  @change=${(e: InputEvent) => this.commit({ ghBinary: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label>
                监听地址
                <input
                  type="text"
                  .value=${cfg.serverAddr}
                  @change=${(e: InputEvent) => this.commit({ serverAddr: (e.target as HTMLInputElement).value })}
                />
              </label>
              <div class="srv-line">${srvLine}</div>
              <div class="actions">
                <button @click=${() => void settingsStore.toggleServer()}>${srv?.running ? '停止' : '启动'}</button>
                <button @click=${() => void settingsStore.applyManaged(this.scope)}>应用并连接</button>
              </div>
              <div class="hint">地址或二进制变更需点"应用并连接"重启托管进程后生效。</div>
            `
          : html`
              <label>
                服务器地址
                <input
                  type="text"
                  .value=${cfg.remoteUrl}
                  @change=${(e: InputEvent) => this.commit({ remoteUrl: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label>
                Token
                <input
                  type="password"
                  .value=${cfg.remoteToken}
                  @change=${(e: InputEvent) => this.commit({ remoteToken: (e.target as HTMLInputElement).value })}
                />
              </label>
              <div class="hint">远程地址经同源代理转发,保存后即时生效。</div>
            `}
      </div>
    `;
  }

  // ---------- 外观:主题 / 强调色 / 字号 ----------

  private renderAppearance() {
    const ap = settingsStore.appearance;
    const themes: [ThemeMode, string][] = [
      ['dark', '深色'],
      ['light', '浅色'],
    ];
    const sizes: [FontSizeMode, string][] = [
      ['compact', '紧凑'],
      ['standard', '标准'],
      ['relaxed', '宽松'],
    ];
    return html`
      <div class="sec">
        <h4>主题</h4>
        <div class="seg">
          ${themes.map(
            ([k, label]) => html`
              <button class=${ap.theme === k ? 'on' : ''} @click=${() => settingsStore.setAppearance({ theme: k })}>${label}</button>
            `,
          )}
        </div>
      </div>
      <div class="sec">
        <h4>强调色</h4>
        <div class="swatches">
          ${(Object.keys(ACCENTS) as AccentKey[]).map((k) => {
            const a = ACCENTS[k];
            return html`
              <button
                class="swatch ${ap.accent === k ? 'on' : ''}"
                title=${a.label}
                @click=${() => settingsStore.setAppearance({ accent: k })}
              >
                <span class="c" style="background:${a.accent}"></span>
              </button>
            `;
          })}
        </div>
      </div>
      <div class="sec">
        <h4>界面字号</h4>
        <div class="seg">
          ${sizes.map(
            ([k, label]) => html`
              <button class=${ap.fontSize === k ? 'on' : ''} @click=${() => settingsStore.setAppearance({ fontSize: k })}>${label}</button>
            `,
          )}
        </div>
      </div>
      <div class="hint">外观即时生效,并镜像保存到本地,重启后自动恢复。嵌入宿主仍可直接覆盖 --grf-* 变量换肤。</div>
    `;
  }

  // ---------- 模型设置:默认模型 + 供应商管理 ----------

  private renderModels() {
    const cfg = settingsStore.cfg;
    const mc = settingsStore.modelCfg;
    // 候选模型:provider/model 全组合(供输入联想,也允许手填任意值)。
    const opts: string[] = [];
    for (const p of mc?.providers ?? []) for (const m of p.models ?? []) opts.push(`${p.name}/${m}`);
    const readOnly = !mc || !mc.writable;
    const needRestart = inWails() && cfg.serverMode === 'managed' && !!settingsStore.srv?.running;

    return html`
      <div class="sec">
        <h4>默认模型</h4>
        <label>
          provider/model
          <input
            type="text"
            list=${this.dlId}
            .value=${cfg.defaultModel}
            placeholder="如 deepseek/deepseek-chat"
            @change=${(e: InputEvent) => this.setDefaultModel((e.target as HTMLInputElement).value)}
          />
          <datalist id=${this.dlId}>
            ${opts.map((o) => html`<option value=${o}></option>`)}
          </datalist>
        </label>
        <div class="hint">
          新会话默认使用该模型;同时写入 gh 的 settings.json(default),终端
          gh 与服务端默认保持一致。留空则沿用服务端默认。
        </div>
      </div>

      <div class="sec">
        <h4>供应商</h4>
        ${mc
          ? html`
              ${this.renderProviders(mc.providers, readOnly)}
              ${readOnly
                ? nothing
                : html`<div class="prov-actions"><button @click=${() => this.addProv()}>${unsafeHTML(icon.plus)} 添加供应商</button></div>`}
              <div class="hint">
                配置保存在 <code class="tok">${mc.path}</code>(其余配置项不受影响)。
                ${needRestart ? ' gh server 正在运行,供应商变更需重启服务后生效。' : ''}
              </div>
              ${needRestart
                ? html`<div class="actions" style="margin-top:8px">
                    <button @click=${() => void settingsStore.applyManaged(this.scope)}>重启服务以生效</button>
                  </div>`
                : nothing}
            `
          : html`<div class="hint">
              ${inWails()
                ? '正在读取模型配置…'
                : '浏览器形态无法访问 gh 的模型配置(~/.grf/settings.json),供应商请在运行 gh server 的机器上用桌面版或 gh model 管理。'}
            </div>`}
      </div>
    `;
  }

  private renderProviders(list: ProviderDTO[], readOnly: boolean) {
    if (!list.length) return html`<div class="hint">还没有供应商,点下方"添加供应商"新增一个。</div>`;
    return html`
      ${list.map((p) => {
        const open = this.openProvs.has(p.name);
        const n = (p.models ?? []).length;
        return html`
          <div class="prov">
            <div class="prov-head" @click=${() => this.toggleProv(p.name)}>
              <span class="caret">${open ? '▾' : '▸'}</span>
              <span class="pname">${p.name}</span>
              <span class="tag">${p.type || '默认'}</span>
              <span class="meta ${n ? '' : 'warn'}">${n ? `${n} 个模型` : '未配置模型'}</span>
              ${readOnly
                ? nothing
                : html`<button
                    class="ghost ${this.pendingDelete === p.name ? 'danger' : ''}"
                    @click=${(e: MouseEvent) => {
                      e.stopPropagation();
                      this.askDelete(p.name);
                    }}
                  >
                    ${this.pendingDelete === p.name ? '确认删除' : '删除'}
                  </button>`}
            </div>
            ${open
              ? html`
                  <div class="prov-body">
                    <label>
                      名称
                      <input
                        type="text"
                        .value=${p.name}
                        ?disabled=${readOnly}
                        @change=${(e: InputEvent) => this.renameProv(p.name, (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label>
                      协议类型
                      <select
                        .value=${p.type}
                        ?disabled=${readOnly}
                        @change=${(e: Event) => this.field(p.name, { type: (e.target as HTMLSelectElement).value })}
                      >
                        <option value="">默认(OpenAI 兼容)</option>
                        <option value="OpenAI">OpenAI</option>
                      </select>
                    </label>
                    <label>
                      Base URL
                      <input
                        type="text"
                        .value=${p.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        ?disabled=${readOnly}
                        @change=${(e: InputEvent) => this.field(p.name, { baseUrl: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label>
                      API Key
                      <input
                        type="password"
                        .value=${p.apiKey}
                        placeholder="sk-…(本地服务可留空)"
                        ?disabled=${readOnly}
                        @change=${(e: InputEvent) => this.field(p.name, { apiKey: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label>
                      模型(逗号或换行分隔)
                      <textarea
                        .value=${(p.models ?? []).join('\n')}
                        placeholder="gpt-4o&#10;gpt-4o-mini"
                        ?disabled=${readOnly}
                        @change=${(e: InputEvent) => this.field(p.name, { models: parseModels((e.target as HTMLTextAreaElement).value) })}
                      ></textarea>
                    </label>
                  </div>
                `
              : nothing}
          </div>
        `;
      })}
    `;
  }

  private setDefaultModel(v: string): void {
    void settingsStore.setDefaultModel(this.scope, v.trim()).then(() => this.flashSaved());
  }

  private toggleProv(name: string): void {
    if (this.openProvs.has(name)) this.openProvs.delete(name);
    else this.openProvs.add(name);
    this.requestUpdate();
  }

  private field(name: string, patch: Partial<ProviderDTO>): void {
    settingsStore.updateProvider(name, patch);
  }

  /** 新增一个占位供应商并展开编辑(名称可直接改)。 */
  private addProv(): void {
    const list = settingsStore.modelCfg?.providers ?? [];
    let i = 1;
    let name = 'new-provider';
    while (list.some((p) => p.name === name)) name = `new-provider-${++i}`;
    settingsStore.addProvider({ name, type: '', baseUrl: '', apiKey: '', models: [] });
    this.openProvs.add(name);
    this.requestUpdate();
  }

  private renameProv(oldName: string, raw: string): void {
    const to = raw.trim();
    if (!to || to === oldName) {
      this.requestUpdate(); // 非法输入:重渲染把输入框拉回原值
      return;
    }
    settingsStore.renameProvider(oldName, to);
    if (this.openProvs.delete(oldName)) this.openProvs.add(to);
    if (this.pendingDelete === oldName) this.pendingDelete = null;
    this.requestUpdate();
  }

  /** 删除需二次确认(3s 内再点一次),避免误删供应商。 */
  private askDelete(name: string): void {
    if (this.pendingDelete === name) {
      this.pendingDelete = null;
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = undefined;
      settingsStore.removeProvider(name);
      this.openProvs.delete(name);
      this.requestUpdate();
      return;
    }
    this.pendingDelete = name;
    this.requestUpdate();
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = setTimeout(() => {
      this.pendingDelete = null;
      this.deleteTimer = undefined;
      this.requestUpdate();
    }, 3000);
  }
}

/** 解析模型输入:逗号(中英文)或换行分隔,去空白与空项。 */
function parseModels(s: string): string[] {
  return s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-settings-page': GrfSettingsPage;
  }
}
