// harness.ts — 「Harness」分区:服务与连接 + gh 常用设置(max_steps/
// policy)。桌面态 4s 轮询服务状态(组件挂载期起、卸载即停;无手动
// 启停入口,托管进程由桌面壳自动拉起保活)。
import { css, html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';

@customElement('goder-settings-harness')
export class GoderSettingsHarness extends SettingsSectionPanel {
  private srvTimer?: ReturnType<typeof setInterval>;

  static styles = [
    ...sectionSharedCss,
    css`
      label {
        margin-bottom: 12px;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadModelCfg();
    this.srvTimer = setInterval(() => {
      if (inWails()) void settingsStore.refreshServerStatus();
    }, 4000);
  }

  disconnectedCallback(): void {
    if (this.srvTimer) clearInterval(this.srvTimer);
    this.srvTimer = undefined;
    super.disconnectedCallback();
  }

  render() {
    const cfg = settingsStore.cfg;
    if (!inWails()) {
      // 纯 web 态:无托管,允许配置直连地址(注意 gh server 无 CORS 头,
      // 浏览器直连需经同源反代,如 goder-serve 的 /goder-api)。
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
            CORS 头,直连需经同源反代(如 goder-serve 的 /goder-api)。
          </div>
        </div>
        ${this.renderGhSettings()}
      `;
    }
    return html`
      <div class="sec">
        <h4>服务</h4>
        <div class="seg" style="margin-bottom:12px">
          <button class=${cfg.serverMode === 'managed' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'managed' })}>
            本地
          </button>
          <button class=${cfg.serverMode === 'remote' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'remote' })}>
            远程
          </button>
        </div>
        ${cfg.serverMode === 'managed'
          ? html`<div class="hint">本地模式使用内置托管的 gh server,无需任何设置。</div>`
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
      ${this.renderGhSettings()}
    `;
  }

  /** gh settings.json 常用设置(max_steps / mouse / policy);桌面经桥、
   * 网页经 gh server agent API(配置随登录用户隔离)。 */
  private renderGhSettings() {
    if (!inWails() && !settingsStore.modelCfg) return nothing; // 未就绪/不支持
    const mc = settingsStore.modelCfg;
    if (!mc) {
      return html`<div class="sec"><h4>gh 设置</h4><div class="hint">正在读取 gh 配置…</div></div>`;
    }
    const ro = !mc.writable;
    return html`
      <div class="sec">
        <h4>gh 设置</h4>
        <label>
          最大步数(max_steps)
          <select
            .value=${mc.maxSteps != null ? String(mc.maxSteps) : ''}
            ?disabled=${ro}
            @change=${(e: Event) => {
              const raw = (e.target as HTMLSelectElement).value;
              // 空值 = 无限制:不写 max_steps 键,沿用文件原值或省略
              settingsStore.updateGhSettings({ maxSteps: raw === '' ? null : Number(raw) });
            }}
          >
            <option value="">无限制</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <!-- 文件里存在列表外的旧值时原样带出,避免保存时静默篡改 -->
            ${mc.maxSteps != null && ![50, 100, 200].includes(mc.maxSteps)
              ? html`<option value=${String(mc.maxSteps)} selected>${mc.maxSteps}(原值)</option>`
              : nothing}
          </select>
        </label>
        <label>
          权限策略
          <select
            .value=${mc.policy || 'write-workspace'}
            ?disabled=${ro}
            @change=${(e: Event) => settingsStore.updateGhSettings({ policy: (e.target as HTMLSelectElement).value })}
          >
            <option value="write-workspace">工作区(仅工作区内可写)</option>
            <option value="off">完全控制(不限制)</option>
            <!-- 文件里存在映射外的旧值时原样带出,避免保存时静默篡改 -->
            ${mc.policy && mc.policy !== 'write-workspace' && mc.policy !== 'off'
              ? html`<option value=${mc.policy} selected>${mc.policy}(原值)</option>`
              : nothing}
          </select>
        </label>
        <div class="hint">
          写入 <code class="tok">${mc.path}</code>,与终端 gh 共用;清空即沿用文件原值或省略该键。gh server 运行中时,部分改动需重启服务后生效。
        </div>
      </div>
    `;
  }
}
