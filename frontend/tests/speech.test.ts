// speech.test.ts — 语音输入的纯函数回归:配置读取(默认值合并、部分
// 字段/类型异常回退、损坏 JSON 回退)、写读 roundtrip;转写/模型地址
// 拼接、录音编码挑选与转写模型筛选。模块无 DOM 依赖,node 环境直接
// 单测(存储经可注入 KV)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH,
  SPEECH_LS_KEY,
  formatSpeechHotkey,
  loadSpeechLocal,
  parseSpeechHotkey,
  saveSpeechLocal,
  speechHotkeyMatches,
} from '../src/core/settings/speech';
import { MemoryStorage, setKeyValueStorage, kvSet } from '../src/core/store/storage';
import {
  VoiceRecorder,
  detectTranscribeModels,
  encodeWav,
  filterTranscribeModels,
  hostVoiceBridge,
  modelsUrl,
  recorderSupported,
  transcribeUrl,
} from '../src/core/speech/record';
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
    const ids = await detectTranscribeModels({ apiBaseUrl: 'http://x.example/v1', apiKey: '', relayBase: '/goder-api' });
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
    const ids = await detectTranscribeModels({ apiBaseUrl: 'http://x.example/v1', apiKey: '', relayBase: '/goder-api' });
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
      detectTranscribeModels({ apiBaseUrl: 'http://x.example/v1', apiKey: '' }),
    ).rejects.toThrow('接口不可达');
    expect(calls).toBe(1);
  });
});

describe('宿主录音桥(goderHostVoice)', () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).goderHostVoice = undefined;
    setApiFetch(undefined);
  });

  const int16ToB64 = (vals: number[]) => {
    const buf = new ArrayBuffer(vals.length * 2);
    const v = new DataView(buf);
    vals.forEach((x, i) => v.setInt16(i * 2, x, true));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  };

  const fullBridge = (over: Partial<Record<string, unknown>> = {}) =>
    Object.assign(
      {
        sampleRate: () => 16000,
        start: () => 'ok',
        poll: () => null,
        stop: () => null,
        cancel: () => {},
      },
      over,
    );

  it('hostVoiceBridge:未注入/缺任一方法视为未提供', () => {
    expect(hostVoiceBridge()).toBeUndefined();
    (globalThis as Record<string, unknown>).goderHostVoice = { start: () => 'ok' };
    expect(hostVoiceBridge()).toBeUndefined();
    (globalThis as Record<string, unknown>).goderHostVoice = fullBridge();
    expect(hostVoiceBridge()?.sampleRate()).toBe(16000);
  });

  it('recorderSupported:桥可用即支持(无需 getUserMedia/AudioContext)', () => {
    (globalThis as Record<string, unknown>).goderHostVoice = fullBridge();
    expect(recorderSupported()).toBe(true);
  });

  it('桥全链路:轮询采集 → stop 尾块 → multipart 上传的 WAV 头与样本正确', async () => {
    const b64a = int16ToB64([0, 16384]);
    const b64tail = int16ToB64([-16384]);
    const calls: string[] = [];
    let polls = 0;
    (globalThis as Record<string, unknown>).goderHostVoice = fullBridge({
      start: () => {
        calls.push('start');
        return 'ok';
      },
      poll: () => {
        polls++;
        return polls === 1 ? b64a : null;
      },
      stop: () => {
        calls.push('stop');
        return b64tail;
      },
    });
    let captured: FormData | undefined;
    setApiFetch(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init?.body as FormData;
        return new Response(JSON.stringify({ text: ' 桥转写ok ' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    );

    const rec = new VoiceRecorder({ apiBaseUrl: 'http://x.example/v1', apiKey: '', apiModel: 'whisper-1', language: 'zh' });
    await rec.start(); // 首块(250ms 轮询)到达才落定
    const text = await rec.stop(); // 停录:尾块入列 → WAV 上传
    expect(text).toBe('桥转写ok');
    expect(calls[0]).toBe('start');
    expect(calls).toContain('stop');

    const file = captured!.get('file') as Blob;
    const ab = await file.arrayBuffer();
    const dv = new DataView(ab);
    const tag = (o: number, n: number) => String.fromCharCode(...new Uint8Array(ab, o, n));
    expect(tag(0, 4)).toBe('RIFF');
    expect(dv.getUint32(24, true)).toBe(16000); // 采样率
    expect(dv.getUint32(40, true)).toBe(6); // 3 样本(2 轮询 + 1 尾块)
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(16383); // 0.5 × 0x7fff 截断
    expect(dv.getInt16(48, true)).toBe(-16384); // -0.5
    expect(captured!.get('model')).toBe('whisper-1');
    expect(captured!.get('language')).toBe('zh');
  }, 10_000);

  it('start 返回 PERMISSION:报授权指引文案,不进入录音', async () => {
    (globalThis as Record<string, unknown>).goderHostVoice = fullBridge({ start: () => 'PERMISSION' });
    const rec = new VoiceRecorder({ apiBaseUrl: 'http://x.example/v1', apiKey: '', apiModel: 'whisper-1', language: 'zh' });
    await expect(rec.start()).rejects.toThrow('授权后请再按一次');
  });

  it('abort:桥 cancel 被调,不上传', async () => {
    const b64a = int16ToB64([1]);
    const calls: string[] = [];
    let polls = 0;
    (globalThis as Record<string, unknown>).goderHostVoice = fullBridge({
      poll: () => {
        polls++;
        return polls === 1 ? b64a : null;
      },
      stop: () => {
        calls.push('stop');
        return null;
      },
      cancel: () => calls.push('cancel'),
    });
    let fetched = false;
    setApiFetch(
      (async () => {
        fetched = true;
        return new Response('{}');
      }) as typeof fetch,
    );
    const rec = new VoiceRecorder({ apiBaseUrl: 'http://x.example/v1', apiKey: '', apiModel: 'whisper-1', language: 'zh' });
    await rec.start();
    rec.abort();
    expect(calls).toContain('cancel');
    expect(calls).not.toContain('stop');
    expect(fetched).toBe(false);
  }, 10_000);
});
