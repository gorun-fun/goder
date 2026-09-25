// desktop.ts — 桌面 app 入口(wails webview 加载)。纯浏览器打开时同样
// 可用(降级为 localStorage 持久化 + 手动配置连接);桌面专属条目
// (终端/审查/文件)在此注册,嵌入形态不包含。
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { theme } from '../ui/theme';
import { configureScope } from '../core/store/scope';
import { settingsStore } from '../core/settings/settings-store';
import { inWails, detectDesktopHost } from '../host/bridge';
import '../shell/app-shell';
import '../shell/builtin-common';
import '../shell/builtin-desktop';
import '../panels/chat/chat-panel';

@customElement('grf-desktop')
export class GrfDesktop extends LitElement {
  @state() private ready = false;
  /** init 诊断标记(顶栏显示,定位启动链路问题) */
  @state() private initStage = 'mount';

  static styles = [
    theme,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100vh;
      }
      grf-app-shell {
        height: 100%;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    // 外观(主题/强调色/字号)从 localStorage 镜像即刻恢复
    settingsStore.initAppearance();
    void this.init();
  }

  private async init(): Promise<void> {
    // 桌面判定只看 origin 形态(wails://localhost 等,确定性信号)。
    const desktop = inWails();
    if (!desktop) {
      // 纯 web:以 scope 上次保存的连接(如有)初始化并连接。
      settingsStore.initWebConn('app');
      this.ready = true;
      this.initStage = 'done';
      // gh 侧模型配置就绪后做一次"无模型配置"守卫(读取失败/不支持则跳过)
      void settingsStore.loadModelCfg().then(() => this.guardModelSetup());
      return;
    }
    // 桌面:先把连接无阻塞切到同源代理(wails 调用通道加载初期可能挂起,
    // 不能把连接设置挡在任何 wails 调用后面);token 等桥就绪后异步补上。
    configureScope('app', { baseUrl: `${location.origin}/grf-api`, token: '' });
    this.initStage = 'proxy';
    void this.bootstrapDesktop();
  }

  // bootstrapDesktop 桌面态异步引导:冷启动连接只走同源 /grf-api/token
  // (纯 fetch,零 wails 依赖;Go 侧已在启动时自行拉起托管 gh)。桥与
  // 配置读取延后懒做,失败不影响连接。
  private async bootstrapDesktop(): Promise<void> {
    try {
      for (let i = 0; i < 30; i++) {
        try {
          // 注意:勿用 cache:'no-store' —— WKWebView 自定义 scheme 对该
          // 缓存模式的请求可能被直接丢弃(请求不达 Go 侧)。
          const r = await fetch(`${location.origin}/grf-api/token`);
          if (r.ok) {
            const info = (await r.json()) as { mode: string; running?: boolean; token?: string };
            // 托管模式:令牌由 app 内同源代理注入,浏览器侧留空即可就绪;
            // 远程模式:仍需配置里的令牌(浏览器自带)。
            const ok =
              (info.mode === 'managed' && info.running) ||
              (info.mode !== 'managed' && !!info.token);
            this.initStage = `proxy:${info.mode}:${info.running ? 1 : 0}:${info.token ? 1 : 0}`;
            if (ok) {
              this.ready = true;
              this.initStage = 'done';
              break;
            }
          } else {
            this.initStage = `proxy:http${r.status}`;
          }
        } catch (e) {
          this.initStage = `proxy:err:${e instanceof Error ? e.message.slice(0, 24) : '?'}`;
        }
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      // 桥就绪后:项目索引切文件持久化、读配置、确保托管 server 运行;
      // 懒做不阻塞。配置就绪后做一次"无模型配置"守卫。
      void settingsStore.loadFromBridge('app').then(() => this.guardModelSetup());
    } catch {
      this.initStage = 'error';
    }
  }

  /** 启动模型守卫:gh 侧没有任何可用模型(供应商列表为空或全都没有
   * 模型)时,自动进入设置的模型分区引导完成配置 —— 此时发送只会收到
   * 服务端报错,不如直接把用户带到配置页。读取失败(桥不可达 / gh 过旧
   * 不支持 agent API)时 modelCfg 为 null,视为未知、不误判。与
   * chat-panel 发送时的模型守卫(modelReady)同一落地路径。 */
  private guardModelSetup(): void {
    const mc = settingsStore.modelCfg;
    if (!mc) return;
    const hasModel = (mc.providers ?? []).some((p) => (p.models ?? []).length > 0);
    if (hasModel) return;
    void this.updateComplete.then(() => {
      const shell = this.renderRoot.querySelector('grf-app-shell');
      shell?.dispatchEvent(new CustomEvent('grf-open-settings', { bubbles: true, composed: true }));
      shell?.dispatchEvent(new CustomEvent('grf-settings-section', { detail: 'models', bubbles: true, composed: true }));
    });
  }

  render() {
    return html`<grf-app-shell scope="app"></grf-app-shell>`;
  }
}

// 挂载。挂载前先做桌面宿主探测(test-serve 无头测试态的 127.0.0.1
// origin 由此识别;wails/goder.localhost origin 探测即时返回,不发请求)
// —— 必须先于 UI 挂载完成,否则面板可见性守卫(inWails)会取到 false。
const mount = () => {
  void detectDesktopHost().then(() => {
    const el = document.createElement('grf-desktop');
    document.body.appendChild(el);
  });
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
