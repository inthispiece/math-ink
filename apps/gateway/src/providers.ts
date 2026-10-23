import { GatewayError } from './types.ts';
import type { RecognitionProvider } from './types.ts';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const candidate = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const confidenceValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
const gather = (formulas: string[]) => formulas.length === 1 ? formulas[0] : formulas.length ? `\\begin{gathered}${formulas.join(' \\\\ ')}\\end{gathered}` : '';

function dataFormulas(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(record).filter(item => item.type === 'latex').map(item => candidate(item.value)).filter(Boolean) : [];
}

/** Extract only complete math blocks. Do not interpret prose, evaluate, or rewrite notation. */
function markdownMath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const blocks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text[offset])) offset++;
    if (offset === text.length) break;
    const delimiters = [['\\[', '\\]'], ['\\(', '\\)'], ['$$', '$$'], ['$', '$']].find(([open]) => text.startsWith(open, offset));
    if (!delimiters) return '';
    const [open, close] = delimiters;
    const begin = offset + open.length;
    let end = text.indexOf(close, begin);
    while (end >= 0) {
      let precedingSlashes = 0;
      for (let index = end - 1; index >= begin && text[index] === '\\'; index--) precedingSlashes++;
      if (precedingSlashes % 2 === 0) break;
      end = text.indexOf(close, end + close.length);
    }
    if (end < 0) return '';
    const math = text.slice(begin, end).trim();
    if (!math) return '';
    blocks.push(math);
    offset = end + close.length;
  }
  return gather(blocks);
}

function lineFormulas(value: unknown) {
  if (!Array.isArray(value)) return [];
  // Container rows and their children must not duplicate one another. Snippet line order is retained.
  const lines = value.filter(record).filter(line => (line.type === undefined || line.type === 'math' || line.type === 'text') && (!line.error_id || line.error_id === 'math_confidence') && (line.conversion_output !== false || line.error_id === 'math_confidence'));
  const candidates = lines.map(line => {
    const textMath = markdownMath(line.text);
    if (candidate(line.text) && !textMath) throw new GatewayError('NO_FORMULA', '选区含有未能完整转写的内容，请缩小到公式范围或手动输入 LaTeX。', 422);
    return { line, latex: textMath || gather(dataFormulas(line.data)), uncertain: line.error_id === 'math_confidence', confidence: confidenceValue(line.confidence) };
  }).filter(item => item.latex);
  const byId = new Map(candidates.filter(item => typeof item.line.id === 'string').map(item => [item.line.id as string, item]));
  return candidates.filter(item => {
    const ancestors: typeof candidates = [];
    const seen = new Set([item]);
    let current = item;
    while (typeof current.line.parent_id === 'string') {
      const parent = byId.get(current.line.parent_id);
      if (!parent || !parent.latex.includes(current.latex)) break;
      // Keep both candidates if inconsistent IDs form a cycle; do not silently discard content.
      if (seen.has(parent)) return true;
      seen.add(parent);
      ancestors.push(parent);
      current = parent;
    }
    // A parent ID alone says nothing about whether its candidate includes the uncertain child.
    // Only remove literal containment, carrying the child's uncertainty to the retained parent.
    for (const parent of ancestors) {
      parent.uncertain ||= item.uncertain;
      if (item.confidence !== undefined) parent.confidence = parent.confidence === undefined ? item.confidence : Math.min(parent.confidence, item.confidence);
    }
    return ancestors.length === 0;
  });
}

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
          include_line_data: true,
          // Return uncertain candidates for the mandatory comparison/edit step, not automatic acceptance.
          confidence_threshold: 0,
          confidence_rate_threshold: 0,
          rm_fonts: false,
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
    // Mathpix can return a recognition error with HTTP 200. Never expose error text (may contain input).
    const errorId = record(result.error_info) ? result.error_info.id : undefined;
    if (result.error_info || result.error) {
      if (errorId === 'image_no_content') throw new GatewayError('NO_CONTENT', '选区没有可识别的公式，请重新圈选。', 422);
      if (errorId !== 'math_confidence') throw new GatewayError('RECOGNITION_FAILED', '识别失败，请调整选区后手动重试。', 422);
    }
    let latex = candidate(result.latex_styled);
    const textMath = markdownMath(result.text);
    if (!latex && candidate(result.text) && !textMath) throw new GatewayError('NO_FORMULA', '选区含有未能完整转写的内容，请缩小到公式范围或手动输入 LaTeX。', 422);
    const lines = latex ? [] : lineFormulas(result.line_data);
    let usedLines = false;
    // A complete styled equation preserves matrices/alignment best. Otherwise retain low-confidence
    // lines that Mathpix may omit from its top-level text/data rather than silently dropping them.
    if (!latex && lines.some(item => item.uncertain)) {
      latex = gather(lines.map(item => item.latex));
      usedLines = true;
    }
    if (!latex) latex = textMath || gather(dataFormulas(result.data));
    if (!latex && lines.length) { latex = gather(lines.map(item => item.latex)); usedLines = true; }
    if (!latex && errorId === 'math_confidence') throw new GatewayError('LOW_CONFIDENCE', '识别服务无法可靠识别该选区，请调整笔迹或范围。', 422);
    if (!latex || latex.length > 50_000) throw new GatewayError('NO_FORMULA', '选区未返回可编辑的公式，请缩小到公式范围。', 422);
    const scores = [confidenceValue(result.confidence), ...(usedLines ? lines.map(item => item.confidence) : [])].filter((value): value is number => value !== undefined);
    const confidence = scores.length ? Math.min(...scores) : undefined;
    // An explicit vendor warning remains meaningful even when its numeric score is absent/high.
    const reviewRequired = errorId === 'math_confidence' || (Array.isArray(result.line_data) && result.line_data.some(line => record(line) && line.error_id === 'math_confidence'));
    return { latex, ...(confidence === undefined ? {} : { confidence }), ...(reviewRequired ? { reviewRequired: true as const } : {}) };
  }
}
