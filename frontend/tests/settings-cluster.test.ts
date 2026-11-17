// settings-cluster.test.ts — 集群段废弃键迁移(migrateClusterPeers)用例:
// 语义对齐 gh config.MergeClusterPeers(nodes/commander_url 按 addr 去重
// 并入 peers、role 清除),覆盖对等网改造前旧 settings.json 的读入形态。
import { describe, expect, it } from 'vitest';
import { migrateClusterPeers } from '../src/core/settings/settings-store';

describe('migrateClusterPeers(集群段废弃键迁移)', () => {
  it('已是 peers 形态:原样保留,废弃键清除', () => {
    const out = migrateClusterPeers({
      enabled: true,
      name: 'mac-studio',
      peers: [{ addr: '127.0.0.1:7500', name: 'mbp' }],
    });
    expect(out.peers).toEqual([{ addr: '127.0.0.1:7500', name: 'mbp' }]);
    expect(out.role).toBeUndefined();
    expect(out.commander_url).toBeUndefined();
    expect(out.nodes).toBeUndefined();
  });

  it('旧指挥官形态:commander_url 追加为无 token 的 peers 条目', () => {
    const out = migrateClusterPeers({
      enabled: true,
      role: 'commander',
      commander_url: 'http://192.168.1.10:7400',
      nodes: [{ addr: '192.168.1.20:7400', token: 't2', name: 'worker' }],
    });
    expect(out.peers).toEqual([{ addr: '192.168.1.20:7400', token: 't2', name: 'worker' }, { addr: 'http://192.168.1.10:7400' }]);
    expect(out.role).toBeUndefined();
    expect(out.commander_url).toBeUndefined();
    expect(out.nodes).toBeUndefined();
  });

  it('旧节点形态:commander_url 条目与既有 peers 按 addr 去重(scheme/斜杠归一)', () => {
    const out = migrateClusterPeers({
      enabled: true,
      role: 'node',
      peers: [{ addr: 'http://192.168.1.10:7400/', name: 'studio' }],
      commander_url: '192.168.1.10:7400',
      nodes: [{ addr: 'https://192.168.1.10:7400', token: 'dup' }],
    });
    // peers 优先,同 addr 的 nodes/commander_url 均不重复追加
    expect(out.peers).toEqual([{ addr: 'http://192.168.1.10:7400/', name: 'studio' }]);
  });

  it('迁移后可 JSON 序列化为纯 peers 形态(废弃键不落盘)', () => {
    const json = JSON.stringify(migrateClusterPeers({ enabled: true, role: 'node', commander_url: '10.0.0.2:7400' }));
    expect(json).not.toContain('role');
    expect(json).not.toContain('commander_url');
    expect(json).toContain('"peers":[{"addr":"10.0.0.2:7400"}]');
  });
});
