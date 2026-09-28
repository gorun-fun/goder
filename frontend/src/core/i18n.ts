// i18n.ts — 文案定制通道(gettext 风格):key 即中文默认文案,嵌入方按
// key 下发译文覆盖,未覆盖的 key 原样返回(默认中文)。支持 {name} 插值。
// 全部 UI 与 core 的用户可见文案逐步收口到 t();同页多 scope 各自locale。
//
// 用法(嵌入方):
//   configure('app', { locale: 'en', messages: { '新会话': 'New chat', … } });
// 带插值的文案 key 里保留 {参数} 占位,译文同位替换:
//   t('已停止本回合(丢弃 {n} 条排队消息)', { n: 3 })

export type I18nMessages = Record<string, string>;

export interface I18nConfig {
  /** 目标语言标记(仅提示性,翻译完全按 messages 键匹配) */
  locale?: string;
  /** key(中文默认文案)→ 译文 */
  messages?: I18nMessages;
}

const byScope = new Map<string, I18nConfig>();

/** 配置某 scope 的文案(undefined = 清除,恢复默认中文)。 */
export function setI18n(scope: string, cfg: I18nConfig | undefined): void {
  if (cfg && (cfg.messages || cfg.locale)) byScope.set(scope, cfg);
  else byScope.delete(scope);
}

/** 读取某 scope 的文案配置。 */
export function getI18n(scope: string): I18nConfig | undefined {
  return byScope.get(scope);
}

/** 翻译一条文案:messages 命中返回译文并做 {x} 插值;未命中原样返回。 */
export function translate(scope: string, key: string, params?: Record<string, string | number>): string {
  const cfg = byScope.get(scope);
  let s = cfg?.messages?.[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** 固定 scope 的翻译函数(组件/纯函数里少传一个参数)。 */
export function tFor(scope: string): (key: string, params?: Record<string, string | number>) => string {
  return (key, params) => translate(scope, key, params);
}
