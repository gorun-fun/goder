// fmt.ts — 展示格式化辅助。
export function fmtTime(iso: string | number | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}/${md}`;
}

// 距今相对时间:刚刚 / n分钟 / n小时 / n天;超过 30 天回退绝对时间。
export function fmtRelative(iso: string | number | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}小时`;
  if (sec < 30 * 86400) return `${Math.floor(sec / 86400)}天`;
  return fmtTime(iso);
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export function fmtTokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// 工具参数一行摘要(bash 取命令,read/write 取路径…)。
export function toolArgSummary(name: string, args: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args || '{}') as Record<string, unknown>;
  } catch {
    return truncate(args, 80);
  }
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  let s: string;
  switch (name) {
    case 'bash':
      s = String(pick('command') ?? '');
      break;
    case 'read':
    case 'write':
    case 'edit':
    case 'glob':
    case 'grep':
    case 'read_image':
      s = String(pick('file_path', 'path', 'pattern') ?? '');
      break;
    case 'web_search':
      s = String(pick('queries', 'query') ?? '');
      break;
    case 'skill':
      s = String(pick('name') ?? '');
      break;
    case 'subagent':
    case 'send_message':
    case 'subagent_fork':
      s = String(pick('prompt', 'message') ?? '');
      break;
    default: {
      const first = Object.values(parsed)[0];
      s = typeof first === 'string' ? first : args ? JSON.stringify(parsed).slice(0, 100) : '';
    }
  }
  return truncate(s, 100);
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 工具名 → 中文展示名(未知工具回退原名)。
const TOOL_LABELS: Record<string, string> = {
  bash: '终端',
  read: '读取',
  write: '创建',
  edit: '编辑',
  glob: '查找',
  grep: '搜索',
  read_image: '读取图片',
  web_search: '联网搜索',
  ask_user_question: '询问用户',
  todo_write: '更新待办',
  skill: '加载技能',
  subagent: '子代理',
  subagent_fork: '派生子代理',
  send_message: '发送消息',
  interrupt_agent: '中断',
  list_agents: '列出子代理',
  workflow: '工作流',
  ralph: '循环执行',
  create_goal: '创建目标',
  update_goal: '更新目标',
  get_goal: '查看目标',
  enter_plan_mode: '进入计划模式',
  exit_plan_mode: '退出计划模式',
  set_policy: '设置策略',
  job_list: '列出作业',
  job_output: '查看作业输出',
  job_kill: '结束作业',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? (name || '工具');
}

// 时长(中文单位):3秒 / 1.5秒 / 0.4秒 / 1分5秒。
export function fmtToolDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}秒`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)}秒`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m}分${rest}秒` : `${m}分`;
}

// 各工具的关键参数(展示"命令",不展示原始 JSON)。
const TOOL_PRIMARY: Record<string, string[]> = {
  bash: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  glob: ['pattern'],
  grep: ['pattern', 'query'],
  web_search: ['queries', 'query'],
  skill: ['name'],
  subagent: ['prompt'],
  subagent_fork: ['prompt'],
  send_message: ['message'],
  job_output: ['job_id'],
  job_kill: ['job_id'],
};

function valText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => valText(x)).join('\n');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// toolDetail 工具调用的可读明细:优先取该工具的关键参数(如 bash 的命令、
// 文件工具的路径),没有固定主参数时按 "key: value" 逐行展示,避免出现
// 带花括号引号的原始 JSON。
export function toolDetail(name: string, args: string): string {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(args || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return args.trim();
    obj = parsed as Record<string, unknown>;
  } catch {
    return args.trim();
  }
  const keys = TOOL_PRIMARY[name];
  if (keys) {
    for (const k of keys) {
      if (k in obj) return valText(obj[k]);
    }
  }
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${valText(v)}`)
    .join('\n');
}

// isToolChoiceUnsupported 命中"上游 vLLM 未开启工具调用"这类错误。
// 上游网关常按后端负载均衡,部分后端没带 --enable-auto-tool-choice,会对
// 带工具的请求瞬时 400;这类失败可重试。
export function isToolChoiceUnsupported(msg: string): boolean {
  return /enable-auto-tool-choice|tool[-_ ]call[-_ ]parser|"auto"\s+tool\s+choice/i.test(msg);
}

// friendlyError 把已知的后端错误翻成可操作的提示(其余原样返回)。
// 典型:模型侧 vLLM 未开启原生工具调用,整个回合都会 400。
export function friendlyError(msg: string): string {
  if (isToolChoiceUnsupported(msg)) {
    return (
      '当前模型服务未开启工具调用,本回合无法执行。\n' +
      'vLLM 需以 --enable-auto-tool-choice 与 --tool-call-parser <解析器> 启动;' +
      '若无法改动服务,请在「设置 → 模型设置」改用支持工具调用的模型。\n' +
      `服务返回:${msg}`
    );
  }
  return msg;
}
