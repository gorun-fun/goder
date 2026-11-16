// speech.test.ts — 语音(输入转写 + 输出朗读)的纯函数回归:配置读取
// (默认值合并、部分字段/类型异常回退、损坏 JSON 回退)、写读 roundtrip;
// 转写/合成/模型地址拼接、录音编码、模型筛选与朗读文本清洗。模块无
// DOM 依赖,node 环境直接单测(存储经可注入 KV)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH,
  DEFAULT_TTS,
  SPEECH_LS_KEY,
  formatSpeechHotkey,
  loadSpeechLocal,
  parseSpeechHotkey,
  saveSpeechLocal,
  speechHotkeyMatches,
} from '../src/core/settings/speech';
import { MemoryStorage, setKeyValueStorage, kvSet } from '../src/core/store/storage';
import { encodeWav, fetchModelIds, filterTranscribeModels, modelsUrl, transcribeUrl } from '../src/core/speech/record';
import { filterTtsModels, speechSynthUrl, speechTextFromMarkdown, speak } from '../src/core/speech/tts';
import { setApiFetch } from '../src/core/api/fetch';

beforeEach(() => setKeyValueStorage(new MemoryStorage()));

describe('loadSpeechLocal', () => {
  it('无存储时返回默认(关闭 + zh + whisper-1)', () => {
    expect(loadSpeechLocal()).toEqual(DEFAULT_SPEECH);
    expect(loadSpeechLocal().enabled).toBe(false);
  });

  it('早期默认 zh-CN 迁移为 ISO-639-1 的 zh(部分网关严格校验)', () => {
    kvSet(SPEECH_LS_KEY, { language: 'zh-CN' });
    expect(loadSpeechLocal().language).toBe('zh');
  });

  it('部分字段缺失/类型异常逐字段回退默认', () => {
    kvSet(SPEECH_LS_KEY, { enabled: 'yes', apiModel: '', language: 123, apiKey: 'sk-x', junk: 1 });
    const cfg = loadSpeechLocal();
    expect(cfg.enabled).toBe(false); // 非 true 即关
    expect(cfg.apiModel).toBe('whisper-1'); // 空串回默认
    expect(cfg.language).toBe('zh'); // 非字符串回默认
    expect(cfg.apiKey).toBe('sk-x'); // 合法字段保留
    expect('junk' in cfg).toBe(false);
  });

  it('损坏 JSON 回退默认', () => {
    setKeyValueStorage(Object.assign(new MemoryStorage(), { getItem: () => '{oops' }));
    expect(loadSpeechLocal()).toEqual(DEFAULT_SPEECH);
  });

  it('saveSpeechLocal → loadSpeechLocal roundtrip', () => {
    saveSpeechLocal({ ...DEFAULT_SPEECH, enabled: true, apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' });
    const cfg = loadSpeechLocal();
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiBaseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.apiKey).toBe('sk-1');
  });

  it('快捷键:非法值回默认,空串(关闭)与单键保留', () => {
    kvSet(SPEECH_LS_KEY, { hotkey: 'mod+enter' }); // 多字符功能键 → 非法
    expect(loadSpeechLocal().hotkey).toBe('mod+shift+m');
    kvSet(SPEECH_LS_KEY, { hotkey: 'ab' }); // 多字符 → 非法
    expect(loadSpeechLocal().hotkey).toBe('mod+shift+m');
    kvSet(SPEECH_LS_KEY, { hotkey: '' });
    expect(loadSpeechLocal().hotkey).toBe(''); // 显式关闭保留
    kvSet(SPEECH_LS_KEY, { hotkey: '`' });
    expect(loadSpeechLocal().hotkey).toBe('`'); // 单键合法
  });

  it('tts:旧数据无 tts 字段补全默认(向后兼容)', () => {
    kvSet(SPEECH_LS_KEY, { enabled: true, apiBaseUrl: 'http://x/v1' });
    expect(loadSpeechLocal().tts).toEqual(DEFAULT_TTS);
  });

  it('tts:部分字段缺失/类型异常逐字段回退,合法字段保留', () => {
    kvSet(SPEECH_LS_KEY, { tts: { enabled: true, apiModel: '', voice: 'daji', speed: 9, junk: 1 } });
    const tts = loadSpeechLocal().tts;
    expect(tts.enabled).toBe(true); // 合法保留
    expect(tts.apiModel).toBe('tts-1'); // 空串回默认
    expect(tts.voice).toBe('daji'); // 合法保留
    expect(tts.speed).toBe(1); // 越界回默认(= 不发送)
    expect(tts.autoSpeak).toBe(false); // 缺省即关
    expect('junk' in tts).toBe(false);
  });
});

describe('parseSpeechHotkey / speechHotkeyMatches / formatSpeechHotkey', () => {
  const ev = (patch: Partial<KeyboardEvent> & { key: string }) =>
    ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...patch }) as KeyboardEvent;

  it('单键(如 `):无修饰键命中,带修饰键不命中', () => {
    expect(speechHotkeyMatches('`', ev({ key: '`' }))).toBe(true);
    expect(speechHotkeyMatches('`', ev({ ctrlKey: true, key: '`' }))).toBe(false);
    expect(speechHotkeyMatches('`', ev({ key: 'a' }))).toBe(false);
  });

  it('mod+shift+m:Ctrl/⌘ + Shift + M 命中,大写 M 兼容;mod 别名 ctrl/cmd 等价', () => {
    expect(speechHotkeyMatches('mod+shift+m', ev({ ctrlKey: true, shiftKey: true, key: 'm' }))).toBe(true);
    expect(speechHotkeyMatches('mod+shift+m', ev({ metaKey: true, shiftKey: true, key: 'M' }))).toBe(true);
    expect(speechHotkeyMatches('ctrl+shift+m', ev({ metaKey: true, shiftKey: true, key: 'M' }))).toBe(true);
    expect(parseSpeechHotkey('cmd+m')).toEqual({ mod: true, shift: false, alt: false, key: 'm' });
  });

  it('修饰键严格全匹配:缺 mod / 多 shift / 多 alt 均不命中', () => {
    expect(speechHotkeyMatches('mod+m', ev({ ctrlKey: true, key: 'm' }))).toBe(true);
    expect(speechHotkeyMatches('mod+m', ev({ ctrlKey: true, shiftKey: true, key: 'm' }))).toBe(false);
    expect(speechHotkeyMatches('mod+m', ev({ ctrlKey: true, altKey: true, key: 'm' }))).toBe(false);
    expect(speechHotkeyMatches('mod+shift+m', ev({ shiftKey: true, key: 'm' }))).toBe(false);
  });

  it('非法组合解析为 null(空/缺键/多字符/空格)', () => {
    expect(parseSpeechHotkey('')).toBeNull();
    expect(parseSpeechHotkey('mod+')).toBeNull();
    expect(parseSpeechHotkey('mod+enter')).toBeNull();
    expect(parseSpeechHotkey('ab')).toBeNull();
    expect(parseSpeechHotkey(' ')).toBeNull();
    expect(speechHotkeyMatches('mod+enter', ev({ ctrlKey: true, key: 'Enter' }))).toBe(false);
  });

  it('IME 物理键位兜底:e.key 是输入法产物时按 e.code 匹配单键', () => {
    // 中文输入法把 ` 变 · / WebKit 报 Process:code 仍是 Backquote
    expect(speechHotkeyMatches('`', ev({ key: '·', code: 'Backquote' }))).toBe(true);
    expect(speechHotkeyMatches('`', ev({ key: 'Process', code: 'Backquote' }))).toBe(true);
    expect(speechHotkeyMatches('a', ev({ key: 'Process', code: 'KeyA' }))).toBe(true);
    // 键位不符 / 组合键不走兜底(IME 不消费带修饰键的按键)
    expect(speechHotkeyMatches('`', ev({ key: '·', code: 'KeyA' }))).toBe(false);
    expect(speechHotkeyMatches('mod+m', ev({ key: 'Process', code: 'KeyM' }))).toBe(false);
  });

  it('展示格式化(字母键统一大写)', () => {
    expect(formatSpeechHotkey('mod+shift+m')).toBe('Ctrl/⌘+Shift+M');
    expect(formatSpeechHotkey('`')).toBe('`');
    expect(formatSpeechHotkey('alt+q')).toBe('Alt+Q');
    expect(formatSpeechHotkey('bad value')).toBe('');
  });
});

