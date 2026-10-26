import type { Bounds, Stroke } from './geometry';
import type { SourceCopyProof } from './source-copy.ts';
import { ensureNotebook, validateNotebook, type Draft, type SnapshotResource, type DraftInsertion, type FormulaPlacement, type PageView } from './notebook-domain.ts';
import { saveEditingNote } from './notebook-repository.ts';
import { ensurePageModel, orderedMarkdown, validateBlockContent, type ContentBlock, type KnowledgeLink, type Page, type PageTask, type SourceRef, type Suggestion } from './page-model.ts';
export { ensurePageModel, orderedMarkdown, exportLatex } from './page-model.ts';

export interface Formula {
  id: string;
  latex: string;
  sourceStrokeIds: string[];
  sourceRevision: number;
  sourceBounds: Bounds;
  sourcePage?: string;
  sourceButterflyRevision?: string;
  createdAt: string;
  provider: string;
  simulated: boolean;
  butterfly?: boolean;
  sourceRefId?: string;
  inline?: boolean;
}
export interface Note {
  id: string;
  title: string;
  tags: string[];
  strokes: Stroke[];
  formulas: Formula[];
  markdown: string;
  revision: number;
  updatedAt: string;
  butterflyData?: number[];
  butterflyRevision?: string;
  butterflyPage?: string;
  butterflyPageRevisions?: Record<string, string>;
  butterflyContentRevisions?: Record<string, string>;
  contentRevision?: number;
  pages?: Page[];
  blocks?: ContentBlock[];
  sources?: SourceRef[];
  suggestions?: Suggestion[];
  tasks?: PageTask[];
  links?: KnowledgeLink[];
  sourceCopyProofs?: SourceCopyProof[];
  inkEngine?: 'experimental' | 'butterfly';
  pageOrder?: string[];
  pageStrokes?: Record<string, Stroke[]>;
  pageViews?: Record<string, PageView>;
  currentPageId?: string;
  drafts?: Draft[];
  resources?: Record<string, SnapshotResource>;
  insertions?: DraftInsertion[];
  placements?: FormulaPlacement[];
  nativePagesEnumerated?: boolean;
  deletedAt?: string;
  pinnedAt?: string;
  storageRevision?: number;
}
export interface NotebookBackup { format: 'math-ink'; schemaVersion: 1 | 2 | 3; exportedAt: string; notes: Note[] }
export type ModelProvider = 'deepseek' | 'ollama' | 'mathpix';
export interface Settings { gatewayUrl: string; pairingToken: string; installationId: string; provider: ModelProvider; cloudConsentProviders: ModelProvider[]; cloudConsent: boolean; inkMode: 'experimental' | 'butterfly' }
const DATABASE = 'math-ink-notebooks';
let database: Promise<IDBDatabase> | undefined;

export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newNote(): Note {
  return ensureNotebook({ id: newId(), title: '未命名笔记', tags: [], strokes: [], formulas: [], markdown: '', revision: 0, updatedAt: new Date().toISOString() });
}
export function bumpRevision(note: Note): void { note.revision += 1; note.updatedAt = new Date().toISOString(); }
export function isStale(note: Note, formula: Formula): boolean {
  if (formula.butterfly && formula.sourceButterflyRevision) {
    const page = formula.sourcePage || 'default';
    if (note.butterflyPageRevisions && Object.hasOwn(note.butterflyPageRevisions, page)) return note.butterflyPageRevisions[page] !== formula.sourceButterflyRevision;
    if (note.butterflyPage === page && note.butterflyRevision) return note.butterflyRevision !== formula.sourceButterflyRevision;
  }
  return formula.sourceRevision !== note.revision;
}

