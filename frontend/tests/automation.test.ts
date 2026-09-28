// automation.test.ts — 自动化协议块解析。
import { describe, it, expect } from 'vitest';
import { parseGrfTaskBlocks, parseGrfSkillBlocks } from '../src/core/store/automation';

// ---------- 协议块解析 ----------

describe('parseGrfTaskBlocks / parseGrfSkillBlocks', () => {
  it('闭合任务块成段,未闭合尾部丢弃', () => {
    const segs = parseGrfTaskBlocks('前置说明\n<grf-task name="每日巡检">检查服务</grf-task>\n尾部<grf-task name="未闭合">');
    expect(segs).toEqual([
      { type: 'text', text: '前置说明\n' },
      { type: 'task', name: '每日巡检', instructions: '检查服务' },
      { type: 'text', text: '\n尾部' },
    ]);
  });

  it('技能块解析(内容含代码栏)', () => {
    const segs = parseGrfSkillBlocks('<grf-skill name="部署">```bash\nk apply\n```</grf-skill>');
    expect(segs[0]).toEqual({ type: 'skill', name: '部署', content: '```bash\nk apply\n```' });
  });
});
