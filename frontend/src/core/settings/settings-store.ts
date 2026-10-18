// settings.ts — 应用级设置状态(页面唯一实例),供设置页与桌面入口共用:
// - 常规:服务连接(托管 gh server / 远程),桌面态经 wails 桥持久化到
//   ~/Library/Application Support/goder/config.json;
// - 外观:主题 / 强调色 / 字号,写 documentElement 的 --goder-skin-* 挂钩
//   (见 ui/theme.ts)穿透全部 shadow DOM 即时生效,并镜像到 localStorage,
//   桌面与浏览器两种形态重启后都能即刻恢复;
// - 模型:供应商配置读写(gh settings.json;默认模型是 gh 侧概念,goder
//   不设不用 —— 会话模型按"同项目最近会话 → 全局最近会话"继承)。
// 桌面形态通道:host/bridge 的 wails 服务(纯 web 态 no-op 回退)。
// 说明:这是 core 内已知的唯一 host 依赖点——设置页的数据装配层,30+
// 个服务符号按「桥 vs /v1/agent 远程」双形态分派,整体注入改造收益
// 不成比例,按装配层定位保留(「core 可整体拷出」对 settings 目录
// 需连 host/bridge 一起评估;store/scope 等其余 core 已无 host 依赖)。
import {
  inWails,
  initHostBridge,
  loadAppConfig,
  loadModelConfig,
  detectModels,
  loadPlugins,
  savePlugins,
  loadSkills,
  getSkillContent,
  saveSkill,
  deleteSkill,
  pluginRemoteList,
  pluginInstall,
  pluginDelete,
  skillRemoteList,
  skillInstall,
  skillInstallFromURL,
  skillSetEnabled,
  saveAppConfig,
  saveModelConfig,
  serverStart,
  serverStatus,
  serverStop,
  type AppConfigDTO,
  type ModelConfigDTO,
  type ProviderDTO,
  type DetectedModelDTO,
  type PluginsDTO,
  type PluginDTO,
  type SkillsDTO,
  type RemoteReleaseDTO,
  type ServerStatusDTO,
} from '../../host/bridge';
import { getScope, configureScope, savedConn, locationDefaultBase, setModelNameResolver } from '../store/scope';
import { kvGet, kvSet } from '../store/storage';
import {
  fetchModelCfg,
  putModelCfg,
  detectModelsRemote,
  fetchPlugins,
  putPlugins,
  fetchSkills,
  getSkillRemote,
  putSkillRemote,
  deleteSkillRemote,
  setSkillEnabledRemote,
  AgentApiUnsupportedError,
} from './agent-api';

// 外观(主题/强调色/字号)的纯计算——预设色表、自定义强调色派生、
// 浅色皮肤常量与 CSS 变量表生成——已外移 appearance.ts(无 DOM 依赖,
// node 环境可独立单测);此处 re-export 维持原导出面(设置页分区与
// 嵌入库在消费),DOM 应用留在下方 applyAppearanceVars。
export { ACCENTS, FONT_MIN, FONT_MAX } from './appearance';
export type { Appearance, ThemeMode, AccentValue } from './appearance';
import { DEFAULT_APPEARANCE, LS_KEY, loadAppearanceLocal, appearanceCssVars, type Appearance } from './appearance';

// ---------- 供应商模型上下文窗口(探测缓存) ----------
// OpenAI 兼容网关(token-hub / OpenRouter / SiliconFlow / vLLM 等)会在
// GET /models 的模型对象上回报上下文窗口(context_length 等字段);
// 这里缓存「provider → {url, 裸模型名 → token 数}」,url 指纹不符即失效。
// localStorage 双形态通用,重启后免探测直接可用。
const CTX_LS_KEY = 'goder-ctxlens-v1';

interface ProviderCtx {
  url: string;
  lens: Record<string, number>;
}

