// client.ts — gh server Responses API 客户端（fetch + SSE 流式解析）。
import type {
  CompactResource,
  Conversation,
  ConversationDetail,
  HistMessage,
  ResponseResource,
  SSEEvent,
  SendOptions,
} from './types';

export interface GrfClientConfig {
  baseUrl: string; // 形如 http://127.0.0.1:7400 或同源网关 /grf-api（不带 /v1）
  token: string; // Bearer 令牌;多用户网关模式由服务端注入,浏览器侧可为空
}

export class GrfApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public param?: unknown,
  ) {
    super(message);
    this.name = 'GrfApiError';
  }

  /** 401:网关/gh server 判定未登录(多用户网关模式下应触发登录流程)。 */
  isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export class GrfClient {
  private cfg: GrfClientConfig;

  constructor(cfg: GrfClientConfig) {
    this.cfg = cfg;
  }

  get config(): GrfClientConfig {
    return this.cfg;
  }

  setConfig(cfg: Partial<GrfClientConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    return `${base}/v1${path}`;
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    // 令牌为空 = 网关模式:鉴权交给网关会话,由服务端注入用户级令牌
    if (this.cfg.token) h['Authorization'] = `Bearer ${this.cfg.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async parseError(res: Response): Promise<GrfApiError> {
    let msg = `HTTP ${res.status}`;
    let code = 'http_error';
    try {
      const body = (await res.json()) as { error?: { message?: string; type?: string } };
      if (body?.error?.message) {
        msg = body.error.message;
        code = body.error.type ?? code;
      }
    } catch {
      /* ignore */
    }
    return new GrfApiError(res.status, code, msg);
  }

  async health(): Promise<void> {
    const res = await fetch(this.url('/health'), { headers: this.headers(false) });
    if (!res.ok) throw await this.parseError(res);
  }

  async listConversations(): Promise<Conversation[]> {
    const res = await fetch(this.url('/conversations'), { headers: this.headers(false) });
    if (!res.ok) throw await this.parseError(res);
    const body = (await res.json()) as { data: Conversation[] };
    return body.data ?? [];
  }

  async getConversation(id: string): Promise<ConversationDetail> {
    const res = await fetch(this.url(`/conversations/${id}`), { headers: this.headers(false) });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as ConversationDetail;
  }

  /** 运行时变更会话访问策略(立即生效,仅本会话;旧 server 404/400 时报错)。 */
  async setConversationPolicy(id: string, policy: string): Promise<string> {
    const res = await fetch(this.url(`/conversations/${id}/policy`), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ policy }),
    });
    if (!res.ok) throw await this.parseError(res);
    const body = (await res.json()) as { policy: string };
    return body.policy;
  }

  async conversationItems(id: string): Promise<HistMessage[]> {
    const res = await fetch(this.url(`/conversations/${id}/items`), { headers: this.headers(false) });
    if (!res.ok) throw await this.parseError(res);
    const body = (await res.json()) as { data: HistMessage[] };
    return body.data ?? [];
  }

  async archiveConversation(id: string): Promise<void> {
    const res = await fetch(this.url(`/conversations/${id}`), {
      method: 'DELETE',
      headers: this.headers(false),
    });
    if (!res.ok && res.status !== 404) throw await this.parseError(res);
  }

  async cancelResponse(id: string): Promise<ResponseResource | null> {
    const res = await fetch(this.url(`/responses/${id}/cancel`), {
      method: 'POST',
      headers: this.headers(),
      body: '{}',
    });
    if (!res.ok) throw await this.parseError(res);
    if (res.status === 204) return null;
    return (await res.json()) as ResponseResource;
  }

  async compact(model: string, previousResponseId: string): Promise<CompactResource> {
    const res = await fetch(this.url('/responses/compact'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, previous_response_id: previousResponseId }),
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as CompactResource;
  }

  // send 发送一轮对话。stream:true 走 SSE,事件经 onEvent 透出,
  // resolve 终态 response(completed/failed/cancelled/incomplete)。
  // idleTimeoutMs:流上无字节的看门狗(网络/代理静默断流的兜底),
  // 超时后中断 fetch 并抛 GrfApiError(stream_idle_timeout)。
  async send(opts: SendOptions): Promise<ResponseResource> {
    const idleTimeout = opts.idleTimeoutMs ?? 120_000;
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const body: Record<string, unknown> = {
      stream: true,
      input: opts.input,
    };
    if (opts.model) body.model = opts.model;
    if (opts.previousResponseId) body.previous_response_id = opts.previousResponseId;
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.grfSession) body['grf:session'] = opts.grfSession;
    if (opts.grfHistory) body['grf:history'] = opts.grfHistory;

    let res: Response;
    try {
      res = await fetch(this.url('/responses'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      opts.signal?.removeEventListener('abort', onOuterAbort);
      throw err;
    }
    if (!res.ok) {
      opts.signal?.removeEventListener('abort', onOuterAbort);
      throw await this.parseError(res);
    }
    if (!res.body) throw new Error('响应无 body(stream 未生效)');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let final: ResponseResource | null = null;
    let gotBytes = false;

    const handleEvent = (raw: string) => {
      const lines = raw.split('\n');
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return;
      let ev: SSEEvent;
      try {
        ev = JSON.parse(data) as SSEEvent;
      } catch {
        return;
      }
      opts.onEvent?.(ev);
      if (ev.response && isTerminal(ev.response.status)) final = ev.response;
    };

    try {
      for (;;) {
        // 看门狗:单次 read 超时视为流静默中断。
        const { done, value } = await raceTimeout(reader.read(), idleTimeout);
        if (done) break;
        gotBytes = true;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.trim()) handleEvent(chunk);
        }
      }
    } catch (err) {
      // 超时或网络错误:中断底层连接,上抛让调用方走恢复路径。
      ac.abort();
      opts.signal?.removeEventListener('abort', onOuterAbort);
      if (gotBytes && final) return final; // 已拿到终态快照,直接用
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
    if (buf.trim()) handleEvent(buf);

    if (!final) {
      // 流中断且无终态:回合可能蒸发(server 重启)或网络断——上抛让调用方处理。
      throw new GrfApiError(0, 'stream_interrupted', '事件流中断且未收到终态');
    }
    return final;
  }

  // retrieveResponse 按响应 id 查终态/进行中快照(断流自愈用)。
  async retrieveResponse(id: string): Promise<ResponseResource | null> {
    const res = await fetch(this.url(`/responses/${encodeURIComponent(id)}`), {
      headers: this.headers(false),
    });
    if (!res.ok) return null;
    return (await res.json()) as ResponseResource;
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GrfApiError(0, 'stream_idle_timeout', `流上 ${ms / 1000}s 无数据,视为中断`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function isTerminal(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'incomplete'
  );
}
