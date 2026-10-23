export type ProviderName = 'mock' | 'mathpix' | 'deepseek' | 'ollama';

export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface RecognitionResult {
  latex: string;
  confidence?: number;
  reviewRequired?: boolean;
  uncertainSymbols?: string[];
  usage?: TokenUsage;
}
export interface ReviewResult { summary: string; issues: string[]; suggestedLatex: string | null }

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
}

export class GatewayError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, statusCode = 400, retryable = false) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