function loadCtxLensLocal(): Record<string, ProviderCtx> {
  const p = kvGet<Record<string, { url?: unknown; lens?: unknown }>>(CTX_LS_KEY);
  if (!p) return {};
  const out: Record<string, ProviderCtx> = {};
  for (const [name, v] of Object.entries(p)) {
    if (typeof v?.url !== 'string' || typeof v?.lens !== 'object' || v.lens === null) continue;
    const lens: Record<string, number> = {};
    for (const [m, n] of Object.entries(v.lens as Record<string, unknown>)) {
      if (typeof n === 'number' && n > 0) lens[m] = n;
    }
    out[name] = { url: v.url, lens };
  }
  return out;
}

function saveCtxLensLocal(data: Record<string, ProviderCtx>): void {
  kvSet(CTX_LS_KEY, data);
}

/** 模型名去 provider 前缀取裸名(与 util/modelctx 的匹配规则一致) */
function bareModelName(model: string): string {
  return model.toLowerCase().split('/').pop() ?? model.toLowerCase();
}

type Listener = () => void;

class SettingsStore {
  cfg: AppConfigDTO = {
    scope: 'app',
    serverMode: 'managed',
    // web 形态默认同源网关(/goder-api);桌面态此字段仅在远程模式生效
    remoteUrl: locationDefaultBase(),
    remoteToken: '',
    ghBinary: 'gh',
    serverAddr: '127.0.0.1:7400',
  };
  srv: ServerStatusDTO | null = null;
  /** gh 侧模型配置(settings.json 的 providers/default);非桌面态为 null */
  modelCfg: ModelConfigDTO | null = null;
  /** 供应商模型上下文窗口探测缓存(provider 名 → url 指纹 + 裸模型名 → token 数) */
  ctxLens: Record<string, ProviderCtx> = loadCtxLensLocal();
  /** 已探测过(成功或失败)的 provider:会话内不重复请求,防渲染每帧触发 */
  private ctxProbed = new Set<string>();
  /** 智能体扩展:插件/MCP(settings.json 的 plugins);非桌面态为 null */
  pluginsCfg: PluginsDTO | null = null;
  /** 智能体扩展:技能(~/.grf/skills);非桌面态为 null */
  skillsCfg: SkillsDTO | null = null;
  /** 在线可安装产物(官方下载服务器);null = 未拉取/不可达 */
  remotePlugins: RemoteReleaseDTO | null = null;
  remoteSkills: RemoteReleaseDTO | null = null;
  /** 网页形态 gh 配置 API(/v1/agent/*)可用性:unknown 未探测,ok 可用
   * (配置随登录用户隔离),unsupported = gh server 过旧,设置页回落引导 */
  agentApi: 'unknown' | 'ok' | 'unsupported' = 'unknown';
  appearance: Appearance = { ...DEFAULT_APPEARANCE };
  /** 桌面态桥配置是否已加载完成 */
  loaded = false;

