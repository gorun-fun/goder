// tts.ts — 语音输出(朗读助手回复)的合成与播放引擎。
//
// 双形态评估结论(AGENTS.md 硬性约束):合成通道为 OpenAI 兼容接口
// (/v1/audio/speech,请求 JSON {model, input, voice[, speed]},响应为音频
// 二进制 —— OpenAI 默认 mp3,grf-voice 等网关回 WAV,故不发送
// response_format,浏览器 Audio 两种容器皆可播),与语音输入同一套
// 双通道:直连优先(接口允许跨域时一步到位),桌面形态注入中继回落
// (relayBase → 本地同源 /goder-api/speech/tts,internal/desktop/
// speechrelay.go)—— 中继把待合成文本作 text/plain 纯文本体携带、
// model/voice/speed 走查询参数(WKWebView 自定义 scheme 只暴露字符串体、
// 自定义请求头会丢,与转写通道同一批坑,见 record.ts 头注释)。
// 本模块不依赖 host/bridge;请求经 apiFetch 发出(scripted-api 可接管)。
//
// 播放为模块级单例:同时只播一条,新的朗读打断旧的;onSpeakStateChange
// 订阅播放状态(多个 chat 面板实例同步「正在朗读哪条」)。
import { apiFetch } from '../api/fetch';
import { assertNotHtml, authHeaders, tryChannels } from './record';

