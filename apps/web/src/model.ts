import type { Bounds, Stroke } from './geometry';

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
}
export interface NotebookBackup { format: 'math-ink'; schemaVersion: 1; exportedAt: string; notes: Note[] }
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
  return { id: newId(), title: '未命名笔记', tags: [], strokes: [], formulas: [], markdown: '', revision: 0, updatedAt: new Date().toISOString() };
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

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器无法打开本地笔记库，请检查存储权限'));
  });
  return database;
}
export async function loadNotes(): Promise<Note[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', 'readonly');
    const request = transaction.objectStore('notes').getAll();
    request.onsuccess = () => resolve(request.result as Note[]);
    request.onerror = () => reject(new Error('无法读取本地笔记'));
  });
}
export async function saveNote(note: Note): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite');
    transaction.objectStore('notes').put(structuredClone(note));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('保存失败：请立即导出备份，并检查剩余存储空间'));
    transaction.onabort = () => reject(new Error('保存中断：请立即导出备份'));
  });
}
export async function importNotes(notes: Note[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', 'readwrite');
    notes.forEach(note => transaction.objectStore('notes').put(note));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('恢复失败，现有笔记仍保留'));
  });
}
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
  if (backup.format !== 'math-ink' || backup.schemaVersion !== 1 || !Array.isArray(backup.notes)) throw new Error('不支持此备份版本');
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
    if (note.butterflyPage !== undefined && (typeof note.butterflyPage !== 'string' || note.butterflyPage.length === 0 || note.butterflyPage.length > 256)) throw new Error('备份包含无效的 Butterfly 页标识');
  }
  return backup;
}
export function exportMarkdown(note: Note): string {
  return `# ${note.title}\n\n${note.tags.length ? `标签：${note.tags.join('、')}\n\n` : ''}${note.markdown}\n\n${note.formulas.map((formula, index) => `### 公式 ${index + 1}\n\n$$\n${formula.latex}\n$$\n\n来源：笔记 ${note.id}，页 ${formula.sourcePage || 'default'}，修订 ${formula.sourceRevision}${isStale(note, formula) ? '（原稿已变化，请核对）' : ''}\n`).join('\n')}`;
}
