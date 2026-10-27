import { normalizeNote,parseBackup, type Note,type NotebookBackup } from './model.ts';
import { ensureNotebook, visiblePages } from './notebook-domain.ts';
import { orderedBlocks } from './page-model.ts';
import {binaryResourceReferences,encodeBinaryResource,decodeBinaryResource,type BinaryResource} from './asset-model.ts';
import {getBinaryResource} from './binary-resources.ts';

/** A regular note export is not a full device backup. Never send the private draft box to a host. */
export function formalNoteForExport(note: Note): Note {
  const n = ensureNotebook(normalizeNote(structuredClone(note))), active = visiblePages(n);
  if (!active.length || n.deletedAt) throw new Error('请先恢复笔记和正式页面，再导出正式内容');
  const activePages = new Set(active.map(p => p.id)), blocks = orderedBlocks(n);
  const blockIds = new Set(blocks.map(b => b.id));
  const formulaIds = new Set(blocks.flatMap(b => [...(b.content.formulaId ? [b.content.formulaId] : []), ...(b.content.runs || []).filter(r => r.type === 'formula').map(r => r.formulaId)]));
  const formulas = n.formulas.filter(f => formulaIds.has(f.id));
  const sourceIds = new Set([...blocks.flatMap(b => b.sourceRefIds), ...formulas.map(f => f.sourceRefId).filter((id): id is string => !!id)]);
  const sources = n.sources.filter(s => sourceIds.has(s.id));
  const neededPages = new Set([...activePages, ...sources.flatMap(s => n.pages.filter(p => p.id === s.pageId || p.nativePageId === s.nativePageId).map(p => p.id))]);
  const resources = new Set<string>();
  n.pages = n.pages.filter(p => neededPages.has(p.id)).map(p => ({ ...p, blockOrder: p.blockOrder.filter(id => blockIds.has(id)) }));
  n.pageOrder = n.pageOrder.filter(id => neededPages.has(id));
  n.pageStrokes = Object.fromEntries(Object.entries(n.pageStrokes).filter(([id]) => neededPages.has(id)));
  n.pageViews = Object.fromEntries(Object.entries(n.pageViews).filter(([id]) => neededPages.has(id)));
  n.insertions = n.insertions.filter(i => !i.undoneAt && activePages.has(i.pageId));
  n.placements = n.placements.filter(p => !p.deletedAt && activePages.has(p.pageId));
  for (const page of n.pages) if (page.thumbnailId) resources.add(page.thumbnailId);
  for(const source of sources)if(source.snapshotResourceId)resources.add(source.snapshotResourceId);
  for (const insertion of n.insertions) {
    insertion.snapshotIds ??= [...(n.drafts.find(d => d.id === insertion.draftId)?.snapshotIds || [])];
    insertion.snapshotIds.forEach(id => resources.add(id));
  }
  n.resources = Object.fromEntries(Object.entries(n.resources).filter(([id]) => resources.has(id)));
  n.blocks = blocks; n.formulas = formulas; n.sources = sources;
  n.markdown = blocks.find(b => b.type === 'legacy-markdown')?.content.markdown || '';
  n.links = n.links.filter(link => blockIds.has(link.sourceBlockId));
  n.sourceCopyProofs = n.sourceCopyProofs?.filter(proof => sourceIds.has(proof.sourceRefId));
  n.drafts = []; n.tasks = []; n.suggestions = [];
  n.folderId=null;n.folderRevision=0;delete n.pinnedAt;
  n.binaryResourceIds=[...binaryResourceReferences({pages:n.pages})];
  // Drop unknown app/account extensions as well as global task-store projections.
  const fields=new Set(['id','title','tags','strokes','formulas','markdown','revision','updatedAt','butterflyData','butterflyRevision','butterflyPage','butterflyPageRevisions','butterflyContentRevisions','contentRevision','pages','blocks','sources','suggestions','tasks','links','sourceCopyProofs','inkEngine','pageOrder','pageStrokes','pageViews','currentPageId','drafts','resources','insertions','placements','nativePagesEnumerated','storageRevision','folderId','folderRevision','binaryResourceIds']);
  for(const key of Object.keys(n))if(!fields.has(key))delete(n as unknown as Record<string,unknown>)[key];
  if (!activePages.has(n.currentPageId)) n.currentPageId = active[0].id;
  n.strokes = n.pageStrokes[n.currentPageId] || [];
  // Raw .bfly remains the editable source document; its page identities and assets must not be truncated.
  return normalizeNote(n);
}

/** A recoverable formal-only envelope; never reads the global document task or folder stores. */
export async function exportFormalBackup(note:Note,loadAsset:(id:string)=>Promise<BinaryResource|null>=getBinaryResource):Promise<NotebookBackup> {
 const clean=formalNoteForExport(note),assets=[];for(const id of binaryResourceReferences(clean)){const resource=await loadAsset(id);if(!resource||resource.id!==id)throw new Error('正式页面缺少原 PDF 资源，请先恢复完整备份');assets.push(encodeBinaryResource(resource));}
 return parseBackup(JSON.stringify({format:'math-ink',schemaVersion:4,exportedAt:new Date().toISOString(),notes:[clean],folders:[],binaryResources:assets,documentTasks:[]}));
}
/** Rebuild supplied transfer material from the authoritative formal note and required asset IDs. */
export function formalAssetLoader(backup:NotebookBackup):(id:string)=>Promise<BinaryResource|null> {
 const resources=new Map((backup.binaryResources||[]).map(resource=>[resource.id,resource]));return async id=>{const encoded=resources.get(id);return encoded?decodeBinaryResource(encoded):null;};
}
