// speech.ts — 语音(输入转写 + 输出朗读)的纯配置模型。
//
// 输入识别通道为 OpenAI 兼容转写接口(/v1/audio/transcriptions):浏览器
// 本地录音(MediaRecorder)直传所配置的第三方接口,不经 gh server/网关
// (gh 无音频端点;走 Web Speech API 的浏览器内置识别在 macOS 桌面
// WKWebView 不可用,故统一只做转写接口一种,三形态行为一致)。
// 输出朗读为 OpenAI 兼容合成接口(/v1/audio/speech),助手回复文本换
// 音频播放,与输入同一套双通道(直连优先/中继兜底)。
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
  /** 语音输出(朗读)配置;与输入共置「语音」分区 */
  tts: TtsConfig;
}

/** 语音输出(TTS 朗读)配置:OpenAI 兼容合成接口(/audio/speech)。 */
export interface TtsConfig {
  /** 总开关:关闭时助手消息不显示朗读按钮、不自动朗读 */
  enabled: boolean;
  /** OpenAI 兼容接口基址;空 = 复用语音输入的 apiBaseUrl(常见:同一
   *  网关同时提供转写与合成,如 grf-voice 的 /gw/voice/v1) */
  apiBaseUrl: string;
  /** 接口 Key;空 = 复用语音输入的 apiKey */
  apiKey: string;
  /** 合成模型名(OpenAI 标准值 tts-1;grf-voice 为 qwen3-tts-… 可「检测」) */
  apiModel: string;
  /** 音色(依接口而定:OpenAI 如 alloy/onyx,grf-voice 当前仅 daji) */
  voice: string;
  /** 语速 0.25~4(OpenAI 口径);1 = 常速不发送该参数(部分网关不识别) */
  speed: number;
  /** 自动朗读:每条助手回复完成后自动播放(手动按钮不受此影响) */
  autoSpeak: boolean;
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

export const DEFAULT_TTS: TtsConfig = {
  enabled: false,
  apiBaseUrl: '',
  apiKey: '',
  apiModel: 'tts-1',
  voice: 'alloy',
  speed: 1,
  autoSpeak: false,
};

export const DEFAULT_SPEECH: SpeechConfig = {
  enabled: false,
  // ISO-639-1:OpenAI 官方文档口径(zh/en/ja…);部分网关(如 grf-voice)
  // 严格校验,拒绝 zh-CN 形态
  language: 'zh',
  apiBaseUrl: '',
  apiKey: '',
  apiModel: 'whisper-1',
  hotkey: 'mod+shift+m',
  tts: DEFAULT_TTS,
};

export const SPEECH_LS_KEY = 'goder-speech-v1';

/** 语音输出配置读回(tts 嵌套对象逐字段回退;旧数据无 tts = 全默认)。 */
function loadTts(p: unknown): TtsConfig {
  const t = (p ?? {}) as Partial<TtsConfig>;
  return {
    enabled: t.enabled === true,
    apiBaseUrl: typeof t.apiBaseUrl === 'string' ? t.apiBaseUrl : '',
    apiKey: typeof t.apiKey === 'string' ? t.apiKey : '',
    apiModel: typeof t.apiModel === 'string' && t.apiModel ? t.apiModel : DEFAULT_TTS.apiModel,
    voice: typeof t.voice === 'string' && t.voice ? t.voice : DEFAULT_TTS.voice,
    // 语速:越界/非法回默认 1(= 不发送)
    speed: typeof t.speed === 'number' && t.speed >= 0.25 && t.speed <= 4 ? t.speed : DEFAULT_TTS.speed,
    autoSpeak: t.autoSpeak === true,
  };
}

/** 从键值存储读回语音配置(损坏/缺省字段回退默认)。 */
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
    tts: loadTts(p.tts),
  };
}

/** 写回键值存储(settings-store.setSpeech 的落盘侧)。 */
export function saveSpeechLocal(cfg: SpeechConfig): void {
  kvSet(SPEECH_LS_KEY, cfg);
}
