import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, characterErrorRate, normalizeFormula, validateManifest, wordErrorRate } from '../apps/gateway/src/evaluation.ts';
import { decodePngBase64 } from '../apps/gateway/src/png.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '.local');
const flag = (args, name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const inside = (base, path) => { const rel = relative(base, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
function privatePath(path) { const result = resolve(root, path); if (!inside(privateRoot, result)) throw new Error('评测清单、输出和人工核对必须保存在本项目 .local 中，避免误提交私人笔记'); return result; }
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
async function atomicJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path); }
function gatewayAddress() { const url = new URL(process.env.EVAL_GATEWAY_URL || 'http://127.0.0.1:8787'); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('EVAL_GATEWAY_URL 必须为不含凭据的 HTTPS 或本机回环 HTTP 来源地址'); return url.origin; }
async function request(base, path, body, timeoutMs = 15000) { const token = process.env.EVAL_GATEWAY_TOKEN || ''; const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); if (Buffer.byteLength(text) > 500_000) throw new Error('评测接口响应过大，结果标记未知'); let data; try { data = JSON.parse(text); } catch { throw new Error(`网关返回非 JSON（HTTP ${response.status}），结果未知`); } return { ok: response.ok, status: response.status, data }; }
export function chargeForRecord(record) { return record.status === 'ok' && record.cost?.status === 'estimated' && typeof record.cost.amount === 'number' && Number.isFinite(record.cost.amount) && record.cost.amount >= 0 ? record.cost.amount : record.reservedCny; }
export function canReserve(records, reserve, budget) { const held = records.reduce((total, record) => total + chargeForRecord(record), 0); return Number.isFinite(reserve) && reserve > 0 && held + reserve <= budget + 1e-9; }
async function readManifest(path, verifyImages = true) { const manifest = validateManifest(await json(path)); if (verifyImages) for (const sample of manifest.samples) if (sample.imagePath) { if (/^https?:/i.test(sample.imagePath)) throw new Error('样本图片只能来自本机文件，不接受远程图片地址'); const image = resolve(dirname(path), sample.imagePath), info = await stat(image); if (!info.isFile() || info.size > 1_400_000 || info.size < 8) throw new Error('样本图片不存在或超过网关 1.4 MB 上限，请预处理并保留原件'); const bytes = await readFile(image); decodePngBase64(bytes.toString('base64'), 1_400_000); } return manifest; }
async function initialize(directory) { const dir = privatePath(directory); await mkdir(dir, { recursive: true }); const writeNew = async (name, value) => { try { await writeFile(resolve(dir, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }; await writeNew('manifest.json', { version: 1, samples: [] }); await writeNew('assessments.json', []); await writeNew('checks-manifest.json', await json(resolve(root, 'evaluation/checks.json'))); console.log('私人评测目录已准备。manifest.json 尚无真实页面；checks-manifest.json 为 40 道待人工核对的候选题，不代表模型成绩。'); }
async function run(args, manifestPath, manifest) {
  if (!args.includes('--allow-paid')) throw new Error('未提交请求：真实云端试验必须显式指定 --allow-paid --budget-cny 金额；调用可能计费');
  const budget = Number(flag(args, '--budget-cny', NaN)), limit = Number(flag(args, '--limit', 3));
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('必须设置正的 --budget-cny；--limit 需为 1–100，默认只提交 3 个样本');
  const runPath = privatePath(flag(args, '--run-file', '.local/evaluation/run.json'));
  // A private exclusive lock prevents two evaluators spending the same local budget concurrently.
  await mkdir(dirname(runPath), { recursive: true }); let lock; try { lock = await open(`${runPath}.lock`, 'wx', 0o600); } catch { throw new Error('已有评测正在使用此运行文件；异常退出后请核对未知任务，再手工删除对应 .lock 文件'); }
  try {
    let state; try { state = await json(runPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const manifestFingerprint = digest(JSON.stringify(manifest));
    if (state && (state.version !== 1 || state.manifestFingerprint !== manifestFingerprint || !Array.isArray(state.records))) throw new Error('运行文件与样本清单不匹配，禁止复用预算和请求标识；请显式换一个 --run-file');
    if (state && state.budgetCny !== budget) throw new Error('恢复时必须沿用原 --budget-cny；扩大预算请审核记录后使用新运行文件');
    const base = gatewayAddress(); const status = await request(base, '/v1/status?provider=deepseek');
    if (!status.ok || status.data.provider !== 'deepseek' || status.data.simulated !== false || status.data.configured !== true) throw new Error('DeepSeek 网关尚未正确配置或未通过授权，本次未提交任何生成。请先在服务器配置密钥和评测访问令牌');
    const reserve = Number(status.data.taskLimits?.maxCostCny);
    if (!Number.isFinite(reserve) || reserve <= 0) throw new Error('网关未报告保守单任务费用上界，禁止付费评测；请更新网关');
    const promptVersion = { tasks: 'mathink-pages-2026-10-24-v1', implementationSha256: digest(await readFile(resolve(root, 'apps/gateway/src/ai-providers.ts'))), taskImplementationSha256: digest(await readFile(resolve(root, 'apps/gateway/src/tasks.ts'))) };
    state ??= { version: 1, createdAt: new Date().toISOString(), installationId: `evaluation-${randomUUID()}`, manifestFingerprint, model: status.data.model || null, provider: 'deepseek', promptVersion, budgetCny: budget, records: [] };
    if (state.model !== status.data.model || JSON.stringify(state.promptVersion) !== JSON.stringify(promptVersion)) throw new Error('模型或提示词已改变，必须创建新运行文件，以免不同配置混入同一评测');
    await atomicJson(runPath, state);
    let submitted = 0;
    for (const sample of manifest.samples) {
      if (state.records.some(record => record.sampleId === sample.id)) continue;
      if (submitted >= limit) break;
      if (!canReserve(state.records, reserve, budget)) { console.log('达到试验预算保护，后续生成已停止；未知费用继续占用预留额。'); break; }
      if (sample.kind === 'page' && status.data.taskCapabilities?.['page-transcribe'] !== true) throw new Error('服务端没有开放整页转写，此运行未调用替代供应商');
      const clientRequestId = `eval-${randomUUID()}`;
      let payload = { clientRequestId, installationId: state.installationId, provider: 'deepseek', sourceRevision: 0 };
      let path;
      if (sample.kind === 'review') { path = '/v1/review'; payload = { ...payload, latex: sample.latex, ...(sample.context ? { context: sample.context } : {}) }; }
      else { const imageBase64 = (await readFile(resolve(dirname(manifestPath), sample.imagePath))).toString('base64'); if (sample.kind === 'formula') { path = '/v1/recognize'; payload = { ...payload, imageBase64 }; } else { path = '/v1/tasks'; payload = { ...payload, type: 'page-transcribe', input: { noteId: `eval-${sample.id}`, pageId: 'evaluation-page', contentRevision: 0, imageBase64 } }; } }
      const record = { sampleId: sample.id, kind: sample.kind, split: sample.split, clientRequestId, status: 'pending', reservedCny: reserve, submittedAt: new Date().toISOString(), model: state.model, provider: 'deepseek', promptVersion };
      state.records.push(record); await atomicJson(runPath, state); // Must exist on disk before the first paid POST.
      submitted++; const started = Date.now();
      try {
        let reply = await request(base, path, payload, Math.max(15000, Math.min(Number(status.data.requestTimeoutMs) + 10000 || 60000, 310000)));
        if (sample.kind === 'page' && reply.ok && reply.data.taskId) { record.taskId = reply.data.taskId; await atomicJson(runPath, state); const deadline = Date.now() + Math.min(Number(status.data.taskLimits?.timeoutMs) || 120000, 300000) + 20000; while (['pending', 'running'].includes(reply.data.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1000)); reply = await request(base, `/v1/tasks/${encodeURIComponent(record.taskId)}?installationId=${encodeURIComponent(state.installationId)}`); if (!reply.ok) break; } }
        if (reply.data.provider !== 'deepseek' || sample.kind !== 'page' && reply.data.simulated !== false) throw new Error('供应商或模拟状态不匹配，输出未计为成功');
        record.status = reply.data.status === 'ok' ? 'ok' : reply.data.status === 'error' ? 'error' : 'unknown';
        record.output = reply.data; record.usage = reply.data.usage || { status: 'unknown' }; record.cost = reply.data.cost || { status: 'unknown', amount: null, reserved: reserve };
      } catch { record.status = 'unknown'; record.error = '请求未取得可信的完整结果；可能已计费，不自动重新提交。请保留 clientRequestId，核对网关和供应商账单'; record.cost = { status: 'unknown', amount: null, reserved: reserve }; }
      record.elapsedMs = Date.now() - started; await atomicJson(runPath, state); console.log(`已记录 ${submitted}/${limit} 次本轮尝试；状态 ${record.status}，正文仅保存在 .local。`);
    }
    console.log(`评测运行已保存；共 ${state.records.length} 条，未决 ${state.records.filter(r => ['pending', 'unknown'].includes(r.status)).length} 条。重复 run 只处理尚未提交的样本，不自动重试旧请求。`);
  } finally { await lock.close(); const { unlink } = await import('node:fs/promises'); await unlink(`${runPath}.lock`); }
}
function outputText(record) { const output = record.output; if (!output) return ''; if (typeof output.latex === 'string') return output.latex; if (Array.isArray(output.result?.blocks)) return output.result.blocks.map(block => (block.segments || []).filter(segment => segment.type === 'text').map(segment => segment.text).join('')).join('\n'); return ''; }
async function report(args, manifest) { const runPath = privatePath(flag(args, '--run-file', '.local/evaluation/run.json')); const state = await json(runPath); if (state.manifestFingerprint !== digest(JSON.stringify(manifest))) throw new Error('报告清单与运行文件不匹配'); const assessmentPath = privatePath(flag(args, '--assessments', '.local/evaluation/assessments.json')); let assessments = []; try { assessments = await json(assessmentPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (!Array.isArray(assessments) || new Set(assessments.map(a => a.sampleId)).size !== assessments.length) throw new Error('人工记录无效或同一样本有重复评审'); const measured = assess(state.records, manifest, assessments); const verified = new Set(manifest.samples.filter(s => s.humanVerified && s.split === 'acceptance').map(s => s.id)); const textMetrics = state.records.filter(r => r.status === 'ok').map(record => { const sample = manifest.samples.find(s => s.id === record.sampleId), text = outputText(record); return { sampleId: record.sampleId, eligibleForAcceptance: verified.has(record.sampleId), chinese: sample.expected?.chinese ? characterErrorRate(sample.expected.chinese.replace(/[^\p{Script=Han}]/gu, ''), text.replace(/[^\p{Script=Han}]/gu, '')) : null, english: sample.expected?.english ? wordErrorRate(sample.expected.english, text) : null, formulaFormattingMatch: sample.expected?.latex ? normalizeFormula(sample.expected.latex) === normalizeFormula(text) : null, mathematicalCorrectness: 'unknown-until-human-reviewed' }; }); const result = { ...measured, model: state.model, provider: state.provider, promptVersion: state.promptVersion, localBudgetCny: state.budgetCny, reservedOrEstimatedCny: state.records.reduce((n, r) => n + chargeForRecord(r), 0), textMetrics, humanAssessments: assessments, missingRealPageSamples: manifest.samples.filter(s => s.kind === 'page').length === 0, warning: '候选检查题不是人工验收集；公式格式相等不代表数学正确。缺少真实调用、人工核对或账单均为未知。' }; const destination = privatePath(flag(args, '--output', '.local/evaluation/report.json')); await atomicJson(destination, result); console.log('本机评测报告已生成，缺少人工验收的数据标为未知；未上传样本或结果。'); }
export async function main(args = process.argv.slice(2)) { const command = args[0] || 'help'; if (command === 'help' || args.includes('--help')) { console.log('node scripts/eval-ai.mjs init|validate|run|report [--manifest .local/evaluation/manifest.json]\nrun 必须指定 --allow-paid --budget-cny 金额 [--limit 3]，旧 pending/unknown 不自动重试。\nEVAL_GATEWAY_URL/EVAL_GATEWAY_TOKEN 仅从环境读取。参见 evaluation/README.md。'); return; } if (command === 'init') return initialize(flag(args, '--directory', '.local/evaluation')); const manifestPath = privatePath(flag(args, '--manifest', '.local/evaluation/manifest.json')), manifest = await readManifest(manifestPath, command === 'run' || command === 'validate'); if (command === 'validate') { console.log(`清单通过分组和格式校验：${manifest.samples.length} 个样本；人工已核对 ${manifest.samples.filter(s => s.humanVerified).length} 个。未调用模型。`); return; } if (command === 'run') return run(args, manifestPath, manifest); if (command === 'report') return report(args, manifest); throw new Error('未知评测命令，请使用 --help'); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error && /^(?:未提交|必须|恢复|运行文件|模型|达到|样本|评测|网关|DeepSeek|服务端|已有|人工|报告|未知)/.test(error.message) ? error.message : '评测无法完成。请检查本机文件、网关连接和配置；未在日志输出密钥或响应正文。'); process.exitCode = 1; });
