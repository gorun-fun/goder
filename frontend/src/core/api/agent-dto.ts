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
