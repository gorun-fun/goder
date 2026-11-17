// record.ts — 语音输入(话筒转文字)的录音与转写引擎。
//
// 双形态评估结论(AGENTS.md 硬性约束):识别通道为 OpenAI 兼容转写接口
// (/v1/audio/transcriptions),浏览器本地录音。采集双通道,宿主桥优先:
//   1. 宿主录音桥(window.goderHostVoice,嵌入宿主原生实现,如
//      goder-mobile 的 Kotlin AudioRecord)——部分国产 ROM 的 SELinux 拦
//      WebView 渲染进程的音频 ioctl,getUserMedia 恒 NotReadableError,
//      原生 AudioRecord 不受限;桥直供 16k Int16 PCM,16k 直通打 WAV 头,
//      零 AudioContext 依赖;
//   2. getUserMedia + 共享 AudioContext + AudioWorklet(回落
//      ScriptProcessor)直采 PCM —— 不采用 MediaRecorder:WKWebView 直启
//      丢最初一两百毫秒且容器需二次解码;PCM 从管线流动的第一块起全量
//      收,天然零丢头,共享上下文把冷启动压到 getUserMedia。
// 上传通道直连优先:接口允许跨域时浏览器直接发 multipart 一步到位;
// 桌面/声明了中继的嵌入宿主回落同源 /speech 端点(relayBase → 如
// internal/desktop/speechrelay.go)——局域网接口常无 CORS 头,且
// WKWebView 对纯 http 目标可能按混合内容拦截,直连被拦时透明回落中继。
// (不采用 Web Speech API:macOS 桌面 WKWebView 不支持;gh server 无音频
// 端点,不经其反代。)全部请求经 apiFetch 发出(core/api/fetch.ts 的统一
// 传输层,scripted-api 可编程假后端同理接管)。
import { apiFetch } from '../api/fetch';
import type { SpeechConfig } from '../settings/speech';

/** 宿主录音桥协议:嵌入宿主注入 window.goderHostVoice 提供的原生录音
 *  通道(WebView 的 JavascriptInterface 只暴露方法,故全为方法形态,
 *  调用全部同步;实现参考 goder-mobile 的 VoiceBridge.kt):
 *   - sampleRate(): 采集率(建议 16000 = ASR 通用输入);
 *   - start(): "ok" 开录成功;"PERMISSION" 已发起系统权限申请(用户
 *     授权后重试);其余字符串 = 失败文案(直接抛给用户);
 *   - poll(): 拉自上次以来的增量 PCM(base64 Int16LE 小端),无新数据
 *     null;前端约 250ms 轮询,宿主单块几十 KB 为宜;
 *   - stop(): 停录并返回最后一批(可 null),此后 poll 不再有数据;
 *   - cancel(): 停录并丢弃已采数据。
 *  生命周期由前端驱动:start → 轮询 poll → stop/cancel;宿主幂等容错。 */
export interface HostVoiceBridge {
  sampleRate(): number;
  start(): string;
  poll(): string | null;
  stop(): string | null;
  cancel(): void;
}

/** 探测宿主录音桥(缺任一方法视为未提供)。 */
export function hostVoiceBridge(): HostVoiceBridge | undefined {
  const b = (globalThis as { goderHostVoice?: Partial<HostVoiceBridge> }).goderHostVoice;
  return b && typeof b.start === 'function' && typeof b.poll === 'function' &&
    typeof b.stop === 'function' && typeof b.sampleRate === 'function'
    ? (b as HostVoiceBridge)
    : undefined;
}

/** 宿主桥增量块 base64(Int16LE)→ Float32Array(÷32768 归一,符号扩展)。 */
function bridgeChunkToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    out[i] = v / 32768;
  }
  return out;
}

/** 转写接口地址:基址(如 https://api.openai.com/v1)去尾斜杠拼端点路径。 */
export function transcribeUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/audio/transcriptions`;
}

/** 模型列表地址(OpenAI 兼容 GET /models,「检测」按钮的数据源)。 */
export function modelsUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/models`;
}