/** 合成接口地址:基址(如 https://api.openai.com/v1)去尾斜杠拼端点路径。 */
export function speechSynthUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/audio/speech`;
}

/** 从 /models 全量 id 里筛「像合成模型」的候选:与转写筛选
 *  (filterTranscribeModels)对称 —— 正向 tts/cosyvoice 等、负向剔除
 *  whisper/asr 等识别类;无命中时调用方应回落展示全量列表。纯函数可单测。 */
export function filterTtsModels(ids: string[]): string[] {
  return ids.filter((id) => /tts|voice-?clone|cosyvoice/i.test(id) && !/whisper|asr|transcri|paraformer|sensevoice/i.test(id));
}

/** 合成请求的超时(模型首次加载可能约 30s,与中继侧 speechTtsWait 对齐)。 */
const SPEAK_TIMEOUT_MS = 130_000;

/** 供单测注入的合成参数(生产由 settingsStore.speech 拼 TtsConfig 传入)。 */
export interface SpeakParams {
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
  voice: string;
  /** 语速;1(默认)不发送该参数 —— 部分网关不识别 speed */
  speed?: number;
  /** 桌面形态的本地同源中继基址(与转写通道同款,见 record.ts)。 */
  relayBase?: string;
}

/** markdown 源文 → 适合朗读的纯文本:跳过代码块与图片、链接只留文字、
 *  去标题/引用/列表/强调标记、压空白。纯代码回复清洗后为空(调用方
 *  据此不朗读)。纯函数可单测。 */
export function speechTextFromMarkdown(md: string): string {
  let s = md;
  // 整体剥离类占位用空串(不留空白行):代码块(读代码无意义)、图片、
  // 水平线、表格分隔行
  s = s.replace(/```[\s\S]*?(```|$)/g, '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '');
  s = s.replace(/^[ \t]*\|?[ \t:*|-]+$/gm, '');
  // 行内代码去反引号留内容;链接只留文字
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 行首结构标记:标题井号、引用、有序/无序列表、任务框
  s = s.replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]+/gm, '');
  s = s.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gm, '');
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
  // 强调标记(粗体/斜体/删除线/下划线)
  s = s.replace(/\*\*|__|~~/g, '');
  s = s.replace(/(^|\W)\*(\S[^*]*?\S|\S)\*(?=\W|$)/g, '$1$2');
  // 空白规整:多空白压一、三行以上压两行;剥离占位留下的空位顺势压掉
  // 标点前空白(合法文本标点前不应有空白,对朗读也更自然)
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+([,，.。;；:：!！?？])/g, '$1')
    .trim();
}

/** 播放状态:key = 调用方传入的消息标识(同一条幂等跳过)。 */
export interface SpeakState {
  /** 正在朗读/加载中的消息标识;null = 空闲 */
  key: string | null;
  /** loading = 请求音频中;playing = 播放中 */
  phase: 'loading' | 'playing';
}

type SpeakListener = (state: SpeakState, err?: string) => void;

const listeners = new Set<SpeakListener>();
let audio: HTMLAudioElement | null = null;
let objectUrl = '';
let currentKey: string | null = null;
let currentPhase: 'loading' | 'playing' = 'loading';
/** 代次号:打断旧请求 —— 迟到的落定发现代次不匹配即丢弃,不覆盖新状态 */
let gen = 0;

/** 订阅播放状态变化(返回退订函数)。多个面板实例共用,同屏同步
 *  「正在朗读哪条」;err 非空 = 刚发生失败(状态已复位)。 */
export function onSpeakStateChange(cb: SpeakListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitState(err?: string): void {
  const state: SpeakState = { key: currentKey, phase: currentPhase };
  for (const l of listeners) l(state, err);
}

/** 停掉当前音频并释放资源(不动 gen:迟到的旧请求自行按代次丢弃)。 */
function teardownAudio(): void {
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
}

/** 停止朗读(手动点停止/切会话/组件卸载)。 */
export function stopSpeak(): void {
  gen++;
  teardownAudio();
  if (currentKey !== null) {
    currentKey = null;
    emitState();
  }
}

/** 当前是否在朗读指定消息(按钮态/幂等判定)。 */
export function isSpeaking(key: string): boolean {
  return currentKey === key;
}

/** 朗读一段文本:请求合成 → 播放。单例 —— 新朗读打断旧的;同 key 且
 *  未结束 = 幂等跳过(自动朗读与手动点击撞车时只发一次)。
 *  autoplay 被浏览器策略拦截等失败经 reject 抛出,调用方负责提示。 */
export async function speak(key: string, text: string, params: SpeakParams): Promise<void> {
  const clean = speechTextFromMarkdown(text);
  if (!clean) throw new Error('没有可朗读的文本(内容只有代码或链接)');
  if (currentKey === key) return; // 同条正在加载/播放
  teardownAudio(); // 打断旧的(静默,不广播)
  const myGen = ++gen;
  currentKey = key;
  currentPhase = 'loading';
  emitState();
  const done = (err?: string) => {
    if (myGen !== gen) return; // 已被新朗读/停止顶替
    teardownAudio();
    currentKey = null;
    emitState(err);
  };
  try {
    const blob = await requestAudio(clean, params);
    if (myGen !== gen) return;
    objectUrl = URL.createObjectURL(blob);
    const a = new Audio(objectUrl);
    audio = a;
    a.onended = () => done();
    a.onerror = () => done('音频播放失败');
    await a.play();
    if (myGen !== gen) return;
    currentPhase = 'playing';
    emitState();
  } catch (e) {
    const msg =
      e instanceof DOMException && e.name === 'NotAllowedError'
        ? '浏览器阻止了自动播放:请手动点击消息上的朗读按钮播放一次'
        : e instanceof Error
          ? e.message
          : '朗读失败';
    done(msg);
    throw new Error(msg);
  }
}

/** 请求合成音频:直连 JSON 优先,桌面中继回落(text/plain 文本体 +
 *  查询参数路由 —— WKWebView scheme 下字符串体才存活,自定义头会丢)。 */
async function requestAudio(text: string, params: SpeakParams): Promise<Blob> {
  const timeout =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? { signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS) } : {};
  // speed 仅在用户显式改非 1 时发送;response_format 不发送(OpenAI
  // 默认 mp3、grf-voice 回 WAV 且不识别该参数,浏览器两种都能播)
  const useSpeed = typeof params.speed === 'number' && params.speed > 0 && params.speed !== 1;
  const payload = JSON.stringify({
    model: params.apiModel,
    input: text,
    ...(params.voice ? { voice: params.voice } : {}),
    ...(useSpeed ? { speed: params.speed } : {}),
  });
  const relay = params.relayBase;
  const channels: Array<() => Promise<Response>> = [
    () =>
      apiFetch(speechSynthUrl(params.apiBaseUrl), {
        method: 'POST',
        headers: { ...authHeaders(params.apiKey), 'Content-Type': 'application/json' },
        body: payload,
        ...timeout,
      }),
  ];
  if (relay) {
    channels.push(() => {
      const q = new URLSearchParams();
      q.set('base', params.apiBaseUrl.trim());
      q.set('model', params.apiModel);
      if (params.voice) q.set('voice', params.voice);
      if (useSpeed) q.set('speed', String(params.speed));
      return apiFetch(`${relay.replace(/\/+$/, '')}/speech/tts?${q}`, {
        method: 'POST',
        headers: { ...authHeaders(params.apiKey), 'Content-Type': 'text/plain; charset=utf-8' },
        body: text,
        ...timeout,
      });
    });
  }

  let res: Response;
  try {
    res = await tryChannels(channels);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new Error('合成请求超时(模型首次加载可能较慢),请稍后重试');
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('合成请求已中止');
    throw new Error(relay ? '接口与本地中继均不可达:请检查地址与网络' : '合成接口不可达:请检查接口地址与跨域(CORS)设置');
  }
  assertNotHtml(res);
  if (!res.ok) {
    if (res.status === 502) throw new Error('无法连接合成接口:请检查地址与网络可达性');
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 160);
    } catch {
      /* 无响应体细节也能报 */
    }
    throw new Error(`合成失败(HTTP ${res.status})${detail ? `:${detail}` : ''}`);
  }
  const blob = await res.blob();
  // 响应须是音频(或不明二进制):200 回 JSON/文本 = 模型或参数不对
  const ct = blob.type || res.headers.get('content-type') || '';
  if (/text\/|json/i.test(ct)) throw new Error('接口返回了非音频内容:请检查模型与音色配置');
  return blob;
}
