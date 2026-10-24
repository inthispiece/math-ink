export interface EvaluationSample {
  id: string; kind: 'page' | 'formula' | 'review'; split: 'debug' | 'acceptance';
  writerGroup: string; sourceGroup: string; imagePath?: string; latex?: string; context?: string;
  expected?: { chinese?: string; english?: string; latex?: string; hasError?: boolean };
  humanVerified?: boolean;
}
export interface EvaluationManifest { version: 1; samples: EvaluationSample[] }
export function validateManifest(input: unknown): EvaluationManifest {
  const m = input as EvaluationManifest;
  if (!m || m.version !== 1 || !Array.isArray(m.samples) || m.samples.length > 1000) throw new Error('评测清单格式无效');
  const ids = new Set<string>(), writers = new Map<string, string>(), sources = new Map<string, string>();
  for (const sample of m.samples) {
    if (!sample || typeof sample.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(sample.id) || ids.has(sample.id) || !['page','formula','review'].includes(sample.kind) || !['debug','acceptance'].includes(sample.split) || typeof sample.writerGroup !== 'string' || !sample.writerGroup.trim() || sample.writerGroup.length > 200 || typeof sample.sourceGroup !== 'string' || !sample.sourceGroup.trim() || sample.sourceGroup.length > 200 || sample.humanVerified !== undefined && typeof sample.humanVerified !== 'boolean') throw new Error('样本标识、分组或任务类型无效');
    ids.add(sample.id);
    for (const [map, key] of [[writers, sample.writerGroup], [sources, sample.sourceGroup]] as const) {
      if (map.has(key) && map.get(key) !== sample.split) throw new Error('同一书写者或来源跨调试/验收组，存在数据泄漏');
      map.set(key, sample.split);
    }
    if (sample.kind === 'review' ? typeof sample.latex !== 'string' || !sample.latex.trim() : typeof sample.imagePath !== 'string' || !sample.imagePath) throw new Error('样本缺少本机图片路径或待检查公式');
    if (sample.kind === 'review' && typeof sample.expected?.hasError !== 'boolean') throw new Error('检查题需要人工期望标签 hasError');
    if (sample.context !== undefined && typeof sample.context !== 'string') throw new Error('样本上下文必须为文字');
    if (sample.expected && (typeof sample.expected !== 'object' || Array.isArray(sample.expected) || ['chinese', 'english', 'latex'].some(key => Object.hasOwn(sample.expected!, key) && typeof sample.expected![key as 'chinese'] !== 'string'))) throw new Error('样本人工参考内容无效');
  }
  return m;
}
export function editDistance(expected: string[], actual: string[]): number {
  if (expected.length * actual.length > 25_000_000) throw new Error('文本过大，请按页面分段计算指标');
  let row = actual.map((_, i) => i + 1); row.unshift(0);
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < actual.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (expected[i] === actual[j] ? 0 : 1)));
    row = next;
  }
  return row[actual.length];
}
export function characterErrorRate(expected: string, actual: string) {
  const reference = Array.from(expected), hypothesis = Array.from(actual);
  return reference.length ? { errors: editDistance(reference, hypothesis), units: reference.length } : null;
}
export function wordErrorRate(expected: string, actual: string) {
  const words = (value: string) => value.toLowerCase().match(/[a-z]+(?:['’-][a-z]+)*/g) || [];
  const reference = words(expected), hypothesis = words(actual);
  return reference.length ? { errors: editDistance(reference, hypothesis), units: reference.length } : null;
}
export function normalizeFormula(value: string) {
  return value.trim().replace(/^\$\$?|\$\$?$/g, '').replace(/\\(?:left|right)(?![a-zA-Z])/g, '').replace(/\\[,;! ]|\s+/g, '');
}
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}
export interface HumanAssessment {
  sampleId: string; readingOrderCorrect?: boolean; formulaUnits?: { correct: number; total: number };
  contentUnits?: Record<string, { correct: number; total: number }>;
  correctIssueFound?: boolean; erroneousChangeSuggested?: boolean; manualSeconds?: number; aiCorrectionSeconds?: number;
}
export function assess(records: { sampleId: string; elapsedMs?: number; status: string; cost?: { amount?: number | null; status?: string }; output?: unknown }[], manifest: EvaluationManifest, assessments: HumanAssessment[] = []) {
  const accepted = manifest.samples.filter(s => s.split === 'acceptance' && s.humanVerified);
  const eligible = new Set(accepted.map(s => s.id));
  if (new Set(assessments.map(a=>a.sampleId)).size !== assessments.length) throw new Error('人工评审包含重复样本，不能重复计入指标');
  const completed = new Set(records.filter(r=>r.status==='ok').map(r=>r.sampleId));
  const frozen = assessments.filter(a => eligible.has(a.sampleId) && completed.has(a.sampleId));
  const correct = accepted.filter(s => s.kind === 'review' && !s.expected?.hasError);
  const incorrect = accepted.filter(s => s.kind === 'review' && s.expected?.hasError);
  const reviewedCorrect = frozen.filter(a => correct.some(s => s.id === a.sampleId) && typeof a.erroneousChangeSuggested === 'boolean');
  const reviewedIncorrect = frozen.filter(a => incorrect.some(s => s.id === a.sampleId) && typeof a.correctIssueFound === 'boolean');
  const timings = frozen.filter(a => typeof a.manualSeconds === 'number' && Number.isFinite(a.manualSeconds) && a.manualSeconds > 0 && typeof a.aiCorrectionSeconds === 'number' && Number.isFinite(a.aiCorrectionSeconds) && a.aiCorrectionSeconds >= 0);
  const latencies = records.map(r => r.elapsedMs).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const paid = records.filter(r => r.cost?.status === 'estimated' && typeof r.cost.amount === 'number');
  const units = frozen.map(a=>a.formulaUnits).filter((u):u is {correct:number;total:number}=>!!u && u.total>0 && u.correct>=0 && u.correct<=u.total);
  const contentUnits: Record<string,{correct:number;total:number}> = {};
  for (const assessment of frozen) for (const [kind,unit] of Object.entries(assessment.contentUnits || {})) if (unit && Number.isSafeInteger(unit.correct) && Number.isSafeInteger(unit.total) && unit.total > 0 && unit.correct >= 0 && unit.correct <= unit.total) { contentUnits[kind] ??= {correct:0,total:0}; contentUnits[kind].correct += unit.correct; contentUnits[kind].total += unit.total; }
  return {
    measuredAt: new Date().toISOString(), sampleCount: manifest.samples.length, frozenVerifiedSamples: accepted.length,
    attempts: records.length, completed: records.filter(r=>r.status==='ok').length, unresolved: records.filter(r=>r.status!=='ok').length,
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
    estimatedCny: paid.length === records.length && records.length ? paid.reduce((n,r)=>n+r.cost!.amount!,0) : null,
    billingReconciled: false, unknownCostAttempts: records.length-paid.length,
    formulaUnits: { correct: units.reduce((n,u)=>n+u.correct,0), total: units.reduce((n,u)=>n+u.total,0) },
    contentUnits,
    readingOrder: { correct: frozen.filter(a=>a.readingOrderCorrect===true).length, total: frozen.filter(a=>typeof a.readingOrderCorrect==='boolean').length },
    reviewFalseChanges: { numerator: reviewedCorrect.filter(a=>a.erroneousChangeSuggested).length, denominator: reviewedCorrect.length },
    reviewDetection: { numerator: reviewedIncorrect.filter(a=>a.correctIssueFound).length, denominator: reviewedIncorrect.length },
    timeReductionMedian: percentile(timings.map(a=>1-a.aiCorrectionSeconds!/a.manualSeconds!), .5),
    note: '空分母、缺少人工核对或账单的数据表示尚未测得；接口测试和字符串一致不代表数学正确。',
  };
}
