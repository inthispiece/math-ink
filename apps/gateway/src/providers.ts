import { GatewayError } from './types.ts';
import type { RecognitionProvider } from './types.ts';

export class MockProvider implements RecognitionProvider {
  readonly name = 'mock' as const;
  readonly simulated = true;
  readonly configured = true;

  async recognize(_image: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    return { latex: '\\int_0^1 x^2\\,dx=\\frac{1}{3}' };
  }
}

export class MathpixProvider implements RecognitionProvider {
  readonly name = 'mathpix' as const;
  readonly simulated = false;
  readonly configured: boolean;
  private readonly appId: string;
  private readonly appKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { appId: string; appKey: string; fetcher?: typeof fetch }) {
    this.appId = options.appId;
    this.appKey = options.appKey;
    this.fetcher = options.fetcher || fetch;
    this.configured = Boolean(this.appId && this.appKey);
  }

  async recognize(image: Buffer, signal: AbortSignal) {
    if (!this.configured) throw new GatewayError('PROVIDER_NOT_CONFIGURED', '真实识别尚未配置，请在服务端设置 Mathpix 凭据。', 503);
    let response: Response;
    try {
      response = await this.fetcher('https://api.mathpix.com/v3/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', app_id: this.appId, app_key: this.appKey },
        body: JSON.stringify({
          src: `data:image/png;base64,${image.toString('base64')}`,
          formats: ['latex_styled', 'text', 'data'],
          data_options: { include_latex: true },
          metadata: { improve_mathpix: false },
        }),
        signal,
      });
    } catch {
      if (signal.aborted) throw new GatewayError('PROVIDER_TIMEOUT', '识别超时。请求可能已计费，请核对后手动重试。', 504);
      throw new GatewayError('PROVIDER_UNAVAILABLE', '识别服务暂时不可用，请稍后手动重试。', 502, true);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new GatewayError('PROVIDER_AUTH_FAILED', '服务端识别凭据无效，请联系服务维护者。', 503);
      if (response.status === 429) throw new GatewayError('PROVIDER_RATE_LIMITED', '识别服务额度或频率受限，请稍后手动重试。', 429, true);
      throw new GatewayError('PROVIDER_UNAVAILABLE', '识别服务返回异常，请稍后手动重试。', 502, true);
    }
    let result: Record<string, unknown>;
    try {
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error('Too large');
      result = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid shape');
    } catch {
      if (signal.aborted) throw new GatewayError('PROVIDER_TIMEOUT', '识别超时。请求可能已计费，请核对后手动重试。', 504);
      throw new GatewayError('PROVIDER_BAD_RESPONSE', '识别服务返回了无效内容。', 502);
    }
    // Mathpix can return a recognition error with HTTP 200. Never expose its text (may contain input).
    if (result.error_info || result.error) {
      const id = typeof result.error_info === 'object' && result.error_info !== null ? (result.error_info as { id?: unknown }).id : undefined;
      if (id === 'image_no_content') throw new GatewayError('NO_CONTENT', '选区没有可识别的公式，请重新圈选。', 422);
      if (id === 'math_confidence') throw new GatewayError('LOW_CONFIDENCE', '识别服务无法可靠识别该选区，请调整笔迹或范围。', 422);
      throw new GatewayError('RECOGNITION_FAILED', '识别失败，请调整选区后手动重试。', 422);
    }
    const data = Array.isArray(result.data) ? result.data as { type?: string; value?: unknown }[] : [];
    const formulas = data.filter(item => item?.type === 'latex' && typeof item.value === 'string').map(item => item.value as string);
    let latex = typeof result.latex_styled === 'string' ? result.latex_styled.trim() : '';
    if (!latex && formulas.length === 1) latex = formulas[0].trim();
    if (!latex && formulas.length > 1) latex = `\\begin{gathered}${formulas.join(' \\\\ ')}\\end{gathered}`;
    // text is Mathpix Markdown. Accept only one whole math expression; never treat prose as LaTeX.
    if (!latex && typeof result.text === 'string') {
      const match = result.text.trim().match(/^(?:\\\[([\s\S]+)\\\]|\\\(([\s\S]+)\\\)|\$\$([\s\S]+)\$\$|\$([^$]+)\$)$/);
      latex = match ? (match[1] || match[2] || match[3] || match[4]).trim() : '';
    }
    if (!latex || latex.length > 50_000) throw new GatewayError('NO_FORMULA', '选区未返回可编辑的公式，请缩小到公式范围。', 422);
    const confidence = typeof result.confidence === 'number' && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : undefined;
    return { latex, ...(confidence === undefined ? {} : { confidence }) };
  }
}
