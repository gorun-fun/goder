// speech.ts — 语音输入(话筒转文字)的纯配置模型。
//
// 识别通道为 OpenAI 兼容转写接口(/v1/audio/transcriptions):浏览器本地
// 录音(MediaRecorder)直传所配置的第三方接口,不经 gh server/网关
// (gh 无音频端点;走 Web Speech API 的浏览器内置识别在 macOS 桌面
// WKWebView 不可用,故统一只做转写接口一种,三形态行为一致)。
// 配置经可注入 KV 存储(settings-store 镜像读写),无 DOM 依赖,可单测。
import { kvGet, kvSet } from '../store/storage';

export interface SpeechConfig {
  /** 总开关:关闭时 composer 不显示话筒按钮(嵌入界面默认零变化) */
  enabled: boolean;
  /** 识别语言(BCP 47,如 zh-CN),透传转写接口 language 参数 */
  language: string;
  /** OpenAI 兼容接口基址,如 https://api.openai.com/v1 */
  apiBaseUrl: string;
  /** 接口 Key(仅存本机浏览器 KV 存储,随音频直传第三方接口;内网无鉴权网关可留空) */
  apiKey: string;
  /** 转写模型名 */
  apiModel: string;
  /** 录音快捷键组合('' = 关闭;支持单键如 ` 或组合如 mod+shift+m,
   *  仅输入框聚焦时生效,点击等效 —— 单键会拦截该字符的正常输入) */
  hotkey: SpeechHotkey;
}

/**
 * 快捷键组合编码:可选修饰键前缀 mod(Ctrl/⌘ 跨平台归一,ctrl/cmd 为
 * 别名)+ shift + alt,加单字符键名(字母小写/数字/符号),如
 * `mod+shift+m`、`` ` ``、`alt+q`。'' = 关闭。
 */
export type SpeechHotkey = string;

/** 解析后的快捷键组合。 */
export interface SpeechHotkeyCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** 单字符键名(字母已小写) */
  key: string;
}

/** 解析并校验快捷键串;非法(空/缺键/多字符键/空格/格式坏)返回 null。 */
export function parseSpeechHotkey(hotkey: string): SpeechHotkeyCombo | null {
  const s = hotkey.trim();
  if (!s) return null;
  let mod = false;
  let shift = false;
  let alt = false;
  let rest = s;
  for (;;) {
    const m = /^(mod|ctrl|cmd|shift|alt)\+/i.exec(rest);
    if (!m) break;
    const t = m[1].toLowerCase();
    if (t === 'mod' || t === 'ctrl' || t === 'cmd') mod = true;
    else if (t === 'shift') shift = true;
    else alt = true;
    rest = rest.slice(m[0].length);
  }
  if (rest.length !== 1 || rest === ' ') return null;
  return { mod, shift, alt, key: rest.toLowerCase() };
}

/** 单字符键 → 物理键位 code(US 布局命名;字母/数字可直接推导,标点
 *  查表)。IME 兜底用:中文输入法下 e.key 是 IME 产物(如 ` 变 ·),
 *  e.code 反映物理按键不受输入法影响。无映射返回 null。 */
export function speechHotkeyCodeOf(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const punctual: Record<string, string> = {
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  };
  return punctual[key] ?? null;
}

/** 快捷键命中判定(纯函数;修饰键严格全匹配,键名大小写归一)。单键
 *  额外按物理键位兜底:IME 场景 e.key 是输入法产物(·/Process 等),
 *  e.code 仍标识物理按键。 */
export function speechHotkeyMatches(
  hotkey: string,
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code?: string },
): boolean {
  const c = parseSpeechHotkey(hotkey);
  if (!c) return false;
  if ((e.metaKey || e.ctrlKey) !== c.mod) return false;
  if (e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  if ((e.key ?? '').toLowerCase() === c.key) return true;
  const code = speechHotkeyCodeOf(c.key);
  return !c.mod && !c.shift && !c.alt && !!e.code && e.code === code;
}

/** 展示文案:如 `Ctrl/⌘+Shift+M`、`` ` ``;非法返回空串。字母键展示大写。 */
export function formatSpeechHotkey(hotkey: string): string {
  const c = parseSpeechHotkey(hotkey);
  if (!c) return '';
  const key = /[a-z]/.test(c.key) ? c.key.toUpperCase() : c.key;
  return [...(c.mod ? ['Ctrl/⌘'] : []), ...(c.shift ? ['Shift'] : []), ...(c.alt ? ['Alt'] : []), key].join('+');
}

export const DEFAULT_SPEECH: SpeechConfig = {
  enabled: false,
  // ISO-639-1:OpenAI 官方文档口径(zh/en/ja…);部分网关(如 grf-voice)
  // 严格校验,拒绝 zh-CN 形态
  language: 'zh',
  apiBaseUrl: '',
  apiKey: '',
  apiModel: 'whisper-1',
  hotkey: 'mod+shift+m',
};

export const SPEECH_LS_KEY = 'goder-speech-v1';

/** 从键值存储读回语音输入配置(损坏/缺省字段回退默认)。 */
export function loadSpeechLocal(): SpeechConfig {
  const p = kvGet<Partial<SpeechConfig>>(SPEECH_LS_KEY);
  if (!p) return { ...DEFAULT_SPEECH };
  return {
    enabled: p.enabled === true,
    // 迁移:早期默认 zh-CN → ISO-639-1 的 zh(两种口径 OpenAI 均收,
    // 但部分网关严格拒绝 zh-CN)
    language: p.language === 'zh-CN' ? 'zh' : typeof p.language === 'string' && p.language ? p.language : DEFAULT_SPEECH.language,
    apiBaseUrl: typeof p.apiBaseUrl === 'string' ? p.apiBaseUrl : '',
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    apiModel: typeof p.apiModel === 'string' && p.apiModel ? p.apiModel : DEFAULT_SPEECH.apiModel,
    // 快捷键:'' = 关闭(合法),其余须可解析;非法/缺省回默认
    hotkey:
      typeof p.hotkey === 'string' && (p.hotkey === '' || parseSpeechHotkey(p.hotkey))
        ? p.hotkey
        : DEFAULT_SPEECH.hotkey,
  };
}

/** 写回键值存储(settings-store.setSpeech 的落盘侧)。 */
export function saveSpeechLocal(cfg: SpeechConfig): void {
  kvSet(SPEECH_LS_KEY, cfg);
}
