import { openNotebookDatabase, normalizeNote, type Note } from './model.ts';
import { ensureNotebook, type Notebook, type Draft, type DraftUsage } from './notebook-domain.ts';
import {binaryResourceReferences} from './asset-model.ts';

export class NoteConflictError extends Error { constructor() { super('笔记已在其他页面改变，未覆盖新内容；请重新打开并核对'); this.name = 'NoteConflictError'; } }
export class NoteDeletedError extends Error { constructor() { super('笔记已永久删除，迟到的结果不会重新创建它'); this.name = 'NoteDeletedError'; } }

/** The writer transaction must include folders and binaryResources. */
export function putCheckedNote(tx:IDBTransaction,note:Notebook,onFailure:(error:Error)=>void):void {
 for(const source of note.sources)if(source.snapshotResourceId&&!note.resources[source.snapshotResourceId])throw new Error('来源历史快照不存在，未保存不完整笔记');
 const refs=binaryResourceReferences(note),pending=(note.folderId?1:0)+(refs.size?1:0);let remaining=pending;
 const write=()=>{try{tx.objectStore('notes').put(note);}catch(error){onFailure(error instanceof Error?error:new Error(String(error)));tx.abort();}};
 const done=()=>{if(--remaining===0)write();};
 const abort=(message:string)=>{onFailure(new Error(message));tx.abort();};
 if(!pending){write();return;}
 if(note.folderId){const folder=tx.objectStore('folders').getKey(note.folderId);folder.onsuccess=()=>{if(folder.result===undefined)abort('目标文件夹已删除，请重新选择或使用未分类');else done();};}
 if(refs.size){const keys=tx.objectStore('binaryResources').getAllKeys();keys.onsuccess=()=>{if([...refs].some(id=>!keys.result.includes(id)))abort('笔记缺少原 PDF 二进制资源，未保存不完整页面');else done();};}
}

/** Draft bodies belong to draft transactions; usage belongs to the formal instances being saved. */
export function mergeEditorDrafts(snapshot: Notebook, latest: Notebook): Draft[] {
  return latest.drafts.map(stored => {
    const draft = structuredClone(stored), uses = new Map(draft.uses.map(use => [use.operationId, use]));
    for (const insertion of snapshot.insertions.filter(item => item.draftId === draft.id)) {
      const instanceId = insertion.kind === 'page' ? insertion.pageId : insertion.formulaId;
      if (!instanceId) throw new Error('插入实例缺少内容标识，使用记录未保存');
      const placement = snapshot.placements.find(item => item.operationId === insertion.operationId && item.pageId === insertion.pageId && item.draftId === draft.id && item.draftVersion === insertion.draftVersion);
      const previous = uses.get(insertion.operationId), undoneAt = insertion.undoneAt || placement?.deletedAt;
      const use: DraftUsage = { id: insertion.id, operationId: insertion.operationId, pageId: insertion.pageId, version: insertion.draftVersion, instanceId, kind: insertion.kind, createdAt: insertion.createdAt, insertedAt: previous?.insertedAt || insertion.createdAt, ...(placement ? { placementId: placement.id } : {}), ...(undoneAt ? { undoneAt } : {}) };
      uses.set(insertion.operationId, use);
    }
    draft.uses = [...uses.values()];
    return draft;
  });
}
export async function getNote(id: string): Promise<Notebook | null> { const db = await openNotebookDatabase(); return new Promise((resolve, reject) => { const request = db.transaction('notes', 'readonly').objectStore('notes').get(id); request.onsuccess = () => { try { resolve(request.result ? ensureNotebook(normalizeNote(request.result)) : null); } catch (error) { reject(error); } }; request.onerror = () => reject(new Error('无法读取本地笔记')); }); }

/** A synchronous patch executes inside the same IndexedDB read/write transaction as the latest read. */
export async function updateNote(id: string, change: (latest: Notebook) => unknown, options: { allowDeleted?: boolean; expectedStorageRevision?: number; preserveEditedAt?: boolean } = {}): Promise<Notebook | null> {
  const db = await openNotebookDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'tombstones','folders','binaryResources'], 'readwrite'), store = tx.objectStore('notes');
    let failure: Error | undefined, result: Notebook | null = null;
    const dead = tx.objectStore('tombstones').get(id);
    dead.onsuccess = () => {
      if (dead.result) { failure = new NoteDeletedError(); tx.abort(); return; }
      const read = store.get(id);
      read.onsuccess = () => {
        if (!read.result) return;
        try {
          const latest = ensureNotebook(normalizeNote(read.result));
          if (latest.deletedAt && !options.allowDeleted) throw new Error('笔记已移入回收站，请恢复后编辑');
          if (options.expectedStorageRevision !== undefined && options.expectedStorageRevision !== latest.storageRevision) throw new NoteConflictError();
          const editedAt = latest.updatedAt, previous = latest.storageRevision;
          const outcome = change(latest);
          if (outcome && typeof (outcome as unknown as { then?: unknown }).then === 'function') throw new Error('存储事务不能等待异步操作');
          latest.storageRevision = previous + 1;
          latest.updatedAt = options.preserveEditedAt ? editedAt : new Date().toISOString();
          result = ensureNotebook(normalizeNote(latest)); putCheckedNote(tx,result,error=>failure=error);
        } catch (error) { failure = error as Error; tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || new Error('保存中断：内容仍保留，请重试或导出'));
    tx.onerror = () => reject(failure || new Error('保存失败：请立即导出备份并检查存储空间'));
  });
}

