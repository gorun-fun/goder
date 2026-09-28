// storage.ts — 可注入的键值存储:core 各处本地持久化的统一落点。
// 默认 localStorage(隐私模式等不可用时回退内存);嵌入方/宿主可整体
// 替换为自家实现(统一 KV、indexedDB、桥接原生等),消除 core 对浏览器
// 存储的硬依赖。项目索引另有 Persistence 接口(persistence.ts,可挂文件
// 系统),这里覆盖其余轻量键值(连接副本/策略偏好/usage 累计/工具耗时/
// 外观/上下文窗口缓存等)。

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 纯内存实现(localStorage 不可用时的回退;不跨会话)。 */
export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const memory = new MemoryStorage();

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__grf_probe__');
      return localStorage;
    }
  } catch {
    /* 隐私模式/受限环境:回退内存 */
  }
  return memory;
}

let kv: KeyValueStorage = defaultStorage();

/** 替换全局键值存储(嵌入方注入;建议在创建任何面板/scope 之前调用)。 */
export function setKeyValueStorage(s: KeyValueStorage): void {
  kv = s;
}

/** 当前键值存储。 */
export function keyValueStorage(): KeyValueStorage {
  return kv;
}

/** 容错 JSON 读(损坏/不存在返回 null)。 */
export function kvGet<T>(key: string): T | null {
  try {
    const raw = kv.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 容错 JSON 写。 */
export function kvSet(key: string, value: unknown): void {
  try {
    kv.setItem(key, JSON.stringify(value));
  } catch {
    /* 写入失败静默,当次会话内仍生效 */
  }
}

/** 容错删。 */
export function kvDel(key: string): void {
  try {
    kv.removeItem(key);
  } catch {
    /* 忽略 */
  }
}
