import { unzipSync } from 'fflate';
import type { Note } from './model.ts';
import type { DraftInsertion, DraftUsage, FormulaPlacement } from './notebook-domain.ts';
import { ensurePageModel } from './page-model.ts';

export interface NativeSynchronization {
  changed: boolean;
  /** Host page IDs whose native page is absent from the current archive. */
  missingPageIds: string[];
  missingElementIds: string[];
  updatedPlacementIds: string[];
}
/** Metadata/media are not annotations; an unknown page must never be called blank. */
export function nativePageContentEmpty(note:Pick<Note,'butterflyData'>,pageId:string):boolean|undefined{if(!note.butterflyData?.length)return undefined;const page=nativePages(note.butterflyData).get(pageId);return page?page.elements.size===0:undefined;}
interface NativeElement {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
interface NativePage {
  id: string;
  elements: Map<string, NativeElement>;
}
const PAGE_PREFIX = 'BFLY/pages/';
const META_FILE = 'META-INF/butterfly.json';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_PAGE_BYTES = 64 * 1024 * 1024;
const ELEMENT_TYPES = new Set(['pen', 'text', 'markdown', 'image', 'pdf', 'svg', 'shape', 'table', 'texture', 'polygon']);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function invalid(detail: string): never {
  throw new Error('原生原稿无法安全核对，未改变公式或使用记录：' + detail);
}
function json(bytes: Uint8Array, name: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid(name + ' 内容损坏'); }
}

