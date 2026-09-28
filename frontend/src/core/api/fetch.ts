// fetch.ts — core API 层的统一传输通道(模块级注入点)。
//
// GoderClient(ORS Responses API)与 agent-api(/v1/agent/*)的一切网络
// 请求都经 apiFetch() 发出,默认回落 globalThis.fetch —— 生产形态行为
// 不变。测试/嵌入方经 setApiFetch 注入替身后即可零网络驱动全部 UI
// 流(与 core/store/storage.ts 的 setKeyValueStorage 同风格:模块级
// 单例,建议在创建任何面板/scope 之前调用)。
//
// 典型用法(AI 自动化测试):setApiFetch(createScriptedApi().asFetch())
// —— 见同目录 scripted-api.ts;test-harness.html 是完整示例。

type FetchLike = typeof fetch;

let impl: FetchLike | undefined;

/** 注入传输层替身;undefined 恢复默认 globalThis.fetch。 */
export function setApiFetch(fn?: FetchLike): void {
  impl = fn;
}

/** 当前生效的传输层(未注入时返回 globalThis.fetch)。 */
export function getApiFetch(): FetchLike {
  return impl ?? globalThis.fetch.bind(globalThis);
}

/** core API 层统一取用;文件内部经它发请求。 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return getApiFetch()(input, init);
}
