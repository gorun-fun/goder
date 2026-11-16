// cluster.ts — 「集群」分区:gh 集群模式配置(指挥官/节点/节点表/
// 同步档/邀请码)+ 节点状态面板(成员表/收件箱在线/远端句柄,挂载期
// 5s 轮询 /v1/agent/cluster/status)。双形态统一走 gh server API(桌面经
// /goder-api 同源反代);配置即时保存(整体替换 PUT),桌面托管态保存后
// 防抖重启生效(settings-store 的 scheduleClusterRestart),web 态提示需
// 服务端重启。枚举校验权威在 gh 服务端,本组件不复制第二套校验语义。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore } from '../../../core/settings/settings-store';
import { inWails } from '../../../host/bridge';
import type { ClusterCfgDTO, ClusterMemberDTO } from '../../../core/api/agent-dto';

@customElement('goder-settings-cluster')
export class GoderSettingsCluster extends SettingsSectionPanel {
  /** 状态轮询(挂载期起、卸载即停;未启用/旧 gh 时服务端响应同样轻量) */
  private statusTimer?: ReturnType<typeof setInterval>;
  /** 展开能力明细的成员名(点成员行切换) */
  @state() private openMember: string | null = null;

  static styles = [
    ...sectionSharedCss,
    css`
      .row2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      /* 节点表条目:头部名称地址 + 常开字段体 */
      .node .prov-body {
        grid-template-columns: none;
      }
      .node .fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      /* 成员行:状态点 + 名字 + 徽标 + 右侧在跑数 */
      .mem {
        border: 1px solid var(--goder-border);
        border-radius: var(--goder-radius);
        background: var(--goder-bg-raise);
        padding: 8px 10px;
      }
      .mem-head {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      .dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--goder-text-faint);
      }
      .dot.online {
        background: var(--goder-success);
      }
      .dot.unknown {
        background: var(--goder-warn);
      }
      .mem .mname {
        font-weight: 650;
        font-size: var(--goder-font-size-sm);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mem .meta {
        margin-left: auto;
        flex: none;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
      }
      .mem-body {
        border-top: 1px solid var(--goder-border-soft);
        margin-top: 8px;
        padding-top: 8px;
        display: grid;
        gap: 4px;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-dim);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chips .chip {
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-dim);
        background: var(--goder-bg);
        border: 1px solid var(--goder-border);
        border-radius: 999px;
        padding: 1px 7px;
      }
      .err {
        border: 1px solid var(--goder-warn);
        background: var(--goder-warn-soft);
        color: var(--goder-text);
        border-radius: var(--goder-radius);
        padding: 8px 10px;
        font-size: var(--goder-font-size-xs);
      }
      @media (max-width: 560px) {
        .row2,
        .node .fields {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void settingsStore.loadClusterCfg();
    void settingsStore.refreshClusterStatus();
    this.statusTimer = setInterval(() => void settingsStore.refreshClusterStatus(), 5000);
  }

  disconnectedCallback(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    super.disconnectedCallback();
  }

  /** 当前内存中的集群段(loadClusterCfg 后非 null 分支才渲染表单) */
  private get cfg(): ClusterCfgDTO {
    return settingsStore.clusterCfg?.cluster ?? {};
  }

  /** 即时修改并保存(fn 返回新段;浅拷贝上做不可变更新) */
  private patch(fn: (c: ClusterCfgDTO) => ClusterCfgDTO): void {
    settingsStore.patchCluster(fn);
    this.fire('goder-saved');
  }

  private patchRoute(allowLocal: boolean, maxInflight: number): void {
    this.patch((c) => ({
      ...c,
      route: { allow_local: allowLocal, max_inflight_per_node: maxInflight > 0 ? maxInflight : undefined },
    }));
  }

  render() {
    if (settingsStore.clusterApi === 'unsupported') {
      return html`<div class="sec"><h4>集群</h4><div class="hint">${this.webAgentHint('集群配置')}</div></div>`;
    }
    const env = settingsStore.clusterCfg;
    if (!env) {
      return html`<div class="sec"><h4>集群</h4><div class="hint">正在读取集群配置…</div></div>`;
    }
    const ro = !env.writable;
    const c = this.cfg;
    const isCommander = (c.role ?? 'node') === 'commander';
    return html`
      ${settingsStore.clusterErr
        ? html`<div class="err">保存失败:${settingsStore.clusterErr}(未生效,修正后再次修改即重试)</div>`
        : nothing}
      <div class="sec">
        <h4>集群模式</h4>
        <div class="seg">
          <button class=${c.enabled ? 'on' : ''} ?disabled=${ro} @click=${() => this.patch((s) => ({ ...s, enabled: true }))}>
            启用
          </button>
          <button class=${!c.enabled ? 'on' : ''} ?disabled=${ro} @click=${() => this.patch((s) => ({ ...s, enabled: false }))}>
            停用
          </button>
        </div>
        <div class="seg">
          <button class=${isCommander ? 'on' : ''} ?disabled=${ro} @click=${() => this.patch((s) => ({ ...s, role: 'commander' }))}>
            指挥官
          </button>
          <button class=${!isCommander ? 'on' : ''} ?disabled=${ro} @click=${() => this.patch((s) => ({ ...s, role: 'node' }))}>
            节点
          </button>
        </div>
        <div class="row2">
          <label>
            节点名(空 = 主机名)
            <input
              type="text"
              .value=${c.name ?? ''}
              ?disabled=${ro}
              @change=${(e: InputEvent) => this.patch((s) => ({ ...s, name: (e.target as HTMLInputElement).value }))}
            />
          </label>
          <label>
            工作区同步(sync)
            <select
              .value=${c.sync ?? ''}
              ?disabled=${ro}
              @change=${(e: Event) => this.patch((s) => ({ ...s, sync: (e.target as HTMLSelectElement).value }))}
            >
              <option value="">任务自包含(关)</option>
              <option value="seed">seed:按需点名文件</option>
              <option value="git">git:自动打包 git 跟踪文件</option>
              <option value="full">full:自动打包整个工作区</option>
            </select>
          </label>
        </div>
        ${isCommander
          ? html`
              <div class="row2">
                <label>
                  局域网发现(discover)
                  <select
                    .value=${c.discover ?? 'off'}
                    ?disabled=${ro}
                    @change=${(e: Event) => this.patch((s) => ({ ...s, discover: (e.target as HTMLSelectElement).value }))}
                  >
                    <option value="off">关</option>
                    <option value="lan">开(mDNS)</option>
                  </select>
                </label>
                <label>
                  派发默认策略(policy)
                  <select
                    .value=${c.policy ?? ''}
                    ?disabled=${ro}
                    @change=${(e: Event) => this.patch((s) => ({ ...s, policy: (e.target as HTMLSelectElement).value }))}
                  >
                    <option value="">未设置(节点默认)</option>
                    <option value="write-workspace">工作区(仅工作区内可写)</option>
                    <option value="off">完全控制(不限制)</option>
                  </select>
                </label>
              </div>
              <div class="row2">
                <label>
                  无匹配节点回退本地
                  <select
                    .value=${c.route?.allow_local === false ? 'no' : 'yes'}
                    ?disabled=${ro}
                    @change=${(e: Event) =>
                      this.patchRoute((e.target as HTMLSelectElement).value === 'yes', c.route?.max_inflight_per_node ?? 0)}
                  >
                    <option value="yes">回退本地执行</option>
                    <option value="no">报错(强制显式路由)</option>
                  </select>
                </label>
                <label>
                  单节点在跑上限(0 = 默认 4)
                  <input
                    type="number"
                    min="0"
                    .value=${String(c.route?.max_inflight_per_node ?? 0)}
                    ?disabled=${ro}
                    @change=${(e: InputEvent) =>
                      this.patchRoute(c.route?.allow_local !== false, Number((e.target as HTMLInputElement).value) || 0)}
                  />
                </label>
              </div>
            `
          : nothing}
        ${!isCommander
          ? html`
              <label>
                指挥官地址(commander_url)
                <input
                  type="text"
                  placeholder="http://host:port"
                  .value=${c.commander_url ?? ''}
                  ?disabled=${ro}
                  @change=${(e: InputEvent) => this.patch((s) => ({ ...s, commander_url: (e.target as HTMLInputElement).value }))}
                />
              </label>
            `
          : nothing}
        <div class="hint">
          写入 <code class="tok">${env.path}</code> 的 cluster 段。${inWails()
            ? '保存后自动重启托管 gh server 生效(连续修改合并为一次重启)。'
            : '配置需重启 gh server 后生效。'}多台设备共用同一集群密钥:指挥官可把任务派发给节点(subagent 描述命中 @节点名 或标签即路由)。
        </div>
      </div>
      <div class="sec">
        <h4>共享凭据</h4>
        <div class="row2">
          <label>
            集群密钥(token)
            <input
              type="password"
              .value=${c.token ?? ''}
              ?disabled=${ro}
              @change=${(e: InputEvent) => this.patch((s) => ({ ...s, token: (e.target as HTMLInputElement).value }))}
            />
          </label>
          <label>
            邀请码(invite_code)
            <input
              type="password"
              .value=${c.invite_code ?? ''}
              ?disabled=${ro}
              @change=${(e: InputEvent) => this.patch((s) => ({ ...s, invite_code: (e.target as HTMLInputElement).value }))}
            />
          </label>
        </div>
        <div class="hint">
          集群密钥等同集群级全权,与 server 访问令牌同级保密。邀请码在指挥官侧配置后,新节点注册/心跳必须携带才能准入;节点侧作为注册凭据上送。
        </div>
      </div>
      ${isCommander ? this.renderNodes(ro) : nothing} ${this.renderStatus()}
    `;
  }

  /** 手动节点表(指挥官侧静态种子;@name/labels 命中即派往该节点) */
  private renderNodes(ro: boolean) {
    const nodes = this.cfg.nodes ?? [];
    return html`
      <div class="sec">
        <h4>节点表</h4>
        ${nodes.map((n, i) => {
          const upd = (patch: Partial<(typeof nodes)[number]>) =>
            this.patch((s) => ({ ...s, nodes: (s.nodes ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
          const name = n.name || n.addr;
          return html`
            <div class="prov node">
              <div class="prov-head">
                <span class="pname">${name || '(未填写地址)'}</span>
                <span class="meta">${(n.labels ?? []).join(' ')}</span>
                <button
                  class="ghost danger"
                  ?disabled=${ro}
                  @click=${() => {
                    if (!this.armDelete(name)) return;
                    this.patch((s) => ({ ...s, nodes: (s.nodes ?? []).filter((_, j) => j !== i) }));
                    this.pendingDelete = null;
                  }}
                >
                  ${this.pendingDelete === name ? '确认删除' : '删除'}
                </button>
              </div>
              <div class="prov-body">
                <div class="fields">
                  <label>
                    地址(host:port)
                    <input
                      type="text"
                      .value=${n.addr}
                      ?disabled=${ro}
                      @change=${(e: InputEvent) => upd({ addr: (e.target as HTMLInputElement).value.trim() })}
                    />
                  </label>
                  <label>
                    节点名(@name 路由名,空取地址主机名)
                    <input
                      type="text"
                      .value=${n.name ?? ''}
                      ?disabled=${ro}
                      @change=${(e: InputEvent) => upd({ name: (e.target as HTMLInputElement).value.trim() })}
                    />
                  </label>
                  <label>
                    令牌(该节点 server token)
                    <input
                      type="password"
                      .value=${n.token ?? ''}
                      ?disabled=${ro}
                      @change=${(e: InputEvent) => upd({ token: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    标签(逗号分隔,description 词汇匹配路由)
                    <input
                      type="text"
                      .value=${(n.labels ?? []).join(',')}
                      ?disabled=${ro}
                      @change=${(e: InputEvent) =>
                        upd({
                          labels: (e.target as HTMLInputElement)
                            .value.split(',')
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })}
                    />
                  </label>
                  <label>
                    TLS 指纹 pin(sha256 hex,空走系统校验)
                    <input
                      type="text"
                      .value=${n.pin ?? ''}
                      ?disabled=${ro}
                      @change=${(e: InputEvent) => upd({ pin: (e.target as HTMLInputElement).value.trim() })}
                    />
                  </label>
                </div>
              </div>
            </div>
          `;
        })}
        <div>
          <button
            class="ghost"
            ?disabled=${ro}
            @click=${() => this.patch((s) => ({ ...s, nodes: [...(s.nodes ?? []), { addr: '' }] }))}
          >
            添加节点
          </button>
        </div>
        <div class="hint">派发直达该节点的 ORS 端点(需该节点的 server 访问令牌);https 自签部署时填证书指纹 pin 即免私有 CA。</div>
      </div>
    `;
  }

  /** 节点状态面板(/v1/agent/cluster/status 快照) */
  private renderStatus() {
    const st = settingsStore.clusterStatus;
    if (!st?.enabled) return nothing;
    const members = st.members ?? [];
    const handles = st.remote_handles ?? [];
    const inbox = st.inbox_connected ?? [];
    const selfName = st.self?.name || '本节点';
    return html`
      <div class="sec">
        <h4>节点状态</h4>
        <div class="hint">
          ${selfName} · ${st.self?.version ?? ''} · ${st.self?.platform ?? ''} · 在跑回合 ${st.running_turns}${st.invite_required
            ? ' · 邀请码门已启用'
            : ''}${st.discover === 'lan' ? ' · 局域网发现开启' : ''}
        </div>
        ${members.length
          ? members.map((m) => this.renderMember(m))
          : html`<div class="hint">成员表为空:${st.role === 'commander' ? '尚无节点接入(检查节点侧指挥官地址与密钥)。' : '本节点为 node 角色,权威成员表在指挥官侧——请在指挥官的此面板查看。'}</div>`}
        ${inbox.length
          ? html`
              <div>
                <div class="hint" style="margin-bottom:4px">收件箱在线(可经中继派发):</div>
                <div class="chips">${inbox.map((n) => html`<span class="chip">${n}</span>`)}</div>
              </div>
            `
          : nothing}
        ${handles.length
          ? html`
              <div>
                <div class="hint" style="margin-bottom:4px">远端句柄(本方派发到节点的在跑任务):</div>
                ${handles.map(
                  (h) => html`
                    <div class="mem">
                      <div class="mem-head">
                        <span class="dot ${h.status === 'running' ? 'online' : ''}"></span>
                        <span class="mname">${h.label || h.id}</span>
                        ${h.relay ? html`<span class="chip">中继</span>` : nothing}
                        <span class="meta">${h.node} · ${h.status === 'running' ? '运行中' : '空闲'}</span>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderMember(m: ClusterMemberDTO) {
    const open = this.openMember === m.name;
    const caps = m.capabilities;
    const srcLabel = { static: '手动', registered: '注册', mdns: '发现' }[m.source] ?? m.source;
    return html`
      <div class="mem">
        <div
          class="mem-head"
          @click=${() => {
            this.openMember = open ? null : m.name;
          }}
        >
          <span class="dot ${m.status}"></span>
          <span class="mname">${m.name}</span>
          <span class="chip">${srcLabel}</span>
          ${(m.labels ?? []).slice(0, 3).map((l) => html`<span class="chip">${l}</span>`)}
          <span class="meta">在跑 ${m.running_turns ?? 0}${caps?.models?.length ? ` · ${caps.models.length} 模型` : ''}</span>
        </div>
        ${open
          ? html`
              <div class="mem-body">
                ${m.addr ? html`<div>地址:${m.addr}</div>` : nothing}
                ${caps
                  ? html`
                      <div>gh ${caps.version} · ${caps.platform}</div>
                      ${caps.models?.length ? html`<div>模型:${caps.models.join('、')}</div>` : nothing}
                      ${caps.plugins?.length
                        ? html`<div>插件:${caps.plugins.map((p) => `${p.name}(${p.tools})`).join('、')}</div>`
                        : nothing}
                    `
                  : html`<div>能力清单未上报(离线节点只保留最近一次快照)。</div>`}
                ${m.last_seen ? html`<div>最近心跳:${new Date(m.last_seen * 1000).toLocaleString()}</div>` : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
