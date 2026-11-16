// agent-api.ts — gh server /v1/agent/* 的浏览器客户端:网页/嵌入形态
// 设置页「智能体配置」的数据源(桌面形态走 host/bridge 的 wails 服务,
// 两者同一套 DTO)。要求网关按用户注入 GRF_HOME(配置随用户隔离)。
//
// 密钥安全往返(掩码语义):GET 只回空 apiKey/token + hasKey/hasToken;
// PUT 空值 = 保留现值(改名经 keepKeyFrom 指回旧条目),非空 = 更换。
import { apiFetch } from '../api/fetch';
import type {
  ClusterCfgDTO,
  ClusterCfgEnvelopeDTO,
  ClusterStatusDTO,
  DetectedModelDTO,
  ModelConfigDTO,
  PluginsDTO,
  ProviderDTO,
  SkillsDTO,
} from '../api/agent-dto';

/** agent API 不可用(404 = gh server 过旧/未启用)时抛出,调用方回落引导文案 */
export class AgentApiUnsupportedError extends Error {
  constructor() {
    super('gh server 不支持 /v1/agent/* 配置 API(需较新版本 gh)');
  }
}

async function req<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await apiFetch(`${base}/v1/agent/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 404) throw new AgentApiUnsupportedError();
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try {
      const j = (await resp.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* 保留状态码 */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

// ---------- 模型 / Harness 常用项 ----------

export function fetchModelCfg(baseUrl: string, token: string): Promise<ModelConfigDTO> {
  return req<ModelConfigDTO>(baseUrl, token, 'GET', 'models');
}

export function putModelCfg(baseUrl: string, token: string, cfg: ModelConfigDTO): Promise<void> {
  return req<void>(baseUrl, token, 'PUT', 'models', cfg);
}

/** 探测供应商模型列表(服务端代理请求,OpenAI 兼容 /models)。
 * 返回富结果(id + ctxLen):新版 gh 的 modelsRich 带 ctxLen,旧版只有
 * models 纯 id 数组(ctxLen 回 0,调用方回落估算表)。失败返回 null。 */
export async function detectModelsRemote(
  baseUrl: string,
  token: string,
  p: Pick<ProviderDTO, 'name' | 'baseUrl' | 'apiKey'>,
): Promise<DetectedModelDTO[] | null> {
  try {
    const out = await req<{ models?: string[]; modelsRich?: { id: string; ctxLen?: number }[] }>(
      baseUrl,
      token,
      'POST',
      'models/detect',
      p,
    );
    if (Array.isArray(out.modelsRich)) {
      return out.modelsRich.map((m) => ({ id: m.id, ctxLen: m.ctxLen && m.ctxLen > 0 ? m.ctxLen : 0 }));
    }
    return (out.models ?? []).map((id) => ({ id, ctxLen: 0 }));
  } catch {
    return null;
  }
}

// ---------- 插件 / MCP ----------

export function fetchPlugins(baseUrl: string, token: string): Promise<PluginsDTO> {
  return req<PluginsDTO>(baseUrl, token, 'GET', 'plugins');
}

export function putPlugins(baseUrl: string, token: string, cfg: PluginsDTO): Promise<void> {
  return req<void>(baseUrl, token, 'PUT', 'plugins', cfg);
}

// ---------- 技能 ----------

export function fetchSkills(baseUrl: string, token: string): Promise<SkillsDTO> {
  return req<SkillsDTO>(baseUrl, token, 'GET', 'skills');
}

export async function getSkillRemote(baseUrl: string, token: string, name: string): Promise<string | null> {
  try {
    const out = await req<{ content: string }>(baseUrl, token, 'GET', `skills/${encodeURIComponent(name)}`);
    return out.content;
  } catch {
    return null;
  }
}

export async function putSkillRemote(baseUrl: string, token: string, name: string, content: string): Promise<string | null> {
  try {
    await req(baseUrl, token, 'PUT', `skills/${encodeURIComponent(name)}`, { content });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function deleteSkillRemote(baseUrl: string, token: string, name: string): Promise<string | null> {
  try {
    await req(baseUrl, token, 'DELETE', `skills/${encodeURIComponent(name)}`);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function setSkillEnabledRemote(baseUrl: string, token: string, name: string, enabled: boolean): Promise<string | null> {
  try {
    await req(baseUrl, token, 'POST', `skills/${encodeURIComponent(name)}/enabled`, { enabled });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------- 集群模式 ----------
// 双形态统一走这两个端点(桌面 /goder-api 同源反代直通 gh server,
// 不加桌面桥副本:枚举校验与归一的权威在 gh 服务端 normalizeClusterCfg,
// 客户端不复制第二套语义)。注意集群段只在 gh server 启动时装配,
// PUT 落盘后需重启进程才生效——生效编排见 settings-store 的 saveClusterCfg。

/** 读集群配置段(信封含 settings.json 路径与可写探测;无段时 cluster 为 null)。 */
export function fetchClusterCfg(baseUrl: string, token: string): Promise<ClusterCfgEnvelopeDTO> {
  return req<ClusterCfgEnvelopeDTO>(baseUrl, token, 'GET', 'cluster');
}

/** 整体替换集群段;响应即归一后的信封,直接回填内存态。 */
export function putClusterCfg(baseUrl: string, token: string, cfg: ClusterCfgDTO): Promise<ClusterCfgEnvelopeDTO> {
  return req<ClusterCfgEnvelopeDTO>(baseUrl, token, 'PUT', 'cluster', cfg);
}

/** 节点状态快照(设置页节点面板数据源:成员表/收件箱在线/远端句柄)。 */
export function fetchClusterStatus(baseUrl: string, token: string): Promise<ClusterStatusDTO> {
  return req<ClusterStatusDTO>(baseUrl, token, 'GET', 'cluster/status');
}
