// errors.ts — 已知后端错误的可操作化翻译(纯字符串函数,不依赖 UI)。
// 从 util/fmt.ts 迁入:core 的 scope/chat-model/send-pipeline 都要用它,
// 而 fmt.ts 依赖 UI 注册表(registry),留在那边会把 UI 带进 core 的模块
// 图,破坏「core 不依赖 UI、可整体拷出独立成包」;fmt.ts re-export 保持
// 既有 import 路径兼容。
// isToolChoiceUnsupported 命中"上游 vLLM 未开启工具调用"这类错误。
// 上游网关常按后端负载均衡,部分后端没带 --enable-auto-tool-choice,会对
// 带工具的请求瞬时 400;这类失败可重试。
export function isToolChoiceUnsupported(msg: string): boolean {
  return /enable-auto-tool-choice|tool[-_ ]call[-_ ]parser|"auto"\s+tool\s+choice/i.test(msg);
}

// friendlyError 把已知的后端错误翻成可操作的提示(其余原样返回)。
// 典型:模型侧 vLLM 未开启原生工具调用,整个回合都会 400。
// t 为 i18n 翻译函数(可选;key 即中文默认文案,支持 {x} 插值)。
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function friendlyError(msg: string, t: Translate = (k) => k): string {
  if (isToolChoiceUnsupported(msg)) {
    return t('当前模型服务未开启工具调用,本回合无法执行。\nvLLM 需以 --enable-auto-tool-choice 与 --tool-call-parser <解析器> 启动;若无法改动服务,请在「设置 → 模型设置」改用支持工具调用的模型。\n服务返回:{msg}', { msg });
  }
  if (/paused awaiting interaction/i.test(msg)) {
    return t('会话正在等待上一次的提问/审批应答,请先完成输入框中的交互再发新消息。');
  }
  if (/a turn is already running/i.test(msg)) {
    return t('本会话仍有一个回合在服务端运行(可能未能停止)。请再点一次「停止」,或稍候片刻重试。');
  }
  return msg;
}
