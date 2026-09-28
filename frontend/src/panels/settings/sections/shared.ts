// shared.ts — 内置设置分区组件的公共基类与共享样式。
// 分区组件(appearance/models/harness/plugins/mcp/skills)经
// registry.settings 注册,builtin-common 的 render 返回池化的组件元素
// (settings-page 的 HTMLElement 保活通道,跨分区切换不丢内部状态)。
// 基类职责:订阅 settingsStore 驱动重渲、通用提交(保存后上抛
// grf-saved 让设置页头部闪「已保存」)、网页形态回落文案、二次确认
// 删除布防、智能体操作忙碌态。
import { css } from 'lit';
import { state } from 'lit/decorators.js';
import { GrfPanel, theme, controls } from '../../../ui/panel';
import { settingsStore } from '../../../core/settings/settings-store';

/** 分区组件共享样式:区块标题/表单/分段按钮/提示行 + 平铺卡片
 * (插件/技能)+ 卡片式详情(models/mcp 共用的 .prov 系)。 */
export const sectionSharedCss = [
  theme,
  controls,
  css`
    :host {
      /* 复刻设置页 .body 的区块间距(26px;分区模板为多根 .sec 节点) */
      display: grid;
      gap: 26px;
      align-content: start;
      font-family: var(--grf-font);
      font-size: var(--grf-font-size);
      color: var(--grf-text);
    }
    .sec {
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .sec h4 {
      margin: 0;
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
    }
    .hint {
      font-size: var(--grf-font-size-xs);
      color: var(--grf-text-faint);
      line-height: 1.7;
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
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    code.tok {
      font-family: var(--grf-mono);
      font-size: 10px;
      background: var(--grf-bg);
      padding: 1px 5px;
      border-radius: 4px;
      user-select: all;
    }
    /* 平铺卡片(插件/技能):网格布局,安装与删除为主 */
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 10px;
    }
    .tile {
      position: relative;
      border: 1px solid var(--grf-border);
      border-radius: var(--grf-radius);
      background: var(--grf-bg-raise);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .tile .corner {
      position: absolute;
      top: 6px;
      right: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tile .tacts {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      margin-top: auto;
      padding-top: 6px;
      min-height: 24px;
    }
    .tile .tname {
      max-width: calc(100% - 64px);
      font-size: var(--grf-font-size-sm);
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tile.on {
      border-color: var(--grf-accent);
      background: var(--grf-accent-soft);
    }
    .tile.off {
      opacity: 0.55;
    }
    .tile.off .tname {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }
    .tile .tsub {
      font-size: var(--grf-font-size-xs);
      color: var(--grf-text-faint);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tile .tag {
      font-size: var(--grf-font-size-xs);
      color: var(--grf-text-dim);
      background: var(--grf-bg);
      border: 1px solid var(--grf-border);
      border-radius: 999px;
      padding: 1px 7px;
    }
    /* 卡片式详情(models 的供应商卡片 / mcp 的端点卡片) */
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
    .prov-body {
      border-top: 1px solid var(--grf-border-soft);
      padding: 10px;
      display: grid;
      gap: 10px;
    }
    .prov-body .fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .prov-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    /* 行内输入行(模型列表 / 技能 URL 安装) */
    .mrow {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      border-radius: var(--grf-radius-sm);
      border: 1px solid transparent;
      font-size: var(--grf-font-size-sm);
      color: var(--grf-text-dim);
    }
    .mrow:hover {
      background: var(--grf-bg-hover);
    }
    .mrow .minput {
      flex: 1;
      min-width: 0;
      font-family: var(--grf-mono);
      font-size: var(--grf-font-size-sm);
      padding: 3px 8px;
    }
    .mrow .mdel {
      flex: none;
      padding: 2px 7px;
      font-size: var(--grf-font-size-sm);
    }
    .mrow .mhint {
      flex: none;
      font-size: var(--grf-font-size-xs);
      color: var(--grf-text-faint);
      user-select: none;
    }
  `,
];

/** 内置设置分区组件基类(抽象,不注册自定义元素)。 */
export class SettingsSectionPanel extends GrfPanel {
  private storeUnsub?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.storeUnsub = settingsStore.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    this.storeUnsub?.();
    this.storeUnsub = undefined;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = undefined;
    super.disconnectedCallback();
  }

  /** 通用提交:改配置 → 保存落盘 → 上抛 grf-saved(设置页头部闪提示)。 */
  protected commit(patch: Parameters<typeof settingsStore.patchCfg>[0]): void {
    settingsStore.patchCfg(patch);
    void settingsStore.saveCfg(this.scope).then(() => this.fire('grf-saved'));
  }

  /** 网页形态配置区回落文案:gh 过旧不支持 vs 读取中/失败。 */
  protected webAgentHint(what: string): string {
    return settingsStore.agentApi === 'unsupported'
      ? `当前 gh server 版本过旧,暂不支持网页管理${what}(升级 gh server 后可用)。`
      : `正在读取${what}…(长时间无响应请检查上方服务连接)`;
  }

  /** 二次确认删除:首次点击布防(3s 内再点才算确认)。
   * 返回 true = 已确认,调用方执行删除;false = 刚布防,仅重渲染。 */
  @state() protected pendingDelete: string | null = null;
  private deleteTimer?: ReturnType<typeof setTimeout>;

  protected armDelete(name: string): boolean {
    if (this.pendingDelete !== name) {
      this.pendingDelete = name;
      this.requestUpdate();
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => {
        this.pendingDelete = null;
        this.requestUpdate();
      }, 3000);
      return false;
    }
    this.pendingDelete = null;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = undefined;
    return true;
  }

  /** 智能体扩展操作(安装/删除)忙碌态与结果提示(插件/技能分区)。 */
  @state() protected busyAgent = false;
  @state() protected agentMsg = '';

  protected setAgentMsg(ok: boolean, msg: string): void {
    if (ok) this.fire('grf-saved');
    this.agentMsg = msg;
    this.requestUpdate();
  }
}
