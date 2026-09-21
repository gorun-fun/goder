// modelctx.ts — 模型上下文窗口估算。gh server 不暴露模型容量,按模型名
// 匹配常见家族取值,未知回落默认;仅作占用圆环的分母,展示时标注「预估」。
// 注意:这只是回落 —— 供应商 /models 接口回报的真实值优先(settings-store
// 的 ctxLens 缓存,token-hub / OpenRouter 等网关),本表兜住未回报的模型。
// 数值按公开规格维护(2026-09 校准:GLM-5.3 系 1M、DeepSeek-V4 系 1M),
// 新模型上线后注意回来校准。
const DEFAULT_CTX = 128_000;

/** [匹配, 容量];按序首中即用。模型名先转小写、去掉 provider 前缀再匹配。 */
const RULES: Array<[RegExp, number]> = [
  [/^gpt-5/, 400_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-4/, 128_000], // 4o / 4-turbo / 4 均为 128k
  [/^o[134]/, 200_000],
  [/claude/, 200_000],
  [/gemini/, 1_000_000],
  [/^glm-?5/, 1_000_000], // 5.3 / 5.3-flash / 5.3-flashx
  [/^glm-4\.[56]-(air|flash)/, 128_000], // 4.5-air / 4.5-flash 为 128k
  [/^glm-4\.[56]/, 200_000], // 满血 4.5 / 4.6 为 200k
  [/^glm/, 128_000], // glm-4 及更早
  [/^deepseek-?v?4/, 1_000_000], // V4 系(含 flash)原生 1M
  [/deepseek/, 128_000], // v3.x 为 128k
  [/qwen/, 262_144],
  [/kimi|moonshot/, 256_000], // K2 起为 256k
  [/llama/, 128_000],
];

/** 估算模型的上下文窗口(token 数);空模型返回默认值。 */
export function modelContextWindow(model: string | undefined): number {
  if (!model) return DEFAULT_CTX;
  const m = model.toLowerCase().split('/').pop() ?? model.toLowerCase();
  for (const [re, n] of RULES) if (re.test(m)) return n;
  return DEFAULT_CTX;
}