  /** 网页形态 agent API 连接参数(沿用设置页的连接配置) */
  private get conn(): { baseUrl: string; token: string } {
    return { baseUrl: this.cfg.remoteUrl || locationDefaultBase(), token: this.cfg.remoteToken };
  }

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    for (const fn of this.listeners) fn();
  }

  /** 启动即恢复外观(localStorage 镜像,双形态通用、即刻生效) */
  initAppearance(): void {
    this.appearance = loadAppearanceLocal();
    this.applyAppearanceVars();
  }

  /**
   * 纯 web 态启动初始化:以 scope 已保存的连接回填配置再应用,
   * 避免用默认值覆盖上次在设置页保存的地址/Token。
   */
  initWebConn(scope: string): void {
    const saved = savedConn(scope);
    if (saved?.baseUrl) this.cfg.remoteUrl = saved.baseUrl;
    if (saved?.token) this.cfg.remoteToken = saved.token;
    this.applyConnection(scope);
  }

  setAppearance(patch: Partial<Appearance>): void {
    this.appearance = { ...this.appearance, ...patch };
    kvSet(LS_KEY, this.appearance);
    this.applyAppearanceVars();
    this.bump();
  }

  /** 把外观写到 documentElement 的 skin 挂钩上(穿透全部 shadow DOM
   * 即时生效);变量表由 appearance.ts 的 appearanceCssVars 纯计算,
   * 这里只做 DOM 应用,null = 清除覆写走 ui/theme.ts 默认值,键序即应用序。 */
  private applyAppearanceVars(): void {
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(appearanceCssVars(this.appearance))) {
      if (value === null) root.removeProperty(name);
      else root.setProperty(name, value);
    }
  }

  patchCfg(patch: Partial<AppConfigDTO>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.bump();
  }

  /** 保存配置并即时应用到连接(scope 为数据域名,桌面为 'app') */
  async saveCfg(scope: string): Promise<void> {
    await saveAppConfig(this.cfg);
    this.applyConnection(scope);
    this.bump();
  }

  /** 按当前模式把连接信息应用到 scope(桌面恒走同源代理) */
  applyConnection(scope: string): void {
    if (!inWails()) {
      configureScope(scope, { baseUrl: this.cfg.remoteUrl, token: this.cfg.remoteToken });
      return;
    }
    configureScope(scope, {
      baseUrl: `${location.origin}/goder-api`,
      token: this.cfg.serverMode === 'managed' ? (this.srv?.token ?? '') : this.cfg.remoteToken,
      // 桌面态连接副本连带 token 落本地存储(本机 gh 短期令牌,冷启动直连用)
      persistToken: true,
    });
  }

  // ---------- 双形态分派收敛(桌面 wails 桥 vs 网页 /v1/agent 远程通道) ----------

  /**
   * 智能体配置读取收敛模板:网页形态走 gh server /v1/agent API(网关按
   * 用户注入 GRF_HOME,读到的就是登录用户自己的配置;密钥掩码,apiKey
   * 恒空 + hasKey),成功置 agentApi = 'ok',404(gh 过旧)置
   * 'unsupported' 供设置页回落引导,其余失败静默——但无论成败都 bump()
   * 驱动界面进回落态。桌面形态走 wails 桥,失败(null)不置位不 bump。
   * remote/bridge 适配器各自带归一化(网页 DTO 的可缺省字段补默认),
   * set 只做置位;每次网页路径调用都会重新探测可用性(与收敛前一致)。
   */
  private async loadAgentCfg<T>(remote: () => Promise<T>, bridge: () => Promise<T | null>, set: (v: T) => void): Promise<void> {
    if (!inWails()) {
      try {
        const cfg = await remote();
        this.agentApi = 'ok';
        set(cfg);
      } catch (e) {
        if (e instanceof AgentApiUnsupportedError) this.agentApi = 'unsupported';
      }
      this.bump();
      return;
    }
    const cfg = await bridge().catch(() => null);
    if (cfg) {
      set(cfg);
      this.bump();
    }
  }

  /**
   * 智能体配置保存收敛模板:remote/bridge 适配器自带各自的落盘
   * (.catch 静默,失败不阻断后续)与回读刷新(网页形态保存后回读刷新
   * 掩码标记;桌面形态按分区各自需要回读);桌面桥通道完成后统一做
   * 「托管且运行中则重启使其生效」(gh server 只在启动时读 settings.json,
   * 桌面 scope 恒为 'app'),网页分支不做重启判定(与收敛前一致)。
   */
  private async saveAgentCfg(remote: () => Promise<void>, bridge: () => Promise<void>): Promise<void> {
    if (!inWails()) {
      await remote();
      return;
    }
    await bridge();
    if (this.cfg.serverMode === 'managed' && this.srv?.running) {
      await this.applyManaged('app').catch(() => undefined);
    }
  }

  /** 在线安装/删除收敛模板:执行桥操作,成功(无错误串)后刷新插件与
   * 技能列表并按需重启托管服务(见 afterAgentChange);失败原样返回错误。 */
  private async agentMutate(op: () => Promise<string | null>): Promise<string | null> {
    const err = await op();
    if (!err) await this.afterAgentChange();
    return err;
  }

  // ---------- 模型供应商(gh settings.json;桌面走桥,网页走 agent API) ----------

  /** 进入模型设置时拉取;force 用于保存后或外部改动后的强制刷新。 */
  async loadModelCfg(force = false): Promise<void> {
    if (this.modelCfg && !force) return;
    await this.loadAgentCfg(
      () => fetchModelCfg(this.conn.baseUrl, this.conn.token),
      () => loadModelConfig(),
      (cfg) => {
        this.modelCfg = cfg;
      },
    );
  }

  /** 把当前内存中的供应商配置写回 settings.json。 */
  async saveModelCfg(): Promise<void> {
    if (!this.modelCfg) return;
    const cfg = this.modelCfg;
    await this.saveAgentCfg(
      async () => {
        // gh server 每会话现读 settings.json,无需重启;保存后回读刷新掩码标记
        await putModelCfg(this.conn.baseUrl, this.conn.token, cfg).catch(() => undefined);
        await this.loadModelCfg(true);
      },
      // 桌面桥通道不回读(与收敛前一致),仅托管且运行中时重启生效
      () => saveModelConfig(cfg).catch(() => undefined),
    );
  }

  private patchProviders(fn: (list: ProviderDTO[]) => ProviderDTO[]): void {
    if (!this.modelCfg) return;
    this.modelCfg = { ...this.modelCfg, providers: fn(this.modelCfg.providers) };
    this.bump();
  }

  /**
   * 更新 gh settings.json 常用项(max_steps / mouse / policy)。
   * maxSteps / mouse 传 null 表示"未设置",保存时不动文件里的原键。
   */
  updateGhSettings(patch: { maxSteps?: number | null; mouse?: boolean | null; policy?: string }): void {
    if (!this.modelCfg) return;
    this.modelCfg = { ...this.modelCfg, ...patch };
    void this.saveModelCfg();
  }

  /** 新增(同名则覆盖)供应商。 */
  addProvider(p: ProviderDTO): void {
    this.patchProviders((l) => [...l.filter((x) => x.name !== p.name), p]);
    void this.saveModelCfg();
  }

  updateProvider(name: string, patch: Partial<ProviderDTO>): void {
    this.patchProviders((l) => l.map((x) => (x.name === name ? { ...x, ...patch } : x)));
    void this.saveModelCfg();
  }

  /**
   * 自动检测:询问供应商 /models 接口,把探测到的模型合并进该供应商
   * 的列表(去重后按字母排序),并缓存模型上下文窗口。双形态同构:
   * 桌面态经 wails、网页态经 gh server 代理(models/detect),均拿
   * id + ctxLen 富结果。返回探测到的数量;失败返回 -1。
   */
  async detectProviderModels(name: string): Promise<number> {
    if (!this.modelCfg) return -1;
    const p = this.modelCfg.providers.find((x) => x.name === name);
    if (!p) return -1;
    const rich = await this.detectProviderRich(p);
    if (!rich) return -1;
    this.setProviderCtx(p.name, p.baseUrl, rich);
    // 合并去重后按字母排序,检测出来的长列表才好找
    const merged = Array.from(new Set([...(p.models ?? []), ...rich.map((x) => x.id)])).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
    this.updateProvider(name, { models: merged });
    return rich.length;
  }

  /** 探测某供应商的模型(富结果):桌面态走 wails,网页态走 gh server
   * 的 models/detect 代理通道(旧版 gh 无 modelsRich 时 ctxLen 为 0,
   * 回落估算表)。失败/不适用返回 null。 */
  private detectProviderRich(p: ProviderDTO): Promise<DetectedModelDTO[] | null> {
    if (inWails()) return detectModels(p);
    if (this.agentApi !== 'ok') return Promise.resolve(null);
    return detectModelsRemote(this.conn.baseUrl, this.conn.token, p);
  }

  /** 从 "provider/model" 全名或裸模型名(含自带 / 的裸名)定位所属供应商。 */
  private providerOf(model: string): ProviderDTO | undefined {
    if (!this.modelCfg) return undefined;
    const slash = model.indexOf('/');
    if (slash > 0) {
      const hit = this.modelCfg.providers.find((p) => p.name === model.slice(0, slash));
      if (hit) return hit;
    }
    // 裸名(或前缀未命中)按 models 列表忽略大小写全文匹配
    const lower = model.toLowerCase();
    return this.modelCfg.providers.find((p) => (p.models ?? []).some((m) => m.toLowerCase() === lower));
  }

  /** 写入某 provider 的上下文窗口缓存(仅保留上游回报了长度的模型)。 */
  private setProviderCtx(name: string, url: string, models: DetectedModelDTO[]): void {
    const lens: Record<string, number> = {};
    for (const m of models) if (m.ctxLen > 0) lens[m.id] = m.ctxLen;
    this.ctxProbed.add(name);
    if (!Object.keys(lens).length) return; // 上游不回报长度:不建缓存,避免脏数据
    this.ctxLens = { ...this.ctxLens, [name]: { url, lens } };
    saveCtxLensLocal(this.ctxLens);
    this.bump();
  }

  /**
   * 查模型的真实上下文窗口:接受 "provider/model" 全名或裸模型名,
   * provider 的 baseUrl 与缓存指纹不符视为失效。查不到返回 null
   * (调用方回落 util/modelctx 的按名估算表)。
   */
  providerCtxWindow(model: string): number | null {
    if (!model) return null;
    const prov = this.providerOf(model);
    if (!prov) return null;
    const c = this.ctxLens[prov.name];
    if (!c || c.url !== prov.baseUrl) return null;
    // 查表用探测到的原始 id;先精确、其次忽略大小写(按去前缀裸名)
    const slash = model.indexOf('/');
    const suffix = slash > 0 ? model.slice(slash + 1) : model;
    if (c.lens[suffix]) return c.lens[suffix];
    const bare = bareModelName(model);
    for (const [m, n] of Object.entries(c.lens)) if (m.toLowerCase() === bare) return n;
    return null;
  }

  /**
   * 惰性探测当前模型的真实上下文窗口(聊天圆环分母):桌面态经 wails、
   * 网页态经 gh server 代理问供应商 /models(双形态同构);已有缓存、
   * 探测中或已探测过(含失败)则跳过,成功后 bump() 触发界面重渲染。
   * 网页形态 agent API 不可用(旧版 gh)时跳过,回落估算表。
   */
  probeProviderCtx(model: string): void {
    if (!model) return;
    // 网页形态评估结论:gh server 的 models/detect 代理通道可承载
    // (桌面/网页双形态同构),不再用 !inWails() 一刀切关闭;仅旧版
    // gh(无 modelsRich)拿不到 ctxLen,回落估算表。
    if (!inWails() && this.agentApi !== 'ok') return;
    const prov = this.providerOf(model);
    if (!prov || !prov.baseUrl || this.ctxProbed.has(prov.name)) return;
    const c = this.ctxLens[prov.name];
    if (c && c.url === prov.baseUrl) return;
    this.ctxProbed.add(prov.name);
    void this.detectProviderRich(prov).then((rich) => {
      if (rich) this.setProviderCtx(prov.name, prov.baseUrl, rich);
    });
  }

  /** 重命名;与目标名已存在时覆盖目标(旧的先摘掉,避免双份)。 */
  renameProvider(oldName: string, newName: string): void {
    const to = newName.trim();
    if (!to || to === oldName) return;
    // 上下文窗口缓存随迁;探测标记同步改名
    if (this.ctxLens[oldName]) {
      const { [oldName]: hit, ...rest } = this.ctxLens;
      this.ctxLens = { ...rest, [to]: hit };
      saveCtxLensLocal(this.ctxLens);
    }
    if (this.ctxProbed.has(oldName)) {
      this.ctxProbed.delete(oldName);
      this.ctxProbed.add(to);
    }
    this.patchProviders((l) => {
      const rest = l.filter((x) => x.name !== oldName && x.name !== to);
      const src = l.find((x) => x.name === oldName);
      const item: ProviderDTO = { ...(src ?? { name: to, type: '', baseUrl: '', apiKey: '', models: [] }), name: to };
      if (!inWails()) {
        // 网页形态密钥是掩码空值:改名经 keepKeyFrom 指回旧名,服务端继承原 Key
        item.apiKey = src?.apiKey ?? '';
        item.keepKeyFrom = oldName;
      }
      const oldIdx = l.findIndex((x) => x.name === oldName);
      const out = [...rest];
      out.splice(oldIdx < 0 ? out.length : Math.min(oldIdx, out.length), 0, item);
      return out;
    });
    void this.saveModelCfg();
  }

  /** 拖拽排序:把 name 移到 target 的位置(从上往下拖落在其后,
   * 从下往上拖落在其前)。非法目标(含同名)静默忽略。 */
  moveProvider(name: string, target: string): void {
    if (!this.modelCfg || name === target) return;
    const l = this.modelCfg.providers;
    const from = l.findIndex((x) => x.name === name);
    const to = l.findIndex((x) => x.name === target);
    if (from < 0 || to < 0) return;
    this.patchProviders((list) => {
      const out = [...list];
      const [item] = out.splice(from, 1);
      const ti = out.findIndex((x) => x.name === target);
      out.splice(from < to ? ti + 1 : ti, 0, item);
      return out;
    });
    void this.saveModelCfg();
  }

  removeProvider(name: string): void {
    this.patchProviders((l) => l.filter((x) => x.name !== name));
    void this.saveModelCfg();
    // 一并清掉该供应商的上下文窗口缓存与探测标记
    if (this.ctxLens[name]) {
      const { [name]: _drop, ...rest } = this.ctxLens;
      this.ctxLens = rest;
      saveCtxLensLocal(this.ctxLens);
    }
    this.ctxProbed.delete(name);
  }

  // ---------- 智能体扩展:插件/MCP(gh settings.json 的 plugins) ----------

  /** 进入插件/MCP/技能分区时拉取;force 用于保存后的强制刷新。 */
  async loadPluginsCfg(force = false): Promise<void> {
    if (this.pluginsCfg && !force) return;
    await this.loadAgentCfg(
      async () => {
        // 网页 DTO 的 command 可缺省,补空数组(界面按数组消费)
        const cfg = await fetchPlugins(this.conn.baseUrl, this.conn.token);
        return { ...cfg, plugins: (cfg.plugins ?? []).map((p) => ({ ...p, command: p.command ?? [] })) };
      },
      async () => {
        const cfg = await loadPlugins();
        return cfg ? { ...cfg, plugins: cfg.plugins ?? [] } : null;
      },
      (cfg) => {
        this.pluginsCfg = cfg;
      },
    );
  }

  /** 把插件/MCP 列表写回 settings.json 并按需重启托管 gh server。 */
  async savePluginsCfg(): Promise<void> {
    if (!this.pluginsCfg) return;
    const cfg = this.pluginsCfg;
    await this.saveAgentCfg(
      async () => {
        await putPlugins(this.conn.baseUrl, this.conn.token, cfg).catch(() => undefined);
        await this.loadPluginsCfg(true);
      },
      async () => {
        await savePlugins(cfg).catch(() => undefined);
        await this.loadPluginsCfg(true);
      },
    );
  }

  private patchPlugins(fn: (cfg: PluginsDTO) => PluginsDTO): void {
    if (!this.pluginsCfg) return;
    this.pluginsCfg = fn(this.pluginsCfg);
    void this.savePluginsCfg();
  }

  /** 本地插件与远程 MCP 共用 plugins 数组,改动后统一保存。 */
  updatePlugins(patch: Partial<Pick<PluginsDTO, 'explicit' | 'plugins'>>): void {
    this.patchPlugins((c) => ({ ...c, ...patch }));
  }

  addPlugin(p: PluginDTO): void {
    this.patchPlugins((c) => ({ ...c, plugins: [...c.plugins.filter((x) => x.name !== p.name), p] }));
  }

  updatePlugin(name: string, patch: Partial<PluginDTO>): void {
    this.patchPlugins((c) => ({
      ...c,
      plugins: c.plugins.map((x) => (x.name === name ? { ...x, ...patch } : x)),
    }));
  }

  removePlugin(name: string): void {
    this.patchPlugins((c) => ({ ...c, plugins: c.plugins.filter((x) => x.name !== name) }));
  }

  /** 把自动发现目录里的一个可执行文件加入显式列表(绝对路径)。
   * 条目名用裸名(去 .exe),command 指向目录里的真实文件。 */
  adoptDiscovered(file: string): void {
    this.patchPlugins((c) => {
      const name = file.replace(/\.exe$/, '');
      if (c.plugins.some((x) => x.name === name)) return c;
      const path = c.dir ? `${c.dir}/${file}` : file;
      return {
        ...c,
        explicit: true,
        plugins: [...c.plugins, { name, command: [path], url: '', token: '', timeout: 0 }],
      };
    });
  }

  /** 插件是否启用:显式列表模式看是否在列;自动发现模式全部启用。 */
  pluginEnabled(name: string): boolean {
    const c = this.pluginsCfg;
    if (!c) return true;
    return !c.explicit || c.plugins.some((x) => x.name === name);
  }

  /**
   * 启用/禁用插件(文件保留,只动显式列表)。自动发现模式下首次操作会
   * 把已发现的插件全部带入显式列表再摘/入该项,保证其余行为不变。
   * Windows 的发现文件名带 .exe:条目名统一用裸名,command 指向真实文件。
   */
  setPluginEnabled(name: string, enabled: boolean): void {
    this.patchPlugins((c) => {
      let plugins = c.plugins;
      let explicit = c.explicit;
      if (!explicit) {
        plugins = [
          ...plugins,
          ...c.discovered
            .filter((f) => !plugins.some((x) => x.name === f.replace(/\.exe$/, '')))
            .map((f) => ({
              name: f.replace(/\.exe$/, ''),
              command: [`${c.dir}/${f}`],
              url: '',
              token: '',
              timeout: 0,
            })),
        ];
        explicit = true;
      }
      if (enabled) {
        if (!plugins.some((x) => x.name === name)) {
          // 目录里的真实文件名(Windows 带 .exe),command 必须指向它
          const found = c.discovered.find((f) => f === name || f === `${name}.exe`);
          plugins = [...plugins, { name, command: [found ? `${c.dir}/${found}` : name], url: '', token: '', timeout: 0 }];
        }
      } else {
        plugins = plugins.filter((x) => x.name !== name);
      }
      return { ...c, explicit, plugins };
    });
  }

  // ---------- 智能体扩展:技能(~/.grf/skills/<name>/SKILL.md) ----------

  async loadSkillsCfg(force = false): Promise<void> {
    if (this.skillsCfg && !force) return;
    const norm = (cfg: SkillsDTO): SkillsDTO => ({ ...cfg, skills: cfg.skills ?? [] });
    await this.loadAgentCfg(
      async () => norm(await fetchSkills(this.conn.baseUrl, this.conn.token)),
      async () => {
        const cfg = await loadSkills();
        return cfg ? norm(cfg) : null;
      },
      (cfg) => {
        this.skillsCfg = cfg;
      },
    );
  }

  readSkill(name: string): Promise<string | null> {
    return inWails() ? getSkillContent(name) : getSkillRemote(this.conn.baseUrl, this.conn.token, name);
  }

  /** 新建/覆盖技能;返回 null 表示成功,否则为错误信息。 */
  async writeSkill(name: string, content: string): Promise<string | null> {
    const err = inWails()
      ? await saveSkill(name, content)
      : await putSkillRemote(this.conn.baseUrl, this.conn.token, name, content);
    if (!err) await this.loadSkillsCfg(true);
    return err;
  }

  /** 删除技能目录;返回 null 表示成功,否则为错误信息。 */
  async removeSkill(name: string): Promise<string | null> {
    const err = inWails()
      ? await deleteSkill(name)
      : await deleteSkillRemote(this.conn.baseUrl, this.conn.token, name);
    if (!err) await this.loadSkillsCfg(true);
    return err;
  }

  // ---------- 在线安装/删除(官方下载服务器;成功后刷新并重启托管服务) ----------

  private async afterAgentChange(): Promise<void> {
    await this.loadPluginsCfg(true);
    await this.loadSkillsCfg(true);
    if (inWails() && this.cfg.serverMode === 'managed' && this.srv?.running) {
      await this.applyManaged('app').catch(() => undefined);
    }
  }

  async loadRemotePlugins(): Promise<void> {
    if (!inWails()) return;
    this.remotePlugins = await pluginRemoteList().catch(() => null);
    this.bump();
  }

  async installPlugin(name: string): Promise<string | null> {
    return this.agentMutate(() => pluginInstall(name));
  }

  async removePluginOnline(name: string): Promise<string | null> {
    return this.agentMutate(() => pluginDelete(name));
  }

  async loadRemoteSkills(): Promise<void> {
    if (!inWails()) return;
    this.remoteSkills = await skillRemoteList().catch(() => null);
    this.bump();
  }

  async installSkillFile(file: string): Promise<string | null> {
    return this.agentMutate(() => skillInstall(file));
  }

  async installSkillFromURL(name: string, url: string): Promise<string | null> {
    return this.agentMutate(() => skillInstallFromURL(name, url));
  }

  /** 启用/禁用技能(SKILL.md ↔ SKILL.md.disabled);返回错误信息或 null。 */
  async toggleSkillEnabled(name: string, enabled: boolean): Promise<string | null> {
    const err = inWails()
      ? await skillSetEnabled(name, enabled)
      : await setSkillEnabledRemote(this.conn.baseUrl, this.conn.token, name, enabled);
    if (!err) await this.loadSkillsCfg(true);
    return err;
  }

  async toggleServer(): Promise<void> {
    if (!inWails()) return;
    this.srv = this.srv?.running ? await serverStop() : await serverStart();
    this.bump();
  }

  /** 地址/二进制变更后重启托管进程并重连环路 */
  async applyManaged(scope: string): Promise<void> {
    if (!inWails()) return;
    if (this.srv?.running) this.srv = await serverStop();
    this.srv = await serverStart();
    if (this.srv?.running) {
      configureScope(scope, { baseUrl: `${location.origin}/goder-api`, token: this.srv.token, persistToken: true });
    }
    this.bump();
  }

  async refreshServerStatus(): Promise<void> {
    if (!inWails()) return;
    const srv = await serverStatus().catch(() => null);
    if (srv) {
      this.srv = srv;
      this.bump();
    }
  }

  /**
   * 桌面态异步引导(桥就绪后):项目索引切文件持久化、读配置、
   * 确保托管 server 运行与外观镜像。
   */
  async loadFromBridge(scope: string): Promise<void> {
    if (!(await initHostBridge().catch(() => false))) return;
    void getScope(scope).reloadIndex();
    const cfg = await loadAppConfig().catch(() => null);
    if (cfg) this.cfg = cfg;
    if (this.cfg.serverMode === 'managed') {
      this.srv = await serverStatus().catch(() => null);
      if (!this.srv?.running) this.srv = await serverStart().catch(() => null);
    }
    this.loaded = true;
    await this.loadModelCfg();
    this.bump();
  }
}