/** 从 /models 全量 id 里筛「像转写模型」的候选:OpenAI 兼容列表不带
 *  能力元数据,按命名惯例启发式(whisper/asr/transcribe/sensevoice 等,
 *  剔除 tts/语音合成);无命中时调用方应回落展示全量列表。纯函数可单测。 */
export function filterTranscribeModels(ids: string[]): string[] {
  return ids.filter(
    (id) => /whisper|asr|transcri|paraformer|sensevoice|speech/i.test(id) && !/tts|voice-?clone/i.test(id),
  );
}

/** 录音能力探测:宿主桥可用即支持(原生采集,不依赖 getUserMedia);
 *  否则 getUserMedia + AudioContext 缺一不可(如 http 非同源页两者皆无)。 */
export function recorderSupported(): boolean {
  if (hostVoiceBridge()) return true;
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined'
  );
}

/** 单次录音上限:防止忘停导致超长音频上传失败 */
export const MAX_RECORD_MS = 60_000;

/** 上传转写的超时(与录音上限同量级) */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** 供单测注入的转写参数(生产由 settingsStore.speech 传入) */
export type TranscribeParams = Pick<SpeechConfig, 'apiBaseUrl' | 'apiKey' | 'apiModel' | 'language'> & {
  /** 桌面形态的本地同源中继基址(如 `${location.origin}/goder-api`);
   *  局域网接口普遍无 CORS 头、浏览器直连被拦,经 Go 侧中继转发
   *  (见 internal/desktop/speechrelay.go)。空 = 网页/嵌入形态直连。 */
  relayBase?: string;
};

/** 中继请求地址(模型检测用;转写的查询参数在 transcribe 内自拼):基址
 *  走 ?base= 查询参数(整条 /goder-api 链路靠 URL 路由,必然存活;自定义
 *  请求头经 wails 资产管道/WKWebView scheme handler 实测会丢,不可依赖),
 *  Key 走 Authorization 头(远程模式同款、已验证)。 */
function relayUrl(relayBase: string, base: string): string {
  return `${relayBase.replace(/\/+$/, '')}/speech/models?base=${encodeURIComponent(base.trim())}`;
}

/** 逐个尝试请求通道:第一个成功(拿到 Response,含 4xx/5xx)即返回;
 *  网络层失败(跨域被拦/混合内容/不可达/超时)且还有后续通道(桌面
 *  中继)时自动回落。全失败抛最后一个错误 —— 通道顺序:直连优先。
 *  (导出供同族 tts.ts 合成通道复用同一回落语义。) */
export async function tryChannels(channels: Array<() => Promise<Response>>): Promise<Response> {
  let lastErr: unknown;
  for (const attempt of channels) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('网络请求失败');
}

/** 鉴权头:Key 为空不发(内网自建网关常无鉴权)。 */
export function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 音频 → base64(FileReader 的 dataURL 通道,大数组不经 JS 拼接)。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('读取录音失败'));
    r.readAsDataURL(blob);
  });
}

/** 采样率:ASR 通用输入(whisper/qwen3-asr 等均为 16k 级)。 */
const ASR_SAMPLE_RATE = 16_000;

/**
 * 采集的 PCM 块(源采样率单声道)→ 16k 单声道 16-bit PCM WAV。转写后端
 * 常为 libsndfile/ffmpeg 系解码,只认 WAV/FLAC/OGG 等容器;WAV 是零依赖
 * 可达的通用格式。OfflineAudioContext 重采样,60s 上限下 ≤ 约 1.9MB。
 */
async function pcmToWav16k(chunks: Float32Array<ArrayBuffer>[], srcRate: number): Promise<Blob> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total === 0) throw new Error('录音时长过短,未采集到音频');
  if (srcRate === ASR_SAMPLE_RATE) {
    // 宿主桥按 ASR 率直供:拼接直打 WAV 头,零 AudioContext 依赖
    // (桥形态正是为绕开受限环境,别引入受限依赖)。
    const all = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return encodeWav(all, ASR_SAMPLE_RATE);
  }
  try {
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((total / srcRate) * ASR_SAMPLE_RATE)), ASR_SAMPLE_RATE);
    // 块拼回源采样率的 AudioBuffer,离线渲染一并完成重采样
    const buffer = off.createBuffer(1, total, srcRate);
    let o = 0;
    for (const c of chunks) {
      buffer.copyToChannel(c, 0, o);
      o += c.length;
    }
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return encodeWav(rendered.getChannelData(0), ASR_SAMPLE_RATE);
  } catch {
    throw new Error('录音处理失败,请重试');
  }
}

