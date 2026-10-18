// model-menu.test.ts — chat 头部模型菜单/圆环分母派生计算的回归:
// provider 前缀、models null 判空、当前模型补组、exact 优先于按名估算。
import { describe, expect, it } from 'vitest';
import { modelMenuOf, contextWindowDenominator } from '../src/util/model-menu';
import type { ModelConfigDTO } from '../src/core/api/agent-dto';

const cfg = (providers: ModelConfigDTO['providers']): ModelConfigDTO =>
  ({ providers }) as unknown as ModelConfigDTO;

describe('modelMenuOf', () => {
  it('菜单项补 provider/ 前缀(gh trySwitchModel 只认全名)', () => {
    const groups = modelMenuOf('', cfg([{ name: 'p1', models: ['m1', 'm2'] } as never]));
    expect(groups).toEqual([{ name: 'p1', models: ['p1/m1', 'p1/m2'] }]);
  });

  it('models 为 null(Go nil 切片)不抛错、按空组处理', () => {
    const groups = modelMenuOf('', cfg([{ name: 'p1', models: null } as never]));
    expect(groups).toEqual([{ name: 'p1', models: [] }]);
  });

  it('当前模型不在列表时补「当前模型」组(勾选态不断流)', () => {
    const groups = modelMenuOf('other/x', cfg([{ name: 'p1', models: ['m1'] } as never]));
    expect(groups[groups.length - 1]).toEqual({ name: '当前模型', models: ['other/x'] });
  });

  it('当前模型已在列表时不重复补组', () => {
    const groups = modelMenuOf('p1/m1', cfg([{ name: 'p1', models: ['m1'] } as never]));
    expect(groups).toHaveLength(1);
  });

  it('空配置 + 无当前模型 = 空菜单', () => {
    expect(modelMenuOf('', null)).toEqual([]);
  });
});

describe('contextWindowDenominator', () => {
  it('exact(供应商接口回报)优先', () => {
    const r = contextWindowDenominator('p1/m1', 123456);
    expect(r.exact).toBe(123456);
    expect(r.value).toBe(123456);
  });

  it('无 exact 回落按名估算', () => {
    const r = contextWindowDenominator('p1/gpt-4o', null);
    expect(r.exact).toBeNull();
    expect(r.value).toBeGreaterThan(0);
  });
});