export const settingsStore = new SettingsStore();

// 裸模型名补全(与 gh 侧 config.ResolveModel 同语义,0.0.1-alpha.29+ 起
// 线上真正生效):裸名默认供应商优先,否则恰一家提供时取该家;多家歧义/
// 零命中返回 undefined —— gh 侧此时透传当前供应商解析,goder 侧按未选
// 处理(走会话当前模型),不武断取表序首个造成与 gh 择店不一致。
function bareModelFull(bare: string): string | undefined {
  const providers = settingsStore.modelCfg?.providers ?? [];
  const def = settingsStore.modelCfg?.default?.split('/')[0] ?? '';
  if (def && (providers.find((p) => p.name === def)?.models ?? []).includes(bare)) {
    return `${def}/${bare}`;
  }
  const hits = providers.filter((p) => (p.models ?? []).includes(bare));
  return hits.length === 1 ? `${hits[0].name}/${bare}` : undefined;
}

// 裸模型名补全器(供 scope 继承旧记录用):见 bareModelFull。
setModelNameResolver((bare) => bareModelFull(bare));

/** 展示用模型名补全:已是合法全名原样;裸名(含九天式自带 / 的裸名,
 * 如 qwen/qwen3.8-27b)按 bareModelFull 同语义补 "provider/" 前缀;表
 * 未加载或歧义/未命中原样返回。仅用于展示,不用于下发 —— 服务端回报的
 * 裸名经此对齐菜单项与详情展示。 */
export function displayFullModel(m: string): string {
  if (!m) return m;
  for (const p of settingsStore.modelCfg?.providers ?? []) {
    for (const name of p.models ?? []) {
      if (m === `${p.name}/${name}`) return m; // 已是合法全名
    }
  }
  return bareModelFull(m) ?? m; // 裸名:默认供应商优先 → 恰一家
}
