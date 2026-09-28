// models.ts — 「模型」分区:供应商/模型双栏(默认模型是 gh 侧概念,
// goder 不设:新会话模型按"同项目最近会话 → 全局最近会话"继承,
// 无记录时守卫引导)。左栏列表可拖拽排序,右栏为选中供应商详情。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';
import type { ProviderDTO } from '../../../host/bridge';
import { icon } from '../../../util/icons';

@customElement('grf-settings-models')
export class GrfSettingsModels extends SettingsSectionPanel {
  /** 当前选中的供应商名(右侧展示其详情) */
  private selProv: string | null = null;

  /** 当前生效的选中供应商:未选中或已失效时回退到第一个(默认展开)。 */
  private get activeProvName(): string | null {
    const list = settingsStore.modelCfg?.providers ?? [];
    if (list.length && !list.some((x) => x.name === this.selProv)) return list[0].name;
    return this.selProv;
  }

  /** 自动检测进行中 / 结果提示 */
  @state() private detecting = false;
  private detectMsg = '';
  /** 左栏供应商列表拖拽排序:拖动项 / 悬停目标项(仅可写配置启用) */
  private dragProv: string | null = null;
  @state() private dragOverProv: string | null = null;

  static styles = [
    ...sectionSharedCss,
    css`
      /* 供应商/模型双栏布局(参考系统设置:左列表右详情) */
      .models-cols {
        display: grid;
        grid-template-columns: 190px 1fr;
        gap: 12px;
        align-items: start;
      }
      .prov-list {
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        padding: 5px;
        display: grid;
        gap: 2px;
        align-content: start;
        /* 供应商过多时限高滚动,"添加供应商"按钮随列表滚动 */
        max-height: 420px;
        overflow-y: auto;
      }
      .prov-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        user-select: none;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .prov-item:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .prov-item.on {
        background: var(--grf-accent-soft);
        color: var(--grf-accent-text);
      }
      .prov-item .pname {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prov-item .cnt {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .prov-item.on .cnt {
        color: inherit;
        opacity: 0.8;
      }
      /* 拖拽排序反馈:可写配置整行可抓取,悬停目标高亮、拖动项半透明 */
      .prov-list .prov-item[draggable='true'] {
        cursor: grab;
      }
      .prov-list .prov-item.dragging {
        opacity: 0.45;
      }
      .prov-list .prov-item.over {
        box-shadow: inset 0 2px 0 var(--grf-accent);
      }
      .add-prov {
        justify-content: flex-start;
        margin-top: 3px;
      }
      .prov-detail {
        min-width: 0;
      }
      .prov-detail .prov {
        margin-bottom: 0;
      }
      .prov-body .fields label {
        margin-bottom: 0;
      }
      /* 模型列表:过多时限高滚动 */
      .mlist {
        display: grid;
        gap: 4px;
        align-content: start;
        max-height: 320px;
        overflow-y: auto;
      }
      .prov-head .meta.warn {
        color: var(--grf-warn);
      }
      .prov-body textarea {
        min-height: 58px;
        resize: vertical;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-sm);
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadModelCfg();
  }

  render() {
    const mc = settingsStore.modelCfg;
    const readOnly = !mc || !mc.writable;

    return html`
      <div class="sec">
        <h4>供应商与模型</h4>
        ${mc
          ? html`
              <div class="models-cols">
                <div class="prov-list">${this.renderProvList(mc.providers, readOnly)}</div>
                <div class="prov-detail">${this.renderProvDetail(readOnly)}</div>
              </div>
              <div class="hint">
                配置保存在 <code class="tok">${mc.path}</code>(其余配置项不受影响)。${inWails()
                  ? '服务运行中时保存后自动重启 gh server 生效。'
                  : '保存后新会话即生效(配置随登录用户隔离;API Key 不回显,留空即保留)。'}
              </div>
            `
          : html`<div class="hint">
              ${inWails()
                ? '正在读取模型配置…'
                : this.webAgentHint('模型配置')}
            </div>`}
      </div>
    `;
  }

  /** 左栏:供应商列表(名称 + 模型数),可写时整行可拖拽排序,
   * 底部"添加供应商"。 */
  private renderProvList(list: ProviderDTO[], readOnly: boolean) {
    if (!list.length && readOnly) return html`<div class="hint">还没有供应商。</div>`;
    return html`
      ${list.map((p) => {
        const n = (p.models ?? []).length;
        return html`
          <div
            class="prov-item ${this.activeProvName === p.name ? 'on' : ''} ${this.dragOverProv === p.name
              ? 'over'
              : ''} ${this.dragProv === p.name ? 'dragging' : ''}"
            title=${p.name}
            draggable=${!readOnly}
            @click=${() => {
              this.selProv = p.name;
              this.requestUpdate();
            }}
            @dragstart=${(e: DragEvent) => {
              if (readOnly) return;
              this.dragProv = p.name;
              e.dataTransfer?.setData('text/plain', p.name);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              this.requestUpdate();
            }}
            @dragover=${(e: DragEvent) => {
              if (!this.dragProv || this.dragProv === p.name) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
              if (this.dragOverProv !== p.name) {
                this.dragOverProv = p.name;
                this.requestUpdate();
              }
            }}
            @dragleave=${() => {
              if (this.dragOverProv === p.name) {
                this.dragOverProv = null;
                this.requestUpdate();
              }
            }}
            @drop=${(e: DragEvent) => {
              e.preventDefault();
              if (this.dragProv && this.dragProv !== p.name) settingsStore.moveProvider(this.dragProv, p.name);
              this.dragProv = null;
              this.dragOverProv = null;
              this.requestUpdate();
            }}
            @dragend=${() => {
              this.dragProv = null;
              this.dragOverProv = null;
              this.requestUpdate();
            }}
          >
            <span class="pname">${p.name}</span>
            ${p.managed ? html`<span class="cnt">托管</span>` : nothing}
            <span class="cnt">${n || '—'}</span>
          </div>
        `;
      })}
      ${readOnly
        ? nothing
        : html`<button class="add-prov" @click=${() => this.addProv()}>${unsafeHTML(icon.plus)} 添加供应商</button>`}
    `;
  }

  /** 右栏:选中供应商的详情(连接信息 + 模型列表)。平台托管项
   * (p.managed,嵌入方反代注入)只读展示:连接信息不显示、模型不可增删。 */
  private renderProvDetail(readOnly: boolean) {
    const list = settingsStore.modelCfg?.providers ?? [];
    const p = list.find((x) => x.name === this.activeProvName);
    if (!p) {
      return html`<div class="hint">${list.length ? '从左侧选择一个供应商查看详情。' : '还没有供应商,点左下"添加供应商"新增一个。'}</div>`;
    }
    const ro = readOnly || p.managed === true;
    return html`
      <div class="prov">
        <div class="prov-head" title="当前模型数">
          <span class="pname">${p.name}</span>
          <span class="tag">${p.type || '默认'}</span>
          <span class="meta">${(p.models ?? []).length} 个模型</span>
          ${ro
            ? nothing
            : html`<button
                class="ghost ${this.pendingDelete === p.name ? 'danger' : ''}"
                style="margin-left:auto"
                @click=${() => this.askDelete(p.name)}
              >
                ${this.pendingDelete === p.name ? '确认删除' : '删除'}
              </button>`}
        </div>
        <div class="prov-body">
          ${p.managed
            ? html`<div class="hint" style="margin:0 0 8px">
                平台托管供应商:由平台统一下发与更新(含连接信息与密钥代理),此处仅展示模型清单。
              </div>`
            : html`
          <div class="fields">
            <label>
              名称
              <input
                type="text"
                .value=${p.name}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.renameProv(p.name, (e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              协议类型
              <select
                .value=${p.type}
                ?disabled=${ro}
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
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.field(p.name, { baseUrl: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                .value=${p.apiKey}
                placeholder=${!inWails() && p.hasKey ? '已设置(留空保留,输入更换)' : 'sk-…(本地服务可留空)'}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.field(p.name, { apiKey: (e.target as HTMLInputElement).value })}
              />
            </label>
          </div>
          `}
          <div class="mlist">
            ${(p.models ?? []).map((m, i) => {
              return html`
                <div class="mrow">
                  <input
                    class="minput"
                    type="text"
                    .value=${m}
                    ?disabled=${ro}
                    @change=${(e: InputEvent) => this.setModelAt(p.name, i, (e.target as HTMLInputElement).value)}
                  />
                  ${ro
                    ? nothing
                    : html`<button class="ghost mdel" title="删除该模型" @click=${() => this.removeModelAt(p.name, i)}>×</button>`}
                </div>
              `;
            })}
            ${ro
              ? nothing
              : html`
                  <div class="mrow add">
                    <input
                      class="minput"
                      type="text"
                      placeholder="添加模型,如 gpt-4o"
                      @change=${(e: InputEvent) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (v) this.addModelRow(p.name, v);
                        else this.requestUpdate();
                      }}
                    />
                    <span class="mhint">回车添加</span>
                  </div>
                `}
          </div>
          ${ro
            ? nothing
            : html`
                <div class="prov-actions">
                  ${this.detectMsg && this.activeProvName === p.name ? html`<span class="hint">${this.detectMsg}</span>` : nothing}
                  <button ?disabled=${this.detecting} @click=${() => void this.detectProvModels(p.name)}>
                    ${this.detecting ? '检测中…' : `${'自动检测'}`}
                  </button>
                </div>
              `}
        </div>
      </div>
    `;
  }

  private field(name: string, patch: Partial<ProviderDTO>): void {
    settingsStore.updateProvider(name, patch);
  }

  /** 改某一行模型名(去空白;与既有名重复时拉回原值)。 */
  private setModelAt(name: string, i: number, raw: string): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    const v = raw.trim();
    if (!p || !v || (p.models ?? [])[i] === v) {
      this.requestUpdate();
      return;
    }
    const ms = [...(p.models ?? [])];
    if (ms.some((m, j) => j !== i && m === v)) {
      this.requestUpdate(); // 重名:拒绝并拉回
      return;
    }
    ms[i] = v;
    this.field(name, { models: ms });
  }

  private removeModelAt(name: string, i: number): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    if (!p) return;
    this.field(name, { models: (p.models ?? []).filter((_, j) => j !== i) });
  }

  private addModelRow(name: string, v: string): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    if (!p) return;
    if ((p.models ?? []).includes(v)) {
      this.requestUpdate(); // 已存在:忽略并清空输入
      return;
    }
    this.field(name, { models: [...(p.models ?? []), v] });
  }

  /** 自动检测:询问供应商 /models 并把结果合并进模型列表。 */
  private async detectProvModels(name: string): Promise<void> {
    this.detecting = true;
    this.detectMsg = '';
    this.requestUpdate();
    const n = await settingsStore.detectProviderModels(name);
    this.detecting = false;
    this.detectMsg = n < 0 ? '检测失败:请检查 Base URL 与 API Key 后重试' : `检测到 ${n} 个模型,已合并进列表`;
    this.requestUpdate();
    this.fire('grf-saved');
  }

  /** 新增一个占位供应商并选中(名称可直接改)。 */
  private addProv(): void {
    const list = settingsStore.modelCfg?.providers ?? [];
    let i = 1;
    let name = 'new-provider';
    while (list.some((p) => p.name === name)) name = `new-provider-${++i}`;
    settingsStore.addProvider({ name, type: '', baseUrl: '', apiKey: '', models: [] });
    this.selProv = name;
    this.requestUpdate();
  }

  private renameProv(oldName: string, raw: string): void {
    // 托管项不可改名(UI 已隐藏输入框,此处兜底防程序化触发)
    if (settingsStore.modelCfg?.providers.find((p) => p.name === oldName)?.managed) {
      this.requestUpdate();
      return;
    }
    const to = raw.trim();
    if (!to || to === oldName) {
      this.requestUpdate(); // 非法输入:重渲染把输入框拉回原值
      return;
    }
    settingsStore.renameProvider(oldName, to);
    if (this.selProv === oldName) this.selProv = to;
    if (this.pendingDelete === oldName) this.pendingDelete = null;
    this.requestUpdate();
  }

  /** 删除需二次确认(3s 内再点一次),避免误删供应商。 */
  private askDelete(name: string): void {
    // 托管项不可删(平台统一下发,UI 已隐藏按钮,此处兜底)
    if (settingsStore.modelCfg?.providers.find((p) => p.name === name)?.managed) return;
    if (!this.armDelete(name)) return;
    settingsStore.removeProvider(name);
    if (this.selProv === name) this.selProv = null;
    this.requestUpdate();
  }
}
