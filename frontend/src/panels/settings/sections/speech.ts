// speech.ts — 「语音输入」分区:话筒转文字的转写接口配置。
// 通道为 OpenAI 兼容 /audio/transcriptions(composer 话筒录音从浏览器直传
// 该接口,不经 gh server/网关;双形态同一套)。配置纯 KV 镜像(与外观
// 同款,改即存),enabled 开关控制输入框话筒按钮的显隐(默认关闭,
// 嵌入三方界面零变化)。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore, formatSpeechHotkey } from '../../../core/settings/settings-store';
import type { SpeechConfig } from '../../../core/settings/settings-store';
import { detectTranscribeModels, filterTranscribeModels, recorderSupported } from '../../../core/speech/record';
import { speechRelayBase } from '../../../host/bridge';

@customElement('goder-settings-speech')
export class GoderSettingsSpeech extends SettingsSectionPanel {
  static styles = [
    ...sectionSharedCss,
    css`
      /* 状态提示行(启用但未配全/环境不支持录音) */
      .warn {
        color: var(--goder-danger, #d33);
      }
      /* 模型行:输入框 + 「检测」按钮并排(检测拉 /models 填候选) */
      .model-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .model-row input {
        flex: 1;
        min-width: 0;
      }
      .model-row button {
        flex: none;
      }
    `,
  ];

  /** 「检测」拉到的模型候选(优先转写类;无命中回落全量),供 datalist */
  @state() private modelOptions: string[] = [];

  render() {
    const sp = settingsStore.speech;
    // 就绪只看接口地址:内网自建网关常无鉴权,API Key 允许留空
    const ready = !!sp.apiBaseUrl.trim();
    return html`
      <div class="sec">
        <h4>语音输入</h4>
        <div class="seg">
          <button class=${sp.enabled ? '' : 'on'} @click=${() => this.save({ enabled: false })}>关闭</button>
          <button class=${sp.enabled ? 'on' : ''} @click=${() => this.save({ enabled: true })}>启用</button>
        </div>
        <div class="hint">
          启用后聊天输入框出现话筒按钮:点击开始录音,再点一次结束并转写为文字落回输入框(Esc 取消);也可用下方配置的快捷键在输入框内直接切换录音。识别由下方转写接口完成。
        </div>
        ${sp.enabled && !ready
          ? html`<div class="hint warn">已启用但接口地址未填:补全后输入框才显示话筒按钮。</div>`
          : nothing}
        ${sp.enabled && ready && !recorderSupported()
          ? html`<div class="hint warn">当前环境不支持录音(需 HTTPS 页面与麦克风权限),话筒按钮暂不可用。</div>`
          : nothing}
      </div>
      <div class="sec">
        <h4>转写接口(OpenAI 兼容)</h4>
        <label>
          接口地址
          <input
            type="text"
            placeholder="https://api.openai.com/v1"
            .value=${sp.apiBaseUrl}
            @change=${(e: InputEvent) => this.save({ apiBaseUrl: (e.target as HTMLInputElement).value.trim() })}
          />
        </label>
        <label>
          API Key(无需鉴权的内网接口可留空)
          <input
            type="password"
            .value=${sp.apiKey}
            @change=${(e: InputEvent) => this.save({ apiKey: (e.target as HTMLInputElement).value.trim() })}
          />
        </label>
        <label>
          模型
          <div class="model-row">
            <input
              type="text"
              placeholder="whisper-1"
              list="goder-speech-models-${this.scope}"
              .value=${sp.apiModel}
              @change=${(e: InputEvent) => {
                const v = (e.target as HTMLInputElement).value.trim();
                this.save({ apiModel: v || 'whisper-1' }); // 清空回默认
              }}
            />
            <button ?disabled=${this.busyAgent} @click=${() => void this.detectModels()}>
              ${this.busyAgent ? '检测中…' : '检测'}
            </button>
          </div>
          <datalist id="goder-speech-models-${this.scope}">
            ${this.modelOptions.map((m) => html`<option value=${m}></option>`)}
          </datalist>
        </label>
        <label>
          语言(ISO-639-1,如 zh / en)
          <input
            type="text"
            placeholder="zh"
            .value=${sp.language}
            @change=${(e: InputEvent) => {
              const v = (e.target as HTMLInputElement).value.trim();
              this.save({ language: v || 'zh' }); // 清空回默认
            }}
          />
        </label>
        <label>
          录音快捷键(等效点话筒;输入框聚焦或页面无编辑焦点时生效,支持单键)
          <div class="model-row">
            <input
              class="hotkey"
              type="text"
              readonly
              spellcheck="false"
              placeholder="点击后按组合键或单键(如 \`)"
              .value=${formatSpeechHotkey(sp.hotkey)}
              @keydown=${(e: KeyboardEvent) => this.captureHotkey(e)}
            />
            <button title="清除快捷键(关闭)" ?disabled=${!sp.hotkey} @click=${() => this.save({ hotkey: '' })}>
              清除
            </button>
          </div>
        </label>
        <div class="hint">
          地址填到 API 前缀为止(自动拼接 /models 与 /audio/transcriptions);「检测」拉取接口的模型列表并筛出转写类候选。浏览器直连优先(接口需允许跨域
          CORS);桌面形态直连被拦时自动经本地服务中继转发,均可用的接口不受影响。不经
          gh server。Key 仅保存在本机浏览器存储。单次录音上限 60 秒。
        </div>
        ${this.agentMsg ? html`<div class="hint">${this.agentMsg}</div>` : nothing}
      </div>
    `;
  }