/** Float32 单声道样本 → 16-bit PCM WAV Blob(44 字节标准头)。 */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt 块长度
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // 字节率 = rate × 声道 × 2
  v.setUint16(32, 2, true); // 块对齐
  v.setUint16(34, 16, true); // 位深
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 200 但回了 HTML(管理面板 SPA 兜底路由)→ 地址指错,给出可读错误。 */
export function assertNotHtml(res: Response): void {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    throw new Error('接口返回了 HTML:地址可能指向管理页面而非 API(检查 /v1 或网关前缀)');
  }
}

/** 共享 AudioContext:创建 + resume 是录音冷启动的大头,跨录音复用把
 *  就绪时间压到 getUserMedia + 首个音频回调;空闲时无源连接,开销可忽略。 */
let sharedCtx: AudioContext | null = null;

async function ensureCtx(): Promise<AudioContext> {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state !== 'running') await sharedCtx.resume();
  return sharedCtx;
}

/** AudioWorklet 采集器源码(Blob URL 装载;音频线程批量 4096 帧上报,
 *  从首个渲染量子起全量收)。 */
const WORKLET_SRC = `class R extends AudioWorkletProcessor{
constructor(){super();this.n=0;this.buf=new Float32Array(4096)}
process(i){const c=i[0]&&i[0][0];if(!c)return true;
const free=this.buf.length-this.n;const take=Math.min(free,c.length);
this.buf.set(c.subarray(0,take),this.n);this.n+=take;
if(this.n===this.buf.length||take<c.length){
this.port.postMessage(this.n===this.buf.length?this.buf:this.buf.slice(0,this.n));
this.buf=new Float32Array(4096);this.n=0;
if(take<c.length){this.buf.set(c.subarray(take));this.n=c.length-take}}
return true}}
registerProcessor('goder-rec',R)`;

let workletLoaded: Promise<void> | null = null;

/** 装载采集 worklet(模块按上下文注册,共享 ctx 只装一次);失败返回
 *  false,调用方回落 ScriptProcessor。 */
async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    if (!workletLoaded) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      workletLoaded = ctx.audioWorklet.addModule(url);
    }
    await workletLoaded;
    return true;
  } catch {
    workletLoaded = null;
    return false;
  }
}

/** 麦克风保温:录音结束后保留流 90 秒待命,期间再次录音跳过 getUserMedia
 *  (冷启动的大头,「按下→可捕获」的主要延迟来源),按下后几十毫秒即出
 *  首块;过期自动停轨释放。保温期内系统麦克风指示常亮属预期。 */
const MIC_WARM_MS = 90_000;

let warmStream: MediaStream | null = null;
let warmTimer = 0;

function releaseWarmStream(): void {
  if (warmTimer) {
    clearTimeout(warmTimer);
    warmTimer = 0;
  }
  warmStream?.getTracks().forEach((t) => t.stop());
  warmStream = null;
}

/** 取可用麦克风流:保温期内直接复用,否则新开(权限错误映射中文)。 */
async function acquireStream(): Promise<MediaStream> {
  if (warmStream) {
    const live = warmStream.getAudioTracks().some((t) => t.readyState === 'live');
    if (live) return warmStream;
    releaseWarmStream();
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    return s;
  } catch (e) {
    throw new Error(mapMicError(e));
  }
}

/** 录音结束后保温(滚动续期)。 */
function keepWarmStream(s: MediaStream): void {
  warmStream = s;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = window.setTimeout(releaseWarmStream, MIC_WARM_MS);
}

/** 预热麦克风:保温池为空时静默开麦(输入框获得焦点时调用 —— 用户点进
 *  输入框即是「要输入」的意图信号,首次录音也能零冷启动;保温期内
 *  调用为空操作)。失败静默,真正开录时才报错。 */
export async function prewarmMic(): Promise<void> {
  if (hostVoiceBridge()) return; // 桥环境采集不走 getUserMedia,保温只会静默失败
  try {
    keepWarmStream(await acquireStream());
  } catch {
    /* 静默 */
  }
}