describe('transcribeUrl', () => {
  it('基址去尾斜杠拼接端点', () => {
    expect(transcribeUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcribeUrl('https://x.example/v1///')).toBe('https://x.example/v1/audio/transcriptions');
    expect(transcribeUrl('')).toBe('/audio/transcriptions');
  });

  it('modelsUrl 同规则拼模型列表端点', () => {
    expect(modelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(modelsUrl('https://x.example/v1/')).toBe('https://x.example/v1/models');
  });
});

describe('filterTranscribeModels', () => {
  it('按命名惯例筛转写类模型(whisper/asr/transcribe/sensevoice…)', () => {
    expect(
      filterTranscribeModels(['gpt-4o', 'whisper-1', 'FunAudioLLM/SenseVoiceSmall', 'glm-4-asr', 'tts-1-hd']),
    ).toEqual(['whisper-1', 'FunAudioLLM/SenseVoiceSmall', 'glm-4-asr']);
  });

  it('剔除 TTS/语音合成,保留含 speech 的识别模型', () => {
    expect(filterTranscribeModels(['speech-to-text-x', 'tts-1', 'voice-clone-y'])).toEqual(['speech-to-text-x']);
  });

  it('无命中返回空数组(调用方回落全量列表)', () => {
    expect(filterTranscribeModels(['gpt-4o', 'claude-3'])).toEqual([]);
  });
});

describe('speechSynthUrl / filterTtsModels(语音输出)', () => {
  it('基址去尾斜杠拼 /audio/speech', () => {
    expect(speechSynthUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/speech');
    expect(speechSynthUrl('https://x.example/gw/voice/v1//')).toBe('https://x.example/gw/voice/v1/audio/speech');
  });

  it('按命名惯例筛合成类模型(tts/cosyvoice/voice-clone…),剔除识别类', () => {
    expect(
      filterTtsModels(['gpt-4o', 'tts-1', 'tts-1-hd', 'qwen3-tts-12hz-0.6b-base', 'qwen3-asr-0.6b', 'whisper-1', 'voice-clone-x']),
    ).toEqual(['tts-1', 'tts-1-hd', 'qwen3-tts-12hz-0.6b-base', 'voice-clone-x']);
  });

  it('无命中返回空数组(调用方回落全量列表)', () => {
    expect(filterTtsModels(['gpt-4o', 'claude-3'])).toEqual([]);
  });
});

describe('speechTextFromMarkdown(朗读文本清洗)', () => {
  it('跳过代码块与图片,链接只留文字,去结构标记', () => {
    const md = [
      '# 标题行',
      '',
      '这是**加粗**与*斜体*和`code`的正文。',
      '',
      '```ts',
      'const x = 1; // 代码块整体跳过',
      '```',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '1. 有序项',
      '',
      '> 引用文字',
      '',
      '看[这个链接](https://x.example)和![图片](https://y.example/a.png)。',
      '',
      '---',
    ].join('\n');
    expect(speechTextFromMarkdown(md)).toBe(
      ['标题行', '', '这是加粗与斜体和code的正文。', '', '列表项一', '列表项二', '', '有序项', '', '引用文字', '', '看这个链接和。'].join('\n'),
    );
  });

  it('纯代码回复清洗后为空(调用方据此不朗读)', () => {
    expect(speechTextFromMarkdown('```python\nprint(1)\n```')).toBe('');
    expect(speechTextFromMarkdown('![图](https://x/a.png)')).toBe('');
  });

  it('未闭合的代码块(截断场景)也整体跳过', () => {
    expect(speechTextFromMarkdown('前文\n```js\nrest…')).toBe('前文');
  });
});

describe('encodeWav(16k 单声道 16-bit PCM)', () => {
  it('44 字节标准头 + 小端样本', async () => {
    const blob = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16_000);
    expect(blob.size).toBe(44 + 8);
    expect(blob.type).toBe('audio/wav');
    const v = new DataView(await blob.arrayBuffer());
    const tag = (off: number, len: number) => String.fromCharCode(...new Uint8Array(v.buffer, off, len));
    expect(tag(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(tag(8, 4)).toBe('WAVE');
    expect(tag(12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // 单声道
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // 字节率 = rate × 2
    expect(v.getUint16(34, true)).toBe(16); // 位深
    expect(tag(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(44, true)).toBe(0); // 0
    expect(v.getInt16(46, true)).toBe(0x7fff); // +1
    expect(v.getInt16(48, true)).toBe(-0x8000); // -1
    expect(v.getInt16(50, true)).toBe(16383); // 0.5 × 0x7fff = 16383.5 → 截断
  });
});

describe('通道回落(直连优先,桌面中继兜底)', () => {
  afterEach(() => setApiFetch(undefined));

  const okModels = () =>
    new Response(JSON.stringify({ data: [{ id: 'whisper-1' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('直连网络层失败(跨域/混合内容被拦)时自动回落中继通道', async () => {
    const urls: string[] = [];
    setApiFetch(
      (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        if (urls.length === 1) throw new TypeError('Failed to fetch'); // 直连被拦
        return okModels();
      }) as typeof fetch,
    );
    const ids = await fetchModelIds({ apiBaseUrl: 'http://x.example/v1', apiKey: '', relayBase: '/goder-api' });
    expect(ids).toEqual(['whisper-1']);
    expect(urls).toEqual(['http://x.example/v1/models', '/goder-api/speech/models?base=http%3A%2F%2Fx.example%2Fv1']);
  });

  it('直连成功时不经中继', async () => {
    let url = '';
    setApiFetch(
      (async (input: RequestInfo | URL) => {
        url = String(input);
        return okModels();
      }) as typeof fetch,
    );
    const ids = await fetchModelIds({ apiBaseUrl: 'http://x.example/v1', apiKey: '', relayBase: '/goder-api' });
    expect(ids).toEqual(['whisper-1']);
    expect(url).toBe('http://x.example/v1/models');
  });

  it('无中继(网页形态)直连失败即报错,不重试', async () => {
    let calls = 0;
    setApiFetch(
      (async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    );
    await expect(
      fetchModelIds({ apiBaseUrl: 'http://x.example/v1', apiKey: '' }),
    ).rejects.toThrow('接口不可达');
    expect(calls).toBe(1);
  });
});

describe('speak(合成通道:直连 JSON 优先,桌面中继兜底)', () => {
  // node 环境无 Audio/URL.createObjectURL:stub 播放侧,用例结束恢复,
  // 不污染后续套件
  const g = globalThis as Record<string, unknown>;
  const orig = { Audio: g.Audio, URL: g.URL };
  afterEach(() => {
    setApiFetch(undefined);
    g.Audio = orig.Audio;
    g.URL = orig.URL;
  });

  /** node 环境 stub 播放侧(Audio/URL),speak 全流程只验证请求通道。 */
  const stubPlayback = () => {
    g.Audio = class {
      play = async () => {};
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause() {}
      removeAttribute() {}
      load() {}
    };
    g.URL = Object.assign(class {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
  };

  const okAudio = () =>
    new Response('fake-audio-bytes', { status: 200, headers: { 'Content-Type': 'audio/wav' } });

  it('直连:POST {base}/audio/speech JSON 体;speed=1 不发送该参数', async () => {
    stubPlayback();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setApiFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return okAudio();
      }) as typeof fetch,
    );
    await speak('m1', '你好,世界', { apiBaseUrl: 'http://x.example/v1', apiKey: 'sk-1', apiModel: 'tts-1', voice: 'alloy', speed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://x.example/v1/audio/speech');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'tts-1', input: '你好,世界', voice: 'alloy' });
  });

  it('直连被拦回落中继:text/plain 纯文本体 + 查询参数(WKWebView 字符串体才存活)', async () => {
    stubPlayback();
    const calls: Array<{ url: string; body: unknown; ct: string }> = [];
    setApiFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (url.startsWith('http://x.example')) throw new TypeError('Failed to fetch'); // 直连被拦
        calls.push({ url, body: init?.body, ct: headers['Content-Type'] });
        return okAudio();
      }) as typeof fetch,
    );
    await speak('m2', '你好', {
      apiBaseUrl: 'http://x.example/v1',
      apiKey: '',
      apiModel: 'qwen3-tts-12hz-0.6b-base',
      voice: 'daji',
      speed: 1.5,
      relayBase: '/goder-api',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      '/goder-api/speech/tts?base=http%3A%2F%2Fx.example%2Fv1&model=qwen3-tts-12hz-0.6b-base&voice=daji&speed=1.5',
    );
    expect(calls[0].body).toBe('你好'); // 纯文本体,非 JSON
    expect(calls[0].ct).toBe('text/plain; charset=utf-8');
  });

  it('200 但回了非音频(JSON)报可读错误', async () => {
    stubPlayback();
    setApiFetch(
      (async () => new Response('{"error":"bad voice"}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    );
    await expect(
      speak('m3', '你好', { apiBaseUrl: 'http://x.example/v1', apiKey: '', apiModel: 'tts-1', voice: 'x' }),
    ).rejects.toThrow('接口返回了非音频内容');
  });

  it('纯代码文本直接拒绝(不发起请求)', async () => {
    stubPlayback();
    let calls = 0;
    setApiFetch(
      (async () => {
        calls++;
        return okAudio();
      }) as typeof fetch,
    );
    await expect(
      speak('m4', '```js\ncode\n```', { apiBaseUrl: 'http://x.example/v1', apiKey: '', apiModel: 'tts-1', voice: 'alloy' }),
    ).rejects.toThrow('没有可朗读的文本');
    expect(calls).toBe(0);
  });
});
