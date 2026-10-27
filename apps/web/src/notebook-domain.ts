import type { Note, Formula, ModelProvider } from './model.ts';
import type { Stroke } from './geometry.ts';
import { ensurePageModel, createFormulaBlock, orderedBlocks, type Page, type StructuredNote, type SourceRef } from './page-model.ts';
import { manuscriptDigest } from './source-copy.ts';
import type {DocumentDraftPage} from './document-model.ts';

export type PaperType = 'blank' | 'ruled' | 'grid';
export interface PageView { zoom: number; panX: number; panY: number }
export type DraftKind = 'formula' | 'page' | 'organization' | 'review' | 'links' | 'proof' | 'document';
export type TaskPhase = 'pending' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'waiting-connection';
export interface NotebookTask { kind: DraftKind; clientRequestId: string; remoteId?: string; provider: ModelProvider; gateway: string; installationId: string; principal: string; phase: TaskPhase; request?: unknown; error?: string; createdAt: string; updatedAt: string; sourceRevision?: number; sourceHash?: string; contentFingerprint?: string }
export interface SnapshotResource { id: string; dataUrl: string; createdAt: string }
export interface DraftUsage { id: string; operationId: string; pageId: string; version: number; instanceId: string; placementId?: string; kind: 'formula' | 'page'; createdAt: string; insertedAt?: string; undoneAt?: string }
export interface Draft { id: string; noteId: string; type: DraftKind; title: string; sourcePageId: string; sourceRevision: number; sourceNativeRevision?: string; source?: SourceRef; snapshotIds: string[]; version: number; reviewed: boolean; status: TaskPhase; taskId?: string; task?: NotebookTask; latex?: string; content?: Note;documentPages?:DocumentDraftPage[]; result?: unknown; usage?: { inputTokens: number; outputTokens: number }; cost?: unknown; uncertainties?: string[]; createdAt: string; updatedAt: string; deletedAt?: string; unread?: boolean; uses: DraftUsage[]; error?: string }
export interface DraftInsertion { id: string; draftId: string; draftVersion: number; operationId: string; pageId: string; kind: 'formula' | 'page'; formulaId?: string; x?: number; y?: number; snapshotIds?: string[]; createdAt: string; undoneAt?: string }
export interface FormulaPlacement { id: string; pageId: string; draftId: string; draftVersion: number; operationId: string; latex: string; x: number; y: number; scale?: number; elementId?: string; deletedAt?: string; createdAt: string }
export interface NativePageInfo { id?: string; name?: string; page?: string; revision?: string; pageRevision?: string; title?: string; deleted?: boolean; paper?: 'blank' | 'lined' | 'ruled' | 'grid' }
export type Notebook = StructuredNote & { pages: Page[]; pageOrder: string[]; pageStrokes: Record<string, Stroke[]>; pageViews: Record<string, PageView>; currentPageId: string; drafts: Draft[]; resources: Record<string, SnapshotResource>; insertions: DraftInsertion[]; placements: FormulaPlacement[]; storageRevision: number };
const copy = <T>(value: T): T => structuredClone(value);
const uid = (): string => { if (typeof crypto.randomUUID === 'function') return crypto.randomUUID(); const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, n => n.toString(16).padStart(2, '0')).join(''); };
const now = (): string => new Date().toISOString();
const defaultView = (): PageView => ({ zoom: 1, panX: 0, panY: 0 });
export const MIN_INSTANCE_SCALE=.05, MAX_INSTANCE_SCALE=20;
export function instanceScale(value:unknown=1):number {if(typeof value!=='number'||!Number.isFinite(value)||value<MIN_INSTANCE_SCALE||value>MAX_INSTANCE_SCALE)throw new Error('公式缩放须在 0.05 到 20 之间');return value;}
/** Publish instance edits to formal formulas, never drafts. Content versions update; raw/page revisions do not. */
export function updateCanonicalPlacements(note:Note,pageId?:string):string[]{
  const n=ensureNotebook(note),plan=n.placements.filter(p=>!p.deletedAt&&(!pageId||p.pageId===pageId)).map(placement=>{const scale=instanceScale(placement.scale??1),insertion=n.insertions.find(i=>i.operationId===placement.operationId&&!i.undoneAt),formula=n.formulas.find(f=>f.id===insertion?.formulaId);if(!formula)throw new Error('公式实例缺少正式内容');return{placement,scale,formula};}),updated:string[]=[];
  for(const {placement,scale,formula}of plan)if(formula.latex!==placement.latex||(formula.scale??1)!==scale){formula.latex=placement.latex;formula.scale=scale;updated.push(formula.id);}if(updated.length)ensurePageModel(n);return updated;
}

