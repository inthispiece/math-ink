import test from 'node:test';
import assert from 'node:assert/strict';
import { MathpixProvider } from '../src/providers.ts';
import { GatewayError } from '../src/types.ts';

// These are synthetic API contract fixtures, not OCR samples or recognition accuracy measurements.
async function transcribe(payload: unknown) {
  const provider = new MathpixProvider({ appId: 'fixture-id', appKey: 'fixture-key', fetcher: (async () => new Response(JSON.stringify(payload))) as typeof fetch });
  return provider.recognize(Buffer.from('fixture-image-not-uploaded'), new AbortController().signal);
}

const indefiniteIntegral = String.raw`\int x^{2}\,\mathrm{d}x`;
const holderNorm = String.raw`\|f\|_{C^{k,\alpha}(\overline{\Omega})}=\sum_{|\beta|\leq k}\sup_{x\in\Omega}|D^{\beta}f(x)|+\sum_{|\beta|=k}\sup_{x\ne y}\frac{|D^{\beta}f(x)-D^{\beta}f(y)|}{|x-y|^{\alpha}}`;
const holderInequality = String.raw`\lVert f\rVert_{L^p}\lVert g\rVert_{L^q}\geq\lVert fg\rVert_{L^1}`;
const matrix = String.raw`\begin{pmatrix}a_{11}&a_{12}\\a_{21}&a_{22}\end{pmatrix}`;
const multiline = String.raw`\begin{aligned}\int f(x)\,dx&=F(x)+C\\F'(x)&=f(x)\end{aligned}`;

test('Mathpix candidates retain indefinite integrals, Holder norms, matrices, and multiline notation exactly', async () => {
  for (const latex of [indefiniteIntegral, holderNorm, holderInequality, matrix, multiline]) {
    assert.deepEqual(await transcribe({ latex_styled: ` ${latex} `, confidence: 0.91 }), { latex, confidence: 0.91 });
    assert.equal((await transcribe({ text: `\\[${latex}\\]` })).latex, latex);
    assert.equal((await transcribe({ data: [{ type: 'latex', value: latex }] })).latex, latex);
  }
  assert.equal((await transcribe({ latex_styled: indefiniteIntegral })).latex.includes('_0^1'), false);
  assert.equal((await transcribe({ latex_styled: indefiniteIntegral })).latex.includes('='), false);
  assert.equal((await transcribe({ latex_styled: holderInequality })).latex.includes('\\leq'), false);
});

test('separate display/inline math blocks preserve order without leaking delimiter markup into LaTeX', async () => {
  for (const text of [String.raw`\[x_{i}^{2}\]
\[\int f(x)\,dx\]`, String.raw`$$x_{i}^{2}$$
$$\int f(x)\,dx$$`, String.raw`\(x_{i}^{2}\) \(\int f(x)\,dx\)`]) {
    assert.equal((await transcribe({ text })).latex, String.raw`\begin{gathered}x_{i}^{2} \\ \int f(x)\,dx\end{gathered}`);
  }
  assert.equal((await transcribe({ text: String.raw`$\text{price: \$2}$` })).latex, String.raw`\text{price: \$2}`);
  for (const text of [String.raw`before \[x\]`, String.raw`\[x\] after`, String.raw`\[x`, '$$', String.raw`\[x\] + \[y\]`]) {
    await assert.rejects(transcribe({ text }), error => error instanceof GatewayError && error.code === 'NO_FORMULA');
  }
});

test('complete structured equation has priority over fragmented data/line alternatives', async () => {
  assert.equal((await transcribe({ latex_styled: matrix, data: [{ type: 'latex', value: 'a_{11}' }], line_data: [{ type: 'math', error_id: 'math_confidence', conversion_output: false, text: '\\(a_{11}\\)' }] })).latex, matrix);
});

test('line data restores math omitted for low confidence while retaining candidates for comparison', async () => {
  const result = await transcribe({ text: String.raw`\[a_{i}=b_{i}\]`, confidence: 0.99, line_data: [
    { id: 'first', type: 'math', conversion_output: true, text: String.raw`\[a_{i}=b_{i}\]`, confidence: 0.98 },
    { id: 'second', type: 'math', conversion_output: false, error_id: 'math_confidence', data: [{ type: 'latex', value: indefiniteIntegral }], confidence: 0.34 },
    { id: 'number', type: 'equation_number', conversion_output: false, text: '(2)' },
  ] });
  assert.deepEqual(result, { latex: String.raw`\begin{gathered}a_{i}=b_{i} \\ \int x^{2}\,\mathrm{d}x\end{gathered}`, confidence: 0.34, reviewRequired: true });
  assert.deepEqual(await transcribe({ error: 'PRIVATE_INPUT', error_info: { id: 'math_confidence', message: 'PRIVATE_INPUT' }, latex_styled: holderNorm, confidence: 0.23 }), { latex: holderNorm, confidence: 0.23, reviewRequired: true });
});

