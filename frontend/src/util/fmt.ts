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
  // 浏览器插件(grf-browser)
  browser_click: '浏览器·点击',
  browser_double_click: '浏览器·双击',
  browser_hover: '浏览器·悬停',
  browser_type: '浏览器·输入',
  browser_press_key: '浏览器·按键',
  browser_navigate: '浏览器·打开网页',
  browser_back: '浏览器·后退',
  browser_forward: '浏览器·前进',
  browser_reload: '浏览器·刷新',
  browser_close: '浏览器·关闭',
  browser_scroll: '浏览器·滚动',
  browser_snapshot: '浏览器·页面快照',
  browser_take_screenshot: '浏览器·截图',
  browser_get_text: '浏览器·获取文本',
  browser_select_option: '浏览器·选择选项',
  browser_evaluate: '浏览器·执行脚本',
  browser_wait_for: '浏览器·等待',
  browser_file_upload: '浏览器·上传文件',
  browser_tabs: '浏览器·标签页',
  browser_console_messages: '浏览器·控制台日志',
  browser_network_requests: '浏览器·网络请求',
  browser_cookies: '浏览器·Cookies',
  // 桌面控制插件(grf-computer)
  computer_click: '电脑·点击',
  computer_type: '电脑·输入',
  computer_key: '电脑·按键',
  computer_move: '电脑·移动鼠标',
  computer_drag: '电脑·拖拽',
  computer_scroll: '电脑·滚动',
  computer_screenshot: '电脑·截屏',
  computer_clipboard: '电脑·剪贴板',
  computer_screen_size: '电脑·屏幕尺寸',
  computer_wait: '电脑·等待',
};

/** 插件前缀与常见动词的中文对照(未收录的 browser_、computer_ 系列兜底拼译) */
const TOOL_PREFIX: Record<string, string> = { browser: '浏览器', computer: '电脑' };
const TOOL_WORDS: Record<string, string> = {
  click: '点击',
  double: '双击',
  type: '输入',
  input: '输入',
  hover: '悬停',
  key: '按键',
  press: '按键',
  navigate: '打开网页',
  open: '打开',
  close: '关闭',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  scroll: '滚动',
  snapshot: '页面快照',
  screenshot: '截图',
  take: '',
  get: '获取',
  text: '文本',
  select: '选择',
  option: '选项',
  evaluate: '执行脚本',
  wait: '等待',
  for: '',
  file: '文件',
  upload: '上传',
  download: '下载',
  tab: '标签页',
  tabs: '标签页',
  console: '控制台',
  messages: '消息',
  network: '网络',
  requests: '请求',
  cookies: 'Cookies',
  clipboard: '剪贴板',
  screen: '屏幕',
  size: '尺寸',
  move: '移动',
  drag: '拖拽',
  page: '页面',
  find: '查找',
  search: '搜索',
  save: '保存',
  delete: '删除',
  read: '读取',
  write: '写入',
};

export function toolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  // 插件工具兜底:按前缀 + 动词词典拼出中文名,避免直接展示 browser_xxx
  const parts = name.split('_').filter(Boolean);
  const prefix = TOOL_PREFIX[parts[0]];
  if (prefix) {
    const rest = parts
      .slice(1)
      .map((w) => TOOL_WORDS[w] ?? w)
      .join('');
    return `${prefix}·${rest || '操作'}`;
  }
  return name || '工具';
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
    // 参数还在流式生成中(残缺 JSON):容错提取关键参数(如文件路径),
    // 取不到再展示原文。
    const keys = TOOL_PRIMARY[name];
    if (keys) {
      for (const k of keys) {
        const v = extractStringArg(args, k);
        if (v !== undefined) return v;
      }
    }
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

// ---- 文件修改工具的 +增/-删 实时统计 ----

// countLines 语义同 git diffstat:按 \n 切分,尾部空行不计;空串为 0 行。
function countLines(s: string): number {
  if (!s) return 0;
  const parts = s.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

// decodePartialJsonString 解码 JSON 字符串字面量的原始段(起始引号之后):
// 容忍流式截断——值未闭合(无结束引号)或结尾转义残缺时,解码到已到达
// 的部分为止。
function decodePartialJsonString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') break; // 值完整结束
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === undefined) break; // 截断在转义符上
      i++;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'u' && i + 4 < raw.length) {
        const h = parseInt(raw.slice(i + 1, i + 5), 16);
        if (!Number.isNaN(h)) {
          out += String.fromCharCode(h);
          i += 4;
        } else out += n;
      } else out += n; // \\ \" \/ \b \f 等按字面量
    } else out += c;
  }
  return out;
}

// extractStringArg 从(可能是流式残缺的)工具参数 JSON 里取字符串字段:
// 完整 JSON 精确解析;残缺时按 "key": 定位后转义扫描(首处匹配即真实
// 字段——gh 侧字段名先于值出现)。该字段尚未流到返回 undefined。
export function extractStringArg(args: string, key: string): string | undefined {
  const s = args ?? '';
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : undefined;
    }
    return undefined;
  } catch {
    /* 流式残缺:走容错扫描 */
  }
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(s);
  if (!m) return undefined;
  return decodePartialJsonString(s.slice(m.index + m[0].length));
}

// fileEditStat 文件修改类工具(edit/write)的 +增/-删 行数。参数可能是
// 模型流式输出中的残缺 JSON——容错提取让统计随输出实时跳动,流完即精确。
// write 覆盖旧文件时旧行数未知,只给 add;edit 完成后输出里的
// "(N replacements)" 用于 replace_all 多处替换的倍数修正。
// 尚未流到可统计字段时返回 undefined。
export function fileEditStat(
  name: string,
  args: string,
  output = '',
): { add: number; del: number } | undefined {
  if (name === 'write') {
    const content = extractStringArg(args, 'content');
    if (content === undefined) return undefined;
    return { add: countLines(content), del: 0 };
  }
  if (name === 'edit') {
    const oldStr = extractStringArg(args, 'old_string');
    if (oldStr === undefined) return undefined;
    const newStr = extractStringArg(args, 'new_string') ?? '';
    let add = countLines(newStr);
    let del = countLines(oldStr);
    const m = /(\d+) replacements?\b/.exec(output ?? '');
    if (m) {
      const n = Math.max(1, parseInt(m[1], 10));
      add *= n;
      del *= n;
    }
    return { add, del };
  }
  return undefined;
}

// 工具标签行的主参数(文件工具的路径、glob/grep 的模式、bash 的命令)——
// 与 TOOL_PRIMARY(展开明细用)分开维护,行内只放短主参数。
const TOOL_LINE_SUBJECT: Record<string, string[]> = {
  bash: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  glob: ['pattern'],
  grep: ['pattern'],
};

// toolFilePath 文件类工具(read/write/edit/read_image)的绝对路径提取
// (参数流式残缺时容错),供行内文件名点击打开右栏文件 tab。
export function toolFilePath(name: string, args: string): string | undefined {
  if (!['read', 'write', 'edit', 'read_image'].includes(name)) return undefined;
  return extractStringArg(args, 'file_path') ?? extractStringArg(args, 'path');
}

// toolPrimaryText 工具标签行的主参数文本:参数可能仍在流式生成(残缺
// JSON),容错提取——文件名在参数刚流出时就上屏,不再只剩"运行中"转圈。
// 取不到返回 undefined。
export function toolPrimaryText(name: string, args: string): string | undefined {
  const keys = TOOL_LINE_SUBJECT[name];
  if (!keys) return undefined;
  for (const k of keys) {
    const v = extractStringArg(args, k);
    if (v) return v;
  }
  return undefined;
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
