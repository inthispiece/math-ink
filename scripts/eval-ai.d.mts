export interface EvaluationBudgetRecord { status: string; reservedCny: number; cost?: { status: string; amount?: number | null } }
export function chargeForRecord(record: EvaluationBudgetRecord): number;
export function canReserve(records: EvaluationBudgetRecord[], reserve: number, budget: number): boolean;
export function main(args?: string[]): Promise<void>;