/** Decode only document metadata and native page JSON; media is never inflated. */
function nativePages(data: number[]): Map<string, NativePage> {
  if (!Array.isArray(data) || !data.length || data.length > MAX_ARCHIVE_BYTES ||
      !data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return invalid('备份字节无效或超出核对上限');
  }
  const entryNames = new Set<string>();
  let totalBytes = 0, pageCount = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(Uint8Array.from(data), {
      filter(file) {
        if (file.name !== META_FILE && !(file.name.startsWith(PAGE_PREFIX) && file.name.endsWith('.json'))) return false;
        if (entryNames.has(file.name) || !Number.isSafeInteger(file.originalSize) ||
            file.originalSize < 0 || file.originalSize > (file.name === META_FILE ? 1024 * 1024 : MAX_PAGE_BYTES)) {
          return invalid('原生归档包含重复或过大的条目');
        }
        entryNames.add(file.name);
        totalBytes += file.originalSize;
        if (file.name !== META_FILE) pageCount++;
        if (totalBytes > MAX_TOTAL_PAGE_BYTES || pageCount > 10000) {
          return invalid('原生页面超出本机核对上限');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('原生原稿无法安全核对')) throw error;
    return invalid('ZIP 归档损坏或无法解码');
  }
  if (!files[META_FILE] || !pageCount) return invalid('缺少原生文档信息或页面');
  const metadata = json(files[META_FILE], META_FILE);
  if (!record(metadata) || !['document', 'template'].includes(String(metadata.type)) ||
      metadata.fileVersion !== undefined && (!Number.isSafeInteger(metadata.fileVersion) || Number(metadata.fileVersion) < 0)) {
    return invalid('原生文档类型无效');
  }
  const pages = new Map<string, NativePage>();
  for (const [path, bytes] of Object.entries(files)) {
    if (path === META_FILE) continue;
    const nativeName = path.slice(PAGE_PREFIX.length, -5);
    if (!identifier(nativeName) || nativeName.includes('\\') ||
        nativeName.split('/').some(part => !part || part === '.' || part === '..')) {
      return invalid('原生页面路径无效');
    }
    const value = json(bytes, path);
    if (!record(value) || !Array.isArray(value.layers) || value.layers.length > 10000 ||
        value.extra !== undefined && !record(value.extra)) return invalid('页面结构无效');
    const extra = record(value.extra) ? value.extra : {};
    if (extra.mathinkPage !== undefined && !record(extra.mathinkPage)) return invalid('页面身份无效');
    const pageMetadata = record(extra.mathinkPage) ? extra.mathinkPage : {};
    const pageId = pageMetadata.id === undefined ? nativeName : pageMetadata.id;
    if (!identifier(pageId) || pages.has(pageId)) return invalid('页面身份重复或无效');
    const elements = new Map<string, NativeElement>();
    for (const layer of value.layers) {
      if (!record(layer) || !Array.isArray(layer.content) || layer.content.length > 100000) {
        return invalid('页面图层结构无效');
      }
      for (const element of layer.content) {
        if (!record(element) || !identifier(element.id) || !identifier(element.type) || !ELEMENT_TYPES.has(element.type) ||
            elements.has(element.id)) return invalid('原生对象身份重复或无效');
        elements.set(element.id, { id: element.id, type: element.type, data: element });
      }
    }
    pages.set(pageId, { id: pageId, elements });
  }
  return pages;
}

/** Exact content comparison independent of JSON object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/**
 * Native duplication regenerates element IDs; the domain copy preserves their
 * prior bindings. Rebind only after proving a complete, unchanged native copy.
 * Call while the copy operation owns the canvas, before accepting more edits.
 */
export function rebindNativePageCopy(note: Note, sourceHostPageId: string, targetHostPageId: string): { changed: boolean; updatedPlacementIds: string[] } {
  const source = note.pages?.find(page => page.id === sourceHostPageId);
  const target = note.pages?.find(page => page.id === targetHostPageId);
  if (!source || !target || source === target || source.nativePageId === target.nativePageId || !note.butterflyData) {
    return invalid('复制页面绑定无效');
  }
  const pages = nativePages(note.butterflyData);
  const original = pages.get(source.nativePageId), copied = pages.get(target.nativePageId);
  if (!original || !copied) return invalid('复制后的原生页面不存在');
  const originalElements = [...original.elements.values()], copiedElements = [...copied.elements.values()];
  if (originalElements.length !== copiedElements.length) return invalid('复制后的对象数量不一致');
  const ids = new Map<string, string>();
  for (let index = 0; index < originalElements.length; index++) {
    const before = originalElements[index], after = copiedElements[index];
    const { id: _beforeId, ...beforeContent } = before.data;
    const { id: _afterId, ...afterContent } = after.data;
    if (canonical(beforeContent) !== canonical(afterContent)) return invalid('复制后的对象顺序或内容已改变');
    ids.set(before.id, after.id);
  }
  const plan = (note.placements || []).filter(placement => placement.pageId === target.id && placement.elementId !== undefined).map(placement => {
    const id = ids.get(placement.elementId!);
    // Repeating this helper is safe after a completed rebind.
    if (!id && copied.elements.has(placement.elementId!)) {
      mathValue(copied.elements.get(placement.elementId!)!);
      return { placement, id: placement.elementId! };
    }
    if (!id || !original.elements.has(placement.elementId!)) return invalid('复制后的数学对象绑定缺失');
    mathValue(original.elements.get(placement.elementId!)!);
    mathValue(copied.elements.get(id)!);
    return { placement, id };
  });
  const updatedPlacementIds: string[] = [];
  for (const { placement, id } of plan) if (placement.elementId !== id) {
    placement.elementId = id;
    updatedPlacementIds.push(placement.id);
  }
  return { changed: updatedPlacementIds.length > 0, updatedPlacementIds };
}

/** Native text is authoritative; extra.mathink.latex may lag built-in edits. */
function mathValue(element: NativeElement): { latex: string; x: number; y: number; scale:number } {
  const value = element.data;
  if (element.type !== 'markdown' || !record(value.extra) ||
      !record(value.extra.mathink) || typeof value.text !== 'string' ||
      !record(value.position)) return invalid('绑定对象已不是可核对的数学对象');
  const text = value.text.trim();
  let latex: string;
  if (text.startsWith('$$') && text.endsWith('$$') && text.length > 4) latex = text.slice(2, -2);
  else if (text.startsWith('$') && text.endsWith('$') && text.length > 2) latex = text.slice(1, -1);
  else if (text.startsWith('\\(') && text.endsWith('\\)')) latex = text.slice(2, -2);
  else if (text.startsWith('\\[') && text.endsWith('\\]')) latex = text.slice(2, -2);
  else return invalid('原生数学对象已改为普通文本，请手工核对');
  if (!latex.trim() || latex.length > 50000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(latex)) {
    return invalid('原生公式文本无效');
  }
  const { x, y } = value.position;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) ||
      !Number.isFinite(y) || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) {
    return invalid('原生公式位置无效');
  }
  const scale=value.scale===undefined?1:value.scale;
  if(typeof scale!=='number'||!Number.isFinite(scale)||scale<.05||scale>20)return invalid('原生公式缩放无效');
  return { latex: latex.trim(), x, y, scale };
}

/**
 * Reconcile derived host records after native undo/redo or explicit object edits.
 * This never writes the native archive, draft contents, notebook edit time or
 * storage revision. Parse and validate every page before changing any record.
 */