/**
 * 一次录音会话(PCM 直采):start() 开录,stop() 停录并上传转写、以识别
 * 文本 resolve;abort() 取消(丢弃音频不上传)。达到 MAX_RECORD_MS 自动
 * 走停录上传,此时先到的 stop() 直接复用同一结果。非复用组件,每次录音
 * 新建实例。不采用 MediaRecorder:WKWebView 直启丢最初一两百毫秒且容器
 * 需二次解码;AudioWorklet(回落 ScriptProcessor)从管线流动的第一块起
 * 全量收,天然零丢头。start() 在收到**第一块音频**后才落定 —— 调用方的
 * 「录音中」视觉提示以此为准,红色之后说出的话必然已被捕获。
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  /** 采集的 PCM 块(源采样率单声道;worklet/回调侧已拷贝) */
  private chunks: Float32Array<ArrayBuffer>[] = [];
  /** 采集上下文的采样率(共享 ctx 的,不 close) */
  private srcRate = 48_000;
  /** 累计样本数 */
  private total = 0;
  private timer = 0;
  private stopped = false;
  private aborted = false;
  /** 宿主录音桥会话(桥模式录音期间非空;采集生命周期见 start 桥分支) */
  private bridge: HostVoiceBridge | null = null;
  /** 桥增量轮询定时器(桥模式录音期间非 0;globalThis 兼容 node 单测) */
  private bridgeTimer: ReturnType<typeof setInterval> | 0 = 0;
  private result: Promise<string> | null = null;
  private settle?: (text: string) => void;
  private fail?: (err: Error) => void;
  /** 首块音频到达信号(start 落定条件) */
  private firstBlock?: () => void;

  constructor(private readonly params: TranscribeParams) {}

  /** 收到一块音频(worklet 消息 / ScriptProcessor 回调共用的入列路径)。 */
  private feed(chunk: Float32Array<ArrayBuffer>): void {
    if (this.stopped) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    if (this.firstBlock) {
      this.firstBlock();
      this.firstBlock = undefined;
    }
  }

  /** 开始录音;权限被拒/无设备时 reject(中文文案)。首块音频到达才落定。 */
  async start(): Promise<void> {
    if (this.node || this.bridge) return; // 已在录音(幂等)
    if (!this.params.apiBaseUrl.trim()) throw new Error('未配置转写接口地址(设置 → 语音)');

    // 宿主桥优先:原生采集不受 WebView 渲染进程限制(部分 ROM 拦
    // getUserMedia),16k Int16 PCM 直供,无 AudioContext/getUserMedia 依赖。
    const bridge = hostVoiceBridge();
    if (bridge) {
      const ok = bridge.start();
      if (ok !== 'ok') {
        throw new Error(
          ok === 'PERMISSION'
            ? '已弹出麦克风权限申请,授权后请再按一次话筒'
            : typeof ok === 'string' && ok
              ? ok
              : '宿主录音启动失败',
        );
      }
      this.bridge = bridge;
      this.srcRate = bridge.sampleRate() || 16_000;
      this.chunks = [];
      this.total = 0;
      this.bridgeTimer = globalThis.setInterval(() => {
        const b64 = bridge.poll();
        if (b64) this.feed(bridgeChunkToFloat32(b64));
      }, 250);
      // 首块到达(2s 超时兜底,与音频管线同语义)才算真正开录
      await Promise.race([
        new Promise<void>((r) => (this.firstBlock = r)),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      this.result = new Promise<string>((resolve, reject) => {
        this.settle = resolve;
        this.fail = reject;
      });
      this.timer = globalThis.setTimeout(() => void this.finish(), MAX_RECORD_MS);
      return;
    }

    if (!recorderSupported()) throw new Error('当前环境不支持录音(需要 HTTPS 页面与麦克风)');
    const stream = await acquireStream(); // 保温复用/新开(getUserMedia)
    this.stream = stream;
    const ctx = await ensureCtx();
    this.srcRate = ctx.sampleRate;
    this.chunks = [];
    this.total = 0;
    let node: AudioNode;
    if (await ensureWorklet(ctx)) {
      const aw = new AudioWorkletNode(ctx, 'goder-rec');
      aw.port.onmessage = (ev) => this.feed(ev.data as Float32Array<ArrayBuffer>);
      node = aw;
    } else {
      // 回落:ScriptProcessor(回调缓冲区复用,必须拷贝)
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (ev) => this.feed(new Float32Array(ev.inputBuffer.getChannelData(0)));
      node = sp;
    }
    this.node = node;
    this.src = ctx.createMediaStreamSource(stream);
    // 输出不写即静音,连 destination 只为驱动节点被拉流
    this.src.connect(node);
    node.connect(ctx.destination);
    // 首块到达(2s 超时兜底:极端环境管线不流动也别卡死)才算真正开录
    await Promise.race([
      new Promise<void>((r) => (this.firstBlock = r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    this.result = new Promise<string>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    // 录音上限:到点自动停录走同一条上传路径,后到的 stop() 复用结果
    this.timer = window.setTimeout(() => void this.finish(), MAX_RECORD_MS);
  }

  /** 停止录音并上传转写;resolve 为识别文本。 */
  stop(): Promise<string> {
    if (!this.result) return Promise.reject(new Error('尚未开始录音'));
    void this.finish();
    return this.result;
  }

  /** 取消录音:丢弃音频不上传(result 以空文本落定)。 */
  abort(): void {
    if (this.stopped) return;
    this.aborted = true;
    this.stopped = true;
    this.teardownBridge(true);
    this.teardown();
    this.settle?.('');
  }

  private teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    if (this.node) {
      if (this.node instanceof AudioWorkletNode) this.node.port.onmessage = null;
      else if (this.node instanceof ScriptProcessorNode) this.node.onaudioprocess = null;
      this.node.disconnect();
      this.node = null;
    }
    this.src?.disconnect();
    this.src = null;
    // 共享 ctx 不 close;麦克风流进保温池(90 秒内再次录音零冷启动)
    if (this.stream) {
      keepWarmStream(this.stream);
      this.stream = null;
    }
  }

  /** 桥会话收尾:停轮询;discard=true 丢弃(abort),否则停录拉尾块入列。 */
  private teardownBridge(discard: boolean): void {
    const bridge = this.bridge;
    if (!bridge) return;
    this.bridge = null;
    if (this.bridgeTimer) {
      clearInterval(this.bridgeTimer);
      this.bridgeTimer = 0;
    }
    if (discard) bridge.cancel();
    else {
      const tail = bridge.stop();
      if (tail) this.feed(bridgeChunkToFloat32(tail));
    }
  }

  /** 停录落点:收尾音频图 → PCM 转 WAV 上传 → settle。 */
  private async finish(): Promise<void> {
    if (this.stopped) return;
    // 桥模式先收尾块再置 stopped(feed 守卫依赖它;丢弃路径在 abort)
    this.teardownBridge(false);
    this.stopped = true;
    this.teardown();
    if (this.aborted) {
      this.settle?.('');
      return;
    }
    try {
      const text = await this.transcribe();
      this.settle?.(text);
    } catch (e) {
      this.fail?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async transcribe(): Promise<string> {
    if (this.total === 0) throw new Error('录音时长过短,未采集到音频');
    // PCM → 16k 单声道 WAV:转写后端只认 WAV/FLAC/OGG 容器(实测
    // webm/mp4 容器被拒 Format not recognised)
    const wav = await pcmToWav16k(this.chunks, this.srcRate);
    // 通道:直连优先(接口允许跨域时浏览器直接发 multipart,一步到位);
    // 桌面配了中继时作回落 —— WKWebView 自定义 scheme 只给 scheme handler
    // 暴露字符串体(聊天 JSON 即此通道),FormData/Blob 体不暴露、会整体
    // 丢失(实测 0 字节文件),回落通道把 WAV base64 成纯文本体,由 Go
    // 侧中继解码重建 multipart 再发上游。
    const relay = this.params.relayBase;
    const timeout =
      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? { signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) }
        : {};
    const form = new FormData();
    form.append('file', wav, 'speech.wav');
    form.append('model', this.params.apiModel);
    if (this.params.language) form.append('language', this.params.language);
    const channels: Array<() => Promise<Response>> = [
      () =>
        apiFetch(transcribeUrl(this.params.apiBaseUrl), {
          method: 'POST',
          headers: authHeaders(this.params.apiKey),
          body: form,
          ...timeout,
        }),
    ];
    if (relay) {
      channels.push(async () => {
        const q = new URLSearchParams();
        q.set('base', this.params.apiBaseUrl.trim());
        q.set('model', this.params.apiModel);
        if (this.params.language) q.set('language', this.params.language);
        q.set('enc', 'b64');
        q.set('fmt', 'wav');
        return apiFetch(`${relay.replace(/\/+$/, '')}/speech/transcribe?${q}`, {
          method: 'POST',
          headers: { ...authHeaders(this.params.apiKey), 'Content-Type': 'text/plain; charset=utf-8' },
          body: await blobToBase64(wav),
          ...timeout,
        });
      });
    }

    let res: Response;
    try {
      res = await tryChannels(channels);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') throw new Error('转写请求超时,请稍后重试');
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('转写请求已中止');
      throw new Error(
        relay ? '接口与本地中继均不可达:请检查地址与网络' : '转写接口不可达:请检查接口地址与跨域(CORS)设置',
      );
    }
    assertNotHtml(res);
    if (!res.ok) {
      // 中继对连不上的上游回 502,单列成可读文案
      if (res.status === 502) throw new Error('无法连接转写接口:请检查地址与网络可达性');
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 160);
      } catch {
        /* 无响应体细节也能报 */
      }
      throw new Error(`转写失败(HTTP ${res.status})${detail ? `:${detail}` : ''}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error('转写接口返回了非 JSON 内容');
    }
    const text = (data as { text?: unknown })?.text;
    if (typeof text !== 'string' || !text) throw new Error('转写接口返回异常(缺少 text 字段)');
    return text.trim();
  }
}

/** getUserMedia 异常 → 中文提示。 */
function mapMicError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return '麦克风权限被拒绝,请在系统/浏览器设置中允许';
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') return '未找到可用的麦克风设备';
  }
  return '无法访问麦克风';
}

/** 模型列表检测的超时 */
const DETECT_TIMEOUT_MS = 20_000;

/**
 * 拉取语音接口的模型列表(设置页「检测」按钮的通用数据源:转写与合成
 * 共用):浏览器直连 GET /models,与转写上传同一通道(接口需允许跨域)。
 * 兼容 OpenAI 的 `{data:[{id}]}` 信封与裸数组两种形态,返回去重排序后的
 * 全量 id;是否像转写/合成模型由调用方经 filterTranscribeModels /
 * filterTtsModels(tts.ts)再筛。
 */
export async function fetchModelIds(
  params: Pick<TranscribeParams, 'apiBaseUrl' | 'apiKey' | 'relayBase'>,
): Promise<string[]> {
  const timeout =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? { signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) } : {};
  // 直连优先(接口允许跨域时一步到位);网络层失败且配了中继(桌面)时回落
  let res: Response;
  try {
    res = await tryChannels([
      () => apiFetch(modelsUrl(params.apiBaseUrl), { headers: authHeaders(params.apiKey), ...timeout }),
      ...(params.relayBase
        ? [() => apiFetch(relayUrl(params.relayBase!, params.apiBaseUrl), { headers: authHeaders(params.apiKey), ...timeout })]
        : []),
    ]);
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('模型列表请求超时,请稍后重试');
    }
    throw new Error(
      params.relayBase ? '接口与本地中继均不可达:请检查地址与网络' : '接口不可达:请检查接口地址与跨域(CORS)设置',
    );
  }
  assertNotHtml(res);
  if (!res.ok) {
    if (res.status === 502) throw new Error('无法连接接口:请检查地址与网络可达性');
    throw new Error(`获取模型列表失败(HTTP ${res.status})`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('接口返回了非 JSON 内容');
  }
  const list: unknown[] = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data ?? [];
  const ids = new Set<string>();
  for (const item of list) {
    const id = typeof item === 'string' ? item : (item as { id?: unknown })?.id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  if (!ids.size) throw new Error('接口未返回任何模型');
  return [...ids].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
