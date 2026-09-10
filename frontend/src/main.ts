// main.ts — 桌面 app 入口(wails webview 加载)。纯浏览器打开时同样可用
// (降级为 localStorage 持久化 + 手动配置连接)。
// 偏好设置不再是模态弹窗:app-shell 内置"工作 / 设置"双视图,配置与
// 外观状态收敛在 state/settings.ts 的 settingsStore。
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './shell/app-shell';
import './panels/chat/chat-panel';
import './panels/session-list';
import './panels/sidebar';
import './panels/review';
import './panels/browser';
// 终端面板仅桌面形态注册(xterm 依赖只进桌面构建;嵌入产物不含)。
import './panels/terminal';
import { theme } from './ui/base';
import { configureScope } from './state/scope';
import { settingsStore } from './state/settings';
import { inWails } from './host/bridge';

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
            const ok =
              (info.mode === 'managed' && info.running && info.token) ||
              (info.mode !== 'managed' && !!info.token);
            this.initStage = `proxy:${info.mode}:${info.running ? 1 : 0}:${info.token ? 1 : 0}`;
            if (ok) {
              configureScope('app', { token: info.token! });
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
      // 桥就绪后:项目索引切文件持久化、读配置、确保托管 server 运行、
      // 应用默认模型;懒做不阻塞。
      void settingsStore.loadFromBridge('app');
    } catch {
      this.initStage = 'error';
    }
  }

  render() {
    return html`<grf-app-shell scope="app"></grf-app-shell>`;
  }
}

// 挂载
const mount = () => {
  const el = document.createElement('grf-desktop');
  document.body.appendChild(el);
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
