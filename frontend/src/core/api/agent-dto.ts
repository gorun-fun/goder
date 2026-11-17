// agent-dto.ts — gh server「智能体配置」的 DTO(模型供应商/插件/MCP/技能)。
// 桌面 wails 服务(internal/desktop/modelconfig.go 等)与网页形态
// /v1/agent/* API(core/settings/agent-api.ts)同构共用 —— 独立成模块,
// core 不再依赖 UI 宿主桥取类型(bridge 反向引用这里)。

export interface ProviderDTO {
  name: string;
  /** 协议类型;空串表示 gh 默认(OpenAI 兼容) */
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** 网页形态(agent API):是否已设置 Key(明文不下发,apiKey 恒空);
   * 桌面形态不填(undefined 按已有明文行为) */
  hasKey?: boolean;
  /** 网页形态 PUT 专用:改名时指向改名前的供应商名,空 apiKey 从它继承 */
  keepKeyFrom?: string;
  /** 平台托管(嵌入方反代在 GET 响应注入,gh 不持久化):界面只读展示——
   * 名称/协议/baseUrl/apiKey 不显示不可改,模型列表只读;PUT 随整表
   * 原样回传保真(gh 侧忽略未知字段) */
  managed?: boolean;
}

export interface ModelConfigDTO {
  /** settings.json 路径(展示用) */
  path: string;
  providers: ProviderDTO[];
  /** gh settings.json 的 default(gh CLI/服务端自己的默认模型概念;
   * goder 不消费,仅整体写回时透传保真,勿删) */
  default: string;
  /** 目标文件是否可写(不可写时 UI 只读) */
  writable: boolean;
  /** gh settings 常用项;null 表示文件里没有该键,保存时原样保留 */
  maxSteps: number | null;
  mouse: boolean | null;
  policy: string;
}

export interface DetectedModelDTO {
  id: string;
  ctxLen: number;
}

export interface PluginDTO {
  name: string;
  /** 本地 stdio 插件:可执行文件 + 参数 */
  command: string[];
  /** 远程 MCP:Streamable HTTP 端点 */
  url: string;
  /** 远程 MCP:Bearer token */
  token: string;
  /** 工具调用超时秒数;0 = 默认 */
  timeout: number;
  /** 网页形态(agent API):是否已设置 Token(明文不下发,token 恒空) */
  hasToken?: boolean;
}

export interface PluginsDTO {
  /** settings.json 路径(展示用) */
  path: string;
  /** 自动发现目录(~/.grf/plugins)路径 */
  dir: string;
  /** true = 显式列表模式;false = 自动发现(~/.grf/plugins/) */
  explicit: boolean;
  plugins: PluginDTO[];
  /** 自动发现目录下的可执行文件名 */
  discovered: string[];
  writable: boolean;
}

export interface SkillDTO {
  name: string;
  description: string;
  /** SKILL.md 绝对路径(展示用) */
  path: string;
  /** true = 已禁用(SKILL.md 改名 .disabled,内容保留) */
  disabled: boolean;
}

export interface SkillsDTO {
  /** skills 目录路径(展示用) */
  path: string;
  skills: SkillDTO[];
  writable: boolean;
}

// ---------- 集群模式(gh settings.json 的 cluster 段 + 状态快照;与 gh
// config.Cluster / server.clusterStatus 对齐。双形态统一走 /v1/agent/cluster,
// 无桌面桥副本——校验归一权威在 gh 服务端 normalizeClusterCfg) ----------
// 对等网形态:无指挥官/节点角色,谁提问谁派发;peers 互配多点 call-home。

/** 对等节点表条目(既是 call-home 对象,也是直连派发候选;goder 设置页编辑对象) */
export interface ClusterNodeDTO {
  /** gh server 地址 host:port(可带 scheme) */
  addr: string;
  /** 该节点任务面的访问令牌;空 = 用集群共享 cluster.token(全互信模型) */
  token?: string;
  /** 路由名(@name 引用;空取 addr 主机名) */
  name?: string;
  /** 能力标签(description 词汇匹配路由) */
  labels?: string[];
  /** https 自签部署的证书指纹 sha256 hex(TOFU 信任锚;空走系统校验) */
  pin?: string;
}

/** 路由参数;字段可缺省 = gh 侧全默认 */
export interface ClusterRouteDTO {
  /** 无匹配节点时回退本地子代理;缺省/true = 回退,false = 报错 */
  allow_local?: boolean;
  /** 单节点在跑远端任务上限;0/缺省 = 默认 4 */
  max_inflight_per_node?: number;
}

