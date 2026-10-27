import { editDraftBlockText, splitDraftParagraph, mergeDraftParagraphs } from './draft-editing';
import katex from 'katex';
import './draft-editor.css';
import { newId, type Note } from './model';
import { getNote, updateNote } from './notebook-repository';
import { editDraft, markDraftReviewed, trashDraft, restoreDraft, permanentDeleteDraft, draftSourceState, type Draft, type Notebook } from './notebook-domain';
import { editableBlockText, formulaFor, record } from './draft-content';
import { ensurePageModel, orderedBlocks, orderedMarkdown, exportLatex, createParagraphBlock, createFormulaBlock, updateBlock, updateFormulaLatex, moveBlock, removeBlock, applySuggestion, applyCheckedSuggestions, rejectSuggestion, undoSuggestion, isSuggestionStale, type ContentBlock, type InlineRun, type BlockContent, type Suggestion } from './page-model';
import type { ResultSaveState,ReceivedResultPreview } from './draft-tasks.ts';

export type DraftTool = 'formula-check' | 'context-review' | 'organize' | 'knowledge-links' | 'proof-assist';
export interface DraftEditorOptions {
  notify: (message: string) => void;
  changed: (note: Notebook, draftId: string) => void;
  insertFormula: (noteId: string, draftId: string) => void | Promise<void>;
  insertPage: (noteId: string, draftId: string) => void | Promise<void>;
  showSource: (noteId: string, draftId: string) => void | Promise<void>;
  advanced: (noteId: string, draftId: string, tool?: DraftTool) => void | Promise<void>;
  query: (noteId: string, draftId: string) => void | Promise<void>;
  redo: (noteId: string, draftId: string) => void | Promise<void>;
  cancel: (noteId: string, draftId: string) => void | Promise<void>;
  hasUnsaved?: (noteId: string, draftId: string) => boolean;
  retrySaving?: (noteId: string, draftId: string) => void | Promise<void>;
  exportUnsaved?: (noteId: string, draftId: string) => void | Promise<void>;
  receivedResult?: (noteId:string,draftId:string) => ResultSaveState|undefined;
  adoptLink?: (noteId: string, draftId: string, index: number) => void | Promise<void>;
}
const labels: Record<string, string> = { formula: '公式', page: '整页', organization: '整理', review: '检查建议', links: '关联建议', proof: '证明辅助', pending: '等待处理', running: '正在处理', partial: '部分完成', completed: '已完成', failed: '处理失败', cancelled: '已取消', unknown: '状态未知', 'waiting-connection': '等待恢复连接', recognition: '识别疑点', language: '语言表达', mathematics: '数学问题', 'missing-condition': '缺少条件' };
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
const control = (text: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement => { const button = element('button', text, 'dd-button ' + className); button.type = 'button'; button.onclick = () => void Promise.resolve(action()).catch(() => {}); return button; };
function renderMath(target: HTMLElement, latex: string, display = true): void { try { katex.render(latex, target, { displayMode: display, throwOnError: true, trust: false, maxExpand: 1000, strict: 'ignore' }); } catch { target.textContent = latex; target.classList.add('dd-math-error'); } }
function download(name: string, value: string | Blob, type = 'text/plain;charset=utf-8') { const blob = typeof value === 'string' ? new Blob([value], { type }) : value; const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function timestamp(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }

/** A note-scoped durable draft editor. Closing never discards an unsaved edit. */
export class DraftEditor {
  private readonly options: DraftEditorOptions;
  private readonly dialog: HTMLDialogElement;
  private note: Notebook | null = null;
  private draft: Draft | null = null;
  private baseSignature = '';
  private baseVersion = 0;
  private baseReviewed = false;
  private checkedSuggestions = new Set<string>();
  private dirty = false;
  private serial = 0;
  private saving: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private loadSequence = 0;
  private saveError = '';
  private positions = new Map<string, { scroll: number; formulaOpen: boolean }>();
  constructor(options: DraftEditorOptions) {
    this.options = options; this.dialog = document.getElementById('draft-detail-dialog') as HTMLDialogElement || element('dialog');
    this.dialog.id = 'draft-detail-dialog'; this.dialog.className = 'draft-detail-dialog'; if (!this.dialog.parentElement) document.body.append(this.dialog);
    this.dialog.setAttribute('aria-label', '草稿详情');
    this.dialog.oncancel = event => { event.preventDefault(); void this.close().catch(error => this.options.notify(error.message)); };
  }
  async open(noteId: string, draftId: string): Promise<void> {
    if (this.dialog.open) { try { await this.flush(); } catch { return; } if (this.note?.id === noteId && this.draft?.id === draftId) return; }
    const sequence = ++this.loadSequence, note = await getNote(noteId), draft = note?.drafts.find(d => d.id === draftId);
    if (sequence !== this.loadSequence) return; if (!note || !draft) { this.options.notify('草稿不存在或已永久删除'); return; }
    if (this.note?.id !== noteId || this.draft?.id !== draftId) this.checkedSuggestions.clear();
    this.rememberPosition(); this.note = note; this.draft = structuredClone(draft); this.baseVersion = draft.version; this.baseReviewed = draft.reviewed; this.baseSignature = this.signature(); this.dirty = false; this.saveError = ''; this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.restorePosition();
    if (draft.unread) { const saved = await updateNote(noteId, latest => { const d = latest.drafts.find(d => d.id === draftId); if (d) d.unread = false; }, { allowDeleted: true, preserveEditedAt: true }); if (saved) this.options.changed(saved, draftId); }
  }
  async close(): Promise<void> { await this.flush(); this.rememberPosition(); this.loadSequence++; this.dialog.close(); }
  async refresh(noteId: string, draftId: string): Promise<void> {
    if (!this.dialog.open || this.note?.id !== noteId || this.draft?.id !== draftId) return;
    if (this.dirty || this.saving || this.dialog.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '')) { this.dialog.querySelector('#draft-task-state')?.replaceWith(this.taskState(this.note,this.draft)); return; }
    const note = await getNote(noteId), draft = note?.drafts.find(d => d.id === draftId); if (!note || !draft) { this.dialog.close(); return; }
    this.rememberPosition(); this.note = note; this.draft = structuredClone(draft); this.baseVersion = draft.version; this.baseReviewed = draft.reviewed; this.baseSignature = this.signature(); this.render();
  }
  private rememberPosition(): void { const key = this.dialog.dataset.draftKey; if (key) this.positions.set(key, { scroll: this.dialog.scrollTop, formulaOpen: this.dialog.querySelector<HTMLDetailsElement>('.dd-formula-edit')?.open || false }); }
  private restorePosition(): void { const value = this.positions.get(this.dialog.dataset.draftKey || ''); if (!value) return; const formula = this.dialog.querySelector<HTMLDetailsElement>('.dd-formula-edit'); if (formula) formula.open = value.formulaOpen; this.dialog.scrollTop = value.scroll; }
  private signature(): string { return JSON.stringify({ title: this.draft?.title, latex: this.draft?.latex, content: this.draft?.content }); }
  private changed(): void { if (!this.draft) return; this.serial++; this.dirty = this.signature() !== this.baseSignature; this.draft.reviewed = this.dirty ? false : this.baseReviewed; const reviewed = this.dialog.querySelector<HTMLInputElement>('#draft-reviewed'); if (reviewed) reviewed.checked = this.draft.reviewed; this.saveError = ''; clearTimeout(this.saveTimer); if (this.dirty) this.saveTimer = setTimeout(() => void this.flush().catch(() => {}), 450); this.updateSaveState(); }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) { await this.saving; return this.flush(); }
    if (!this.dirty || !this.note || !this.draft) return;
    const noteId = this.note.id, draftId = this.draft.id, expectedVersion = this.baseVersion, serial = this.serial, snapshot = structuredClone(this.draft);
    const patch = { title: snapshot.title.trim() || '未命名草稿', ...(snapshot.latex !== undefined ? { latex: snapshot.latex } : {}), ...(snapshot.content ? { content: snapshot.content } : {}) };
    this.updateSaveState('正在保存修改…');
    const task = (async () => {
      try {
        const saved = await updateNote(noteId, latest => { editDraft(latest, draftId, patch, expectedVersion); }, { preserveEditedAt: true });
        if (!saved) throw new Error('所属笔记已不存在，修改仍保留在详情中');
        const draft = saved.drafts.find(d => d.id === draftId)!;
        if (this.note?.id === noteId && this.draft?.id === draftId) { this.note = saved; this.baseVersion = draft.version; this.baseReviewed = draft.reviewed; this.draft.version = draft.version; this.draft.reviewed = false; this.baseSignature = JSON.stringify(patch); if (serial === this.serial) { this.draft.title = draft.title; this.baseSignature = this.signature(); this.dirty = false; } this.saveError = ''; this.updateSaveState(); this.updateFormulaPreview(); }
        this.options.changed(saved, draftId);
      } catch (error) { this.saveError = (error as Error).message || '保存失败，修改仍保留'; this.updateSaveState(); throw error; }
    })();
    this.saving = task; try { await task; } finally { this.saving = null; } if (this.dirty) await this.flush();
  }
  private updateSaveState(message?: string) {
    const state = this.dialog.querySelector<HTMLElement>('#draft-save-state'); if (state) state.textContent = message || (this.saveError ? '尚未保存：' + this.saveError : this.dirty ? '有未保存修改' : '已保存到草稿箱');
    const recovery = this.dialog.querySelector<HTMLElement>('#draft-save-recovery'); if (recovery) recovery.hidden = !this.saveError;
  }
  private async operation(action: (note: Notebook, draft: Draft) => unknown): Promise<void> {
    await this.flush(); const noteId = this.note!.id, draftId = this.draft!.id, expectedVersion = this.baseVersion;
    const saved = await updateNote(noteId, latest => { const draft = latest.drafts.find(d => d.id === draftId); if (!draft) throw new Error('草稿不存在'); if (draft.version !== expectedVersion) throw new Error('草稿已更新，请重新打开核对后再操作'); action(latest, draft); }, { preserveEditedAt: true });
    if (!saved) throw new Error('所属笔记已不存在'); this.options.changed(saved, draftId);
    if (this.note?.id === noteId && this.draft?.id === draftId) { this.note = saved; this.draft = structuredClone(saved.drafts.find(d => d.id === draftId)!); this.baseVersion = this.draft.version; this.baseReviewed = this.draft.reviewed; this.baseSignature = this.signature(); this.render(); }
  }
  private async leave(action: (noteId: string, draftId: string) => void | Promise<void>): Promise<void> { try { await this.flush(); const noteId = this.note!.id, draftId = this.draft!.id; this.rememberPosition(); this.dialog.close(); await action(noteId, draftId); } catch (error) { this.options.notify((error as Error).message); } }
  private button(text: string, action: () => void | Promise<void>, className = '') { return control(text, async () => { try { await action(); } catch (error) { this.options.notify((error as Error).message); } }, className); }
  private render() {
    if (!this.note || !this.draft) return; const n = this.note, d = this.draft; this.rememberPosition(); this.dialog.dataset.draftKey = n.id + ':' + d.id;
    this.dialog.replaceChildren(); const header = element('header', '', 'dd-header'), heading = element('div'), kind = element('p', (labels[d.type] || '数学') + '草稿' + (d.deletedAt ? ' · 回收区' : ''), 'dd-eyebrow');
    const title = element('input'); title.id = 'draft-title-input'; title.value = d.title; title.maxLength = 160; title.setAttribute('aria-label', '草稿标题'); title.disabled = !!d.deletedAt; title.oninput = () => { d.title = title.value; this.changed(); };
    const livePageIds = n.pageOrder.filter(id => n.pages.some(p => p.id === id && !p.deletedAt));
    const sourceLabel = livePageIds.includes(d.sourcePageId) ? '第 ' + (livePageIds.indexOf(d.sourcePageId) + 1) + ' 页' : '来源页已删除';
    heading.append(kind, title, element('p', timestamp(d.createdAt) + ' · ' + sourceLabel, 'dd-caption')); header.append(heading, this.button('关闭', () => this.close(), 'dd-close')); this.dialog.append(header);
    this.dialog.append(this.taskState(n,d));
    const body = element('div', '', 'dd-body'), source = element('aside', '', 'dd-source'), sourceState = draftSourceState(n, d);
    source.append(element('h3', d.type === 'formula' ? '原始选区' : '原稿快照'), element('p', { unchanged: '对应原稿未变化', modified: '原稿已修改 · 此处保留识别时的快照', deleted: '来源页已删除 · 历史快照仍保留' }[sourceState], sourceState === 'unchanged' ? 'dd-caption' : 'dd-notice'));
    for (const snapshotId of d.snapshotIds) { const resource = n.resources[snapshotId]; if (!resource) continue; const image = element('img'); image.src = resource.dataUrl; image.alt = '本次识别保存的原稿快照'; source.append(image); }
    if (!d.snapshotIds.length) source.append(element('p', '没有原稿图片，可继续查看和编辑草稿。', 'dd-caption'));
    const sourceButton = this.button('返回原稿', () => this.leave(this.options.showSource)); sourceButton.disabled = sourceState === 'deleted'; source.append(sourceButton);
    const main = element('section', '', 'dd-content'); main.id = 'draft-edit-content';
    if (d.type === 'formula' || d.latex !== undefined) this.formulaEditor(main, d);
    if (d.content) this.contentEditor(main, d);
    this.resultSummary(main, d); if (d.content?.suggestions?.length) this.suggestions(main, d);
    if (!d.latex && !d.content && !d.result) main.append(element('p', this.options.hasUnsaved?.(n.id,d.id)?'收到的结果可在上方查看，尚未写入草稿。':'结果尚未收到。你可以关闭详情继续书写，任务不会因此重新提交。', 'dd-empty'));
    body.append(source, main); this.dialog.append(body);
    const footer = element('footer', '', 'dd-footer'), reviewedLabel = element('label', '', 'dd-reviewed'), reviewed = element('input'); reviewed.type = 'checkbox'; reviewed.id = 'draft-reviewed'; reviewed.checked = d.reviewed; reviewed.disabled = !!d.deletedAt||!!this.options.hasUnsaved?.(n.id,d.id);
    reviewed.onchange = () => { const checked = reviewed.checked, content = this.signature(); void this.operation((latest, draft) => { if (checked && this.signature() !== content) throw new Error('核对期间内容又有修改，请重新核对后勾选'); markDraftReviewed(latest, draft.id, checked); }).catch(error => { reviewed.checked = !checked; this.options.notify(error.message); }); }; reviewedLabel.append(reviewed, document.createTextNode('已核对'));
    const saveState = element('p', '', 'dd-caption'); saveState.id = 'draft-save-state'; const recovery = element('div', '', 'dd-actions'); recovery.id = 'draft-save-recovery'; recovery.hidden = true; recovery.append(this.button('重试保存修改', () => this.flush()), this.button('导出未保存修改', () => this.exportLocal()));
    const actions = element('div', '', 'dd-actions');
    if (d.deletedAt) { actions.append(this.button('恢复草稿', () => this.operation((latest, draft) => restoreDraft(latest, draft.id)), 'dd-primary'), this.button('永久删除', async () => { if (!window.confirm('永久删除这条草稿？已插入笔记的内容继续保留。此操作不能撤销。')) return; await this.flush(); if (['pending', 'running', 'partial'].includes(d.status)) await this.options.cancel(n.id, d.id); const saved = await updateNote(n.id, latest => permanentDeleteDraft(latest, d.id), { preserveEditedAt: true }); if (saved) this.options.changed(saved, d.id); this.dialog.close(); })); }
    else { actions.append(this.button('复制 LaTeX', () => this.copyText(this.exportText('latex'))), this.button('复制 Markdown', () => this.copyText(this.exportText('markdown')))); const exporting = element('details', '', 'dd-menu'); exporting.append(element('summary', '导出')); const exportActions = element('div', '', 'dd-actions'); exportActions.append(this.button('导出 LaTeX', () => download('MathInk-草稿.tex', this.exportText('latex'))), this.button('导出 Markdown', () => download('MathInk-草稿.md', this.exportText('markdown')))); if (d.snapshotIds.length) exportActions.append(this.button('导出原稿 PNG', () => this.exportSnapshot())); exporting.append(exportActions); actions.append(exporting);
      if (d.latex?.trim()) actions.append(this.button('插入当前页', () => this.leave(this.options.insertFormula), 'dd-primary'));
      if (d.content && ['page', 'organization'].includes(d.type)) actions.append(this.button('作为排版页加入笔记', () => this.leave(this.options.insertPage), 'dd-primary'));
      actions.append(this.button('移入回收区', async () => { await this.operation((latest, draft) => trashDraft(latest, draft.id)); this.dialog.close(); this.options.notify('草稿已移入回收区，已插入内容继续保留'); }));
    }
    footer.append(reviewedLabel, element('span', '核对只表示你确认内容，不代表数学证明。', 'dd-caption'), saveState, recovery, actions); this.dialog.append(footer); this.updateSaveState();
    if (d.uses.length) { const history = element('details', '', 'dd-uses'); history.append(element('summary', '使用记录 · ' + d.uses.length + ' 次')); const list = element('ul'); for (const use of d.uses) { const index = livePageIds.indexOf(use.pageId), page = n.pages.find(p => p.id === use.pageId); list.append(element('li', '版本 ' + use.version + ' · ' + (page && !page.deletedAt && index >= 0 ? '第 ' + (index + 1) + ' 页' : '目标页已删除') + ' · ' + timestamp(use.createdAt) + (use.undoneAt ? ' · 已撤销' : ''))); } history.append(list, element('p', '再次使用会产生独立内容，编辑草稿不会修改以前插入的实例。', 'dd-caption')); this.dialog.append(history); }
    if (d.deletedAt) this.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('.dd-content input,.dd-content textarea,.dd-content select,.dd-content button').forEach(el => el.disabled = true);
    this.restorePosition();
  }
  private taskState(n:Notebook,d:Draft):HTMLElement {
    const receipt=this.options.receivedResult?.(n.id,d.id),pending=receipt&&receipt.phase!=='saved';
    const state=element('div','','dd-state');state.id='draft-task-state';state.append(element('strong',receipt?({received:'结果已收到，待保存',saving:'结果已收到，正在本地保存','save-failed':'已收到，待保存',invalid:'结果已收到，暂时无法解析',saved:'结果已保存'}[receipt.phase]):labels[d.status]||'状态未知'));
    if(d.error)state.append(element('p',d.error));
    if(!pending&&['pending','running','partial','unknown','waiting-connection','failed','cancelled'].includes(d.status)){const actions=element('div','','dd-actions');actions.append(this.button('查询原任务',async()=>{await this.options.query(n.id,d.id);await this.refresh(n.id,d.id);}));if(!['pending','running'].includes(d.status))actions.append(this.button('重新识别',()=>this.leave(this.options.redo)));if(['pending','running','partial'].includes(d.status))actions.append(this.button('取消任务',async()=>{await this.options.cancel(n.id,d.id);await this.refresh(n.id,d.id);}));state.append(actions);}
    if(this.options.hasUnsaved?.(n.id,d.id)){const recovery=element('div','','dd-notice');recovery.append(element('p',receipt?.error||'结果已收到，但还没有保存成功。可查看和导出，不必重新识别。'),this.button('重试保存收到的结果',async()=>{await this.flush();await this.options.retrySaving?.(n.id,d.id);await this.refresh(n.id,d.id);}),this.button('导出收到的结果',()=>this.options.exportUnsaved?.(n.id,d.id)));state.append(recovery);}
    if(pending){const details=element('details','','dd-received');details.id='draft-received-preview';details.open=true;details.append(element('summary','查看收到的结果（未保存）'),element('p','下面仅供预览和复制，保存成功前不会写入正文或作为已保存草稿使用。','dd-caption'));if(receipt.preview){this.receivedPreview(details,receipt.preview);details.append(this.button('复制收到的内容',()=>this.copyText(this.receivedText(receipt.preview!))));}else details.append(element('p',receipt.phase==='invalid'?'结构暂时无法解析，请导出原始结果后恢复。':'正在准备安全预览…'));state.append(details);}
    return state;
  }
  private receivedText(preview:ReceivedResultPreview){const data=record(preview.result);return[preview.latex||'',preview.content?orderedMarkdown(preview.content):'',typeof data.summary==='string'?data.summary:'',...(Array.isArray(data.nextSteps)?data.nextSteps.filter((x):x is string=>typeof x==='string'):[])].filter(Boolean).join('\n\n');}
  private receivedPreview(parent:HTMLElement,preview:ReceivedResultPreview){if(preview.latex){const formula=element('div');renderMath(formula,preview.latex);parent.append(formula);}if(preview.content)for(const block of orderedBlocks(preview.content))parent.append(this.blockPreview(preview.content,block));const data=record(preview.result);if(typeof data.summary==='string')parent.append(element('p',data.summary));if(Array.isArray(data.nextSteps)){parent.append(element('p','AI 建议（未验证）','dd-notice'));for(const text of data.nextSteps)if(typeof text==='string')parent.append(element('p',text));}if(Array.isArray(data.links))for(const raw of data.links){const link=record(raw);if(typeof link.reason==='string')parent.append(element('p',link.reason));for(const rawEvidence of Array.isArray(link.evidence)?link.evidence:[]){const evidence=record(rawEvidence);if(typeof evidence.quote==='string')parent.append(element('blockquote',evidence.quote));}}}
  private formulaEditor(parent: HTMLElement, draft: Draft) {
    const rendered = element('div', '', 'dd-formula-preview'); rendered.id = 'draft-formula-preview'; renderMath(rendered, draft.latex || ''); parent.append(rendered);
    if (draft.uncertainties?.length) parent.append(element('p', '待核对：' + draft.uncertainties.join('；'), 'dd-notice'));
    const details = element('details', '', 'dd-formula-edit'); details.append(element('summary', '编辑公式')); const input = element('textarea'); input.id = 'draft-latex-input'; input.rows = 4; input.maxLength = 32000; input.value = draft.latex || ''; input.setAttribute('aria-label', '草稿 LaTeX');
    input.oninput = () => { draft.latex = input.value; this.changed(); this.updateFormulaPreview(); }; details.append(input, element('p', '修改会自动保存为新的草稿版本，不会改写已经插入的内容。', 'dd-caption'));
    parent.append(details, this.button('检查这条公式', () => this.leave((noteId, draftId) => this.options.advanced(noteId, draftId, 'formula-check'))));
  }
  private updateFormulaPreview() { const preview = this.dialog.querySelector<HTMLElement>('#draft-formula-preview'); if (preview && this.draft?.latex !== undefined) { preview.replaceChildren(); renderMath(preview, this.draft.latex); } }
  private contentEditor(parent: HTMLElement, draft: Draft) {
    const doc = ensurePageModel(draft.content!), list = element('div', '', 'dd-blocks'), blocks = orderedBlocks(doc); list.id = 'draft-block-list';
    for (const [index, block] of blocks.entries()) {
      const card = element('article', '', 'dd-block'); card.dataset.blockId = block.id; const heading = element('div', '', 'dd-block-heading'); heading.append(element('strong', String(index + 1)), element('span', block.needsReview ? '待核对' : '已核对', 'dd-caption')); card.append(heading, this.blockPreview(doc, block));
      if (block.uncertainties?.length) card.append(element('p', block.uncertainties.join('；'), 'dd-notice'));
      const input = element('textarea'); input.value = editableBlockText(doc, block); input.rows = block.type === 'formula' || block.type === 'derivation' ? 2 : 3; input.maxLength = 32000; input.setAttribute('aria-label', '草稿内容块 ' + (index + 1)); input.oninput = () => { editDraftBlockText(doc, block.id, input.value); this.changed(); const previous = card.querySelector('.dd-block-preview'); previous?.replaceWith(this.blockPreview(doc, block)); }; card.append(input);
      if (block.type === 'paragraph') card.append(element('p', '行内公式用 $LaTeX$ 编辑。', 'dd-caption'));
      const actions = element('div', '', 'dd-block-actions'); const type = element('select'); type.setAttribute('aria-label', '内容块 ' + (index + 1) + ' 类型'); const kind = block.type === 'paragraph' ? block.content.role || 'paragraph' : block.type; for (const [value, label] of [['paragraph', '段落'], ['heading', '标题'], ['list-item', '列表'], ['formula', '公式'], ['derivation', '多行推导'], ...(block.type === 'legacy-markdown' ? [['legacy-markdown', '原 Markdown']] : []), ...(block.type === 'image' ? [['image', '原图区域']] : [])]) { const option = element('option', label); option.value = value; type.append(option); } type.value = kind; type.disabled = block.type === 'image'; type.onchange = () => { try { this.changeType(doc, block, type.value); this.changed(); this.render(); } catch (error) { this.options.notify((error as Error).message); } }; actions.append(type);
      actions.append(this.button('上移', () => { moveBlock(doc, block.id, -1); this.changed(); this.render(); }), this.button('下移', () => { moveBlock(doc, block.id, 1); this.changed(); this.render(); }));
      if (block.type === 'paragraph') actions.append(this.button('在光标处分段', () => { splitDraftParagraph(doc, block.id, input.selectionStart); this.changed(); this.render(); }));
      const next = blocks[index + 1]; if (block.type === 'paragraph' && next?.type === 'paragraph' && next.pageId === block.pageId) actions.append(this.button('合并下一段', () => { mergeDraftParagraphs(doc, block.id, next.id); this.changed(); this.render(); }));
      actions.append(this.button('删除此块', () => { removeBlock(doc, block.id); this.changed(); this.render(); }));
      if (block.sourceRefIds.length) actions.append(this.button('查看原稿', () => this.leave(this.options.showSource))); else card.append(element('p', '手工内容，没有原稿关联。', 'dd-caption'));
      card.append(actions); list.append(card);
    }
    parent.append(list); const add = element('div', '', 'dd-actions'); add.append(this.button('添加段落', () => { createParagraphBlock(doc, '新段落'); this.changed(); this.render(); }), this.button('添加公式', () => { const f = formulaFor(doc, 'x', undefined, true); f.provider = 'manual'; createFormulaBlock(doc, f.id); this.changed(); this.render(); })); parent.append(add);
    const tools = element('details', '', 'dd-secondary-tools'); tools.append(element('summary', '更多数学工具')); const actions = element('div', '', 'dd-actions'); for (const [tool, label] of [['context-review', '检查上下文'], ['organize', '整理内容'], ['knowledge-links', '知识关联'], ['proof-assist', '证明辅助']] as const) actions.append(this.button(label, () => this.leave((noteId, draftId) => this.options.advanced(noteId, draftId, tool)))); tools.append(actions); parent.append(tools);
  }
  private blockPreview(document: Note, block: ContentBlock): HTMLElement {
    const preview = element('div', '', 'dd-block-preview');
    if (block.content.role === 'heading') preview.classList.add('dd-heading-preview');
    if (block.content.role === 'list-item') preview.append(window.document.createTextNode('• '));
    if (block.type === 'paragraph') for (const run of block.content.runs || []) { const part = element('span'); if (run.type === 'text') part.textContent = run.text; else renderMath(part, document.formulas.find(f => f.id === run.formulaId)?.latex || '', false); preview.append(part); }
    else if (block.type === 'formula' || block.type === 'derivation') renderMath(preview, editableBlockText(document, block));
    else if (block.type === 'image') { const image = element('img'); image.src = block.content.imageDataUrl || ''; image.alt = block.content.caption || '保留原图'; preview.append(image, element('p', block.content.caption || '')); }
    else preview.textContent = block.content.markdown || '';
    return preview;
  }
  private changeType(document: Note, block: ContentBlock, type: string): void {
    const n = ensurePageModel(document), content = structuredClone(block.content);
    if (['paragraph', 'heading', 'list-item'].includes(type)) { const runs: InlineRun[] = content.runs || (content.formulaId ? [{ type: 'formula', formulaId: content.formulaId }] : [{ type: 'text', text: content.markdown || '' }]); if (content.formulaId) n.formulas.find(f => f.id === content.formulaId)!.inline = true; updateBlock(n, block.id, { type: 'paragraph', content: { runs, ...(type === 'heading' ? { role: 'heading', level: 2 } : type === 'list-item' ? { role: 'list-item' } : {}) } }); if (content.markdown !== undefined) n.markdown = ''; }
    else if (type === 'formula' || type === 'derivation') { let id = content.formulaId; if (!id) { const f = formulaFor(n, editableBlockText(n, block), n.sources?.find(s => block.sourceRefIds.includes(s.id)), true); id = f.id; } updateBlock(n, block.id, { type, content: { formulaId: id } }); if (content.markdown !== undefined) n.markdown = ''; }
  }
  private suggestions(parent: HTMLElement, draft: Draft) {
    const section = element('section', '', 'dd-suggestions'); section.append(element('h3', '修改建议'), element('p', '原文、建议与采用是独立步骤。过期建议需要重新检查。', 'dd-caption'));
    const document = ensurePageModel(draft.content!);
    const batch = this.button('采用勾选且有效的建议', () => { const result = applyCheckedSuggestions(document, [...this.checkedSuggestions]); this.checkedSuggestions.clear(); if (result.applied.length) this.changed(); this.render(); this.options.notify('已采用 ' + result.applied.length + ' 条，跳过 ' + result.skipped.length + ' 条过期或冲突建议'); }); batch.id = 'draft-apply-checked'; batch.disabled = !this.checkedSuggestions.size; section.append(batch);
    for (const [index, suggestion] of document.suggestions.entries()) {
      const stale = isSuggestionStale(document, suggestion), card = element('article', '', 'dd-suggestion'); card.dataset.suggestionId = suggestion.id; card.append(element('strong', labels[suggestion.category] || '修改建议'));
      if (suggestion.status === 'pending') { const label = element('label', '', 'dd-reviewed'), check = element('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '勾选建议 ' + (index + 1)); check.checked = this.checkedSuggestions.has(suggestion.id); check.disabled = stale; check.onchange = () => { if (check.checked) this.checkedSuggestions.add(suggestion.id); else this.checkedSuggestions.delete(suggestion.id); batch.disabled = !this.checkedSuggestions.size; }; label.append(check, window.document.createTextNode('选择这条建议')); card.append(label); }
      const comparison = element('div', '', 'dd-comparison'); comparison.append(this.suggestionVersion(document, suggestion, false), this.suggestionVersion(document, suggestion, true)); card.append(comparison, element('p', suggestion.reason));
      if (suggestion.evidence.length) card.append(element('p', '依据：' + suggestion.evidence.join('；'), 'dd-caption'));
      const actions = element('div', '', 'dd-actions');
      if (suggestion.status === 'pending') { const accept = this.button(stale ? '已过期，请重新检查' : '采用这条建议', () => { if (!applySuggestion(document, suggestion.id)) throw new Error('建议已过期或与当前内容冲突，未应用'); this.changed(); this.render(); }); accept.disabled = stale; actions.append(accept, this.button('拒绝', () => { rejectSuggestion(document, suggestion.id); this.changed(); this.render(); })); }
      else if (suggestion.status === 'accepted') actions.append(element('span', '已采用'), this.button('撤销采用', () => { if (!undoSuggestion(document, suggestion.id)) throw new Error('采用后内容已修改，未覆盖较新的编辑'); this.changed(); this.render(); }));
      else actions.append(element('span', suggestion.status === 'rejected' ? '已拒绝' : '已撤销', 'dd-caption'));
      card.append(actions); section.append(card);
    }
    parent.append(section);
  }
  private suggestionVersion(document: Note, suggestion: Suggestion, after: boolean): HTMLElement {
    const box = element('div'), label = element('small', after ? '建议' : '原内容'), content: BlockContent = after ? suggestion.proposed : suggestion.original; box.append(label);
    if (content.formulaId) { const preview = element('div'); renderMath(preview, (after ? suggestion.proposedLatex : suggestion.originalLatex) ?? document.formulas.find(f => f.id === content.formulaId)?.latex ?? ''); box.append(preview); }
    else if (content.runs) { const preview = element('p'); for (const run of content.runs) { const part = element('span'); if (run.type === 'text') part.textContent = run.text; else { const patch = suggestion.inlineFormulaChanges?.find(c => c.formulaId === run.formulaId); renderMath(part, patch ? after ? patch.proposedLatex : patch.originalLatex : document.formulas.find(f => f.id === run.formulaId)?.latex || '', false); } preview.append(part); } box.append(preview); }
    else box.append(element('p', content.markdown || content.caption || '')); return box;
  }
  private resultSummary(parent: HTMLElement, draft: Draft) {
    const result = record(draft.result);
    if (typeof result.summary === 'string') parent.append(element('p', result.summary, 'dd-result-summary'));
    if (Array.isArray(result.warnings)) for (const warning of result.warnings) if (typeof warning === 'string') parent.append(element('p', warning, 'dd-notice'));
    if (draft.type === 'proof') {
      const section = element('section', '', 'dd-proof'); section.append(element('h3', '证明步骤建议 · 未验证'), element('p', '下列内容是模型建议，尚未通过符号或形式验证。', 'dd-notice'));
      if (typeof result.goal === 'string') section.append(element('p', '目标：' + result.goal));
      for (const [key, title] of [['assumptions', '假设'], ['existingSteps', '已有步骤'], ['nextSteps', '下一步建议'], ['unresolved', '尚未解决']]) if (Array.isArray(result[key])) { section.append(element('h4', title)); const list = element('ol'); for (const value of result[key] as unknown[]) if (typeof value === 'string') { const item = element('li', value); if (key === 'nextSteps' && draft.content) item.append(this.button('加入草稿', () => { createParagraphBlock(draft.content!, 'AI 建议（未验证）：' + value); this.changed(); this.render(); })); list.append(item); } section.append(list); } parent.append(section);
    }
    if (Array.isArray(result.links)) {
      const section = element('section', '', 'dd-links'); section.append(element('h3', '有来源的关联建议'));
      for (const [index, raw] of result.links.entries()) { const link = record(raw), card = element('article'); card.append(element('p', typeof link.reason === 'string' ? link.reason : '请核对关联依据')); if (Array.isArray(link.evidence)) for (const raw of link.evidence) { const evidence = record(raw); if (typeof evidence.quote === 'string') card.append(element('blockquote', evidence.quote)); } if (this.options.adoptLink) card.append(this.button('采用这条关联', () => this.options.adoptLink!(this.note!.id, draft.id, index))); else card.append(element('p', '关联尚未写入笔记。', 'dd-caption')); section.append(card); } parent.append(section);
    }
  }
  private exportText(format: 'latex' | 'markdown'): string { if (!this.draft) return ''; const pieces = [this.draft.latex || '', this.draft.content ? format === 'latex' ? exportLatex(this.draft.content) : orderedMarkdown(this.draft.content) : ''].filter(Boolean); if (!pieces.length) { const result = record(this.draft.result); if (typeof result.summary === 'string') pieces.push(result.summary); if (Array.isArray(result.nextSteps)) pieces.push('AI 建议（未验证）\n' + result.nextSteps.filter(v => typeof v === 'string').join('\n')); } return pieces.join('\n\n'); }
  private async copyText(text: string): Promise<void> {
    if (!text) { this.options.notify('还没有可复制的内容'); return; }
    try { if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用'); await navigator.clipboard.writeText(text); this.options.notify('已复制' + (this.dirty ? '当前内容（含未保存修改）' : '草稿内容')); }
    catch { let dialog = document.getElementById('draft-copy-fallback') as HTMLDialogElement | null; if (!dialog) { dialog = element('dialog'); dialog.id = 'draft-copy-fallback'; dialog.className = 'dd-copy-dialog'; document.body.append(dialog); } dialog.replaceChildren(element('h3', '请手动复制'), element('p', '未写入系统剪贴板。可以选择下面的文本复制。')); const field = element('textarea'); field.value = text; field.rows = 10; field.readOnly = true; field.setAttribute('aria-label', '可复制草稿内容'); dialog.append(field, this.button('全选文本', () => { field.focus(); field.select(); }), this.button('关闭', () => dialog!.close())); dialog.showModal(); field.focus(); field.select(); }
  }
  private async exportSnapshot(): Promise<void> {
    const id = this.draft?.snapshotIds[0], resource = id && this.note?.resources[id]; if (!resource) throw new Error('没有原稿快照');
    const image = new Image(); image.src = resource.dataUrl; await image.decode(); const canvas = element('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); if (!context) throw new Error('无法导出图片，原稿仍保留'); context.drawImage(image, 0, 0); const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('无法生成 PNG，原稿仍保留'); download('MathInk-草稿原稿.png', blob);
  }
  private exportLocal(): void { if (!this.note || !this.draft) return; download('MathInk-未保存草稿.json', JSON.stringify({ format: 'mathink-draft-recovery', noteId: this.note.id, draft: this.draft, snapshots: this.draft.snapshotIds.map(id => this.note!.resources[id]).filter(Boolean), exportedAt: new Date().toISOString() }, null, 2), 'application/json;charset=utf-8'); }
}