  /** 「检测」:拉接口 GET /models 模型列表(桌面经本地中继)→ 筛转写类
   *  候选填入 datalist;唯一候选直接填入模型项,无命中回落全量列表手选。 */
  private async detectModels(): Promise<void> {
    const sp = settingsStore.speech;
    if (!sp.apiBaseUrl.trim()) {
      this.setAgentMsg(false, '请先填写接口地址');
      return;
    }
    this.busyAgent = true;
    this.agentMsg = '';
    try {
      const all = await detectTranscribeModels({
        apiBaseUrl: sp.apiBaseUrl.trim(),
        apiKey: sp.apiKey.trim(),
        // 桌面态/声明了中继的嵌入宿主走同源回落(接口普遍无 CORS 头,
        // 浏览器直连被拦);其余 undefined = 直连(要求接口自身允许跨域)
        relayBase: speechRelayBase(),
      });
      const audio = filterTranscribeModels(all);
      if (audio.length === 1) settingsStore.setSpeech({ apiModel: audio[0] });
      this.modelOptions = audio.length ? audio : all;
      this.setAgentMsg(
        true,
        audio.length
          ? `检测到 ${audio.length} 个转写模型${audio.length === 1 ? `,已填入「${audio[0]}」` : ',点击「模型」输入框选择'}。`
          : `未识别出明确的转写模型,已列出全部 ${all.length} 个模型供手选。`,
      );
    } catch (e) {
      this.setAgentMsg(false, e instanceof Error ? e.message : '检测失败');
    } finally {
      this.busyAgent = false;
    }
  }

  /** 改即存 + 头部闪「已保存」(与 commit 同反馈,落点为 speech 镜像)。 */
  private save(patch: Partial<SpeechConfig>): void {
    settingsStore.setSpeech(patch);
    this.fire('goder-saved');
  }

  /** 快捷键捕获:点击输入框后直接按键即录入(修饰键 + 单字符键,单键如
   *  ` 亦可;单键会拦截该字符在输入框的正常输入)。Esc/Enter 取消不改;
   *  退格 = 清除;空格与多字符功能键(含单独按下的修饰键)忽略。 */
  private captureHotkey(e: KeyboardEvent): void {
    e.preventDefault();
    if (e.isComposing) return;
    if (e.key === 'Escape' || e.key === 'Enter') return; // 取消,保持现值
    if (e.key === 'Backspace') {
      this.save({ hotkey: '' });
      return;
    }
    if (e.key.length !== 1 || e.key === ' ') return;
    const combo = `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.key.toLowerCase()}`;
    this.save({ hotkey: combo });
  }
}
