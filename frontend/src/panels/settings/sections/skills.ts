// skills.ts — 「技能」分区:平铺卡片(安装/删除/点开编辑)+ 搜索 +
// 在线安装 + URL 安装。内置技能(与 Go 侧 agentconfig.go 的
// builtinSkills 对齐,两边同改)不可删/编辑,可禁用。
import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';

function isBuiltinSkill(name: string): boolean {
  return name === 'goder-auto';
}

@customElement('goder-settings-skills')
export class GoderSettingsSkills extends SettingsSectionPanel {
  static styles = [
    ...sectionSharedCss,
  ];

  /** 当前编辑中的技能名与全文(点开时从后端读取)。 */
  private selSkill: string | null = null;
  private skillText = '';
  @state() private skillMsg = '';
  private skillKw = '';
  private newSkillName = '';
  private newSkillUrl = '';

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadSkillsCfg();
    void settingsStore.loadRemoteSkills();
  }

  render() {
    const sc = settingsStore.skillsCfg;
    if (!sc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取技能列表…' : this.webAgentHint('技能列表')}</div></div>`;
    }
    const ro = !sc.writable;
    const kw = this.skillKw.trim().toLowerCase();
    const skills = sc.skills.filter((s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw));
    // 在线可安装 = 服务器 skills/*.md 减去已装同名技能
    const installed = new Set(sc.skills.map((s) => s.name.toLowerCase()));
    const available = (settingsStore.remoteSkills?.files ?? [])
      .map((f) => f.replace(/\.md$/, ''))
      .filter((n) => !installed.has(n.toLowerCase()));
    return html`
      <div class="sec">
        <h4>已安装</h4>
        <input
          type="text"
          placeholder="搜索已安装技能…"
          .value=${this.skillKw}
          style="margin-bottom:10px"
          @input=${(e: InputEvent) => {
            this.skillKw = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        ${skills.length
          ? html`
              <div class="tiles">
                ${skills.map(
                  (s) => html`
                    <div class="tile ${s.disabled ? 'off' : ''} ${this.selSkill === s.name ? 'on' : ''}">
                      <div class="corner">
                        ${s.disabled ? html`<span class="tag">已禁用</span>` : nothing}
                        ${isBuiltinSkill(s.name) ? html`<span class="tag">内置</span>` : nothing}
                        ${ro
                          ? nothing
                          : html`<button class="ghost" @click=${() => void this.toggleSkill(s.name, s.disabled)}>
                              ${s.disabled ? '启用' : '禁用'}
                            </button>`}
                      </div>
                      <div class="tname" title=${isBuiltinSkill(s.name) ? '点击查看' : '点击编辑'} style="cursor:pointer" @click=${() => void this.openSkill(s.name)}>${s.name}</div>
                      <div class="tsub" title=${s.description}>${s.description || '—'}</div>
                      <div class="tacts">
                        ${ro || isBuiltinSkill(s.name)
                          ? nothing
                          : html`<button
                              class="ghost ${this.pendingDelete === s.name ? 'danger' : ''}"
                              @click=${() => void this.deleteSkill(s.name)}
                            >
                              ${this.pendingDelete === s.name ? '确认删除' : '删除'}
                            </button>`}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<div class="hint">${kw ? '没有匹配的技能。' : '还没有技能。'}</div>`}
        ${this.agentMsg ? html`<div class="hint">${this.agentMsg}</div>` : nothing}
      </div>
      <div class="sec">
        <h4>在线安装</h4>
        ${settingsStore.remoteSkills === null
          ? html`<div class="hint">${inWails() ? '正在查询官方下载服务器…' : '在线安装请用桌面版;网页形态可新建/编辑/启停自己的技能。'}</div>`
          : available.length
            ? html`
                <div class="tiles">
                  ${available.map(
                    (n) => html`
                      <div class="tile">
                        <div class="tname">${n}</div>
                        <div class="tsub">官方技能</div>
                        <div class="tacts">
                          <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installSkillFile(n)}>
                            ${this.busyAgent ? '安装中…' : '安装'}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : html`<div class="hint">官方服务器上暂无其他可安装技能。</div>`}
        ${ro
          ? nothing
          : html`
              <div class="mrow add" style="margin-top:8px">
                <input
                  class="minput"
                  type="text"
                  placeholder="技能名"
                  .value=${this.newSkillName}
                  @input=${(e: InputEvent) => (this.newSkillName = (e.target as HTMLInputElement).value)}
                />
                <input
                  class="minput"
                  type="text"
                  placeholder="SKILL.md 的在线 URL(https://…/SKILL.md)"
                  .value=${this.newSkillUrl}
                  @input=${(e: InputEvent) => (this.newSkillUrl = (e.target as HTMLInputElement).value)}
                />
                <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installSkillURL()}>URL 安装</button>
              </div>
            `}
        <div class="hint">
          技能目录 <code class="tok">${sc.path}</code>,安装/删除后自动重启 gh server 生效;点技能名可编辑 SKILL.md。
        </div>
      </div>
      ${this.selSkill
        ? html`
            <div class="sec">
              <h4>${isBuiltinSkill(this.selSkill) ? '查看' : '编辑'} ${this.selSkill}${isBuiltinSkill(this.selSkill) ? '(内置,只读)' : ''}</h4>
              <textarea
                style="min-height:220px;font-family:var(--goder-mono);font-size:var(--goder-font-size-sm)"
                ?readonly=${isBuiltinSkill(this.selSkill)}
                .value=${this.skillText}
                @input=${(e: InputEvent) => (this.skillText = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <div class="actions" style="margin-top:8px">
                ${this.skillMsg ? html`<span class="hint">${this.skillMsg}</span>` : nothing}
                <button class="ghost" @click=${() => this.closeSkill()}>关闭</button>
                <button ?disabled=${ro || isBuiltinSkill(this.selSkill)} @click=${() => void this.saveSkillNow()}>保存</button>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private async openSkill(name: string): Promise<void> {
    if (this.selSkill === name) {
      this.closeSkill();
      return;
    }
    const text = await settingsStore.readSkill(name);
    this.selSkill = name;
    this.skillText = text ?? '';
    this.skillMsg = '';
    this.requestUpdate();
  }

  private closeSkill(): void {
    this.selSkill = null;
    this.skillText = '';
    this.skillMsg = '';
    this.requestUpdate();
  }

  private async saveSkillNow(): Promise<void> {
    if (!this.selSkill) return;
    const err = await settingsStore.writeSkill(this.selSkill, this.skillText);
    this.skillMsg = err ? `保存失败:${err}` : '已保存';
    if (!err) this.fire('goder-saved');
    this.requestUpdate();
  }

  /** 删除技能(二次确认)。 */
  private async deleteSkill(name: string): Promise<void> {
    if (!this.armDelete(name)) return;
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.removeSkill(name);
    this.busyAgent = false;
    this.setAgentMsg(!err, err ? `删除失败:${err}` : `已删除技能 ${name}`);
    if (!err && this.selSkill === name) this.closeSkill();
  }

  /** 禁用/启用技能(改名 SKILL.md ↔ SKILL.md.disabled)。 */
  private async toggleSkill(name: string, disabled: boolean): Promise<void> {
    this.agentMsg = '';
    // disabled 是点击时状态:当前已禁用 ⇒ 本次动作是启用,直接作为目标启用态传入
    const err = await settingsStore.toggleSkillEnabled(name, disabled);
    this.setAgentMsg(!err, err ? `操作失败:${err}` : disabled ? `已启用技能 ${name}` : `已禁用技能 ${name}`);
  }

  /** 在线安装官方技能。 */
  private async installSkillFile(name: string): Promise<void> {
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installSkillFile(`${name}.md`);
    this.busyAgent = false;
    this.setAgentMsg(!err, err ? `安装失败:${err}` : `已安装技能 ${name}`);
  }

  /** 从任意 URL 安装 SKILL.md。 */
  private async installSkillURL(): Promise<void> {
    const name = this.newSkillName.trim();
    const url = this.newSkillUrl.trim();
    if (!name || !url) {
      this.agentMsg = '请填写技能名与 SKILL.md 的 URL';
      this.requestUpdate();
      return;
    }
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installSkillFromURL(name, url);
    this.busyAgent = false;
    if (!err) {
      this.newSkillName = '';
      this.newSkillUrl = '';
    }
    this.setAgentMsg(!err, err ? `安装失败:${err}` : `已安装技能 ${name}`);
  }
}
