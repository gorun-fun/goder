// automation.ts — 自动化操作员的纯逻辑层:system prompt 构造与
// <grf-task> 任务块解析。操作员 = kind:'operator' 的项目(home 下专属
// 目录作工作区),会话随首条消息注入这里的 system prompt;任务沉淀协议
// 约定操作员在用户确认成功后输出 <grf-task name="…">指令</grf-task>,
// 前端解析渲染保存卡,入库后出现在状态浮窗,点击即新建执行会话。
import type { AutomationTask } from './persistence';

/** 任务块标签(markdown 代码栏之外的裸标签,assistant 文本里出现即解析) */
const TASK_OPEN = /<grf-task(?:\s+name="([^"]*)")?\s*>/;

/** 任务块解析结果:普通文本段或完整任务块。 */
export type TaskSegment = { type: 'text'; text: string } | { type: 'task'; name: string; instructions: string };

/**
 * 把 assistant 文本拆为普通文本段与完整 <grf-task> 任务块段。
 * 只认成对闭合的块;流式输出中尚未闭合的尾部标签整段丢弃(等闭合后
 * 再出现成卡,避免渲染中途闪现原始标签文本)。
 */
export function parseGrfTaskBlocks(text: string): TaskSegment[] {
  const segs: TaskSegment[] = [];
  let rest = text;
  for (;;) {
    const m = TASK_OPEN.exec(rest);
    if (!m) break;
    const close = rest.indexOf('</grf-task>', m.index + m[0].length);
    if (close < 0) {
      // 未闭合:丢弃从标签起的所有剩余文本(流式中)
      if (m.index > 0) segs.push({ type: 'text', text: rest.slice(0, m.index) });
      return segs;
    }
    if (m.index > 0) segs.push({ type: 'text', text: rest.slice(0, m.index) });
    segs.push({
      type: 'task',
      name: (m[1] ?? '').trim(),
      instructions: rest.slice(m.index + m[0].length, close).trim(),
    });
    rest = rest.slice(close + '</grf-task>'.length);
  }
  if (rest) segs.push({ type: 'text', text: rest });
  return segs;
}

/** 文本里是否含完整任务块(快速判定,渲染分支用)。 */
export function hasTaskBlock(text: string): boolean {
  const m = TASK_OPEN.exec(text);
  return !!m && text.indexOf('</grf-task>', m.index + m[0].length) >= 0;
}

/**
 * 操作员(调试协作)会话的 system prompt。随首条消息烙进会话;
 * 已有任务名列表作为上下文注入(指令全文不注入,保持 prompt 精简,
 * 细节用 memory 工具按需检索)。
 */
export function operatorSystemPrompt(tasks: AutomationTask[]): string {
  const names = tasks.map((t) => `- ${t.name}`).join('\n');
  return `你是 goder 的「自动化操作员」,与用户协作在他们的电脑上完成操作,并把成功的操作沉淀为可复用的自动化任务。

工作方式:
- 通过对话了解用户想自动化的操作,用工具实际执行、逐步调试,不要只给口头步骤。优先用电脑操作(computer / grf-computer)与界面控制(goder_browser_* / goder_terminal_*)工具;文件类操作用常规文件/终端工具。
- 每次重要操作前先说明意图,执行后汇报结果;用户会指导与纠正,按其反馈调整。
- 跨会话记忆用内置 memory 工具(默认 project 级,自动落本工作区 .grf/memory.json):调试中的操作要点、站点/环境差异、失败教训,值得留给下次的都应保存;开新会话先 find 相关记忆。
- 本操作员已沉淀的自动化任务:
${names || '- (暂无)'}

任务沉淀协议:
当用户确认一轮操作已经成功、或明确要求保存任务时,先与用户确认任务名称与完整指令,然后原样输出一个结构块:

<grf-task name="任务名">
(完整、可独立执行的指令。执行这条例子的会话不再有你现在的记忆与上下文,指令必须自包含:目标、前置条件、具体操作步骤、成功判断标准、常见失败的处置。)
</grf-task>

输出该块后界面会出现保存入口,由用户确认入库。不要在指令里引用本次对话内容。`;
}

/** 执行会话(点击任务触发)的 system prompt:直接按指令执行。 */
export function runnerSystemPrompt(): string {
  return `你是自动化任务的执行操作员。用户消息里带有一条完整任务指令,直接按指令在电脑上执行:
- 优先用电脑操作(computer / grf-computer)与界面控制(goder_browser_* / goder_terminal_*)工具,文件类操作用常规文件/终端工具。
- 相关经验可用内置 memory 工具(默认 project 级)检索,但不要改写任务目标。
- 严格按指令执行,不自行扩大范围;指令含糊或执行失败时如实汇报并停止,等待用户处理。
- 本会话不需要沉淀新任务,不要输出 grf-task 结构块。`;
}

/** 点击任务执行时下发的用户消息文本。 */
export function runnerMessage(task: AutomationTask): string {
  return `执行自动化任务「${task.name}」:\n\n${task.instructions}`;
}