export function openNotebookDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 3);
    let migrationError: Error | undefined;
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        const transaction = request.transaction!;
        const notes = transaction.objectStore('notes'), read = notes.getAll();
        read.onsuccess = () => {
          try {
            const original = structuredClone(read.result);
            const migrated = original.map(note => normalizeNote(note));
            transaction.objectStore('recovery').put({ id: `before-schema-3-${Date.now()}`, backup: { format: 'math-ink', schemaVersion: event.oldVersion >= 2 ? 2 : 1, exportedAt: new Date().toISOString(), notes: original } });
            migrated.forEach(note => notes.put(note));
          } catch (error) { migrationError = new Error(`本地笔记升级失败，原数据库未修改：${(error as Error).message}。请保留当前浏览器数据并导出恢复备份`); transaction.abort(); }
        };
      }
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); database = undefined; }; resolve(db); };
    request.onerror = () => { database = undefined; reject(migrationError || new Error('浏览器无法打开本地笔记库，请检查存储权限')); };
    request.onblocked = () => { database = undefined; reject(new Error('本地笔记升级被旧页面阻止，请关闭其他 MathInk 标签页后重试；数据仍保留')); };
  });
  return database;
}
export async function loadNotes(): Promise<Note[]> {
  const db = await openNotebookDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', 'readonly');
    const request = transaction.objectStore('notes').getAll();
    request.onsuccess = () => { try { resolve(request.result.map(note => normalizeNote(note))); } catch (error) { reject(error); } };
    request.onerror = () => reject(new Error('无法读取本地笔记'));
  });
}
export async function saveNote(note: Note): Promise<void> {
  await saveEditingNote(note);
}
export async function importNotes(notes: Note[], options: { allowOverwrite?: boolean } = {}): Promise<void> {
  const snapshots = notes.map(note => normalizeNote(structuredClone(note)));
  if (new Set(snapshots.map(note => note.id)).size !== snapshots.length) throw new Error('备份包含重复的笔记标识，现有笔记未修改');
  const db = await openNotebookDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['notes', 'tombstones'], 'readwrite');
    let importError: Error | undefined;
    const store = transaction.objectStore('notes'), read = store.getAllKeys();
    read.onsuccess = () => { const deleted = transaction.objectStore('tombstones').getAllKeys(); deleted.onsuccess = () => { const conflicts = snapshots.filter(note => read.result.includes(note.id) || deleted.result.includes(note.id)); if (conflicts.length && !options.allowOverwrite) { importError = new Error(`恢复包含 ${conflicts.length} 个已有笔记标识或永久删除记录。为保留稳定来源和现有内容，本次未导入；请先导出当前备份，再明确选择覆盖恢复`); transaction.abort(); return; } snapshots.forEach(note => { store.put(note); if (options.allowOverwrite) transaction.objectStore('tombstones').delete(note.id); }); }; };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(importError || new Error('恢复失败，现有笔记仍保留'));
    transaction.onabort = () => reject(importError || new Error('恢复中断，现有笔记仍保留'));
  });
}
export async function recoveryBackups(): Promise<NotebookBackup[]> { const db = await openNotebookDatabase(); return new Promise((resolve, reject) => { const transaction = db.transaction('recovery', 'readonly'); const request = transaction.objectStore('recovery').getAll(); request.onsuccess = () => resolve(request.result.map(record => record.backup)); request.onerror = () => reject(new Error('无法读取升级前恢复备份')); }); }
export function createBackup(notes: Note[]): NotebookBackup { return { format: 'math-ink', schemaVersion: 3, exportedAt: new Date().toISOString(), notes: notes.map(note => normalizeNote(structuredClone(note))) }; }
export function loadSettings(): Settings {
  const defaults: Settings = { gatewayUrl: location.origin, pairingToken: '', installationId: newId(), provider: 'deepseek', cloudConsentProviders: [], cloudConsent: false, inkMode: 'experimental' };
  try {
    const value = JSON.parse(localStorage.getItem('math-ink-settings') || '{}');
    const provider: ModelProvider = ['deepseek', 'ollama', 'mathpix'].includes(value.provider) ? value.provider : 'deepseek';
    const authorized = Array.isArray(value.cloudConsentProviders) ? value.cloudConsentProviders.filter((p: unknown) => p === 'deepseek' || p === 'mathpix') : value.cloudConsent === true ? ['mathpix'] : [];
    return { ...defaults, ...value, provider, cloudConsentProviders: [...new Set(authorized)] as ModelProvider[], cloudConsent: authorized.includes(provider) };
  } catch { return defaults; }
}
export function saveSettings(settings: Settings): void { localStorage.setItem('math-ink-settings', JSON.stringify(settings)); }