/** Idempotent migration. Drafts never enter formulas/blocks belonging to a formal page. */
export function ensureNotebook(note: Note): Notebook {
  const n = ensurePageModel(note) as Notebook;
  n.inkEngine ??= n.butterflyData?.length ? 'butterfly' : 'experimental';
  const first = !Array.isArray(note.pageOrder);
  n.pageStrokes ??= {}; n.pageViews ??= {}; n.drafts ??= []; n.resources ??= {}; n.insertions ??= []; n.placements ??= []; n.storageRevision ??= 0;n.folderId??=null;n.folderRevision??=0;n.binaryResourceIds??=[];
  if (first) {
    n.pageOrder = n.pages.map(p => p.id);
    for (const p of n.pages) { p.kind ??= 'handwritten'; p.paper ??= 'ruled'; p.revision ??= p.sourceRevision; }
    const active = n.pages.find(p => p.nativePageId === (n.butterflyPage || 'default')) || n.pages[0];
    n.currentPageId = active.id;
    n.pageStrokes[active.id] = copy(n.strokes);
    // Existing structured content remains formal and reachable, with original block IDs.
    if (n.blocks.length) {
      const legacy: Page = { id: uid(), noteId: n.id, nativePageId: `legacy-${uid()}`, sourceRevision: n.revision, blockOrder: n.pages.flatMap(p => p.blockOrder), kind: 'legacy', paper: 'blank', revision: 0 };
      for (const block of n.blocks) block.pageId = legacy.id;
      for (const p of n.pages) p.blockOrder = [];
      n.pages.push(legacy); n.pageOrder.push(legacy.id);
    }
  }
  for (const p of n.pages) { p.kind ??= 'handwritten'; p.paper ??= 'ruled'; p.revision ??= p.sourceRevision; n.pageStrokes[p.id] ??= []; n.pageViews[p.id] ??= defaultView(); if (!n.pageOrder.includes(p.id)) n.pageOrder.push(p.id);if(p.kind==='typeset'&&!p.recognitionOrigin){const insertion=n.insertions.find(i=>i.kind==='page'&&i.pageId===p.id),draft=n.drafts.find(d=>d.id===insertion?.draftId);if(draft&&['page','document'].includes(draft.type))p.recognitionOrigin={kind:draft.type==='document'?'document':'page',draftId:draft.id,...(draft.taskId?{taskId:draft.taskId}:{}),sourcePageId:draft.sourcePageId};} }
  // Schema3 used a canvas view slot for formal-page scroll. Its position is
  // migrated once; real camera transforms and existing reading views are independent.
  for(const p of n.pages)if(p.kind!=='handwritten'&&p.readingView===undefined)p.readingView={zoom:1,scrollX:0,scrollY:Math.max(0,n.pageViews[p.id].panY)};
  const live = n.pageOrder.filter(key => n.pages.some(p => p.id === key && !p.deletedAt && !p.nativeMissing));
  if (!live.includes(n.currentPageId)) n.currentPageId = live[0] || n.pageOrder[0];
  n.strokes = n.pageStrokes[n.currentPageId] || [];
  if (first) migrateKnownTaskDrafts(n);
  return n;
}

function migrateKnownTaskDrafts(n: Notebook): void {
  for (const task of n.tasks) {
    if (!n.pages.some(p => p.id === task.pageId)) continue;
    const id = `history-${manuscriptDigest(task.id)}`;
    if (n.drafts.some(d => d.id === id || d.taskId === task.id)) continue;
    const kind: DraftKind = task.type === 'page-transcribe' ? 'page' : task.type === 'organize' ? 'organization' : task.type === 'link' ? 'links' : task.type === 'proof' ? 'proof' : 'review';
    const status: TaskPhase = task.status === 'pending' || task.status === 'running' ? 'unknown' : task.status;
    const snapshots: string[] = [];
    if (task.sourceImage?.imageUrl && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(task.sourceImage.imageUrl)) { const resourceId = `snapshot-${manuscriptDigest(task.sourceImage.imageUrl)}`; n.resources[resourceId] ??= { id: resourceId, dataUrl: task.sourceImage.imageUrl, createdAt: task.createdAt }; snapshots.push(resourceId); }
    const draft: Draft = { id, noteId: n.id, type: kind, title: kind === 'page' ? '历史整页识别' : '历史数学工具结果', sourcePageId: task.pageId, sourceRevision: task.input.sourceRevision, snapshotIds: snapshots, version: 0, reviewed: false, status, taskId: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt, uses: [], result: copy(task.result), ...(task.usage ? { usage: copy(task.usage) } : {}), ...(task.cost ? { cost: copy(task.cost) } : {}), ...(status === 'unknown' ? { error: '历史任务连接身份不可恢复，状态未知；不会自动重新调用。' } : {}) };
    const keys = new Set(task.steps.flatMap(s => s.blockIds)), blocks = n.blocks.filter(b => keys.has(b.id));
    if (blocks.length) {
      const p: Page = { id: uid(), noteId: uid(), nativePageId: 'default', sourceRevision: 0, blockOrder: blocks.map(b => b.id), kind: 'typeset', paper: 'blank', revision: 0 };
      const usedFormulas = new Set(blocks.flatMap(b => [b.content.formulaId, ...(b.content.runs || []).filter(r => r.type === 'formula').map(r => r.formulaId)]).filter((id): id is string => !!id));
      const content: Note = { id: p.noteId, title: draft.title, tags: [], strokes: [], formulas: copy(n.formulas.filter(f => usedFormulas.has(f.id))).map(f => ({ ...f, inline: true })), markdown: '', revision: 0, updatedAt: task.updatedAt, pages: [p], blocks: copy(blocks).map(b => ({ ...b, pageId: p.id })), sources: copy(n.sources.filter(s => blocks.some(b => b.sourceRefIds.includes(s.id)))), suggestions: [], tasks: [], links: [], contentRevision: 0 };
      draft.content = ensureNotebook(content);
    }
    n.drafts.push(draft);
  }
}

