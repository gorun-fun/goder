// settings.ts — 应用级设置状态(页面唯一实例),供设置页与桌面入口共用:
// - 常规:服务连接(托管 gh server / 远程),桌面态经 wails 桥持久化到
//   ~/Library/Application Support/goder/config.json;
// - 外观:主题 / 强调色 / 字号,写 documentElement 的 --grf-skin-* 挂钩
//   (见 ui/theme.ts)穿透全部 shadow DOM 即时生效,并镜像到 localStorage,
//   桌面与浏览器两种形态重启后都能即刻恢复;
// - 模型:默认模型,应用到对应 scope。
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
  type PluginsDTO,
  type PluginDTO,
  type SkillsDTO,
  type RemoteReleaseDTO,
  type ServerStatusDTO,
} from '../../host/bridge';
import { getScope, configureScope, savedConn, locationDefaultBase } from '../store/scope';

export type ThemeMode = 'dark' | 'light';
/** 强调色:预设 key 或 "#rrggbb" 自定义色值 */
export type AccentValue = string;

/** 强调色预设:text 为深色主题文字变体,textOnLight 为浅色主题文字变体 */
export const ACCENTS = {
  blue: { label: '蓝', accent: '#4c8dff', text: '#7faeff', textOnLight: '#2563eb', soft: 'rgba(76, 141, 255, 0.16)' },
  violet: { label: '紫', accent: '#8d7ce8', text: '#ab9df0', textOnLight: '#6d3fd4', soft: 'rgba(141, 124, 232, 0.18)' },
  green: { label: '绿', accent: '#3fb96f', text: '#6ed598', textOnLight: '#15803d', soft: 'rgba(63, 185, 111, 0.16)' },
  orange: { label: '橙', accent: '#e08a3c', text: '#f0a765', textOnLight: '#b45309', soft: 'rgba(224, 138, 60, 0.18)' },
  rose: { label: '玫红', accent: '#e5637a', text: '#f2899b', textOnLight: '#be3455', soft: 'rgba(229, 99, 122, 0.16)' },
} as const;

/** 旧版字号档位 → 基准像素(迁移用) */
const FONT_MODE_PX: Record<string, number> = { compact: 12.5, standard: 13.5, relaxed: 14.5 };
export const FONT_MIN = 11;
export const FONT_MAX = 20;

// ---------- 自定义强调色派生(hex → 各主题变体) ----------

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 向白色(t>0)或黑色(t<0)方向插值 */
function mixRgb(rgb: [number, number, number], t: number): string {
  const [r, g, b] = rgb;
  const to = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  const c = (x: number) => clampByte(x + (to - x) * k);
  return `#${[c(r), c(g), c(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** 解析强调色取值:预设 key 或自定义 hex;非法时回退默认蓝。 */
function resolveAccent(v: string): { accent: string; text: string; textOnLight: string; soft: string } {
  if (v in ACCENTS) return ACCENTS[v as keyof typeof ACCENTS];
  const rgb = hexToRgb(v);
  if (rgb) {
    return {
      accent: `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`,
      text: mixRgb(rgb, 0.28),
      textOnLight: mixRgb(rgb, -0.35),
      soft: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`,
    };
  }
  return ACCENTS.blue;
}

/** 浅色主题 skin 挂钩取值(深色为默认值,无需覆写) */
const LIGHT_SKIN: Record<string, string> = {
  '--grf-skin-bg': '#f4f5f7',
  '--grf-skin-bg-raise': '#ffffff',
  '--grf-skin-bg-hover': '#eceef1',
  '--grf-skin-bg-active': '#e3e6ea',
  '--grf-skin-border': '#d5d8de',
  '--grf-skin-border-soft': '#e4e6eb',
  '--grf-skin-border-hover': '#bfc4cc',
  '--grf-skin-text': '#26292f',
  '--grf-skin-text-dim': '#5d636e',
  '--grf-skin-text-faint': '#9096a0',
  '--grf-skin-user-bubble': '#e8ecf2',
  '--grf-skin-shadow': '0 8px 28px rgba(20, 24, 32, 0.12)',
  '--grf-skin-card': '#ffffff',
  '--grf-skin-scroll-thumb': '#c6cad2',
};