/** Formal editor writes preserve concurrently received drafts and their shared image resources. */
export async function saveEditingNote(note: Note, expectedStorageRevision?: number): Promise<Notebook> {
  const snapshot = ensureNotebook(normalizeNote(structuredClone(note))), db = await openNotebookDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'tombstones','folders','binaryResources'], 'readwrite'), store = tx.objectStore('notes'); let error: Error | undefined, result: Notebook;
    const dead = tx.objectStore('tombstones').get(snapshot.id);
    dead.onsuccess = () => {
      if (dead.result) { error = new NoteDeletedError(); tx.abort(); return; }
      const request = store.get(snapshot.id);
      request.onsuccess = () => {
        try {
          const latest = request.result ? ensureNotebook(normalizeNote(request.result)) : null;
          if (latest?.deletedAt && !snapshot.deletedAt) throw new Error('笔记已移入回收站，旧保存不能将它重新带回首页');
          if (latest && expectedStorageRevision !== undefined && latest.storageRevision !== expectedStorageRevision) throw new NoteConflictError();
          if (latest) {
            // Draft editing/result application must use updateNote; stale canvas snapshots
            // cannot remove a received result, revert its version or overwrite its task state.
            // Only latest IDs survive: a stale canvas cannot resurrect a permanently deleted draft.
            // New drafts on an existing note must be created through updateNote, not editor snapshots.
            snapshot.drafts = mergeEditorDrafts(snapshot, latest); snapshot.resources = { ...snapshot.resources, ...latest.resources };
            snapshot.deletedAt = latest.deletedAt || snapshot.deletedAt;
            snapshot.folderId=latest.folderId;snapshot.folderRevision=latest.folderRevision;
          }
          snapshot.storageRevision = (latest?.storageRevision || 0) + 1;
          result = ensureNotebook(normalizeNote(snapshot)); putCheckedNote(tx,result,failure=>error=failure);
        } catch (failure) { error = failure as Error; tx.abort(); }
      };
    };
    tx.oncomplete = () => { note.storageRevision = result.storageRevision; resolve(result); };
    tx.onerror = () => reject(error || new Error('保存失败：请导出备份并检查剩余存储空间'));
    tx.onabort = () => reject(error || new Error('保存中断，原稿未被替换'));
  });
}
export async function permanentDeleteNote(id: string): Promise<void> {
 const db=await openNotebookDatabase();return new Promise((resolve,reject)=>{
  const tx=db.transaction(['notes','tombstones','documentTasks','binaryResources'],'readwrite'),reads={notes:tx.objectStore('notes').getAll(),tasks:tx.objectStore('documentTasks').getAll(),resources:tx.objectStore('binaryResources').getAllKeys()};let error:Error|undefined,remaining=3;
  const done=()=>{if(--remaining)return;try{const original=reads.notes.result.find((n:Note)=>n.id===id);if(original&&!original.deletedAt)throw new Error('请先将笔记移入回收站，再永久删除');const otherNotes=reads.notes.result.filter((n:Note)=>n.id!==id),otherTasks=reads.tasks.result.filter((t:{noteId:string})=>t.noteId!==id),keep=binaryResourceReferences([otherNotes,otherTasks]);tx.objectStore('tombstones').put({id,deletedAt:new Date().toISOString()});tx.objectStore('notes').delete(id);for(const task of reads.tasks.result)if(task.noteId===id)tx.objectStore('documentTasks').delete(task.id);for(const resource of reads.resources.result)if(typeof resource==='string'&&!keep.has(resource))tx.objectStore('binaryResources').delete(resource);}catch(failure){error=failure as Error;tx.abort();}};
  for(const request of Object.values(reads))request.onsuccess=done;tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(error||new Error('永久删除失败，笔记、任务和资源保持原状'));
 });
}