export function parseBackup(text: string): NotebookBackup {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('备份格式不正确');
  const backup = value as NotebookBackup;
  if (backup.format !== 'math-ink' || ![1, 2, 3].includes(backup.schemaVersion) || !Array.isArray(backup.notes) || backup.schemaVersion >= 2 && (typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt)))) throw new Error('不支持此备份版本或缺少导出时间');
  if (backup.notes.length > 1000) throw new Error('单次最多恢复 1,000 篇笔记');
  const ids = new Set<string>();
  for (const note of backup.notes) {
    if (!note || typeof note.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(note.id) || typeof note.title !== 'string' || !Array.isArray(note.strokes) || !Array.isArray(note.formulas) || !Array.isArray(note.tags) || !note.tags.every(tag => typeof tag === 'string') || !Number.isSafeInteger(note.revision) || note.revision < 0 || typeof note.markdown !== 'string' || typeof note.updatedAt !== 'string' || !Number.isFinite(Date.parse(note.updatedAt))) throw new Error('备份包含无效的笔记记录');
    if (ids.has(note.id)) throw new Error('备份包含重复的笔记标识'); ids.add(note.id);
    if (!note.strokes.every(stroke => stroke && typeof stroke.id === 'string' && typeof stroke.color === 'string' && Number.isFinite(stroke.width) && stroke.width > 0 && Array.isArray(stroke.points) && stroke.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.pressure) && p.pressure >= 0 && p.pressure <= 1))) throw new Error('备份包含无效笔迹');
    if (!note.formulas.every(formula => formula && typeof formula.id === 'string' && typeof formula.latex === 'string' && Array.isArray(formula.sourceStrokeIds) && formula.sourceStrokeIds.every(id => typeof id === 'string') && Number.isSafeInteger(formula.sourceRevision) && formula.sourceRevision >= 0 && formula.sourceBounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(formula.sourceBounds[key as keyof Bounds])) && formula.sourceBounds.width > 0 && formula.sourceBounds.height > 0 && typeof formula.provider === 'string' && typeof formula.simulated === 'boolean' && typeof formula.createdAt === 'string' && Number.isFinite(Date.parse(formula.createdAt)))) throw new Error('备份包含无效公式');
    if (!note.formulas.every(formula => (formula.sourcePage === undefined || (typeof formula.sourcePage === 'string' && formula.sourcePage.length > 0 && formula.sourcePage.length <= 256)) && (formula.sourceButterflyRevision === undefined || (typeof formula.sourceButterflyRevision === 'string' && formula.sourceButterflyRevision.length > 0 && formula.sourceButterflyRevision.length <= 128)))) throw new Error('备份包含无效的公式来源页或修订标识');
    if (note.butterflyData !== undefined && (!Array.isArray(note.butterflyData) || !note.butterflyData.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))) throw new Error('备份包含无效的 Butterfly 原稿');
    if (note.butterflyPageRevisions !== undefined && (!note.butterflyPageRevisions || typeof note.butterflyPageRevisions !== 'object' || Array.isArray(note.butterflyPageRevisions) || !Object.entries(note.butterflyPageRevisions).every(([page, revision]) => page.length > 0 && page.length <= 256 && typeof revision === 'string' && revision.length > 0 && revision.length <= 128))) throw new Error('备份包含无效的 Butterfly 页修订记录');
    if (note.butterflyContentRevisions !== undefined && (!note.butterflyContentRevisions || typeof note.butterflyContentRevisions !== 'object' || Array.isArray(note.butterflyContentRevisions) || !Object.entries(note.butterflyContentRevisions).every(([page, revision]) => page.length > 0 && page.length <= 256 && typeof revision === 'string' && revision.length > 0 && revision.length <= 256))) throw new Error('备份包含无效的 Butterfly 整页内容修订记录');
    if (note.butterflyPage !== undefined && (typeof note.butterflyPage !== 'string' || note.butterflyPage.length === 0 || note.butterflyPage.length > 256)) throw new Error('备份包含无效的 Butterfly 页标识');
  }
  for (const note of backup.notes) {
    if (backup.schemaVersion >= 2 || note.pages !== undefined || note.blocks !== undefined) validateStructuredNote(note);
    if (backup.schemaVersion === 3 && (!Array.isArray(note.pageOrder) || !note.pageStrokes || !note.pageViews || typeof note.currentPageId !== 'string' || !Array.isArray(note.drafts) || !note.resources || !Array.isArray(note.insertions) || !Array.isArray(note.placements) || !Number.isSafeInteger(note.storageRevision))) throw new Error('版本 3 备份缺少页面或草稿数据，未修改现有笔记');
    ensurePageModel(note);
    validateStructuredNote(note);
    ensureNotebook(note);
    validateNotebook(note, child => { if (child.drafts?.length) throw new Error('草稿内容不能包含嵌套草稿'); normalizeNote(child); });
  }
  return { ...backup, schemaVersion: 3, exportedAt: typeof backup.exportedAt === 'string' && Number.isFinite(Date.parse(backup.exportedAt)) ? backup.exportedAt : new Date().toISOString() };
}
export function normalizeNote(note: Note): Note {
  // Only a persistence boundary may import a legacy active-page projection.
  // Read-only wrappers (for example a cover of another page) must never write it back.
  const input = structuredClone(note);
  if (input.currentPageId && input.pageStrokes && input.pageOrder?.includes(input.currentPageId)) input.pageStrokes[input.currentPageId] = input.strokes;
  const result = parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, exportedAt: new Date().toISOString(), notes: [input] })).notes[0]; result.updatedAt = note.updatedAt; return result;
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function validateStructuredNote(note: Note): void {
  if (!nonnegative(note.contentRevision) || !Array.isArray(note.pages) || !Array.isArray(note.blocks) || !Array.isArray(note.sources) || !Array.isArray(note.suggestions) || !Array.isArray(note.tasks) || !Array.isArray(note.links)) throw new Error('备份缺少版本 2 页面内容，不能使用旧客户端恢复');
  const unique = (values: { id: string }[], label: string): void => { if (!values.every(value => value && validId(value.id)) || new Set(values.map(value => value.id)).size !== values.length) throw new Error(`备份包含无效或重复的${label}标识`); };
  unique(note.formulas, '公式'); unique(note.pages, '页面'); unique(note.blocks, '内容块'); unique(note.sources, '来源'); unique(note.suggestions, '建议'); unique(note.tasks, '任务'); unique(note.links, '链接');
  const pageIds = new Set(note.pages.map(p => p.id)), blockIds = new Set(note.blocks.map(b => b.id)), sourceIds = new Set(note.sources.map(s => s.id));
  if (note.sourceCopyProofs !== undefined && (!Array.isArray(note.sourceCopyProofs) || note.sourceCopyProofs.length > note.sources.length || new Set(note.sourceCopyProofs.map(p => p.sourceRefId)).size !== note.sourceCopyProofs.length || !note.sourceCopyProofs.every(p => p && p.version === 1 && sourceIds.has(p.sourceRefId) && typeof p.sourceIdentity === 'string' && p.sourceIdentity.length < 200000 && typeof p.manuscriptSha256 === 'string' && /^[a-f0-9]{64}$/.test(p.manuscriptSha256) && typeof p.capturedAt === 'string' && Number.isFinite(Date.parse(p.capturedAt))))) throw new Error('备份包含无效的原稿副本来源凭据');
  if (!note.pages.length || !note.pages.every(p => p.noteId === note.id && typeof p.nativePageId === 'string' && p.nativePageId.length > 0 && p.nativePageId.length <= 256 && nonnegative(p.sourceRevision) && stringArray(p.blockOrder) && new Set(p.blockOrder).size === p.blockOrder.length && p.blockOrder.every(key => note.blocks!.find(b => b.id === key)?.pageId === p.id))) throw new Error('备份包含无效的页面顺序或所属笔记');
  if (!note.blocks.every(b => pageIds.has(b.pageId) && ['paragraph', 'formula', 'derivation', 'legacy-markdown', 'image'].includes(b.type) && nonnegative(b.revision) && typeof b.needsReview === 'boolean' && (b.uncertainties === undefined || stringArray(b.uncertainties)) && stringArray(b.sourceRefIds) && b.sourceRefIds.every(key => sourceIds.has(key)) && note.pages!.find(p => p.id === b.pageId)!.blockOrder.includes(b.id))) throw new Error('备份包含无效的内容块或来源引用');
  note.blocks.forEach(block => validateBlockContent(note, block));
  if (!note.sources.every(s => validId(s.noteId) && validId(s.pageId) && stringArray(s.strokeIds) && nonnegative(s.sourceRevision) && typeof s.nativePageId === 'string' && ['ink', 'manual', 'import'].includes(s.kind) && (s.nativeRevision === undefined || typeof s.nativeRevision === 'string' && s.nativeRevision.length > 0 && s.nativeRevision.length <= 256) && (s.nativeInkRevision === undefined || typeof s.nativeInkRevision === 'string' && s.nativeInkRevision.length > 0 && s.nativeInkRevision.length <= 256) && (!s.bounds || ['x', 'y', 'width', 'height'].every(key => Number.isFinite(s.bounds![key as keyof Bounds])) && s.bounds.width > 0 && s.bounds.height > 0) && (!s.transform || Object.values(s.transform).length === 4 && Object.values(s.transform).every(Number.isFinite) && s.transform.scaleX > 0 && s.transform.scaleY > 0))) throw new Error('备份包含无效的来源定位');
  if (!note.formulas.every(f => f.sourceRefId === undefined || sourceIds.has(f.sourceRefId))) throw new Error('公式引用了不存在的来源');
  const snapshotValid = (s: unknown): boolean => { if (!s || typeof s !== 'object') return false; const v = s as Record<string, unknown>; return nonnegative(v.contentRevision) && nonnegative(v.sourceRevision) && !!v.blocks && typeof v.blocks === 'object' && !Array.isArray(v.blocks) && Object.entries(v.blocks).every(([key, value]) => validId(key) && nonnegative(value)) && !!v.formulas && typeof v.formulas === 'object' && !Array.isArray(v.formulas) && Object.entries(v.formulas).every(([key, value]) => validId(key) && typeof value === 'string') && (v.sourcePages === undefined || !!v.sourcePages && typeof v.sourcePages === 'object' && !Array.isArray(v.sourcePages) && Object.entries(v.sourcePages).every(([key, value]) => key.length > 0 && key.length <= 256 && typeof value === 'string' && value.length > 0 && value.length <= 256)); };
  if (!note.suggestions.every(s => validId(s.targetBlockId) && ['recognition', 'language', 'mathematics', 'missing-condition', 'organization'].includes(s.category) && ['pending', 'accepted', 'rejected', 'undone'].includes(s.status) && typeof s.reason === 'string' && stringArray(s.evidence) && snapshotValid(s.snapshot) && typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt)) && s.original && typeof s.original === 'object' && s.proposed && typeof s.proposed === 'object' && (s.acceptedBlockRevision === undefined || nonnegative(s.acceptedBlockRevision)))) throw new Error('备份包含无效的建议快照');
  for (const suggestion of note.suggestions) if (suggestion.inlineFormulaChanges !== undefined) {
    const changes = suggestion.inlineFormulaChanges, target = note.blocks.find(block => block.id === suggestion.targetBlockId);
    if (!Array.isArray(changes) || changes.length > 200 || new Set(changes.map(change => change?.formulaId)).size !== changes.length) throw new Error('备份包含无效的行内公式修改');
    if (!changes.length) continue;
    if (!Array.isArray(suggestion.original.runs) || !Array.isArray(suggestion.proposed.runs)) throw new Error('行内公式建议必须引用段落快照');
    const originalRefs = new Set(suggestion.original.runs.filter(run => run.type === 'formula').map(run => run.formulaId)), proposedRefs = new Set(suggestion.proposed.runs.filter(run => run.type === 'formula').map(run => run.formulaId));
    const targetRefs = new Set((target?.content.runs || []).filter(run => run.type === 'formula').map(run => run.formulaId));
    const unchangedTarget = target && target.revision === suggestion.snapshot.blocks[target.id];
    if (!changes.every(change => change && Object.keys(change).length === 3 && Object.keys(change).every(key => ['formulaId','originalLatex','proposedLatex'].includes(key)) && validId(change.formulaId) && note.formulas.some(formula => formula.id === change.formulaId) && originalRefs.has(change.formulaId) && proposedRefs.has(change.formulaId) && [change.originalLatex,change.proposedLatex].every(latex => typeof latex === 'string' && latex.length <= 16000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(latex)) && (!unchangedTarget || target.type === 'paragraph' && targetRefs.has(change.formulaId)))) throw new Error('行内公式修改引用、目标或 LaTeX 格式无效');
    // Historical suggestions keep their original snapshot even after adoption/edit/deletion.
    // Their originalLatex deliberately need not equal the current canonical formula value.
  }
  if (!note.tasks.every(t => ['page-transcribe', 'context-review', 'organize', 'link', 'proof'].includes(t.type) && typeof t.provider === 'string' && typeof t.model === 'string' && pageIds.has(t.pageId) && snapshotValid(t.input) && ['pending', 'running', 'partial', 'completed', 'failed', 'cancelled', 'unknown'].includes(t.status) && Array.isArray(t.steps) && t.steps.every(step => validId(step.id) && typeof step.clientRequestId === 'string' && ['pending', 'running', 'partial', 'completed', 'failed', 'cancelled', 'unknown'].includes(step.status) && stringArray(step.blockIds)) && typeof t.createdAt === 'string' && Number.isFinite(Date.parse(t.createdAt)) && typeof t.updatedAt === 'string' && Number.isFinite(Date.parse(t.updatedAt)))) throw new Error('备份包含无效的任务记录');
  if (!note.links.every(link => validId(link.sourceNoteId) && validId(link.sourceBlockId) && validId(link.targetNoteId) && validId(link.targetBlockId) && ['definition', 'theorem', 'example', 'counterexample', 'dependency', 'related'].includes(link.relation) && (link.targetRevision === undefined || nonnegative(link.targetRevision)) && typeof link.createdAt === 'string' && Number.isFinite(Date.parse(link.createdAt)))) throw new Error('备份包含无效的知识链接');
  // References to deleted blocks are retained in history and links, so users can inspect broken sources.
  void blockIds;
}
export function exportMarkdown(note: Note, options: { includeSources?: boolean } = { includeSources: true }): string { return `# ${note.title}\n\n${note.tags.length ? `标签：${note.tags.join('、')}\n\n` : ''}${orderedMarkdown(structuredClone(note), options)}`; }