/** 字号:基准像素(sm = 基准 -1.5,xs = 基准 -2.5) */
function fontVars(base: number): [string, string, string] {
  return [`${base}px`, `${base - 1.5}px`, `${base - 2.5}px`];
}

export interface Appearance {
  theme: ThemeMode;
  accent: AccentValue;
  fontSize: number;
}

const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: 'blue', fontSize: 13.5 };
const LS_KEY = 'grf-appearance-v1';

type Listener = () => void;

function loadAppearanceLocal(): Appearance {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const p = JSON.parse(raw) as Partial<Appearance> & { fontSize?: number | string };
    // 旧档位名(compact/standard/relaxed)迁移为基准像素
    const fontSize =
      typeof p.fontSize === 'number'
        ? p.fontSize
        : typeof p.fontSize === 'string' && p.fontSize in FONT_MODE_PX
          ? FONT_MODE_PX[p.fontSize]
          : DEFAULT_APPEARANCE.fontSize;
    return {
      theme: p.theme === 'light' ? 'light' : 'dark',
      accent: typeof p.accent === 'string' && p.accent ? p.accent : 'blue',
      fontSize: Math.max(FONT_MIN, Math.min(FONT_MAX, fontSize)),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

class SettingsStore {
  cfg: AppConfigDTO = {
    scope: 'app',
    serverMode: 'managed',
    // web 形态默认同源网关(/grf-api);桌面态此字段仅在远程模式生效
    remoteUrl: locationDefaultBase(),
    remoteToken: '',
    defaultModel: '',
    ghBinary: 'gh',
    serverAddr: '127.0.0.1:7400',
  };
  srv: ServerStatusDTO | null = null;
  /** gh 侧模型配置(settings.json 的 providers/default);非桌面态为 null */
  modelCfg: ModelConfigDTO | null = null;
  /** 智能体扩展:插件/MCP(settings.json 的 plugins);非桌面态为 null */
  pluginsCfg: PluginsDTO | null = null;
  /** 智能体扩展:技能(~/.grf/skills);非桌面态为 null */
  skillsCfg: SkillsDTO | null = null;
  /** 在线可安装产物(官方下载服务器);null = 未拉取/不可达 */
  remotePlugins: RemoteReleaseDTO | null = null;
  remoteSkills: RemoteReleaseDTO | null = null;
  appearance: Appearance = { ...DEFAULT_APPEARANCE };
  /** 桌面态桥配置是否已加载完成 */
  loaded = false;

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
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.appearance));
    } catch {
      /* 隐私模式等写入失败时静默,当次会话内仍生效 */
    }
    this.applyAppearanceVars();
    this.bump();
  }

  /** 把外观写到 documentElement 的 skin 挂钩上;深色主题 + 默认蓝/标准字号时清除覆写走默认值 */
  private applyAppearanceVars(): void {
    const root = document.documentElement.style;
    const a = this.appearance;
    const setOrClear = (name: string, value: string | null) => {
      if (value === null) root.removeProperty(name);
      else root.setProperty(name, value);
    };
    // 主题:深色走默认值,浅色整体覆写
    for (const [k, v] of Object.entries(LIGHT_SKIN)) setOrClear(k, a.theme === 'light' ? v : null);
    // 强调色:浅色主题文字用加深变体保证对比度
    const onLight = a.theme === 'light';
    const accent = resolveAccent(a.accent);
    const isDefaultBlue = a.accent === 'blue';
    setOrClear('--grf-skin-accent', isDefaultBlue ? null : accent.accent);
    setOrClear('--grf-skin-accent-soft', isDefaultBlue ? null : accent.soft);
    setOrClear('--grf-skin-accent-text', isDefaultBlue && !onLight ? null : onLight ? accent.textOnLight : accent.text);
    // 字号:13.5px 基准走默认值
    const [fs, fss, fsxs] = fontVars(a.fontSize);
    const std = a.fontSize === 13.5;
    setOrClear('--grf-skin-font-size', std ? null : fs);
    setOrClear('--grf-skin-font-size-sm', std ? null : fss);
    setOrClear('--grf-skin-font-size-xs', std ? null : fsxs);
  }

  patchCfg(patch: Partial<AppConfigDTO>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.bump();
  }

  /** 保存配置并即时应用到连接与默认模型(scope 为数据域名,桌面为 'app') */
  async saveCfg(scope: string): Promise<void> {
    await saveAppConfig(this.cfg);
    this.applyConnection(scope);
    this.applyDefaultModel(scope);
    this.bump();
  }

  /** 按当前模式把连接信息应用到 scope(桌面恒走同源代理) */
  applyConnection(scope: string): void {
    if (!inWails()) {
      configureScope(scope, { baseUrl: this.cfg.remoteUrl, token: this.cfg.remoteToken });
      return;
    }
    configureScope(scope, {
      baseUrl: `${location.origin}/grf-api`,
      token: this.cfg.serverMode === 'managed' ? (this.srv?.token ?? '') : this.cfg.remoteToken,
    });
  }

  applyDefaultModel(scope: string): void {
    configureScope(scope, { model: this.cfg.defaultModel || undefined });
  }

  // ---------- 模型供应商(gh settings.json;仅桌面态可读写) ----------

  /** 进入模型设置时拉取;force 用于保存后或外部改动后的强制刷新。 */
  async loadModelCfg(force = false): Promise<void> {
    if (!inWails()) return;
    if (this.modelCfg && !force) return;
    const cfg = await loadModelConfig().catch(() => null);
    if (cfg) {
      this.modelCfg = cfg;
      // gh 侧已有默认模型而本端未设置时回填,避免两处默认值打架。
      if (!this.cfg.defaultModel && cfg.default) this.cfg = { ...this.cfg, defaultModel: cfg.default };
      this.bump();
    }
  }

  /** 把当前内存中的供应商配置写回 settings.json。 */
  async saveModelCfg(): Promise<void> {
    if (!this.modelCfg) return;
    await saveModelConfig(this.modelCfg).catch(() => undefined);
    // gh server 只在启动时读 settings.json:本地托管且运行中时自动重启使其生效
    // (桌面 scope 恒为 'app')。
    if (inWails() && this.cfg.serverMode === 'managed' && this.srv?.running) {
      await this.applyManaged('app').catch(() => undefined);
    }
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
   * 的列表(去重保序)。返回探测到的数量;失败返回 -1。
   */
  async detectProviderModels(name: string): Promise<number> {
    if (!this.modelCfg) return -1;
    const p = this.modelCfg.providers.find((x) => x.name === name);
    if (!p) return -1;
    const ids = await detectModels(p);
    if (!ids) return -1;
    const merged = Array.from(new Set([...(p.models ?? []), ...ids]));
    this.updateProvider(name, { models: merged });
    return ids.length;
  }

  /** 重命名;与目标名已存在时覆盖目标(旧的先摘掉,避免双份)。 */
  renameProvider(oldName: string, newName: string): void {
    const to = newName.trim();
    if (!to || to === oldName) return;
    this.patchProviders((l) => {
      const rest = l.filter((x) => x.name !== oldName && x.name !== to);
      const src = l.find((x) => x.name === oldName);
      const item: ProviderDTO = { ...(src ?? { name: to, type: '', baseUrl: '', apiKey: '', models: [] }), name: to };
      const oldIdx = l.findIndex((x) => x.name === oldName);
      const out = [...rest];
      out.splice(oldIdx < 0 ? out.length : Math.min(oldIdx, out.length), 0, item);
      return out;
    });
    void this.saveModelCfg();
  }

  removeProvider(name: string): void {
    this.patchProviders((l) => l.filter((x) => x.name !== name));
    void this.saveModelCfg();
  }

  // ---------- 智能体扩展:插件/MCP(gh settings.json 的 plugins) ----------

  /** 进入插件/MCP/技能分区时拉取;force 用于保存后的强制刷新。 */
  async loadPluginsCfg(force = false): Promise<void> {
    if (!inWails()) return;
    if (this.pluginsCfg && !force) return;
    const cfg = await loadPlugins().catch(() => null);
    if (cfg) {
      this.pluginsCfg = { ...cfg, plugins: cfg.plugins ?? [] };
      this.bump();
    }
  }

  /** 把插件/MCP 列表写回 settings.json 并按需重启托管 gh server。 */
  async savePluginsCfg(): Promise<void> {
    if (!this.pluginsCfg) return;
    await savePlugins(this.pluginsCfg).catch(() => undefined);
    await this.loadPluginsCfg(true);
    if (inWails() && this.cfg.serverMode === 'managed' && this.srv?.running) {
      await this.applyManaged('app').catch(() => undefined);
    }
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

  /** 把自动发现目录里的一个可执行文件加入显式列表(绝对路径)。 */
  adoptDiscovered(file: string): void {
    this.patchPlugins((c) => {
      if (c.plugins.some((x) => x.name === file)) return c;
      const path = c.dir ? `${c.dir}/${file}` : file;
      return {
        ...c,
        explicit: true,
        plugins: [...c.plugins, { name: file, command: [path], url: '', token: '', timeout: 0 }],
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
   */
  setPluginEnabled(name: string, enabled: boolean): void {
    this.patchPlugins((c) => {
      let plugins = c.plugins;
      let explicit = c.explicit;
      if (!explicit) {
        plugins = [
          ...plugins,
          ...c.discovered
            .filter((f) => !plugins.some((x) => x.name === f))
            .map((f) => ({ name: f, command: [`${c.dir}/${f}`], url: '', token: '', timeout: 0 })),
        ];
        explicit = true;
      }
      if (enabled) {
        if (!plugins.some((x) => x.name === name)) {
          const found = c.discovered.includes(name);
          plugins = [...plugins, { name, command: [found ? `${c.dir}/${name}` : name], url: '', token: '', timeout: 0 }];
        }
      } else {
        plugins = plugins.filter((x) => x.name !== name);
      }
      return { ...c, explicit, plugins };
    });
  }

  // ---------- 智能体扩展:技能(~/.grf/skills/<name>/SKILL.md) ----------

  async loadSkillsCfg(force = false): Promise<void> {
    if (!inWails()) return;
    if (this.skillsCfg && !force) return;
    const cfg = await loadSkills().catch(() => null);
    if (cfg) {
      this.skillsCfg = { ...cfg, skills: cfg.skills ?? [] };
      this.bump();
    }
  }

  readSkill(name: string): Promise<string | null> {
    return getSkillContent(name);
  }

  /** 新建/覆盖技能;返回 null 表示成功,否则为错误信息。 */
  async writeSkill(name: string, content: string): Promise<string | null> {
    const err = await saveSkill(name, content);
    if (!err) await this.loadSkillsCfg(true);
    return err;
  }

  /** 删除技能目录;返回 null 表示成功,否则为错误信息。 */
  async removeSkill(name: string): Promise<string | null> {
    const err = await deleteSkill(name);
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
    const err = await pluginInstall(name);
    if (!err) await this.afterAgentChange();
    return err;
  }

  async removePluginOnline(name: string): Promise<string | null> {
    const err = await pluginDelete(name);
    if (!err) await this.afterAgentChange();
    return err;
  }

  async loadRemoteSkills(): Promise<void> {
    if (!inWails()) return;
    this.remoteSkills = await skillRemoteList().catch(() => null);
    this.bump();
  }

  async installSkillFile(file: string): Promise<string | null> {
    const err = await skillInstall(file);
    if (!err) await this.afterAgentChange();
    return err;
  }

  async installSkillFromURL(name: string, url: string): Promise<string | null> {
    const err = await skillInstallFromURL(name, url);
    if (!err) await this.afterAgentChange();
    return err;
  }

  /** 启用/禁用技能(SKILL.md ↔ SKILL.md.disabled);返回错误信息或 null。 */
  async toggleSkillEnabled(name: string, enabled: boolean): Promise<string | null> {
    const err = await skillSetEnabled(name, enabled);
    if (!err) await this.loadSkillsCfg(true);
    return err;
  }

  /** 默认模型:app 配置(前端请求)与 gh settings.json(服务端默认)同步写。 */
  async setDefaultModel(scope: string, value: string): Promise<void> {
    this.patchCfg({ defaultModel: value });
    if (this.modelCfg) this.modelCfg = { ...this.modelCfg, default: value };
    await this.saveCfg(scope);
    await this.saveModelCfg();
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
      configureScope(scope, { baseUrl: `${location.origin}/grf-api`, token: this.srv.token });
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
   * 确保托管 server 运行、应用默认模型与外观镜像。
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
    this.applyDefaultModel(scope);
    this.bump();
  }
}

export const settingsStore = new SettingsStore();