test('line-only candidates work without duplicating parent and child math', async () => {
  assert.equal((await transcribe({ line_data: [
    { id: 'parent', type: 'math', data: [{ type: 'latex', value: matrix }] },
    { id: 'child', parent_id: 'parent', type: 'math', data: [{ type: 'latex', value: 'a_{11}' }] },
  ] })).latex, matrix);
  assert.equal((await transcribe({ line_data: [{ type: 'math', text: `\\[${multiline}\\]`, confidence: 0.42 }] })).latex, multiline);
});

test('fragmented math data never silently drops operators or prose from the same result', async () => {
  const fragments = [{ type: 'latex', value: 'a' }, { type: 'latex', value: 'b' }];
  for (const text of [String.raw`\(a\) + \(b\)`, String.raw`\(a\) \geq \(b\)`, String.raw`compare \(a\) with \(b\)`]) {
    await assert.rejects(transcribe({ text, data: fragments }), error => error instanceof GatewayError && error.code === 'NO_FORMULA');
    await assert.rejects(transcribe({ line_data: [{ type: 'math', text, data: fragments }] }), error => error instanceof GatewayError && error.code === 'NO_FORMULA');
  }
});

test('a parent candidate cannot hide a different low-confidence child and retains child uncertainty when contained', async () => {
  const child = { id: 'child', parent_id: 'parent', type: 'math', conversion_output: false, error_id: 'math_confidence', data: [{ type: 'latex', value: 'c=d' }], confidence: 0.3 };
  assert.deepEqual(await transcribe({ text: String.raw`\[a=b\]`, confidence: 0.99, line_data: [
    { id: 'parent', type: 'math', data: [{ type: 'latex', value: 'a=b' }], confidence: 0.99 }, child,
  ] }), { latex: String.raw`\begin{gathered}a=b \\ c=d\end{gathered}`, confidence: 0.3, reviewRequired: true });
  const whole = String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`;
  assert.deepEqual(await transcribe({ text: String.raw`\[a=b\]`, confidence: 0.99, line_data: [
    { id: 'parent', type: 'math', data: [{ type: 'latex', value: whole }], confidence: 0.99 },
    { ...child, data: [{ type: 'latex', value: 'c&=d' }] },
  ] }), { latex: whole, confidence: 0.3, reviewRequired: true });
});

test('explicit Mathpix uncertainty remains visible even without a score or despite a high aggregate score', async () => {
  for (const confidence of [undefined, 0.99]) {
    const score = confidence === undefined ? {} : { confidence };
    assert.deepEqual(await transcribe({ latex_styled: holderInequality, ...score, error_info: { id: 'math_confidence' } }), { latex: holderInequality, ...score, reviewRequired: true });
    assert.deepEqual(await transcribe({ latex_styled: matrix, ...score, line_data: [{ type: 'math', error_id: 'math_confidence' }] }), { latex: matrix, ...score, reviewRequired: true });
  }
  assert.deepEqual(await transcribe({ latex_styled: holderInequality }), { latex: holderInequality });
});

test('bad provider errors stay safe and confidence is never invented from missing or invalid values', async () => {
  for (const id of ['image_no_content', 'math_syntax', 'unknown_error']) {
    await assert.rejects(transcribe({ error_info: { id, message: 'PRIVATE_PROVIDER_BODY' }, latex_styled: 'PRIVATE_LATEX' }), error => error instanceof GatewayError && !error.message.includes('PRIVATE'));
  }
  await assert.rejects(transcribe({ error_info: { id: 'math_confidence', message: 'PRIVATE_INPUT' } }), error => error instanceof GatewayError && error.code === 'LOW_CONFIDENCE' && !error.message.includes('PRIVATE'));
  for (const confidence of [undefined, -0.1, 1.1, '0.5']) assert.deepEqual(await transcribe({ latex_styled: indefiniteIntegral, confidence }), { latex: indefiniteIntegral });
  await assert.rejects(transcribe({ latex_styled: 'x'.repeat(50_001) }), error => error instanceof GatewayError && error.code === 'NO_FORMULA');
});

test('Mathpix requests uncertain line candidates without enabling automatic mathematical rewriting', async () => {
  let calls = 0;
  const provider = new MathpixProvider({ appId: 'fixture-id', appKey: 'fixture-key', fetcher: (async (_url, options) => {
    calls++;
    const body = JSON.parse(options?.body as string);
    assert.deepEqual(body.formats, ['latex_styled', 'text', 'data']);
    assert.equal(body.include_line_data, true);
    assert.equal(body.confidence_threshold, 0);
    assert.equal(body.confidence_rate_threshold, 0);
    assert.equal(body.rm_fonts, false);
    assert.equal(body.metadata.improve_mathpix, false);
    return new Response(JSON.stringify({ latex_styled: indefiniteIntegral, confidence: 0.4 }));
  }) as typeof fetch });
  assert.deepEqual(await provider.recognize(Buffer.from('fixture'), new AbortController().signal), { latex: indefiniteIntegral, confidence: 0.4 });
  assert.equal(calls, 1);
});