export function visiblePages(note: Note): Page[] { const n = ensureNotebook(note); return n.pageOrder.map(id => n.pages.find(p => p.id === id)).filter((p): p is Page => !!p && !p.deletedAt && !p.nativeMissing); }
export function currentPage(note: Note): Page { const n = ensureNotebook(note); const page = n.pages.find(p => p.id === n.currentPageId && !p.deletedAt && !p.nativeMissing); if (!page) throw new Error('当前页面不存在，请恢复页面或新增一页'); return page; }
export function selectPage(note: Note, pageId: string, view?: PageView): Page { const n = ensureNotebook(note); const page = n.pages.find(p => p.id === pageId && !p.deletedAt && !p.nativeMissing); if (!page) throw new Error('页面已删除，不能跳到其他同页码页面'); if (view) n.pageViews[n.currentPageId] = copy(view); n.currentPageId = pageId; n.strokes = n.pageStrokes[pageId] || []; n.butterflyPage = page.nativePageId; return page; }
export function commitPageInk(note: Note, strokes: Stroke[], view?: PageView, pageId?: string): void { const n = ensureNotebook(note), page = n.pages.find(p => p.id === (pageId || n.currentPageId)); if (!page || page.deletedAt) throw new Error('当前页面已删除，笔迹未写入其他页面'); n.pageStrokes[page.id] = copy(strokes); if (view) n.pageViews[page.id] = copy(view); if (page.id === n.currentPageId) n.strokes = n.pageStrokes[page.id]; page.revision = (page.revision || 0) + 1; n.revision++; page.sourceRevision = n.revision; n.updatedAt = now(); }
export function setPageView(note: Note, view: PageView, pageId?: string): void { const n = ensureNotebook(note); n.pageViews[pageId || n.currentPageId] = copy(view); }
export function setPagePaper(note: Note, paper: PaperType, pageId?: string): void { const n = ensureNotebook(note), p = n.pages.find(p => p.id === (pageId || n.currentPageId)); if (!p || p.deletedAt) throw new Error('页面不存在'); p.paper = paper; n.updatedAt = now(); }
export function addPage(note: Note, options: { afterPageId?: string; nativePageId?: string; paper?: PaperType; kind?: Page['kind']; title?: string } = {}): Page { const n = ensureNotebook(note); const page: Page = { id: uid(), noteId: n.id, nativePageId: options.nativePageId || `page-${uid()}`, sourceRevision: n.revision, blockOrder: [], kind: options.kind || 'handwritten', paper: options.paper || 'ruled', revision: 0, ...(options.title ? { title: options.title } : {}) }; n.pages.push(page); const after = options.afterPageId ? n.pageOrder.indexOf(options.afterPageId) : n.pageOrder.length - 1; n.pageOrder.splice(after + 1, 0, page.id); n.pageStrokes[page.id] = []; n.pageViews[page.id] = defaultView(); n.updatedAt = now(); return page; }
export function movePage(note: Note, pageId: string, index: number): boolean { const n = ensureNotebook(note), old = n.pageOrder.indexOf(pageId); if (old < 0 || !Number.isInteger(index)) return false; const target = Math.max(0, Math.min(n.pageOrder.length - 1, index)); if (target === old) return false; n.pageOrder.splice(old, 1); n.pageOrder.splice(target, 0, pageId); n.updatedAt = now(); return true; }
export function trashPage(note: Note, pageId: string): boolean { const n = ensureNotebook(note), p = n.pages.find(p => p.id === pageId); if (!p || p.deletedAt) return false; p.deletedAt = now(); const next = visiblePages(n)[0]; if (n.currentPageId === pageId && next) selectPage(n, next.id); n.updatedAt = now(); return true; }
export function restorePage(note: Note, pageId: string): boolean { const n = ensureNotebook(note), p = n.pages.find(p => p.id === pageId); if (!p?.deletedAt) return false; if (p.nativeMissing) throw new Error('原生页面已被撤销且不在原稿中，请使用原生重做或恢复旧备份'); delete p.deletedAt; if (!visiblePages(n).some(p => p.id === n.currentPageId)) selectPage(n, pageId); n.updatedAt = now(); return true; }
export function duplicatePage(note: Note, pageId: string, nativePageId?: string): Page {
  const n = ensureNotebook(note), source = n.pages.find(p => p.id === pageId && !p.deletedAt && !p.nativeMissing);
  if (!source) throw new Error('要复制的页面不存在');
  const page = addPage(n, { afterPageId: source.id, nativePageId, paper: source.paper, kind: source.kind });
  if(source.pdf)page.pdf=copy(source.pdf);if(source.geometry)page.geometry=copy(source.geometry);if(source.recognitionOrigin)page.recognitionOrigin=copy(source.recognitionOrigin);if(source.readingView)page.readingView=copy(source.readingView);
  n.pageStrokes[page.id] = copy(n.pageStrokes[source.id]).map(s => ({ ...s, id: uid() })); n.pageViews[page.id] = copy(n.pageViews[source.id]);
  const formulas = cloneFormalPage(n, n, source, page);
  for (const original of [...n.placements].filter(p => p.pageId === source.id && !p.deletedAt)) {
    const oldInstance = n.insertions.find(i => i.operationId === original.operationId);
    const placement = { ...copy(original), id: uid(), pageId: page.id, operationId: uid(), createdAt: now() };
    let formulaId = oldInstance?.formulaId ? formulas.get(oldInstance.formulaId) : undefined;
    if (!formulaId) {
      const f: Formula = { id: uid(), latex: original.latex, inline: true, sourceStrokeIds: [], sourceRevision: n.revision, sourceBounds: { x: original.x, y: original.y, width: 100, height: 60 }, sourcePage: source.nativePageId, provider: 'manual', simulated: false, createdAt: now() };
      n.formulas.push(f); createFormulaBlock(n, f.id, page.id); formulaId = f.id;
    }
    n.placements.push(placement);
    n.insertions.push({ id: placement.id, draftId: placement.draftId, draftVersion: placement.draftVersion, operationId: placement.operationId, pageId: page.id, kind: 'formula', formulaId, x: placement.x, y: placement.y, snapshotIds: [...(oldInstance?.snapshotIds || [])], createdAt: placement.createdAt });
    n.drafts.find(d => d.id === placement.draftId)?.uses.push({ id: placement.id, operationId: placement.operationId, pageId: page.id, version: placement.draftVersion, instanceId: formulaId, placementId: placement.id, kind: 'formula', createdAt: placement.createdAt, insertedAt: placement.createdAt });
  }
  return page;
}

