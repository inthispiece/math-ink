import type { Bounds } from './geometry.ts';
import type { Formula, Note } from './model.ts';

export type InlineRun = { type: 'text'; text: string } | { type: 'formula'; formulaId: string };
export type BlockType = 'paragraph' | 'formula' | 'derivation' | 'legacy-markdown' | 'image';
export interface BlockContent { runs?: InlineRun[]; formulaId?: string; markdown?: string; imageDataUrl?: string; caption?: string; role?: 'heading' | 'list-item'; level?: 1 | 2 | 3 | 4 }
export interface ContentBlock { id: string; pageId: string; type: BlockType; revision: number; content: BlockContent; sourceRefIds: string[]; needsReview: boolean; uncertainties?: string[]; contentHash?: string }
export interface Page { id: string; noteId: string; nativePageId: string; sourceRevision: number; blockOrder: string[]; kind?: 'handwritten' | 'typeset' | 'legacy'; paper?: 'blank' | 'ruled' | 'grid'; deletedAt?: string; revision?: number; title?: string; thumbnailId?: string; nativeMissing?: boolean }
export interface SourceRef { id: string; noteId: string; pageId: string; strokeIds: string[]; sourceRevision: number; nativePageId: string; nativeRevision?: string; nativeInkRevision?: string; bounds?: Bounds; transform?: { scaleX: number; scaleY: number; offsetX: number; offsetY: number }; kind: 'ink' | 'manual' | 'import' }
export interface ContextSnapshot { contentRevision: number; sourceRevision: number; blocks: Record<string, number>; formulas: Record<string, string>; sourcePages?: Record<string, string> }
export type SuggestionCategory = 'recognition' | 'language' | 'mathematics' | 'missing-condition' | 'organization';
export interface InlineFormulaChange { formulaId: string; originalLatex: string; proposedLatex: string }
export interface Suggestion { id: string; targetBlockId: string; category: SuggestionCategory; original: BlockContent; proposed: BlockContent; originalLatex?: string; proposedLatex?: string; inlineFormulaChanges?: InlineFormulaChange[]; reason: string; evidence: string[]; snapshot: ContextSnapshot; status: 'pending' | 'accepted' | 'rejected' | 'undone'; createdAt: string; acceptedBlockRevision?: number }
export interface PageTask { id: string; type: 'page-transcribe' | 'context-review' | 'organize' | 'link' | 'proof'; provider: string; model: string; pageId: string; input: ContextSnapshot; status: 'pending' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled' | 'unknown'; steps: { id: string; clientRequestId: string; status: PageTask['status']; blockIds: string[]; error?: string }[]; usage?: { inputTokens: number; outputTokens: number }; error?: string; createdAt: string; updatedAt: string; gatewayTaskId?: string; result?: unknown; request?: unknown; cost?: unknown; sourceImage?: { imageUrl: string; bounds: Bounds; strokeIds: string[]; page: string; revision: string | number; transform?: SourceRef['transform'] } }
export type LinkRelation = 'definition' | 'theorem' | 'example' | 'counterexample' | 'dependency' | 'related';
export interface KnowledgeLink { id: string; sourceNoteId: string; sourceBlockId: string; targetNoteId: string; targetBlockId: string; relation: LinkRelation; targetRevision?: number; createdAt: string }
export type StructuredNote = Note & { pages: Page[]; blocks: ContentBlock[]; sources: SourceRef[]; suggestions: Suggestion[]; tasks: PageTask[]; links: KnowledgeLink[]; contentRevision: number };
const copy = <T>(value: T): T => structuredClone(value);
const id = (): string => { if (typeof crypto.randomUUID === 'function') return crypto.randomUUID(); const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128; const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };
const hash = (value: unknown): string => { const text = JSON.stringify(value); let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
const derivedId = (note: Note, suffix: string): string => `${note.id.slice(0, 70)}-${suffix}`;
// An exact serialization is used for change detection: a short hash must never authorize stale writes.
function fingerprint(note: Note, block: ContentBlock): string { return JSON.stringify([block.type, block.content, block.sourceRefIds, block.needsReview, block.uncertainties, formulaIds(block).map(key => [key, note.formulas.find(f => f.id === key)?.latex])]); }
function formulaIds(block: ContentBlock): string[] { return [...new Set([...(block.content.formulaId ? [block.content.formulaId] : []), ...(block.content.runs || []).filter(r => r.type === 'formula').map(r => r.formulaId)])]; }

/** Normalizes old notes in place. Old Markdown is preserved verbatim, never rewritten by AI. */
export function ensurePageModel(note: Note): StructuredNote {
  const first = !Array.isArray(note.pages) || !Array.isArray(note.blocks);
  note.pages ??= []; note.blocks ??= []; note.sources ??= []; note.suggestions ??= []; note.tasks ??= []; note.links ??= []; note.contentRevision ??= 0;
  const n = note as StructuredNote;
  const pageFor = (native: string): Page => { let page = n.pages.find(p => p.nativePageId === native); if (!page) { const pageId = derivedId(note, `page-${hash(native)}`); if (n.pages.some(p => p.id === pageId)) throw new Error('页面标识冲突，原笔记未保存，请导出备份'); page = { id: pageId, noteId: note.id, nativePageId: native, sourceRevision: note.revision, blockOrder: [] }; n.pages.push(page); } page.sourceRevision = note.revision; return page; };
  pageFor(note.butterflyPage || 'default');
  let legacy = n.blocks.find(b => b.type === 'legacy-markdown');
  if (!legacy && note.markdown) { legacy = { id: derivedId(note, 'legacy-markdown'), pageId: n.pages[0].id, type: 'legacy-markdown', revision: 0, content: { markdown: note.markdown }, sourceRefIds: [], needsReview: false }; n.blocks.unshift(legacy); n.pages[0].blockOrder.unshift(legacy.id); }
  if (legacy && legacy.content.markdown !== note.markdown) legacy.content = { markdown: note.markdown };
  for (const formula of note.formulas) {
    const page = pageFor(formula.sourcePage || 'default');
    let source = n.sources.find(s => s.id === formula.sourceRefId);
    if (!source) { const sourceId = formula.sourceRefId || derivedId(note, `src-${hash(formula.id)}`); if (n.sources.some(s => s.id === sourceId)) throw new Error('来源标识冲突，原笔记未保存，请导出备份'); source = { id: sourceId, noteId: note.id, pageId: page.id, nativePageId: page.nativePageId, strokeIds: [...formula.sourceStrokeIds], sourceRevision: formula.sourceRevision, ...(formula.sourceButterflyRevision ? { nativeRevision: formula.sourceButterflyRevision, nativeInkRevision: formula.sourceButterflyRevision } : {}), bounds: copy(formula.sourceBounds), kind: formula.provider === 'manual' ? 'manual' : 'ink' }; n.sources.push(source); formula.sourceRefId = source.id; }
    if (!formula.inline && !n.blocks.some(b => formulaIds(b).includes(formula.id))) { const block: ContentBlock = { id: derivedId(note, `formula-${hash(formula.id)}`), pageId: page.id, type: 'formula', revision: 0, content: { formulaId: formula.id }, sourceRefIds: [source.id], needsReview: false }; n.blocks.push(block); page.blockOrder.push(block.id); }
  }
  let changed = false;
  for (const block of n.blocks) {
    const next = fingerprint(note, block);
    if (block.contentHash && block.contentHash !== next) { block.revision++; changed = true; }
    else if (!block.contentHash && !first) changed = true;
    block.contentHash = next;
  }
  if (changed) { n.contentRevision++; note.updatedAt = new Date().toISOString(); }
  return n;
}
function touch(note: Note, block?: ContentBlock): void { const n = note as StructuredNote; n.contentRevision++; if (block) { block.revision++; block.contentHash = fingerprint(note, block); } note.updatedAt = new Date().toISOString(); }
export function orderedBlocks(note: Note, pageId?: string): ContentBlock[] { const n = ensurePageModel(note); const hidden = new Set((note.insertions || []).filter(i => i.undoneAt && i.formulaId).map(i => i.formulaId)); const pages = note.pageOrder ? note.pageOrder.map(key => n.pages.find(p => p.id === key)).filter((p): p is Page => !!p && !p.deletedAt && !p.nativeMissing) : n.pages.filter(p => !p.deletedAt && !p.nativeMissing); return pages.filter(p => !pageId || p.id === pageId).flatMap(p => p.blockOrder.map(key => n.blocks.find(b => b.id === key)).filter((b): b is ContentBlock => !!b && !hidden.has(b.content.formulaId))); }
export function blockText(note: Note, block: ContentBlock): string { if (block.type === 'legacy-markdown') return block.content.markdown || ''; if (block.type === 'formula' || block.type === 'derivation') return note.formulas.find(f => f.id === block.content.formulaId)?.latex || ''; if (block.type === 'image') return block.content.caption || '[保留原图，待手工整理]'; return (block.content.runs || []).map(r => r.type === 'text' ? r.text : note.formulas.find(f => f.id === r.formulaId)?.latex || '').join(''); }
export function createParagraphBlock(note: Note, text: string, pageId?: string): ContentBlock { const n = ensurePageModel(note); const page = n.pages.find(p => p.id === pageId) || n.pages[0]; const block: ContentBlock = { id: id(), pageId: page.id, type: 'paragraph', revision: 0, content: { runs: [{ type: 'text', text }] }, sourceRefIds: [], needsReview: false }; n.blocks.push(block); page.blockOrder.push(block.id); block.contentHash = fingerprint(note, block); touch(note); return block; }
export function createFormulaBlock(note: Note, formulaId: string, pageId?: string): ContentBlock {
  const n = ensurePageModel(note), formula = n.formulas.find(f => f.id === formulaId);
  if (!formula) throw new Error('公式不存在');
  const existing = n.blocks.find(b => b.content.formulaId === formulaId), page = n.pages.find(p => p.id === pageId) || n.pages[0];
  if (existing) {
    if (pageId && existing.pageId !== page.id) { n.pages.forEach(p => p.blockOrder = p.blockOrder.filter(key => key !== existing.id)); existing.pageId = page.id; page.blockOrder.push(existing.id); touch(note, existing); }
    return existing;
  }
  const block: ContentBlock = { id: id(), pageId: page.id, type: 'formula', revision: 0, content: { formulaId }, sourceRefIds: formula.sourceRefId ? [formula.sourceRefId] : [], needsReview: false };
  n.blocks.push(block); page.blockOrder.push(block.id); block.contentHash = fingerprint(note, block); touch(note); return block;
}
export function createSourceRef(note: Note, pageId: string, bounds?: Bounds, strokeIds: string[] = []): SourceRef { const n = ensurePageModel(note), page = n.pages.find(p => p.id === pageId); if (!page) throw new Error('来源页不存在'); const source: SourceRef = { id: id(), noteId: note.id, pageId, nativePageId: page.nativePageId, sourceRevision: note.revision, strokeIds: [...strokeIds], kind: bounds || strokeIds.length ? 'ink' : 'manual', ...(bounds ? { bounds: copy(bounds) } : {}), ...(note.butterflyPageRevisions?.[page.nativePageId] ? { nativeRevision: note.butterflyPageRevisions[page.nativePageId] } : {}) }; n.sources.push(source); return source; }
export function updateBlock(note: Note, blockId: string, patch: Partial<ContentBlock>): boolean { const n = ensurePageModel(note); const block = n.blocks.find(b => b.id === blockId); if (!block) return false; const next = { ...block, ...copy(patch), id: block.id, pageId: block.pageId, revision: block.revision }; validateBlockContent(n, next); if (JSON.stringify([block.type, block.content, block.needsReview, block.sourceRefIds]) === JSON.stringify([next.type, next.content, next.needsReview, next.sourceRefIds])) return false; Object.assign(block, next); if (block.type === 'legacy-markdown') note.markdown = block.content.markdown || ''; touch(note, block); return true; }
export function updateFormulaLatex(note: Note, formulaId: string, latex: string): boolean { const n = ensurePageModel(note); const formula = n.formulas.find(f => f.id === formulaId); if (!formula || formula.latex === latex) return false; formula.latex = latex; ensurePageModel(note); return true; }
export function updateLegacyMarkdown(note: Note, markdown: string): void { ensurePageModel(note); if (note.markdown === markdown) return; note.markdown = markdown; ensurePageModel(note); }
export function moveBlock(note: Note, blockId: string, offset: number): boolean { const n = ensurePageModel(note); const page = n.pages.find(p => p.blockOrder.includes(blockId)); if (!page) return false; const index = page.blockOrder.indexOf(blockId), target = Math.max(0, Math.min(page.blockOrder.length - 1, index + offset)); if (index === target) return false; page.blockOrder.splice(index, 1); page.blockOrder.splice(target, 0, blockId); touch(note, n.blocks.find(b => b.id === blockId)); return true; }
export function removeBlock(note: Note, blockId: string): boolean { const n = ensurePageModel(note); const block = n.blocks.find(b => b.id === blockId); if (!block) return false; n.blocks = n.blocks.filter(b => b.id !== blockId); n.pages.forEach(p => p.blockOrder = p.blockOrder.filter(key => key !== blockId)); if (block.type === 'legacy-markdown') note.markdown = ''; if (block.content.formulaId && !n.blocks.some(b => formulaIds(b).includes(block.content.formulaId!))) n.formulas = n.formulas.filter(f => f.id !== block.content.formulaId); touch(note); return true; }
export function captureContext(note: Note, blockIds?: string[]): ContextSnapshot {
  const n = ensurePageModel(note), selected = n.blocks.filter(b => !blockIds || blockIds.includes(b.id));
  const pages = new Set(selected.flatMap(block => [n.pages.find(page => page.id === block.pageId)?.nativePageId, ...block.sourceRefIds.map(key => n.sources.find(source => source.id === key && source.noteId === note.id)?.nativePageId)]).filter((page): page is string => !!page));
  if (!selected.length) pages.add(note.butterflyPage || 'default');
  const sourcePages = Object.fromEntries([...pages].filter(page => note.butterflyContentRevisions?.[page]).map(page => [page, note.butterflyContentRevisions![page]]));
  return { contentRevision: n.contentRevision, sourceRevision: note.revision, blocks: Object.fromEntries(selected.map(b => [b.id, b.revision])), formulas: Object.fromEntries(n.formulas.filter(f => selected.some(b => formulaIds(b).includes(f.id))).map(f => [f.id, f.latex])), ...(Object.keys(sourcePages).length ? { sourcePages } : {}) };
}
function inlineIds(content: BlockContent): string[] { return (content.runs || []).filter(run => run.type === 'formula').map(run => run.formulaId); }
function validateInlinePatch(note: Note, target: ContentBlock, proposed: BlockContent, changes: InlineFormulaChange[] | undefined, undo = false): void {
  if (target.type === 'paragraph' && JSON.stringify(inlineIds(target.content)) !== JSON.stringify(inlineIds(proposed))) throw new Error('行内公式建议不能新增、删除或重排行内公式引用，请手工处理');
  if (changes === undefined) return;
  if (target.type !== 'paragraph' || !Array.isArray(changes) || changes.length > 100) throw new Error('行内公式建议必须对应段落中已有的公式');
  const referenced = new Set(inlineIds(target.content)), seen = new Set<string>();
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Object.keys(change).some(key => !['formulaId', 'originalLatex', 'proposedLatex'].includes(key)) || typeof change.formulaId !== 'string' || seen.has(change.formulaId) || !referenced.has(change.formulaId) || typeof change.originalLatex !== 'string' || typeof change.proposedLatex !== 'string' || !change.proposedLatex.trim() || change.proposedLatex.length > 50000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(change.proposedLatex)) throw new Error('行内公式建议包含无效或冲突的公式修改');
    const formula = note.formulas.find(f => f.id === change.formulaId);
    if (!formula || formula.latex !== (undo ? change.proposedLatex : change.originalLatex)) throw new Error('行内公式已变化，请重新检查');
    seen.add(change.formulaId);
  }
}
export function createSuggestion(note: Note, input: { targetBlockId: string; proposed: BlockContent; proposedLatex?: string; originalLatex?: string; inlineFormulaChanges?: InlineFormulaChange[]; reason: string; category?: SuggestionCategory; evidence?: string[]; contextBlockIds?: string[] }): Suggestion {
  const n = ensurePageModel(note), target = n.blocks.find(b => b.id === input.targetBlockId);
  if (!target) throw new Error('建议目标已不存在');
  validateBlockContent(n, { ...target, content: input.proposed });
  validateInlinePatch(n, target, input.proposed, input.inlineFormulaChanges);
  const formula = n.formulas.find(f => f.id === target.content.formulaId);
  if (input.proposedLatex !== undefined && (!formula || typeof input.proposedLatex !== 'string' || input.proposed.formulaId !== target.content.formulaId)) throw new Error('公式建议缺少唯一公式来源');
  if (input.originalLatex !== undefined && input.originalLatex !== formula?.latex) throw new Error('公式已变化，请重新检查');
  const suggestion: Suggestion = { id: id(), targetBlockId: target.id, category: input.category || 'recognition', original: copy(target.content), proposed: copy(input.proposed), ...(input.proposedLatex !== undefined ? { originalLatex: formula!.latex, proposedLatex: input.proposedLatex } : {}), ...(input.inlineFormulaChanges !== undefined ? { inlineFormulaChanges: copy(input.inlineFormulaChanges) } : {}), reason: input.reason, evidence: [...(input.evidence || [])], snapshot: captureContext(note, [...new Set([target.id, ...(input.contextBlockIds || [])])]), status: 'pending', createdAt: new Date().toISOString() };
  n.suggestions.push(suggestion); return suggestion;
}
export function isSuggestionStale(note: Note, suggestion: Suggestion): boolean { const n = ensurePageModel(note); return suggestion.snapshot.contentRevision !== n.contentRevision || suggestion.snapshot.sourceRevision !== note.revision || Object.entries(suggestion.snapshot.sourcePages || {}).some(([page, revision]) => note.butterflyContentRevisions?.[page] !== revision) || Object.entries(suggestion.snapshot.blocks).some(([key, revision]) => n.blocks.find(b => b.id === key)?.revision !== revision) || Object.entries(suggestion.snapshot.formulas).some(([key, latex]) => n.formulas.find(f => f.id === key)?.latex !== latex); }
interface FormulaWrite { formulaId: string; expected: string; next: string }
function formulaWrites(suggestion: Suggestion, undo = false): FormulaWrite[] {
  const changes = (suggestion.inlineFormulaChanges || []).map(change => ({ formulaId: change.formulaId, expected: undo ? change.proposedLatex : change.originalLatex, next: undo ? change.originalLatex : change.proposedLatex }));
  if (suggestion.proposedLatex !== undefined) changes.push({ formulaId: suggestion.original.formulaId!, expected: undo ? suggestion.proposedLatex : suggestion.originalLatex!, next: undo ? suggestion.originalLatex! : suggestion.proposedLatex });
  return changes;
}
/** All targets are validated before this operation mutates any canonical formula. */
function writeSuggestion(note: StructuredNote, target: ContentBlock, content: BlockContent, writes: FormulaWrite[], needsReview?: boolean): boolean {
  const prepared = copy(content), seen = new Set<string>(), referenced = new Set(formulaIds(target));
  for (const write of writes) {
    if (seen.has(write.formulaId) || !referenced.has(write.formulaId) || typeof write.expected !== 'string' || typeof write.next !== 'string' || note.formulas.find(f => f.id === write.formulaId)?.latex !== write.expected) return false;
    seen.add(write.formulaId);
  }
  try { validateBlockContent(note, { ...target, content: prepared }); } catch { return false; }
  const affected = note.blocks.filter(block => block.id === target.id || formulaIds(block).some(key => seen.has(key)));
  for (const write of writes) note.formulas.find(f => f.id === write.formulaId)!.latex = write.next;
  target.content = prepared;
  if (needsReview !== undefined) target.needsReview = needsReview;
  if (target.type === 'legacy-markdown') note.markdown = prepared.markdown || '';
  let changed = false;
  for (const block of affected) { const next = fingerprint(note, block); if (block.contentHash !== next) { block.revision++; block.contentHash = next; changed = true; } }
  if (changed) { note.contentRevision++; note.updatedAt = new Date().toISOString(); }
  return true;
}
function commitSuggestion(note: Note, suggestion: Suggestion): boolean {
  const n = ensurePageModel(note), target = n.blocks.find(b => b.id === suggestion.targetBlockId);
  if (!target || target.revision !== suggestion.snapshot.blocks[target.id] || JSON.stringify(target.content) !== JSON.stringify(suggestion.original)) return false;
  try { validateInlinePatch(n, target, suggestion.proposed, suggestion.inlineFormulaChanges); } catch { return false; }
  if (!writeSuggestion(n, target, suggestion.proposed, formulaWrites(suggestion), false)) return false;
  suggestion.status = 'accepted'; suggestion.acceptedBlockRevision = target.revision; return true;
}
export function applySuggestion(note: Note, suggestionId: string): boolean { const suggestion = ensurePageModel(note).suggestions.find(s => s.id === suggestionId); if (!suggestion || suggestion.status !== 'pending' || isSuggestionStale(note, suggestion)) return false; return commitSuggestion(note, suggestion); }
export function rejectSuggestion(note: Note, suggestionId: string): boolean { const suggestion = ensurePageModel(note).suggestions.find(s => s.id === suggestionId); if (!suggestion || suggestion.status !== 'pending') return false; suggestion.status = 'rejected'; return true; }
export function undoSuggestion(note: Note, suggestionId: string): boolean {
  const n = ensurePageModel(note), suggestion = n.suggestions.find(s => s.id === suggestionId), block = n.blocks.find(b => b.id === suggestion?.targetBlockId);
  if (!suggestion || suggestion.status !== 'accepted' || !block || block.revision !== suggestion.acceptedBlockRevision || JSON.stringify(block.content) !== JSON.stringify(suggestion.proposed)) return false;
  try { validateInlinePatch(n, block, suggestion.original, suggestion.inlineFormulaChanges, true); } catch { return false; }
  if (!writeSuggestion(n, block, suggestion.original, formulaWrites(suggestion, true))) return false;
  suggestion.status = 'undone'; return true;
}
export function applyCheckedSuggestions(note: Note, ids: string[]): { applied: string[]; skipped: string[] } { const n = ensurePageModel(note), selected = [...new Set(ids)], valid = new Set(selected.filter(key => { const s = n.suggestions.find(item => item.id === key); return s?.status === 'pending' && !isSuggestionStale(note, s); })); const result = { applied: [] as string[], skipped: [] as string[] }; for (const key of selected) { const s = n.suggestions.find(item => item.id === key); if (valid.has(key) && s && commitSuggestion(note, s)) result.applied.push(key); else result.skipped.push(key); } return result; }
export function validateBlockContent(note: Note, block: ContentBlock): void {
  const c = block.content;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('备份包含无效内容块');
  if (Object.hasOwn(c, 'latex')) throw new Error('LaTeX 必须存储在公式对象中');
  if (Object.keys(c).some(key => !['runs', 'formulaId', 'markdown', 'imageDataUrl', 'caption', 'role', 'level'].includes(key))) throw new Error('内容块包含未知字段');
  if (c.role !== undefined && !['heading', 'list-item'].includes(c.role) || c.level !== undefined && ![1, 2, 3, 4].includes(c.level)) throw new Error('内容块标题或列表结构无效');
  const formulas = new Set(note.formulas.map(f => f.id));
  if (block.type === 'paragraph' && (!Array.isArray(c.runs) || !c.runs.every(r => r && (r.type === 'text' && typeof r.text === 'string' && Object.keys(r).every(key => ['type', 'text'].includes(key)) || r.type === 'formula' && typeof r.formulaId === 'string' && formulas.has(r.formulaId) && Object.keys(r).every(key => ['type', 'formulaId'].includes(key)))))) throw new Error('段落包含无效行内公式引用');
  if ((block.type === 'formula' || block.type === 'derivation') && (!c.formulaId || !formulas.has(c.formulaId))) throw new Error('内容块引用了不存在的公式');
  if (block.type === 'legacy-markdown' && typeof c.markdown !== 'string') throw new Error('备份包含无效 Markdown 兼容块');
  if (block.type === 'image' && (typeof c.imageDataUrl !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(c.imageDataUrl) || c.caption !== undefined && typeof c.caption !== 'string')) throw new Error('备份包含无效原图区域');
}
export function orderedMarkdown(note: Note, options: { includeSources?: boolean } = {}): string {
  const n = ensurePageModel(note);
  return orderedBlocks(n).map(block => {
    let text = block.type === 'paragraph' ? (block.content.runs || []).map(r => r.type === 'text' ? r.text : `$${n.formulas.find(f => f.id === r.formulaId)?.latex || ''}$`).join('') : block.type === 'formula' || block.type === 'derivation' ? `$$\n${blockText(n, block)}\n$$` : blockText(n, block);
    if (block.type === 'paragraph' && block.content.role === 'heading') text = `${'#'.repeat(block.content.level || 2)} ${text}`;
    if (block.type === 'paragraph' && block.content.role === 'list-item') text = `- ${text}`;
    if (options.includeSources) {
      const refs = block.sourceRefIds.map(key => n.sources.find(s => s.id === key)).filter((s): s is SourceRef => !!s);
      text += `\n\n<!-- mathink:block=${block.id} page=${block.pageId} revision=${block.revision} -->\n` + (refs.length ? refs.map(s => `来源：笔记 ${s.noteId}，页 ${s.nativePageId}，修订 ${s.sourceRevision}${s.sourceRevision !== note.revision ? '（原稿已变化，请核对）' : ''}；来源标识 ${s.id}`).join('\n') : '来源：手工或导入内容，没有原稿关联');
    }
    return text;
  }).join('\n\n');
}
export function exportLatex(note: Note, options: { includeSources?: boolean } = {}): string {
  return orderedBlocks(note).map(block => {
    let text = block.type === 'paragraph' ? (block.content.runs || []).map(r => r.type === 'formula' ? `$${note.formulas.find(f => f.id === r.formulaId)?.latex || ''}$` : r.text.replace(/[\\{}$&#_%]/g, '\\$&')).join('') : block.type === 'formula' || block.type === 'derivation' ? `\\[\n${blockText(note, block)}\n\\]` : `% ${blockText(note, block).replace(/\n/g, '\n% ')}`;
    if (block.type === 'paragraph' && block.content.role === 'heading') text = `\\${(block.content.level || 2) <= 2 ? 'section' : 'subsection'}*{${text}}`;
    if (block.type === 'paragraph' && block.content.role === 'list-item') text = `\\begin{itemize}\n\\item ${text}\n\\end{itemize}`;
    return (options.includeSources ? `% MathInk block ${block.id}, page ${block.pageId}, source ${block.sourceRefIds.join(',') || 'manual/import'}\n` : '') + text;
  }).join('\n\n');
}
