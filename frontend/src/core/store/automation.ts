// automation.ts — 自动化操作员的纯逻辑层:system prompt 构造与
// <goder-task> 任务块解析。操作员 = kind:'operator' 的项目(home 下专属
// 目录作工作区),会话随首条消息注入这里的 system prompt;任务沉淀协议
// 约定操作员在用户确认成功后输出 <goder-task name="…">指令</goder-task>,
// 前端解析渲染保存卡,入库后出现在状态浮窗,点击即新建执行会话。
//
// 内置技能 goder-auto(自动化任务创作指南)的正文单一源文件在
// internal/desktop/agentskills/goder-auto.md:经两个 vite 配置的 define
// (__GODER_AUTO_SKILL_MD__,构建时读该文件注入)进操作员 system prompt
// (创建自动化会话即全文生效),Go 侧 go:embed 启动烙写 ~/.grf/skills
// 供设置页展示与非操作员会话 skill 工具加载 —— 改指南只改那一份。
// core 由此不再跨树引 Go 源码,可整体拷出独立成包。
import type { AutomationTask } from './persistence';

/** 构建期注入的 goder-auto 技能全文(vite define;两个配置同源注入)。 */
declare const __GODER_AUTO_SKILL_MD__: string | undefined;
const goderAutoSkillMD: string =
  typeof __GODER_AUTO_SKILL_MD__ === 'string' ? __GODER_AUTO_SKILL_MD__ : '';

/** 任务块标签(markdown 代码栏之外的裸标签,assistant 文本里出现即解析) */
const TASK_OPEN = /<goder-task(?:\s+name="([^"]*)")?\s*>/;
/** 技能块标签(执行会话成功后沉淀技能,语义同任务块) */
const SKILL_OPEN = /<goder-skill(?:\s+name="([^"]*)")?\s*>/;

/** 协议块解析结果:普通文本段、任务块段或技能块段。 */
export type TaskSegment =
  | { type: 'text'; text: string }
  | { type: 'task'; name: string; instructions: string }
  | { type: 'skill'; name: string; content: string };

/** 通用协议块拆分:把文本拆为普通段与成对闭合的 <tag name="…">…</tag>
 * 块段。只认闭合块;流式输出中尚未闭合的尾部标签整段丢弃(等闭合后再
 * 出现成卡,避免渲染中途闪现原始标签文本)。 */
function parseProtocolBlocks(
  text: string,
  open: RegExp,
  closeTag: string,
  wrap: (name: string, body: string) => TaskSegment,
): TaskSegment[] {
  const segs: TaskSegment[] = [];
  let rest = text;
  for (;;) {
    const m = open.exec(rest);
    if (!m) break;
    const close = rest.indexOf(closeTag, m.index + m[0].length);
    if (close < 0) {
      // 未闭合:丢弃从标签起的所有剩余文本(流式中)
      if (m.index > 0) segs.push({ type: 'text', text: rest.slice(0, m.index) });
      return segs;
    }
    if (m.index > 0) segs.push({ type: 'text', text: rest.slice(0, m.index) });
    segs.push(wrap((m[1] ?? '').trim(), rest.slice(m.index + m[0].length, close).trim()));
    rest = rest.slice(close + closeTag.length);
  }
  if (rest) segs.push({ type: 'text', text: rest });
  return segs;
}

/** 拆出完整闭合的 <goder-task> 任务块。 */
export function parseGoderTaskBlocks(text: string): TaskSegment[] {
  return parseProtocolBlocks(text, TASK_OPEN, '</goder-task>', (name, instructions) => ({
    type: 'task',
    name,
    instructions,
  }));
}

/** 拆出完整闭合的 <goder-skill> 技能块(执行会话成功沉淀)。 */
export function parseGoderSkillBlocks(text: string): TaskSegment[] {
  return parseProtocolBlocks(text, SKILL_OPEN, '</goder-skill>', (name, content) => ({
    type: 'skill',
    name,
    content,
  }));
}