/** Enumerate all native pages, including pages never selected or recognized by the host. */
export function syncNativePages(note: Note, pages: NativePageInfo[]): Page[] {
  const n = ensureNotebook(note); if (!pages.length) throw new Error('原生画布未返回页面目录，旧原稿保持完整');
  const names = pages.map(p => p.id || p.name || p.page || ''); if (names.some(p => !p) || new Set(names).size !== names.length) throw new Error('原生画布页面目录无效');
  const priorOrder = [...n.pageOrder], enumerated = n.nativePagesEnumerated, ordered: Page[] = [];
  pages.forEach((entry, i) => { const nativePageId = names[i]; let page = n.pages.find(p => p.nativePageId === nativePageId && p.kind === 'handwritten'); if (!page) page = addPage(n, { nativePageId }); if (entry.revision) (n.butterflyPageRevisions ??= {})[nativePageId] = entry.revision; if (entry.pageRevision) (n.butterflyContentRevisions ??= {})[nativePageId] = entry.pageRevision; if (entry.title) page.title = entry.title; delete page.nativeMissing; if (entry.paper) page.paper = entry.paper === 'lined' ? 'ruled' : entry.paper; if (entry.deleted === true) page.deletedAt ??= now(); else if (entry.deleted === false) delete page.deletedAt; ordered.push(page); });
  for (const page of n.pages) if (page.kind === 'handwritten' && !names.includes(page.nativePageId)) page.deletedAt ??= now();
  if (!enumerated) n.pageOrder = [...ordered.map(p => p.id), ...priorOrder.filter(id => !ordered.some(p => p.id === id))];
  else { const rest = [...ordered.map(p => p.id)]; n.pageOrder = priorOrder.map(id => { const page = n.pages.find(p => p.id === id)!; return page.kind === 'handwritten' && ordered.some(p => p.id === id) ? rest.shift()! : id; }); n.pageOrder.push(...rest); }
  n.nativePagesEnumerated = true; return ordered;
}

export function addSnapshot(note: Note, dataUrl: string): string { const n = ensureNotebook(note); if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('原稿快照格式无效'); const id = `snapshot-${manuscriptDigest(dataUrl)}`; n.resources[id] ??= { id, dataUrl, createdAt: now() }; return id; }
export function createDraft(note: Note, input: Partial<Draft> & Pick<Draft, 'type' | 'sourcePageId'>): Draft { const n = ensureNotebook(note); if (!n.pages.some(p => p.id === input.sourcePageId)) throw new Error('草稿来源页不存在'); if (input.noteId !== undefined && input.noteId !== n.id) throw new Error('草稿所属笔记不匹配'); const at = now(); const draft: Draft = { id: uid(), noteId: n.id, title: input.type === 'formula' ? '公式草稿' : '整页草稿', sourceRevision: n.pages.find(p => p.id === input.sourcePageId)!.revision || 0, snapshotIds: [], version: 0, reviewed: false, status: 'pending', createdAt: at, updatedAt: at, unread: false, uses: [], ...copy(input) }; if (n.drafts.some(d => d.id === draft.id)) throw new Error('草稿标识已存在'); n.drafts.push(draft); return draft; }
export function editDraft(note: Note, draftId: string, patch: Partial<Pick<Draft, 'title' | 'latex' | 'content' | 'documentPages'>>, expectedVersion?: number): Draft { const n = ensureNotebook(note), draft = n.drafts.find(d => d.id === draftId); if (!draft) throw new Error('草稿已删除'); if (expectedVersion !== undefined && draft.version !== expectedVersion) throw new Error('草稿已在其他位置改变，请重新打开'); if (JSON.stringify(patch) === '{}') return draft; Object.assign(draft, copy(patch)); draft.version++; draft.reviewed = false; draft.updatedAt = now(); return draft; }
export function markDraftReviewed(note: Note, draftId: string, reviewed = true): void { const draft = ensureNotebook(note).drafts.find(d => d.id === draftId); if (!draft) throw new Error('草稿不存在'); draft.reviewed = reviewed; draft.unread = false; }
export function trashDraft(note: Note, draftId: string): void { const draft = ensureNotebook(note).drafts.find(d => d.id === draftId); if (!draft) return; draft.deletedAt = now(); }
export function restoreDraft(note: Note, draftId: string): void { const draft = ensureNotebook(note).drafts.find(d => d.id === draftId); if (draft) delete draft.deletedAt; }
export function draftSourceState(note: Note, draft: Draft): 'unchanged' | 'modified' | 'deleted' { const n = ensureNotebook(note), page = n.pages.find(p => p.id === draft.sourcePageId); if (!page || page.deletedAt) return 'deleted'; if ((page.revision || 0) !== draft.sourceRevision) return 'modified'; if (draft.sourceNativeRevision && n.butterflyContentRevisions?.[page.nativePageId] !== draft.sourceNativeRevision) return 'modified'; return 'unchanged'; }

