// display-model.test.ts — 裸模型名补全与 gh 侧 config.ResolveModel 同
// 语义的回归:默认供应商优先 → 恰一家命中 → 歧义/零命中原样(未选)。
import { describe, expect, it } from 'vitest';
import { settingsStore, displayFullModel } from '../src/core/settings/settings-store';

function setCfg(defaultModel: string, providers: { name: string; models: string[] }[]) {
  settingsStore.modelCfg = { path: '', providers, default: defaultModel, writable: true } as never;
}

describe('bareModelFull 语义(displayFullModel 共用同一实现)', () => {
  it('裸名在默认供应商表内 → 默认供应商优先(多家同名不取表序首个)', () => {
    setCfg('GRF/glm-5.3-flash', [
      { name: 'GoProxy', models: ['glm-5.3-flash'] },
      { name: 'GRF', models: ['glm-5.3-flash'] },
    ]);
    expect(displayFullModel('glm-5.3-flash')).toBe('GRF/glm-5.3-flash');
  });

  it('默认供应商没有、恰一家提供 → 取该家', () => {
    setCfg('GRF/glm-5.3-flash', [
      { name: 'GRF', models: ['glm-5.3-flash'] },
      { name: 'Ollama', models: ['qwen3.8:27b-mlx'] },
    ]);
    expect(displayFullModel('qwen3.8:27b-mlx')).toBe('Ollama/qwen3.8:27b-mlx');
  });

  it('多家同名且默认供应商不含 → 歧义,原样返回(gh 侧透传,goder 侧未选)', () => {
    setCfg('GRF/glm-5.3-flash', [
      { name: 'A', models: ['shared-model'] },
      { name: 'B', models: ['shared-model'] },
    ]);
    expect(displayFullModel('shared-model')).toBe('shared-model');
  });

  it('零命中 → 原样返回(九天式自带 / 的裸名同样透传)', () => {
    setCfg('GRF/glm-5.3-flash', [{ name: 'GRF', models: ['glm-5.3-flash'] }]);
    expect(displayFullModel('qwen/qwen3.8:27b')).toBe('qwen/qwen3.8:27b');
  });

  it('已是合法全名原样返回', () => {
    setCfg('GRF/glm-5.3-flash', [{ name: 'GRF', models: ['glm-5.3-flash'] }]);
    expect(displayFullModel('GRF/glm-5.3-flash')).toBe('GRF/glm-5.3-flash');
  });
});
