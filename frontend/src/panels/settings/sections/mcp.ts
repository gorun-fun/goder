// mcp.ts — 「MCP」分区:远程 MCP 端点(plugins 数组的 url/token 项)。
// 远程 MCP 依赖显式列表:自动发现模式下先切换(切换时带入已发现的
// 本地插件,避免显式列表为空导致全部停用)。
import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';
import { icon } from '../../../util/icons';
import type { PluginDTO } from '../../../host/bridge';

@customElement('grf-settings-mcp')
export class GrfSettingsMcp extends SettingsSectionPanel {
  static styles = [...sectionSharedCss];

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadPluginsCfg();
  }

  render() {
    const pc = settingsStore.pluginsCfg;
    if (!pc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取 MCP 配置…' : this.webAgentHint('MCP 配置')}</div></div>`;
    }
    const ro = !pc.writable;
    // command 为空的项也算远程卡片:新添加的端点(url 尚未填)立即显示。
    const remotes = pc.plugins.filter((p) => p.url || p.command.length === 0);
    if (!pc.explicit) {
      return html`
        <div class="sec">
          <h4>MCP</h4>
          <div class="hint">
            当前为自动发现模式(只加载本地插件目录)。添加远程 MCP 端点需要切换为显式列表。
          </div>
          <button
            ?disabled=${ro}
            @click=${() =>
              settingsStore.updatePlugins({
                explicit: true,
                // 切换时把已发现的本地插件一并带入,避免显式列表为空导致全部停用
                // (条目名用裸名,command 指向目录里的真实文件,Windows 带 .exe)
                plugins: [
                  ...pc.plugins,
                  ...pc.discovered
                    .filter((f) => !pc.plugins.some((x) => x.name === f.replace(/\.exe$/, '')))
                    .map((f) => ({
                      name: f.replace(/\.exe$/, ''),
                      command: [`${pc.dir}/${f}`],
                      url: '',
                      token: '',
                      timeout: 0,
                    })),
                ],
              })}
          >
            切换为显式列表
          </button>
        </div>
      `;
    }
    return html`
      <div class="sec">
        <h4>远程 MCP 端点</h4>
        ${remotes.length
          ? remotes.map((p) => this.renderMcpCard(p, ro))
          : html`<div class="hint">还没有远程 MCP 端点。</div>`}
        ${ro
          ? nothing
          : html`<button @click=${() => this.addMcp()}>${unsafeHTML(icon.plus)} 添加 MCP 端点</button>`}
        <div class="hint">
          远程 MCP 经 Streamable HTTP 接入(写入 settings.json 的 plugins 数组);本地 stdio
          型 MCP 在「插件」分区用启动命令接入。保存后自动重启 gh server 生效。
        </div>
      </div>
    `;
  }

  private renderMcpCard(p: PluginDTO, ro: boolean) {
    return html`
      <div class="prov">
        <div class="prov-head">
          <span class="pname">${p.name}</span>
          <span class="tag">远程</span>
          ${ro
            ? nothing
            : html`<button
                class="ghost ${this.pendingDelete === p.name ? 'danger' : ''}"
                style="margin-left:auto"
                @click=${() => void this.deleteMcp(p.name)}
              >
                ${this.pendingDelete === p.name ? '确认删除' : '删除'}
              </button>`}
        </div>
        <div class="prov-body">
          <div class="fields">
            <label>
              名称
              <input
                type="text"
                .value=${p.name}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.renameMcp(p.name, (e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              超时(秒,0=默认)
              <input
                type="number"
                min="0"
                .value=${String(p.timeout || 0)}
                ?disabled=${ro}
                @change=${(e: InputEvent) =>
                  settingsStore.updatePlugin(p.name, { timeout: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
              />
            </label>
          </div>
          <label>
            URL(Streamable HTTP 端点)
            <input
              type="text"
              .value=${p.url}
              placeholder="https://mcp.example.com/mcp"
              ?disabled=${ro}
              @change=${(e: InputEvent) => settingsStore.updatePlugin(p.name, { url: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label>
            Bearer Token
            <input
              type="password"
              .value=${p.token}
              placeholder=${!inWails() && p.hasToken ? '已设置(留空保留,输入更换)' : ''}
              ?disabled=${ro}
              @change=${(e: InputEvent) => settingsStore.updatePlugin(p.name, { token: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
      </div>
    `;
  }

  private addMcp(): void {
    const pc = settingsStore.pluginsCfg!;
    let i = 1;
    let name = 'new-mcp';
    while (pc.plugins.some((x) => x.name === name)) name = `new-mcp-${++i}`;
    settingsStore.addPlugin({ name, command: [], url: '', token: '', timeout: 0 });
  }

  /** MCP 端点重命名(摘旧加新,保存时自动重启)。 */
  private renameMcp(oldName: string, raw: string): void {
    const to = raw.trim();
    const pc = settingsStore.pluginsCfg!;
    if (!to || to === oldName || pc.plugins.some((x) => x.name === to)) {
      this.requestUpdate();
      return;
    }
    settingsStore.removePlugin(oldName);
    const src = pc.plugins.find((x) => x.name === oldName);
    settingsStore.addPlugin({ ...(src as PluginDTO), name: to });
    this.pendingDelete = null;
  }

  /** 删除 MCP 端点(二次确认)。 */
  private async deleteMcp(name: string): Promise<void> {
    if (!this.armDelete(name)) return;
    settingsStore.removePlugin(name);
  }
}
