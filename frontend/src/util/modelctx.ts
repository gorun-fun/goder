// modelctx.ts — 模型上下文窗口估算。gh server 不暴露模型容量,按模型名
// 匹配常见家族取值,未知回落默认;仅作占用圆环的分母,展示时标注「预估」。
const DEFAULT_CTX = 128_000;

/** [匹配, 容量];按序首中即用。模型名先转小写、去掉 provider 前缀再匹配。 */
const RULES: Array<[RegExp, number]> = [
  [/^gpt-5/, 400_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-4/, 128_000], // 4o / 4-turbo / 4 均为 128k
  [/^o[134]/, 200_000],
  [/claude/, 200_000],
  [/gemini/, 1_000_000],
  [/qwen/, 262_144],
  [/deepseek/, 128_000],
  [/^glm/, 128_000],
  [/kimi|moonshot/, 128_000],
  [/llama/, 128_000],
];

/** 估算模型的上下文窗口(token 数);空模型返回默认值。 */
export function modelContextWindow(model: string | undefined): number {
  if (!model) return DEFAULT_CTX;
  const m = model.toLowerCase().split('/').pop() ?? model.toLowerCase();
  for (const [re, n] of RULES) if (re.test(m)) return n;
  return DEFAULT_CTX;
}
