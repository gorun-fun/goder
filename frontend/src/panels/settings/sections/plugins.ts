// plugins.ts — 「插件」分区:平铺卡片,只做安装与删除;
// 内置(浏览器/电脑操作/界面控制)不可删。
import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';

/** 已知内置插件的展示名;其余展示文件名。 */
function pluginLabel(name: string): string {
  const map: Record<string, string> = {
    'grf-browser': '浏览器',
    'grf-computer': '电脑操作',
    'goder-console': '界面控制',
  };
  return map[name] ?? name;
}

function isBuiltinPlugin(name: string): boolean {
  return name === 'grf-browser' || name === 'grf-computer' || name === 'goder-console';
}

@customElement('grf-settings-plugins')
export class GrfSettingsPlugins extends SettingsSectionPanel {
  static styles = [...sectionSharedCss];

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadPluginsCfg();
    void settingsStore.loadRemotePlugins();
  }

  render() {
    const pc = settingsStore.pluginsCfg;
    if (!pc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取插件配置…' : this.webAgentHint('插件配置')}</div></div>`;
    }
    // 已安装 = 自动发现目录文件 ∪ 显式列表里的本地项(command 型)。
    // Windows 的发现名带 .exe、显式列表存裸名:展示与去重统一按裸名
    // (删除走服务端 名/名.exe 双探测,均兼容)。
    const local = pc.plugins.filter((p) => !p.url).map((p) => p.name);
    const installed = Array.from(new Set([...pc.discovered.map((f) => f.replace(/\.exe$/, '')), ...local]));
    installed.sort();
    const ro = !pc.writable;
    // 服务器上可安装的 = 远端文件减去已安装(宽松匹配 grf- 前缀/.exe 后缀)
    const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/^grf-/, 'grf-');
    const installedNorm = new Set(installed.map(norm));
    const available = (settingsStore.remotePlugins?.files ?? []).filter((f) => !installedNorm.has(norm(f)));
    return html`
      <div class="sec">
        <h4>已安装</h4>
        ${installed.length
          ? html`
              <div class="tiles">
                ${installed.map((name) => {
                  const on = settingsStore.pluginEnabled(name);
                  return html`
                    <div class="tile ${on ? '' : 'off'}">
                      <div class="corner">
                        ${on ? nothing : html`<span class="tag">已禁用</span>`}
                        ${isBuiltinPlugin(name) ? html`<span class="tag">内置</span>` : nothing}
                        ${ro
                          ? nothing
                          : html`<button class="ghost" @click=${() => settingsStore.setPluginEnabled(name, !on)}>
                              ${on ? '禁用' : '启用'}
                            </button>`}
                      </div>
                      <div class="tname">${pluginLabel(name)}</div>
                      <div class="tsub">${name}</div>
                      <div class="tacts">
                        ${ro || isBuiltinPlugin(name)
                          ? nothing
                          : html`<button
                              class="ghost ${this.pendingDelete === name ? 'danger' : ''}"
                              @click=${() => void this.deletePlugin(name)}
                            >
                              ${this.pendingDelete === name ? '确认删除' : '删除'}
                            </button>`}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          : html`<div class="hint">还没有安装插件。</div>`}
        ${this.agentMsg ? html`<div class="hint">${this.agentMsg}</div>` : nothing}
      </div>
      <div class="sec">
        <h4>在线安装</h4>
        ${settingsStore.remotePlugins === null
          ? html`<div class="hint">${inWails() ? '正在查询官方下载服务器…' : '在线安装请用桌面版;网页形态经上方的插件/MCP 列表管理。'}</div>`
          : available.length
            ? html`
                <div class="tiles">
                  ${available.map(
                    (f) => html`
                      <div class="tile">
                        <div class="tname">${pluginLabel(f.replace(/\.exe$/, '').replace(/^grf-/, 'grf-'))}</div>
                        <div class="tsub">${f}</div>
                        <div class="tacts">
                          <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installPlugin(f)}>
                            ${this.busyAgent ? '安装中…' : '安装'}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : html`<div class="hint">官方下载服务器上暂无其他可安装插件。</div>`}
        <div class="hint">插件安装到 <code class="tok">${pc.dir}</code>,安装/删除后自动重启 gh server 生效。</div>
      </div>
    `;
  }

  private async installPlugin(name: string): Promise<void> {
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installPlugin(name);
    this.busyAgent = false;
    this.pendingDelete = null;
    this.setAgentMsg(!err, err ? `安装失败:${err}` : `已安装 ${name}`);
  }

  private async deletePlugin(name: string): Promise<void> {
    if (!this.armDelete(name)) return;
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.removePluginOnline(name);
    this.busyAgent = false;
    this.setAgentMsg(!err, err ? `删除失败:${err}` : `已删除 ${name}`);
  }
}
