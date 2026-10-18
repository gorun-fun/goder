// model-menu.ts — chat 头部模型菜单与上下文圆环分母的派生计算。
// 从 chat-panel 的 render 内联块抽出的纯函数(数据经参数注入、默认取
// settingsStore 单例,便于 vitest 直测;不碰 Lit 状态与 DOM)。
import { settingsStore, displayFullModel } from '../core/settings/settings-store';
import type { ModelConfigDTO } from '../core/api/agent-dto';
import { modelContextWindow } from './modelctx';

/** 菜单分组:组名 + 已补 provider/ 前缀的模型全名列表。 */
export interface ModelMenuGroup {
  name: string;
  models: string[];
}

/** 模型菜单分组:settings 供应商列表补 provider/ 前缀 —— gh server 的
 * trySwitchModel 只认 "provider/model" 全名,裸模型名会被忽略(切换不
 * 生效);models 判空:Go 侧 nil 切片序列化为 null,直接展开会抛
 * TypeError 冻结整个聊天面板(会话点不开/三栏开关失效)。服务端回报的
 * 当前模型不在列表时补「当前模型」组(勾选态不断流)。curModel 为
 * 「下一回合将使用的模型」:本机选择优先(刚切换就能看到),会话尚未
 * 发过消息时回落服务端回报。 */
export function modelMenuOf(curModel: string, cfg: ModelConfigDTO | null = settingsStore.modelCfg): ModelMenuGroup[] {
  const groups: ModelMenuGroup[] = (cfg?.providers ?? []).map((p) => ({
    name: p.name,
    models: (p.models ?? []).map((m) => `${p.name}/${m}`),
  }));
  const curFull = displayFullModel(curModel);
  if (curFull && !groups.some((g) => g.models.includes(curFull))) {
    groups.push({ name: '当前模型', models: [curFull] });
  }
  return groups;
}

/** 上下文圆环分母:优先供应商 /models 接口回报的真实窗口(token-hub /
 * OpenRouter 等网关;exact 非 null 时调用方无需再探测),查不到按名
 * 估算兜底 —— 调用方见机后台探测一次,成功后 store bump 触发重渲染
 * 换上真实值。 */
export function contextWindowDenominator(
  model: string,
  exact: number | null = settingsStore.providerCtxWindow(model),
): { exact: number | null; value: number } {
  return { exact, value: exact ?? modelContextWindow(model || undefined) };
}