function cloneFormalPage(target: Notebook, origin: Note, source: Page, page: Page): Map<string,string> { const ids = new Map<string, string>(); const formulaIds = new Map<string, string>(); const blocks = orderedBlocks(origin, source.id); for (const block of blocks) { const fids = [block.content.formulaId, ...(block.content.runs || []).filter(r => r.type === 'formula').map(r => r.formulaId)].filter((s): s is string => !!s); for (const id of fids) if (!formulaIds.has(id)) { const f = origin.formulas.find(f => f.id === id); if (!f) continue; const clone = copy(f); clone.id = uid(); clone.inline = true; target.formulas.push(clone); formulaIds.set(id, clone.id); } } for (const original of blocks) { const block = copy(original); ids.set(block.id, uid()); block.id = ids.get(block.id)!; block.pageId = page.id; if (block.content.formulaId) block.content.formulaId = formulaIds.get(block.content.formulaId); if (block.content.runs) block.content.runs = block.content.runs.map(run => run.type === 'formula' ? { type: 'formula', formulaId: formulaIds.get(run.formulaId)! } : run); delete block.contentHash; target.blocks.push(block); page.blockOrder.push(block.id); } const sourceIds = new Set(blocks.flatMap(b => b.sourceRefIds)); for (const id of formulaIds.keys()) { const refId = origin.formulas.find(f => f.id === id)?.sourceRefId; if (refId) sourceIds.add(refId); } for (const ref of origin.sources || []) if (sourceIds.has(ref.id) && !target.sources.some(s => s.id === ref.id)) target.sources.push(copy(ref)); return formulaIds; }
function requireDraft(note: Notebook, draftId: string, allowHistorical: boolean): Draft { const draft = note.drafts.find(d => d.id === draftId && !d.deletedAt); if (!draft || !['completed', 'partial'].includes(draft.status)) throw new Error('草稿尚未完成或已删除'); if (draftSourceState(note, draft) !== 'unchanged' && !allowHistorical) throw new Error('原稿已变化或删除，请核对后明确使用历史草稿'); return draft; }
export function insertDraftFormula(note: Note, draftId: string, pageId: string, x: number, y: number, operationId: string, allowHistorical = false): DraftInsertion {
  const n = ensureNotebook(note), existing = n.insertions.find(i => i.operationId === operationId);
  if (existing) return existing;
  const draft = requireDraft(n, draftId, allowHistorical), page = n.pages.find(p => p.id === pageId && !p.deletedAt && !p.nativeMissing);
  if (!page || page.kind !== 'handwritten' || !draft.latex?.trim() || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('请选择有效手写页和放置位置');
  const source = n.pages.find(p => p.id === draft.sourcePageId), ref = draft.source;
  if (ref && !n.sources.some(s => s.id === ref.id)) n.sources.push(copy(ref));
  const f: Formula = { id: uid(), latex: draft.latex, inline: true, sourceStrokeIds: [...(ref?.strokeIds || [])], sourceRevision: ref?.sourceRevision ?? draft.sourceRevision, sourceBounds: copy(ref?.bounds || { x: 0, y: 0, width: 100, height: 60 }), sourcePage: ref?.nativePageId || source?.nativePageId || 'default', ...(ref ? { sourceRefId: ref.id } : {}), ...(ref?.nativeInkRevision ? { butterfly: true, sourceButterflyRevision: ref.nativeInkRevision } : {}), provider: draft.task?.provider || 'manual', simulated: false, createdAt: now() };
  n.formulas.push(f); createFormulaBlock(n, f.id, pageId);
  const insertion: DraftInsertion = { id: uid(), draftId, draftVersion: draft.version, operationId, pageId, kind: 'formula', formulaId: f.id, x, y, snapshotIds: [...draft.snapshotIds], createdAt: now() };
  n.insertions.push(insertion); draft.uses.push({ id: insertion.id, operationId, pageId, version: draft.version, instanceId: f.id, kind: 'formula', createdAt: insertion.createdAt }); n.updatedAt = now(); return insertion;
}
export function insertDraftPage(note: Note, draftId: string, afterPageId: string, operationId: string, allowHistorical = false): DraftInsertion { const n = ensureNotebook(note), existing = n.insertions.find(i => i.operationId === operationId); if (existing) return existing; const draft = requireDraft(n, draftId, allowHistorical); if (!draft.content) throw new Error('草稿没有排版内容'); const page = addPage(n, { afterPageId, kind: 'typeset', paper: 'blank', title: draft.title }); const document = ensurePageModel(copy(draft.content)); for (const source of document.pages) cloneFormalPage(n, document, source, page); const insertion: DraftInsertion = { id: uid(), draftId, draftVersion: draft.version, operationId, pageId: page.id, kind: 'page', snapshotIds: [...draft.snapshotIds], createdAt: now() }; n.insertions.push(insertion); draft.uses.push({ id: insertion.id, operationId, pageId: page.id, version: draft.version, instanceId: page.id, kind: 'page', createdAt: insertion.createdAt }); n.updatedAt = now(); return insertion; }
export function undoDraftInsertion(note: Note, insertionId: string): boolean { const n = ensureNotebook(note), insertion = n.insertions.find(i => i.id === insertionId); if (!insertion || insertion.undoneAt) return false; if (insertion.kind === 'page') trashPage(n, insertion.pageId); else if (!n.placements.some(p => p.operationId === insertion.operationId && p.elementId)) { n.blocks = n.blocks.filter(b => b.content.formulaId !== insertion.formulaId); n.pages.forEach(p => p.blockOrder = p.blockOrder.filter(id => n.blocks.some(b => b.id === id))); n.formulas = n.formulas.filter(f => f.id !== insertion.formulaId); } insertion.undoneAt = now(); const use = n.drafts.find(d => d.id === insertion.draftId)?.uses.find(u => u.id === insertionId); if (use) use.undoneAt = insertion.undoneAt; n.updatedAt = now(); return true; }
export function permanentDeleteDraft(note: Note, draftId: string): void { const n = ensureNotebook(note), draft = n.drafts.find(d => d.id === draftId); if (!draft?.deletedAt) throw new Error('请先将草稿移入回收区'); n.drafts = n.drafts.filter(d => d.id !== draftId); const refs = new Set([...n.drafts.flatMap(d => d.snapshotIds), ...n.pages.map(p => p.thumbnailId).filter((id): id is string => !!id),...n.sources.map(s=>s.snapshotResourceId).filter((id):id is string=>!!id)]);for(const d of n.drafts)for(const page of d.documentPages||[]){if(page.snapshotId)refs.add(page.snapshotId);for(const source of page.content.sources||[])if(source.snapshotResourceId)refs.add(source.snapshotResourceId);} for (const insertion of n.insertions) if (!insertion.undoneAt) for (const id of insertion.snapshotIds || []) refs.add(id); for (const id of Object.keys(n.resources)) if (!refs.has(id)) delete n.resources[id]; }
export function trashNote(note: Note): void { note.deletedAt = now(); }
export function restoreNote(note: Note): void { delete note.deletedAt; }
export function pinNote(note: Note, pinned = true): void { if (pinned) note.pinnedAt = now(); else delete note.pinnedAt; }
export function duplicateNote(note: Note): Note { const n = copy(ensureNotebook(note)); const oldId = n.id; n.id = uid(); n.title += '（副本）'; n.updatedAt = now(); n.storageRevision = 0; delete n.deletedAt; delete n.pinnedAt; n.pages.forEach(p => p.noteId = n.id); n.drafts.forEach(d => { d.noteId = n.id; if (d.source?.noteId === oldId) d.source.noteId = n.id; d.content?.sources?.forEach(s => { if (s.noteId === oldId) s.noteId = n.id; }); d.task = undefined; if (['pending','running','partial'].includes(d.status)) { d.status = 'unknown'; d.error = '副本保留已收到内容，不恢复原笔记的进行中任务。'; } }); n.sources.forEach(s => { if (s.noteId === oldId) s.noteId = n.id; }); n.links.forEach(link => { if (link.sourceNoteId === oldId) link.sourceNoteId = n.id; if (link.targetNoteId === oldId) link.targetNoteId = n.id; }); return n; }

export function insertFormulaDraft(note: Note, draftId: string, pageId: string, position: { x: number; y: number }, operationId: string, allowHistorical = false): FormulaPlacement {
  const n = ensureNotebook(note), old = n.placements.find(p => p.operationId === operationId); if (old) return old;
  const insertion = insertDraftFormula(n, draftId, pageId, position.x, position.y, operationId, allowHistorical);
  const placement: FormulaPlacement = { id: insertion.id, pageId, draftId, draftVersion: insertion.draftVersion, operationId, latex: n.formulas.find(f => f.id === insertion.formulaId)!.latex, x: position.x, y: position.y, scale:1, createdAt: insertion.createdAt };
  n.placements.push(placement); const use = n.drafts.find(d => d.id === draftId)!.uses.find(u => u.id === insertion.id)!; use.placementId = placement.id; use.insertedAt = placement.createdAt; return placement;
}
export const insertPageDraft = insertDraftPage;
export function undoInsertion(note: Note, operationId: string): boolean { const n = ensureNotebook(note), insertion = n.insertions.find(i => i.operationId === operationId); if (!insertion) return false; const result = undoDraftInsertion(n, insertion.id); if (result) { const placement = n.placements.find(p => p.operationId === operationId); if (placement) placement.deletedAt = insertion.undoneAt; } return result; }

export function validateNotebook(note: Note, validateContent: (child: Note) => void = () => {}): void {
  const n = note as Notebook, validId = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s), date = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));
  const phases = ['pending','running','partial','completed','failed','cancelled','unknown','waiting-connection'];
  if (!['experimental','butterfly'].includes(n.inkEngine || '')) throw new Error('备份包含无效的笔记画布类型');
  if(n.folderId!==null&&!validId(n.folderId)||!Number.isSafeInteger(n.folderRevision)||n.folderRevision!<0)throw new Error('备份包含无效文件夹归属版本');
  if(!Array.isArray(n.binaryResourceIds)||new Set(n.binaryResourceIds).size!==n.binaryResourceIds.length||n.binaryResourceIds.some(id=>typeof id!=='string'||!/^binary-[a-f0-9]{64}$/.test(id)))throw new Error('备份包含无效二进制资源引用');
  const jsonData = (value: unknown, label: string, maximum = 2_000_000): void => {
    if (value === undefined) return;
    const text = JSON.stringify(value);
    if (text.length > maximum) throw new Error(`${label}过大，请导出后分段保存`);
    const visit = (v: unknown, depth: number): void => { if (depth > 32) throw new Error(`${label}结构过深`); if (!v || typeof v !== 'object') return; if (Array.isArray(v)) { v.forEach(c => visit(c, depth + 1)); return; } for (const [key, child] of Object.entries(v)) { if (/^(?:api_?key|app_?key|authorization|password|secret|access_?token|pairing_?token|session_?token|credential)$/i.test(key)) throw new Error('任务不能保存服务凭据'); visit(child, depth + 1); } }; visit(value, 0);
  };
  if (!Array.isArray(n.pageOrder) || new Set(n.pageOrder).size !== n.pageOrder.length || !n.pageOrder.length || n.pageOrder.some(id => !n.pages.some(p => p.id === id)) || !n.pageOrder.includes(n.currentPageId)) throw new Error('备份包含无效的手写页面目录');
  if (!Number.isSafeInteger(n.storageRevision) || n.storageRevision < 0 || n.deletedAt !== undefined && !date(n.deletedAt) || n.pinnedAt !== undefined && !date(n.pinnedAt)) throw new Error('备份包含无效笔记版本或回收状态');
  if (!n.pageStrokes || typeof n.pageStrokes !== 'object' || Array.isArray(n.pageStrokes) || !n.pageViews || typeof n.pageViews !== 'object' || Array.isArray(n.pageViews)) throw new Error('备份缺少每页原稿或视图');
  if ([...Object.keys(n.pageStrokes), ...Object.keys(n.pageViews)].some(id => !n.pages.some(p => p.id === id))) throw new Error('每页原稿引用了不存在的页面');
  for (const p of n.pages) {
    if (p.nativeMissing !== undefined && typeof p.nativeMissing !== 'boolean') throw new Error('原生页面缺失标记无效'); if (!['handwritten','typeset','legacy'].includes(p.kind || '') || !['blank','ruled','grid'].includes(p.paper || '') || !Number.isSafeInteger(p.revision) || p.revision! < 0 || p.deletedAt !== undefined && !date(p.deletedAt)) throw new Error('备份包含无效页面设置');
    const strokes = n.pageStrokes[p.id], view = n.pageViews[p.id];
    if (!Array.isArray(strokes) || !strokes.every(s => s && typeof s.id === 'string' && typeof s.color === 'string' && Number.isFinite(s.width) && s.width > 0 && Array.isArray(s.points) && s.points.every(v => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.pressure) && v.pressure >= 0 && v.pressure <= 1))) throw new Error('备份包含无效的每页笔迹');
    if (!view || ![view.zoom,view.panX,view.panY].every(Number.isFinite) || view.zoom <= 0 || view.zoom > 100) throw new Error('备份包含无效的页面视图');
    if(p.geometry&&(![p.geometry.width,p.geometry.height].every(v=>Number.isFinite(v)&&v>0&&v<=1_000_000)))throw new Error('页面纸张尺寸无效');
    if(p.pdf&&(!/^binary-[a-f0-9]{64}$/.test(p.pdf.resourceId)||!n.binaryResourceIds.includes(p.pdf.resourceId)||!Number.isSafeInteger(p.pdf.pageIndex)||p.pdf.pageIndex<0||p.pdf.pageIndex>100000||![p.pdf.width,p.pdf.height,p.pdf.displayWidth,p.pdf.displayHeight].every(v=>Number.isFinite(v)&&v>0&&v<=1_000_000)||![0,90,180,270].includes(p.pdf.rotation)||p.kind!=='handwritten'))throw new Error('PDF 页面资源或尺寸信息无效');
    if(p.recognitionOrigin&&(p.kind!=='typeset'||!['page','document'].includes(p.recognitionOrigin.kind)||['draftId','taskId','batchId','sourcePageId'].some(key=>{const value=p.recognitionOrigin![key as keyof typeof p.recognitionOrigin];return value!==undefined&&!validId(value);})))throw new Error('识别排版页来源标记无效');
    if(p.readingView&&(![p.readingView.zoom,p.readingView.scrollX,p.readingView.scrollY].every(Number.isFinite)||p.readingView.zoom<=0||p.readingView.zoom>100||p.readingView.scrollX<0||p.readingView.scrollY<0))throw new Error('排版页阅读视图无效');
  }
  if (!n.resources || typeof n.resources !== 'object' || Array.isArray(n.resources) || !Object.entries(n.resources).every(([id,r]) => r && r.id === id && /^snapshot-[a-f0-9]{64}$/.test(id) && typeof r.dataUrl === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(r.dataUrl) && id === `snapshot-${manuscriptDigest(r.dataUrl)}` && date(r.createdAt))) throw new Error('备份包含无效原稿快照');
  const hasSnapshot=(id:unknown)=>typeof id==='string'&&/^snapshot-[a-f0-9]{64}$/.test(id)&&Object.hasOwn(n.resources,id);
  if (n.pages.some(p => p.thumbnailId !== undefined && !hasSnapshot(p.thumbnailId))) throw new Error('页面缩略图引用不存在的快照');
  if (!Array.isArray(n.drafts) || new Set(n.drafts.map(d => d.id)).size !== n.drafts.length) throw new Error('备份包含重复草稿');
  for (const draft of n.drafts) {
    if (!validId(draft.id) || draft.noteId !== n.id || !['formula','page','organization','review','links','proof','document'].includes(draft.type) || typeof draft.title !== 'string' || !validId(draft.sourcePageId) || !n.pages.some(p => p.id === draft.sourcePageId) || !Number.isSafeInteger(draft.sourceRevision) || draft.sourceRevision < 0 || !Array.isArray(draft.snapshotIds) || draft.snapshotIds.some(id => !hasSnapshot(id)) || !Number.isSafeInteger(draft.version) || draft.version < 0 || typeof draft.reviewed !== 'boolean' || !phases.includes(draft.status) || !date(draft.createdAt) || !date(draft.updatedAt) || draft.deletedAt !== undefined && !date(draft.deletedAt) || draft.latex !== undefined && typeof draft.latex !== 'string') throw new Error('备份包含无效草稿记录');
    if (!Array.isArray(draft.uses) || !draft.uses.every(u => u && validId(u.id) && validId(u.pageId) && typeof u.operationId === 'string' && Number.isSafeInteger(u.version) && u.version >= 0 && typeof u.instanceId === 'string' && ['formula','page'].includes(u.kind) && date(u.createdAt) && (u.undoneAt === undefined || date(u.undoneAt)))) throw new Error('备份包含无效草稿使用记录');
    if (draft.task) {
      const t = draft.task;
      if (!['formula','page','organization','review','links','proof'].includes(t.kind) || typeof t.clientRequestId !== 'string' || typeof t.gateway !== 'string' || !['deepseek','ollama','mathpix'].includes(t.provider) || typeof t.installationId !== 'string' || typeof t.principal !== 'string' || !phases.includes(t.phase) || !date(t.createdAt) || !date(t.updatedAt) || Object.keys(t).some(k => /token|password|secret|api.?key/i.test(k))) throw new Error('备份包含无效任务或不应保存的凭据');
      if (t.contentFingerprint !== undefined && (typeof t.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(t.contentFingerprint))) throw new Error('任务正文快照指纹无效');
      jsonData(t.request, '任务输入');
      if (t.request && typeof t.request === 'object' && Object.keys(t.request).some(k => /^(?:imageBase64|dataUrl|imageUrl|images)$/i.test(k))) throw new Error('任务图片应通过快照引用保存');
    }
    jsonData(draft.result, '任务结果'); jsonData(draft.cost, '费用元数据', 10000);
    if (draft.usage && (![draft.usage.inputTokens, draft.usage.outputTokens].every(v => Number.isSafeInteger(v) && v >= 0))) throw new Error('备份包含无效用量');
    if (draft.uncertainties && (!Array.isArray(draft.uncertainties) || !draft.uncertainties.every(v => typeof v === 'string'))) throw new Error('备份包含无效识别疑点');
    if (draft.source && (!validId(draft.source.noteId) || !validId(draft.source.pageId) || !Array.isArray(draft.source.strokeIds) || !draft.source.strokeIds.every(id => typeof id === 'string') || typeof draft.source.nativePageId !== 'string' || !Number.isSafeInteger(draft.source.sourceRevision) || draft.source.sourceRevision < 0 || draft.source.bounds && !['x','y','width','height'].every(k => Number.isFinite(draft.source!.bounds![k as keyof typeof draft.source.bounds])))) throw new Error('备份包含无效草稿来源');
    if(draft.source?.snapshotResourceId!==undefined&&!hasSnapshot(draft.source.snapshotResourceId))throw new Error('草稿来源历史快照不存在');
    if (draft.content) { if (draft.content.id === note.id || draft.content.drafts?.length || draft.content.resources && Object.keys(draft.content.resources).length) throw new Error('草稿排版内容不能包含笔记库、嵌套草稿或快照副本');for(const source of draft.content.sources||[])if(source.snapshotResourceId!==undefined&&!hasSnapshot(source.snapshotResourceId))throw new Error('草稿内容历史快照不存在'); validateContent(draft.content); }
    if(draft.documentPages!==undefined){if(draft.type!=='document'||!Array.isArray(draft.documentPages)||!draft.documentPages.length||new Set(draft.documentPages.map(p=>p.id)).size!==draft.documentPages.length)throw new Error('整文档草稿页面清单无效');for(const page of draft.documentPages){if(!validId(page.id)||!validId(page.sourcePageId)||!Number.isSafeInteger(page.sourceRevision)||page.sourceRevision<0||!['completed','blank','copied','failed'].includes(page.status)||!page.source||!validId(page.source.noteId)||!validId(page.source.pageId)||page.snapshotId!==undefined&&!hasSnapshot(page.snapshotId)||page.source.snapshotResourceId!==undefined&&!hasSnapshot(page.source.snapshotResourceId)||!page.content||page.content.id===note.id||page.content.drafts?.length||page.content.resources&&Object.keys(page.content.resources).length)throw new Error('整文档草稿来源或内容无效');for(const source of page.content.sources||[])if(source.snapshotResourceId!==undefined&&!hasSnapshot(source.snapshotResourceId))throw new Error('多页草稿内容历史快照不存在');validateContent(page.content);}}
  }
  if (!Array.isArray(n.insertions) || !n.insertions.every(i => i && validId(i.id) && typeof i.operationId === 'string' && validId(i.pageId) && validId(i.draftId) && ['formula','page'].includes(i.kind) && Number.isSafeInteger(i.draftVersion) && i.draftVersion >= 0 && date(i.createdAt))) throw new Error('备份包含无效插入实例');
  if (!Array.isArray(n.placements) || !n.placements.every(p => p && validId(p.id) && validId(p.pageId) && validId(p.draftId) && Number.isSafeInteger(p.draftVersion) && p.draftVersion >= 0 && typeof p.operationId === 'string' && typeof p.latex === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.scale===undefined||typeof p.scale==='number'&&Number.isFinite(p.scale)&&p.scale>=MIN_INSTANCE_SCALE&&p.scale<=MAX_INSTANCE_SCALE) && date(p.createdAt) && (p.deletedAt === undefined || date(p.deletedAt)))) throw new Error('备份包含无效公式放置对象或缩放');
}
