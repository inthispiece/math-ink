export type ProviderName = 'mock' | 'mathpix' | 'deepseek' | 'ollama';

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; reasoningTokens?: number; status?: 'reported' | 'unknown' }
export interface RecognitionResult {
  latex: string;
  confidence?: number;
  reviewRequired?: boolean;
  uncertainSymbols?: string[];
  usage?: TokenUsage;
}
export interface ReviewResult { summary: string; issues: string[]; suggestedLatex: string | null; usage?: TokenUsage }

export interface RecognitionRequest {
  clientRequestId: string;
  installationId: string;
  imageBase64: string;
  sourceRevision: number;
  provider?: ProviderName;
}

export interface ReviewRequest {
  clientRequestId: string;
  installationId: string;
  sourceRevision: number;
  provider?: ProviderName;
  latex: string;
  context?: string;
}

export interface RecognitionResponse {
  requestId: string;
  status: 'ok' | 'error';
  provider: ProviderName;
  simulated: boolean;
  sourceRevision: number;
  latex?: string;
  confidence?: number;
  reviewRequired?: boolean;
  uncertainSymbols?: string[];
  usage?: TokenUsage;
  cost?: TaskCost;
  error?: { code: string; message: string; retryable: boolean };
}

/** Queryable selection transcription; payloads are retained only in bounded memory. */
export interface RecognitionTaskResponse {
  taskId: string;
  type: 'formula-transcribe';
  provider: ProviderName;
  model: string | null;
  simulated: boolean;
  status: 'pending' | 'running' | 'ok' | 'error' | 'result-unavailable';
  sourceRevision: number;
  createdAt: string;
  updatedAt: string;
  result?: RecognitionResponse;
  usage?: TokenUsage;
  cost?: TaskCost;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ReviewResponse {
  requestId: string;
  status: 'ok' | 'error';
  provider: ProviderName;
  simulated: boolean;
  sourceRevision: number;
  originalLatex?: string;
  review?: ReviewResult;
  usage?: TokenUsage;
  cost?: TaskCost;
  error?: { code: string; message: string; retryable: boolean };
}

export interface RecognitionProvider {
  readonly name: ProviderName;
  readonly simulated: boolean;
  readonly configured: boolean;
  readonly model?: string;
  readonly local?: boolean;
  readonly timeoutMs?: number;
  recognize(image: Buffer, signal: AbortSignal): Promise<RecognitionResult>;
  review?(latex: string, context: string | undefined, signal: AbortSignal): Promise<ReviewResult>;
  probe?(signal: AbortSignal): Promise<{ ready: boolean; message: string }>;
  task?(request: TaskRequest, signal: AbortSignal): Promise<TaskProviderResult>;
}

export const taskTypes = ['page-transcribe', 'context-review', 'organize', 'knowledge-links', 'proof-assist'] as const;
export type TaskType = typeof taskTypes[number];
export interface NormalizedBox { x: number; y: number; width: number; height: number }
export interface TaskBlock { id: string; version: number; kind: string; text?: string; latex?: string; source?: { bbox: NormalizedBox } }
export interface TaskInput {
  noteId: string; pageId: string; contentRevision: number; imageBase64?: string;
  blocks?: TaskBlock[]; candidates?: TaskBlock[]; domain?: 'elementary-algebra' | 'calculus';
  goal?: string; assumptions?: string[]; steps?: string[];
}
export interface TaskRequest { clientRequestId: string; installationId: string; provider?: ProviderName; sourceRevision: number; type: TaskType; input: TaskInput }
export interface PageDraftBlock { id: string; kind: 'heading' | 'paragraph' | 'list-item' | 'formula' | 'equation' | 'image-region'; segments?: ({ type: 'text'; text: string } | { type: 'math'; latex: string })[]; latex?: string; bbox: NormalizedBox; uncertainties: string[] }
export interface PageDraft { blocks: PageDraftBlock[]; warnings: string[] }
export interface TaskEvidence { blockId: string; version: number; quote: string }
export interface ContextSuggestion { id: string; type: 'recognition' | 'language' | 'mathematics' | 'missing-condition'; blockId: string; expectedVersion: number; before: string; after: string; reason: string; evidence: TaskEvidence[] }
export interface ContextReview { suggestions: ContextSuggestion[]; summary: string }
export interface OrganizedDraft { title: string; outline: { blockId: string; level: number; category: 'definition' | 'theorem' | 'example' | 'proof' | 'text' }[]; summary: string; newExplanations: string[] }
export interface KnowledgeLinks { links: { fromBlockId: string; toBlockId: string; relation: 'definition' | 'theorem' | 'example' | 'counterexample' | 'dependency'; reason: string; evidence: TaskEvidence[] }[] }
export interface ProofAssistance { domain: 'elementary-algebra' | 'calculus'; goal: string; assumptions: string[]; existingSteps: string[]; nextSteps: string[]; unresolved: string[]; verification: 'unverified' }
export type TaskPayload = PageDraft | ContextReview | OrganizedDraft | KnowledgeLinks | ProofAssistance;
export interface TaskProviderResult { result: TaskPayload; usage?: TokenUsage }
export interface PriceConfig { model: string; date: string; currency: 'CNY'; inputPerMillion: number; cachedInputPerMillion?: number; outputPerMillion: number }
export interface TaskCost { status: 'estimated' | 'unknown'; currency: 'CNY'; amount: number | null; priceDate: string | null; reserved: number }
export interface TaskResponse {
  taskId: string; type: TaskType; provider: ProviderName; model: string | null;
  status: 'pending' | 'running' | 'ok' | 'error' | 'result-unavailable'; sourceRevision: number; contentRevision: number;
  createdAt: string; updatedAt: string; steps: { id: 'generate'; status: 'pending' | 'running' | 'ok' | 'error' }[];
  result?: TaskPayload; usage?: TokenUsage; cost?: TaskCost;
  error?: { code: string; message: string; retryable: boolean };
}

export interface QuotaWindow {
  limit: number | null;
  used: number;
  remaining: number | null;
  resetsAt: string | null;
}

export interface RecognitionQuota {
  enforced: boolean;
  source: 'local-service';
  installationDaily: QuotaWindow;
  globalDaily: QuotaWindow;
  globalMonthly: QuotaWindow;
  userMonthly?: QuotaWindow;
  subject?: 'account' | 'installation';
}

export class GatewayError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  usage?: TokenUsage;

  constructor(code: string, message: string, statusCode = 400, retryable = false) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
