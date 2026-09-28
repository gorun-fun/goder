// fmt.test.ts — 工具展示名词典、流式残缺参数容错提取、±行数统计。
import { describe, it, expect } from 'vitest';
import { toolLabel, extractStringArg, fileEditStat, truncate } from '../src/util/fmt';
// console-ui 模块加载即注册 goder-console 工具元数据(与前端接线同源)
import '../src/shell/console-ui';

describe('toolLabel', () => {
  it('内置词典覆盖基础工具', () => {
    expect(toolLabel('bash')).toBe('终端');
    expect(toolLabel('edit')).toBe('编辑');
    expect(toolLabel('ask_user_question')).toBe('询问用户');
  });

  it('未知工具回退原名;browser_/computer_ 系按动词词典拼译', () => {
    expect(toolLabel('some_unknown_tool')).toBe('some_unknown_tool');
    expect(toolLabel('browser_click')).toBe('浏览器·点击');
    expect(toolLabel('computer_clipboard')).toBe('电脑·剪贴板');
  });

  it('goder-console 系经 console-ui 同源注册出中文名', () => {
    expect(toolLabel('goder_browser_navigate')).toBe('面板浏览器·打开网页');
    expect(toolLabel('goder_ui_do')).toBe('界面·操作');
    expect(toolLabel('goder_terminal_send')).toBe('面板终端·输入');
  });
});

describe('extractStringArg(流式残缺容错)', () => {
  it('完整 JSON 精确取字段', () => {
    expect(extractStringArg('{"file_path":"/a/b.ts","old":"x"}', 'file_path')).toBe('/a/b.ts');
    expect(extractStringArg('{"n":5}', 'file_path')).toBeUndefined();
  });

  it('残缺 JSON(值未闭合)按 key 定位扫描到已到达部分', () => {
    const partial = '{"file_path":"/a/b';
    expect(extractStringArg(partial, 'file_path')).toBe('/a/b');
  });

  it('字段尚未流到返回 undefined', () => {
    expect(extractStringArg('{"file_path":', 'file_path')).toBeUndefined();
    expect(extractStringArg('{"other":1,', 'file_path')).toBeUndefined();
  });

  it('转义序列解码(换行/unicode)', () => {
    expect(extractStringArg('{"t":"a\\nb"}', 't')).toBe('a\nb');
    expect(extractStringArg('{"t":"中\\u6587"}', 't')).toBe('中文');
  });
});

describe('fileEditStat(±行数随流式实时)', () => {
  it('write 按内容行数计 add', () => {
    expect(fileEditStat('write', '{"content":"a\\nb\\nc"}')).toEqual({ add: 3, del: 0 });
  });

  it('edit 按 old/new 行数;replace_all 多处替换按输出倍数修正', () => {
    expect(fileEditStat('edit', '{"old_string":"a","new_string":"x\\ny"}')).toEqual({ add: 2, del: 1 });
    expect(fileEditStat('edit', '{"old_string":"a","new_string":"b"}', '(3 replacements)')).toEqual({ add: 3, del: 3 });
  });

  it('非文件工具与残缺参数返回 undefined', () => {
    expect(fileEditStat('bash', '{"command":"ls"}')).toBeUndefined();
    expect(fileEditStat('edit', '{"old_str')).toBeUndefined();
  });
});

describe('truncate', () => {
  it('空白折叠与超长截断', () => {
    expect(truncate('a  b\n c', 10)).toBe('a b c');
    expect(truncate('x'.repeat(20), 5)).toBe('xxxxx…');
  });
});