/** 文本里是否含完整任务/技能块(快速判定,渲染分支用)。 */
export function hasTaskBlock(text: string): boolean {
  return hasBlock(text, TASK_OPEN, '</goder-task>');
}

export function hasSkillBlock(text: string): boolean {
  return hasBlock(text, SKILL_OPEN, '</goder-skill>');
}

function hasBlock(text: string, open: RegExp, closeTag: string): boolean {
  const m = open.exec(text);
  return !!m && text.indexOf(closeTag, m.index + m[0].length) >= 0;
}

/**
 * 操作员(调试协作)会话的 system prompt。随首条消息烙进会话:开头即
 * 注入内置技能 goder-auto 全文(创建自动化会话自动加载,静态段在前),
 * 已有任务名列表作为上下文殿后(指令全文不注入,保持 prompt 精简,
 * 细节用 memory 工具按需检索)。
 */
export function operatorSystemPrompt(tasks: AutomationTask[]): string {
  const names = tasks.map((t) => `- ${t.name}`).join('\n');
  return `你是 goder 的「自动化操作员」,与用户协作在他们的电脑上完成操作,并把成功的操作沉淀为可复用的自动化任务。会话开始即已加载下方内置技能,全程按其指南工作。

## 内置技能 goder-auto(全文已加载)

${goderAutoSkillMD.trim()}

## 本操作员已沉淀的自动化任务
${names || '- (暂无)'}
(执行细节用 memory 工具检索;用户提出同类需求时先对照本列表,避免重复沉淀。)`;
}

/** 执行会话(点击任务触发)的 system prompt:直接按指令执行;完整跑通
 * 后必须输出 <goder-skill> 块沉淀技能(固定收尾步骤,前端渲染保存卡)。 */
export function runnerSystemPrompt(): string {
  return `你是自动化任务的执行操作员。用户消息里带有一条完整任务指令,直接按指令在电脑上执行:
- 优先用电脑操作(computer / grf-computer)与界面控制(goder_browser_* / goder_terminal_*)工具,文件类操作用常规文件/终端工具。
- 相关经验可用内置 memory 工具(默认 project 级)检索,但不要改写任务目标。
- 严格按指令执行,不自行扩大范围;指令含糊或执行失败时如实汇报并停止,等待用户处理。
- 本会话不需要沉淀新任务,不要输出 goder-task 结构块。

## 成功后沉淀技能(固定收尾步骤,必须执行)

按指令完整跑通、达到成功判断标准后,本会话必须以输出一份技能结构块收尾,不能省略:
- 提炼本次实际跑通、可复用的经验:界面元素如何定位、等待时机、登录态/弹窗等环境差异的容错处置、踩过的坑与绕法。即使任务指令本身已足够详细,也要写出实际执行中验证过的做法,技能面向同类场景,不只是复述指令;
- 不要以「把经验写进 memory」代替沉淀:memory 只是执行期的检索手段,技能结构块才是本会话唯一认可的沉淀出口,只写 memory 就收尾视为未完成;
- 只写跑通验证过的内容,不要猜测;执行失败时不输出该结构块,如实汇报即可。

技能块要求:
1. 技能名用小写字母/数字/连字符(将作为技能目录名),简短且能体现适用场景;已有同名技能时输出修订后的完整新版(保存会整体覆盖同名目录);
2. 正文是 SKILL.md 格式的完整指南:YAML frontmatter 带 description: 一句话说明何时使用,正文按"适用场景 → 前置条件 → 操作步骤 → 成功标准 → 常见问题处置"组织,自包含、下次可直接照做;
3. 收尾时原样输出一个结构块(不要包进 markdown 代码栏),界面上会出现保存入口,由用户确认保存:

<goder-skill name="技能名">
(SKILL.md 完整正文)
</goder-skill>

- 协议块之外不要再输出 goder-skill 标签。`;
}

/** 点击任务执行时下发的用户消息文本。 */
export function runnerMessage(task: AutomationTask): string {
  return `执行自动化任务「${task.name}」:\n\n${task.instructions}`;
}
