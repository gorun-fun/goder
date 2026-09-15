// settings.ts — 应用级设置状态(页面唯一实例),供设置页与桌面入口共用:
// - 常规:服务连接(托管 gh server / 远程),桌面态经 wails 桥持久化到
//   ~/Library/Application Support/grf-harness-ui/config.json;
// - 外观:主题 / 强调色 / 字号,写 documentElement 的 --grf-skin-* 挂钩
//   (见 ui/theme.ts)穿透全部 shadow DOM 即时生效,并镜像到 localStorage,
//   桌面与浏览器两种形态重启后都能即刻恢复;
// - 模型:默认模型,应用到对应 scope。
import {
  inWails,
  initHostBridge,
  loadAppConfig,
  loadModelConfig,
  saveAppConfig,
  saveModelConfig,
  serverStart,
  serverStatus,
  serverStop,
  type AppConfigDTO,
  type ModelConfigDTO,
  type ProviderDTO,
  type ServerStatusDTO,
} from '../../host/bridge';
import { getScope, configureScope, savedConn, locationDefaultBase } from '../store/scope';

export type ThemeMode = 'dark' | 'light';
export type FontSizeMode = 'compact' | 'standard' | 'relaxed';
export type AccentKey = keyof typeof ACCENTS;

/** 强调色预设:text 为深色主题文字变体,textOnLight 为浅色主题文字变体 */
export const ACCENTS = {
  blue: { label: '蓝', accent: '#4c8dff', text: '#7faeff', textOnLight: '#2563eb', soft: 'rgba(76, 141, 255, 0.16)' },
  violet: { label: '紫', accent: '#8d7ce8', text: '#ab9df0', textOnLight: '#6d3fd4', soft: 'rgba(141, 124, 232, 0.18)' },
  green: { label: '绿', accent: '#3fb96f', text: '#6ed598', textOnLight: '#15803d', soft: 'rgba(63, 185, 111, 0.16)' },
  orange: { label: '橙', accent: '#e08a3c', text: '#f0a765', textOnLight: '#b45309', soft: 'rgba(224, 138, 60, 0.18)' },
  rose: { label: '玫红', accent: '#e5637a', text: '#f2899b', textOnLight: '#be3455', soft: 'rgba(229, 99, 122, 0.16)' },
} as const;

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

/** 字号档位 → 三级字体令牌 */
const FONT_SIZES: Record<FontSizeMode, [string, string, string]> = {
  compact: ['12.5px', '11px', '10px'],
  standard: ['13.5px', '12px', '11px'],
  relaxed: ['14.5px', '13px', '12px'],
};

export interface Appearance {
  theme: ThemeMode;
  accent: AccentKey;
  fontSize: FontSizeMode;
}

const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: 'blue', fontSize: 'standard' };
const LS_KEY = 'grf-appearance-v1';

type Listener = () => void;

function loadAppearanceLocal(): Appearance {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const p = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: p.theme === 'light' ? 'light' : 'dark',
      accent: p.accent && p.accent in ACCENTS ? p.accent : 'blue',
      fontSize: p.fontSize && p.fontSize in FONT_SIZES ? p.fontSize : 'standard',
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

  /** 把外观写到 documentElement 的 skin 挂钩上;默认值(深色/蓝/标准)清除覆写 */
  private applyAppearanceVars(): void {
    const root = document.documentElement.style;
    const a = this.appearance;
    const accent = ACCENTS[a.accent];
    const setOrClear = (name: string, value: string | null) => {
      if (value === null) root.removeProperty(name);
      else root.setProperty(name, value);
    };
    // 主题:深色走默认值,浅色整体覆写
    for (const [k, v] of Object.entries(LIGHT_SKIN)) setOrClear(k, a.theme === 'light' ? v : null);
    // 强调色:深色 + 默认蓝走默认值;浅色主题文字用加深变体保证对比度
    const onLight = a.theme === 'light';
    setOrClear('--grf-skin-accent', a.accent === 'blue' ? null : accent.accent);
    setOrClear('--grf-skin-accent-soft', a.accent === 'blue' ? null : accent.soft);
    setOrClear('--grf-skin-accent-text', a.accent === 'blue' && !onLight ? null : onLight ? accent.textOnLight : accent.text);
    // 字号:标准档走默认值
    const [fs, fss, fsxs] = FONT_SIZES[a.fontSize];
    const std = a.fontSize === 'standard';
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
  }

  private patchProviders(fn: (list: ProviderDTO[]) => ProviderDTO[]): void {
    if (!this.modelCfg) return;
    this.modelCfg = { ...this.modelCfg, providers: fn(this.modelCfg.providers) };
    this.bump();
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
