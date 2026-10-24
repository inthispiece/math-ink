import type { GatewayConfig } from './config.ts';
import { GatewayError } from './types.ts';
import type { PriceConfig, TaskCost, TokenUsage } from './types.ts';

export const unknownUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, status: 'unknown' });
export function reserveAmount(config: GatewayConfig, model: string | undefined, maxInputTokens: number, maxOutputTokens: number): number {
  const rate = config.priceConfig;
  // A developer's unknown-price hold is not a provider price ceiling. Public hosted
  // generation must have a dated rate for the actual configured model before it can
  // reserve counts, concurrency or money and before any supplier request is sent.
  if(config.authMode==='hosted'&&(!rate||rate.model!==model))throw new GatewayError('PRICING_REQUIRED','托管云生成尚未配置当前模型的带日期价格。运营者需核对价格后开启；本次未调用供应商，也未扣减次数或费用预算。',503);
  const amount = rate && rate.model === model ? (maxInputTokens * rate.inputPerMillion + maxOutputTokens * rate.outputPerMillion) / 1_000_000 : config.taskReserveCny;
  const rounded = Math.ceil(amount * 1_000_000) / 1_000_000;
  if (rounded > config.taskMaxCostCny) throw new GatewayError('TASK_BUDGET_EXCEEDED', '本次任务的保守费用预留超过单任务预算，请缩小输入或调整运营预算。', 429);
  return rounded;
}
export function estimateCost(usage: TokenUsage | undefined, model: string | undefined, rate: PriceConfig | null, reserved: number): TaskCost {
  if (!usage || usage.status === 'unknown' || !rate || rate.model !== model) return { status:'unknown', currency:'CNY', amount:null, priceDate:rate&&rate.model===model?rate.date:null, reserved };
  const hit = usage.cacheHitTokens || 0;
  const cachedPrice = rate.cachedInputPerMillion;
  // If cache tokens exist but their price is unavailable, do not invent a bill.
  if (hit > 0 && cachedPrice === undefined) return { status:'unknown',currency:'CNY',amount:null,priceDate:rate.date,reserved };
  const input = (usage.inputTokens-hit) * rate.inputPerMillion + hit * (cachedPrice || 0);
  const amount = Math.ceil((input + usage.outputTokens * rate.outputPerMillion)) / 1_000_000;
  return { status:'estimated',currency:'CNY',amount,priceDate:rate.date,reserved };
}
