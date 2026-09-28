// appearance.ts — 「外观」分区:主题 / 强调色(预设 + 调色盘) / 字号。
// 经 registry.settings 注册(builtin-common),render 返回池化元素。
import { css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { sectionSharedCss, SettingsSectionPanel } from './shared';
import { settingsStore, ACCENTS, FONT_MIN, FONT_MAX, type ThemeMode } from '../../../core/settings/settings-store';

@customElement('grf-settings-appearance')
export class GrfSettingsAppearance extends SettingsSectionPanel {
  static styles = [
    ...sectionSharedCss,
    css`
      .swatches {
        display: flex;
        gap: 10px;
        padding: 2px 0;
      }
      .swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        padding: 0;
        cursor: pointer;
        position: relative;
      }
      .swatch .c {
        position: absolute;
        inset: 3px;
        border-radius: 50%;
      }
      .swatch.on {
        box-shadow: 0 0 0 2px var(--grf-card), 0 0 0 4px var(--grf-text-dim);
      }
      .swatch:hover {
        filter: brightness(1.15);
      }
      /* 调色盘:原生取色器叠在圆上,点击即弹系统取色面板 */
      .swatch.picker {
        background: conic-gradient(
          from 0deg,
          #e5534b,
          #e5a53c,
          #3fb96f,
          #3ca6e5,
          #8d7ce8,
          #e5637a,
          #e5534b
        );
        display: inline-block;
      }
      .swatch.picker input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        margin: 0;
        padding: 0;
        border: none;
      }
      .fontsize {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .fontsize input {
        width: 84px;
      }
      .fontsize .unit {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
    `,
  ];

  render() {
    const ap = settingsStore.appearance;
    const themes: [ThemeMode, string][] = [
      ['dark', '深色'],
      ['light', '浅色'],
    ];
    // 当前是否为自定义色(非预设 key)
    const custom = !(ap.accent in ACCENTS);
    return html`
      <div class="sec">
        <h4>主题</h4>
        <div class="seg">
          ${themes.map(
            ([k, label]) => html`
              <button class=${ap.theme === k ? 'on' : ''} @click=${() => settingsStore.setAppearance({ theme: k })}>${label}</button>
            `,
          )}
        </div>
      </div>
      <div class="sec">
        <h4>强调色</h4>
        <div class="swatches">
          ${(Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]).map((k) => {
            const a = ACCENTS[k];
            return html`
              <button
                class="swatch ${ap.accent === k ? 'on' : ''}"
                title=${a.label}
                @click=${() => settingsStore.setAppearance({ accent: k })}
              >
                <span class="c" style="background:${a.accent}"></span>
              </button>
            `;
          })}
          <!-- 调色盘:自定义任意颜色 -->
          <label class="swatch picker ${custom ? 'on' : ''}" title="自定义颜色">
            <input
              type="color"
              .value=${custom && ap.accent.startsWith('#') ? ap.accent : '#4c8dff'}
              @input=${(e: InputEvent) => settingsStore.setAppearance({ accent: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
        <div class="hint">点击调色盘可任选颜色;强调色会同步应用到按钮、链接与运行指示等界面元素。</div>
      </div>
      <div class="sec">
        <h4>界面字号</h4>
        <div class="fontsize">
          <button title="减小字号" @click=${() => this.stepFontSize(-0.5)}>−</button>
          <input
            type="number"
            min=${FONT_MIN}
            max=${FONT_MAX}
            step="0.5"
            .value=${String(ap.fontSize)}
            @change=${(e: InputEvent) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) settingsStore.setAppearance({ fontSize: v });
              else this.requestUpdate(); // 越界输入:重渲染拉回当前值
            }}
          />
          <span class="unit">px</span>
          <button title="增大字号" @click=${() => this.stepFontSize(0.5)}>+</button>
        </div>
        <div class="hint">基准字号(${FONT_MIN}–${FONT_MAX}px,步进 0.5);各级文字按比例随基准缩放。</div>
      </div>
      <div class="hint">外观即时生效,并镜像保存到本地,重启后自动恢复。嵌入宿主仍可直接覆盖 --grf-* 变量换肤。</div>
    `;
  }

  private stepFontSize(d: number): void {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round((settingsStore.appearance.fontSize + d) * 2) / 2));
    settingsStore.setAppearance({ fontSize: next });
  }
}