export function synchronizeNativeInstances(note: Note): NativeSynchronization {
  const result: NativeSynchronization = { changed: false, missingPageIds: [], missingElementIds: [], updatedPlacementIds: [] };
  const placements = (note.placements || []).filter(placement => placement.elementId !== undefined);
  if (note.butterflyData === undefined && !placements.length) return result;
  if (!note.butterflyData) return invalid('缺少已保存的原生原稿');
  const pages = nativePages(note.butterflyData);
  result.missingPageIds = (note.pages || []).filter(page =>
    page.kind !== 'typeset' && page.kind !== 'legacy' && !pages.has(page.nativePageId),
  ).map(page => page.id);
  const plan: { placement: FormulaPlacement; insertion: DraftInsertion; uses: DraftUsage[]; value?: { latex: string; x: number; y: number; scale:number } }[] = [];
  const canonicalValues = new Map<string, string>();
  for (const placement of placements) {
    if (!identifier(placement.elementId)) return invalid('宿主数学对象绑定无效');
    const page = note.pages?.find(page => page.id === placement.pageId);
    if (!page) return invalid('宿主数学对象所属页缺失');
    const insertions = (note.insertions || []).filter(insertion =>
      insertion.kind === 'formula' && insertion.operationId === placement.operationId,
    );
    if (insertions.length !== 1 || insertions[0].pageId !== placement.pageId ||
        !insertions[0].formulaId || !note.formulas.some(formula => formula.id === insertions[0].formulaId)) {
      return invalid('宿主插入记录或独立公式缺失');
    }
    const insertion = insertions[0];
    const uses = (note.drafts || []).flatMap(draft => draft.id === placement.draftId
      ? draft.uses.filter(use => use.kind === 'formula' && use.operationId === placement.operationId &&
          use.pageId === placement.pageId && (use.id === insertion.id ||
            use.placementId === placement.id || use.instanceId === insertion.formulaId))
      : []);
    if (uses.length > 1) return invalid('草稿使用记录重复');
    const element = pages.get(page.nativePageId)?.elements.get(placement.elementId);
    if (!element) {
      result.missingElementIds.push(placement.elementId);
      plan.push({ placement, insertion, uses });
      continue;
    }
    const value = mathValue(element);
    const canonical=JSON.stringify([value.latex,value.scale]),old = canonicalValues.get(insertion.formulaId!);
    if (old !== undefined && old !== canonical) return invalid('原生对象对应冲突的独立公式');
    canonicalValues.set(insertion.formulaId!, canonical);
    plan.push({ placement, insertion, uses, value });
  }
  const at = new Date().toISOString(), originalTime = note.updatedAt;
  const originalRevision = note.contentRevision || 0;
  for (const { placement, insertion, uses, value } of plan) {
    let changed = false;
    if (!value) {
      const removedAt = placement.deletedAt || insertion.undoneAt || uses[0]?.undoneAt || at;
      if (!placement.deletedAt) { placement.deletedAt = removedAt; changed = true; }
      if (!insertion.undoneAt) { insertion.undoneAt = removedAt; changed = true; }
      for (const use of uses) if (!use.undoneAt) { use.undoneAt = removedAt; changed = true; }
    } else {
      if (placement.deletedAt !== undefined) { delete placement.deletedAt; changed = true; }
      if (insertion.undoneAt !== undefined) { delete insertion.undoneAt; changed = true; }
      for (const use of uses) if (use.undoneAt !== undefined) { delete use.undoneAt; changed = true; }
      if (placement.latex !== value.latex || placement.x !== value.x || placement.y !== value.y || (placement.scale??1)!==value.scale) {
        placement.latex = value.latex; placement.x = value.x; placement.y = value.y; placement.scale=value.scale; changed = true;
      }
      if (insertion.x !== value.x || insertion.y !== value.y) {
        insertion.x = value.x; insertion.y = value.y; changed = true;
      }
      const formula = note.formulas.find(formula => formula.id === insertion.formulaId)!;
      if (formula.latex !== value.latex) { formula.latex = value.latex; changed = true; }
      if ((formula.scale??1)!==value.scale) { formula.scale=value.scale; changed = true; }
    }
    if (changed) result.updatedPlacementIds.push(placement.id);
  }
  result.changed = result.updatedPlacementIds.length > 0;
  if (result.changed) {
    ensurePageModel(note);
    if ((note.contentRevision || 0) === originalRevision) note.contentRevision = originalRevision + 1;
    note.updatedAt = originalTime;
  }
  return result;
}
