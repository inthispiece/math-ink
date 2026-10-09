export type ProviderName = 'mock' | 'mathpix';

export interface RecognitionRequest {
  clientRequestId: string;
  installationId: string;
  imageBase64: string;
  sourceRevision: number;
}

export interface RecognitionResponse {
  requestId: string;
  status: 'ok' | 'error';
  provider: ProviderName;
  simulated: boolean;
  sourceRevision: number;
  latex?: string;
  confidence?: number;
  error?: { code: string; message: string; retryable: boolean };
}

export interface RecognitionProvider {
  readonly name: ProviderName;
  readonly simulated: boolean;
  readonly configured: boolean;
  recognize(image: Buffer, signal: AbortSignal): Promise<{ latex: string; confidence?: number }>;
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
