import { requestJson } from './recognition-request';
import { newId, type ModelProvider } from './model';

export interface ReviewServiceStatus {
  provider: string; configured: boolean; simulated: boolean; local?: boolean;
  capabilities?: { transcribe: boolean; review: boolean }; requestTimeoutMs?: number;
}
interface Snapshot { noteId: string; sourceRevision: number; provider: ModelProvider; latex: string; context: string; gateway: string; token: string; installationId: string }
interface ReviewResult { originalLatex: string; review: { summary: string; issues: string[]; suggestedLatex: string | null } }
interface Request { snapshot: Snapshot; requestId: string }
interface ReviewOptions {
  parent: HTMLElement; state: () => Omit<Snapshot, 'context'>;
  status: (signal: AbortSignal) => Promise<ReviewServiceStatus>;
  adopt: (latex: string) => void; changed: () => void; available: () => boolean;
}
export class FormulaReview {
  private active: AbortController | null = null;
  private sequence = 0;
  private retry: Request | null = null;
  private approved: Request | null = null;
  private suggestion: { request: Request; latex: string } | null = null;
  private status: ReviewServiceStatus | null = null;
  private box: HTMLElement;
  private dialog: HTMLDialogElement;
  private options: ReviewOptions;
  constructor(options: ReviewOptions) {
    this.options = options;
    this.box = document.createElement('section'); this.box.className = 'formula-review';
    this.box.innerHTML = '<h3>检查公式</h3><p>转写保留原式。检查会单独分析当前 LaTeX 与你填写的条件，结果仅供核对。</p><label for="review-context">补充条件（可选，不会自动读取笔记）</label><textarea id="review-context" rows="2" maxlength="4000" placeholder="如：p > 1，函数定义域…"></textarea><div class="review-actions"><button id="review-formula" type="button" class="button secondary" disabled>检查公式</button><button id="review-cancel" type="button" class="link-button" hidden>取消检查</button><button id="review-retry" type="button" class="link-button" hidden>手动重试检查</button></div><p id="review-status" role="status">填写 LaTeX 后可单独检查。</p><div id="review-result" hidden><label>本次原式</label><pre id="review-original"></pre><p id="review-summary"></p><ul id="review-issues"></ul><label>建议（不会自动采用）</label><pre id="review-suggestion"></pre><button id="apply-review" type="button" class="button secondary" disabled>采用建议到编辑框</button></div>';
    const confirmation = options.parent.querySelector('.confirmation-actions');
    if (confirmation) confirmation.before(this.box); else options.parent.append(this.box);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'review-consent-dialog';
    this.dialog.innerHTML = '<h2>单独检查当前公式？</h2><p id="review-consent-description"></p><p>仅发送下面的 LaTeX 和你手动填写的补充条件，不发送图片或笔记正文。检查与转写分别计入云服务额度。</p><pre id="review-consent-payload"></pre><div class="dialog-actions"><button id="review-consent-refuse" type="button" class="button secondary">暂不检查</button><button id="review-consent-allow" type="button" class="button primary">同意发送公式并检查</button></div>';
    document.body.append(this.dialog);
    this.el<HTMLButtonElement>('review-formula').onclick = () => void this.start();
    this.el<HTMLButtonElement>('review-retry').onclick = () => void this.start(true);
    this.el<HTMLButtonElement>('review-cancel').onclick = () => this.invalidate('已取消检查，原式和转写结果仍保留');
    this.el<HTMLTextAreaElement>('review-context').oninput = () => this.invalidate('补充条件已改变，请重新检查');
    this.el<HTMLButtonElement>('review-consent-refuse').onclick = () => { this.approved = null; this.dialog.close(); this.el('review-status').textContent = '未发送公式，可继续编辑。'; };
    this.el<HTMLButtonElement>('review-consent-allow').onclick = () => { const request = this.approved; this.approved = null; this.dialog.close(); if (request && this.matches(request.snapshot)) void this.launch(request, true); };
    this.dialog.addEventListener('cancel', () => { this.approved = null; });
    this.el<HTMLButtonElement>('apply-review').onclick = () => {
      const suggestion = this.suggestion;
      if (!suggestion || !this.matches(suggestion.request.snapshot)) { this.invalidate('原式已改变，请重新检查'); return; }
      this.options.adopt(suggestion.latex);
      this.invalidate('建议已放入编辑框；核对后再点击“确认并整理”保存。');
    };
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
  private snapshot(): Snapshot { return { ...this.options.state(), context: this.el<HTMLTextAreaElement>('review-context').value.trim() }; }
  private matches(snapshot: Snapshot) { return JSON.stringify(snapshot) === JSON.stringify(this.snapshot()); }
  update(status?: ReviewServiceStatus) {
    if (status) this.status = status;
    const state = this.options.state();
    this.el<HTMLButtonElement>('review-formula').disabled = Boolean(this.active) || !this.options.available() || !state.latex.trim();
  }
  invalidate(message = '公式或笔记已改变，请重新检查', clearContext = false) {
    ++this.sequence; this.active?.abort(); this.active = null; this.retry = null; this.approved = null; this.suggestion = null;
    this.dialog.close(); this.el('review-result').hidden = true; this.el('review-retry').hidden = true; this.el('review-cancel').hidden = true;
    this.el<HTMLButtonElement>('apply-review').disabled = true; this.el('review-status').textContent = message;
    if (clearContext) this.el<HTMLTextAreaElement>('review-context').value = '';
    this.update();
  }
  private async start(retry = false) {
    if (this.active) return;
    const snapshot = this.snapshot();
    if (!snapshot.latex.trim()) return;
    if (snapshot.context.length > 4000) { this.el('review-status').textContent = '补充条件最多 4000 字符'; return; }
    const request = { snapshot: retry && this.retry && this.matches(this.retry.snapshot) ? this.retry.snapshot : snapshot, requestId: newId() };
    await this.launch(request, false);
  }
  private async launch(request: Request, cloudApproved: boolean) {
    if (this.active || !this.matches(request.snapshot)) return;
    const controller = new AbortController(); this.active = controller; const sequence = ++this.sequence;
    this.retry = request; this.suggestion = null; this.el('review-result').hidden = true; this.el('review-retry').hidden = true; this.el('review-cancel').hidden = false;
    this.el('review-status').textContent = '正在检查模型配置…'; this.update();
    const current = () => this.active === controller && sequence === this.sequence && this.matches(request.snapshot);
    try {
      const status = await this.options.status(controller.signal);
      if (!current()) return;
      this.status = status;
      if (status.provider !== request.snapshot.provider) throw new Error('服务返回了其他后端的配置，请检查连接后重试。');
      if (status.simulated || !status.configured) throw new Error('当前模型尚未配置，无法检查公式；原式仍保留。');
      if (status.capabilities?.review === false || status.provider === 'mathpix') throw new Error('当前后端仅支持转写。请选择 DeepSeek 或本地 Qwen 检查公式。');
      if (!(status.local ?? status.provider === 'ollama') && !cloudApproved) {
        this.approved = request;
        this.el('review-consent-description').textContent = `将公式文本发送给 ${status.provider} 云服务进行独立检查。`;
        this.el('review-consent-payload').textContent = `${request.snapshot.latex}${request.snapshot.context ? `\n\n补充条件：${request.snapshot.context}` : ''}`;
        this.dialog.showModal(); return;
      }
      this.el('review-status').textContent = '正在检查公式，可取消；不会自动替换原式…';
      const { snapshot } = request;
      const { response, data } = await requestJson<ReviewResult & { status?: string; provider?: string; simulated?: boolean; error?: { message?: string } }>(`${snapshot.gateway.replace(/\/$/, '')}/v1/review`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(snapshot.token ? { Authorization: `Bearer ${snapshot.token}` } : {}) },
        body: JSON.stringify({ clientRequestId: request.requestId, installationId: snapshot.installationId, provider: snapshot.provider, sourceRevision: snapshot.sourceRevision, latex: snapshot.latex, ...(snapshot.context ? { context: snapshot.context } : {}) }),
      }, { timeoutMs: Math.min(300000, Math.max(1000, status.requestTimeoutMs ?? 30000)) + 5000 });
      if (!current()) return;
      if (!response.ok || data?.status !== 'ok') throw new Error(data?.error?.message || `检查失败（HTTP ${response.status}）`);
      if (data.simulated !== false || data.provider !== snapshot.provider || data.originalLatex !== snapshot.latex || !data.review || typeof data.review.summary !== 'string' || !Array.isArray(data.review.issues) || !data.review.issues.every(issue => typeof issue === 'string') || !(data.review.suggestedLatex === null || typeof data.review.suggestedLatex === 'string')) throw new Error('检查结果无效或来自其他后端，原式仍保留，请手动重试。');
      this.el('review-original').textContent = snapshot.latex; this.el('review-summary').textContent = data.review.summary;
      this.el('review-issues').replaceChildren(...data.review.issues.map(issue => { const li = document.createElement('li'); li.textContent = issue; return li; }));
      this.el('review-suggestion').textContent = data.review.suggestedLatex || '没有建议替换的公式。';
      this.suggestion = data.review.suggestedLatex?.trim() ? { request, latex: data.review.suggestedLatex } : null;
      this.el<HTMLButtonElement>('apply-review').disabled = !this.suggestion;
      this.el('review-result').hidden = false; this.el('review-status').textContent = '检查完成。建议尚未应用，仍需人工核对。';
    } catch (error) {
      if (!current()) return;
      this.el('review-status').textContent = `${error instanceof Error ? error.message : '检查失败'} 原式与转写结果已保留；不会自动重试。`;
      this.el('review-retry').textContent = (this.status?.local ?? request.snapshot.provider === 'ollama') ? '重新检查（本地）' : '重新检查（可能再次计费）'; this.el('review-retry').hidden = false;
    } finally {
      if (this.active === controller) { this.active = null; this.el('review-cancel').hidden = true; this.update(); this.options.changed(); }
    }
  }
}