/** 集群段(settings.json 的 cluster 键;PUT 整体替换)。废弃键
 * (role/commander_url/nodes)仅为兼容旧配置的读入形态——前端加载即
 * 迁移并入 peers 后清除(语义对齐 gh config.MergeClusterPeers),UI 与
 * PUT 均不再写它们。 */
export interface ClusterCfgDTO {
  enabled?: boolean;
  /** @deprecated 对等网无角色,服务端恒 "peer";仅为兼容旧 settings.json 读取 */
  role?: string;
  /** 节点显示名/路由名;空 = hostname */
  name?: string;
  /** 集群共享密钥(全互信凭据):/cluster/* 端点与集群派发任务面都接受;
   * 持有它 = 可在集群内任意实例派发任务 */
  token?: string;
  /** 邀请码:非空时新实例注册/心跳须携带匹配值才准入;加入侧上送 */
  invite_code?: string;
  /** @deprecated 对等网经 peers 互注册;兼容读,迁移为一条 peers 条目 */
  commander_url?: string;
  /** 局域网自动发现:off | lan(mDNS 双向通告+浏览);缺省 off */
  discover?: string;
  /** 对等节点表(call-home 注册/心跳/收件箱的对象清单,兼直连派发候选) */
  peers?: ClusterNodeDTO[];
  /** @deprecated 原指挥官静态节点表;兼容读,按 addr 去重并入 peers */
  nodes?: ClusterNodeDTO[];
  /** 派发任务默认策略;空 = off */
  policy?: string;
  /** 工作区同步档位:none | seed | git | full;空/none = 关(任务自包含) */
  sync?: string;
  route?: ClusterRouteDTO;
}

/** GET/PUT /v1/agent/cluster 的响应信封 */
export interface ClusterCfgEnvelopeDTO {
  /** settings.json 路径(展示用) */
  path: string;
  writable: boolean;
  /** 文件里无 cluster 段时为 null */
  cluster: ClusterCfgDTO | null;
}

/** 成员能力清单(gh /cluster/capabilities 的缓存形状,不含密钥) */
export interface ClusterCapsDTO {
  node_id: string;
  name: string;
  /** gh 版本 */
  version: string;
  /** runtime GOOS/GOARCH */
  platform: string;
  tools?: string[];
  plugins?: { name: string; tools: number }[];
  /** "provider/model" 条目 */
  models?: string[];
  ts: number;
}

/** 成员表条目(本机视角的对等成员表;static 手动 | registered call-home
 * 注册 | mdns 发现) */
export interface ClusterMemberDTO {
  /** call-home 节点有;静态节点空 */
  node_id?: string;
  name: string;
  addr?: string;
  labels?: string[];
  source: string;
  /** online | offline | unknown */
  status: string;
  running_turns?: number;
  /** unix 秒 */
  last_seen?: number;
  capabilities?: ClusterCapsDTO;
}

/** 远端句柄(本方派发到远端对等实例的子代理/工作流在跑状态) */
export interface ClusterHandleDTO {
  id: string;
  node: string;
  /** running | idle */
  status: string;
  /** true = 经对端中继(回投走指令来源 peer 的收件箱) */
  relay?: boolean;
  label: string;
}

/** 集群共享记忆条目(对等多主复制;origin 记来源节点名) */
export interface ClusterMemoryEntryDTO {
  key: string;
  content: string;
  /** 来源对等实例名(本机写入的条目为空) */
  origin?: string;
  /** 最后写入日期 */
  updated?: string;
}

/** GET /v1/agent/cluster/status 的自身段 */
export interface ClusterSelfDTO {
  id: string;
  name: string;
  version: string;
  platform: string;
}

/** GET /v1/agent/cluster/status 响应(设置页对等状态面板数据源) */
export interface ClusterStatusDTO {
  enabled: boolean;
  /** 对等网恒 "peer"(字段为兼容面板保留) */
  role: string;
  self: ClusterSelfDTO;
  /** 配置的对等节点表回显 */
  peers?: ClusterNodeDTO[];
  sync?: string;
  discover?: string;
  invite_required?: boolean;
  members?: ClusterMemberDTO[];
  /** 收件箱 SSE 在线的对等实例名(中继派发可达) */
  inbox_connected?: string[];
  remote_handles?: ClusterHandleDTO[];
  /** 集群共享记忆(对等多主复制的收敛结果) */
  shared_memory?: ClusterMemoryEntryDTO[];
  running_turns: number;
}
