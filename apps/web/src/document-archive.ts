import {newId,newNote,normalizeNote,openNotebookDatabase,type Note} from './model.ts';
import {ensureNotebook,addPage,createDraft,type Notebook} from './notebook-domain.ts';
import {ensurePageModel,orderedBlocks,createParagraphBlock,updateBlock,type Page,type SourceRef} from './page-model.ts';
import {manuscriptDigest} from './source-copy.ts';
import {NoteDeletedError} from './notebook-repository.ts';
import {validateDocumentTask,type DocumentTask,type DocumentDraftPage,type DocumentArchiveReceipt,type DocumentPageResult} from './document-model.ts';

const clone=<T>(v:T):T=>structuredClone(v),at=()=>new Date().toISOString();
export interface DocumentArchiveOptions {kind:'draft'|'note';operationId:string;resultVersion?:number;title?:string;folderId?:string|null;allowPartial?:boolean}
export interface DocumentArchiveResult {note:Notebook;receipt:DocumentArchiveReceipt;reused:boolean}
export interface DocumentInsertionReceipt {operationId:string;noteId:string;draftId:string;pageIds:string[];insertionIds:string[];previousCurrentPageId:string;createdAt:string}
export const documentArchiveKey=(taskId:string,version:number,kind:string,operationId:string)=>manuscriptDigest([taskId,version,kind,operationId].join('\0'));

/** A one-page content document. No owner library metadata or unrelated drafts. */
export function isolatedFormalPage(origin:Note,pageId:string,title=origin.title):Note {
  const original=ensureNotebook(clone(origin)),page=original.pages.find(p=>p.id===pageId);if(!page)throw new Error('冻结来源页不存在');
  const n=ensureNotebook(newNote());n.title=title;n.pages=[];n.pageOrder=[];n.pageStrokes={};n.pageViews={};n.blocks=[];n.formulas=[];n.sources=[];n.markdown='';n.drafts=[];n.tasks=[];n.suggestions=[];n.links=[];n.resources={};n.insertions=[];n.placements=[];n.inkEngine='experimental';delete n.butterflyData;delete n.butterflyPageRevisions;delete n.butterflyContentRevisions;
  const target:Page={id:newId(),noteId:n.id,nativePageId:'default',kind:'typeset',paper:'blank',sourceRevision:0,revision:0,blockOrder:[],title};n.pages=[target];n.pageOrder=[target.id];n.currentPageId=target.id;n.pageStrokes[target.id]=[];n.pageViews[target.id]={zoom:1,panX:0,panY:0};n.butterflyPage='default';
  appendContent(n,original,page,target);return ensurePageModel(n);
}
/** Clone canonical blocks/formulas/sources with independent IDs, preserving external provenance. */
function appendContent(target:Notebook,origin:Note,sourcePage:Page,page:Page,fallback?:SourceRef):void {
  const blocks=orderedBlocks(origin,sourcePage.id),formulaIds=new Map<string,string>(),sourceIds=new Map<string,string>();
  const sameOrigin=(source:SourceRef,other:SourceRef)=>source.noteId===other.noteId&&source.pageId===other.pageId&&source.nativePageId===other.nativePageId&&source.sourceRevision===other.sourceRevision&&(!source.nativeRevision||!other.nativeRevision||source.nativeRevision===other.nativeRevision);
  const references=new Set(blocks.flatMap(b=>b.sourceRefIds));for(const b of blocks){if(b.content.formulaId)references.add(origin.formulas.find(f=>f.id===b.content.formulaId)?.sourceRefId||'');for(const run of b.content.runs||[])if(run.type==='formula')references.add(origin.formulas.find(f=>f.id===run.formulaId)?.sourceRefId||'');}
  for(const original of origin.sources||[])if(references.has(original.id)){const source=clone(original);source.id=newId();if(fallback?.snapshotResourceId&&!source.snapshotResourceId&&sameOrigin(source,fallback))source.snapshotResourceId=fallback.snapshotResourceId;target.sources.push(source);sourceIds.set(original.id,source.id);}
  let fallbackId:string|undefined;const fallbackSource=()=>{if(!fallback)return undefined;if(!fallbackId){const value=clone(fallback);value.id=newId();fallbackId=value.id;target.sources.push(value);}return fallbackId;};
  const formula=(id:string)=>{if(formulaIds.has(id))return formulaIds.get(id)!;const value=origin.formulas.find(f=>f.id===id);if(!value)throw new Error('结果页缺少行内或独立公式');const copy=clone(value);copy.id=newId();copy.inline=true;copy.sourceRefId=copy.sourceRefId?sourceIds.get(copy.sourceRefId)||fallbackSource():fallbackSource();copy.sourcePage=page.nativePageId;target.formulas.push(copy);formulaIds.set(id,copy.id);return copy.id;};
  for(const original of blocks){const block=clone(original);block.id=newId();block.pageId=page.id;if(block.content.formulaId)block.content.formulaId=formula(block.content.formulaId);if(block.content.runs)block.content.runs=block.content.runs.map(run=>run.type==='formula'?{type:'formula',formulaId:formula(run.formulaId)}:run);block.sourceRefIds=block.sourceRefIds.map(id=>sourceIds.get(id)).filter((id):id is string=>!!id);if(fallback&&!block.sourceRefIds.some(id=>{const source=target.sources.find(s=>s.id===id);return source&&sameOrigin(source,fallback);})){const source=fallbackSource();if(source)block.sourceRefIds.unshift(source);}delete block.contentHash;target.blocks.push(block);page.blockOrder.push(block.id);}
}
function resultContent(task:DocumentTask,page:DocumentPageResult):Note {
  if(page.content)return clone(page.content);
  if(page.mode==='copied')return isolatedFormalPage(task.frozen,page.pageId,page.title);
  const content=isolatedFormalPage(task.frozen,page.pageId,page.title),n=ensureNotebook(content);n.blocks=[];n.formulas=[];n.sources=[];n.pages.forEach(p=>p.blockOrder=[]);n.markdown='';
  if(page.mode==='blank')return n;
  if(!page.input)throw new Error('未完成页缺少冻结原图，不能归档成空白占位');
  const reason=page.error||'此页尚未完成识别，保留原图，可手工补录。';createParagraphBlock(n,'未完成识别：'+reason,n.pages[0].id);
  if(page.input){const block=createParagraphBlock(n,'',n.pages[0].id);updateBlock(n,block.id,{type:'image',content:{imageDataUrl:page.input.imageUrl,caption:'原页位置保留；此页未作为成功识别结果。'},needsReview:true});}
  return n;
}
export function documentResultPages(task:DocumentTask,allowPartial=false):DocumentDraftPage[]{
  if(!allowPartial&&task.pages.some(p=>!['completed','copied','blank'].includes(p.phase)||p.savePhase!=='parsed'))throw new Error('文档尚有未完成页，请明确选择保存部分结果；失败页将保留原位置和原图说明。');
  return task.pages.map(p=>({id:p.id,sourcePageId:p.pageId,sourceRevision:p.sourcePageRevision,source:clone(p.source),...(p.input?{snapshotId:'snapshot-'+manuscriptDigest(p.input.imageUrl)}:{}),status:p.phase==='copied'?'copied':p.phase==='blank'?'blank':p.phase==='completed'?'completed':'failed',content:resultContent(task,p),...(!['completed','copied','blank'].includes(p.phase)?{error:p.error||'此页未完成识别'}:{})}));
}
function copyResources(target:Notebook,task:DocumentTask,pages:DocumentDraftPage[]):void {
  const required=new Set(pages.flatMap(p=>[p.snapshotId,...(p.content.sources||[]).map(s=>s.snapshotResourceId)].filter((id):id is string=>!!id)));
  for(const page of task.pages)if(page.input){const id='snapshot-'+manuscriptDigest(page.input.imageUrl);if(required.has(id))target.resources[id]??={id,dataUrl:page.input.imageUrl,createdAt:at()};}
  for(const key of required)if(!target.resources[key]){const original=task.frozen.resources[key];if(original)target.resources[key]=clone(original);else throw new Error('归档缺少历史原稿快照，未创建不完整副本');}
}
export function buildDocumentDraft(owner:Notebook,task:DocumentTask,options:DocumentArchiveOptions):{note:Notebook;receipt:DocumentArchiveReceipt}{
  const note=ensureNotebook(clone(owner)),version=options.resultVersion??task.resultVersion,key=documentArchiveKey(task.id,version,'draft',options.operationId),pages=documentResultPages(task,!!options.allowPartial);if(version!==task.resultVersion)throw new Error('任务结果版本已变化，请重新核对归档范围');copyResources(note,task,pages);
  const id='document-'+key.slice(0,40),existing=note.drafts.find(d=>d.id===id);
  if(!existing)createDraft(note,{id,type:'document',title:options.title||task.title+' · 整文档识别',sourcePageId:task.pages[0].pageId,sourceRevision:task.pages[0].sourcePageRevision,source:clone(task.pages[0].source),snapshotIds:[...new Set(pages.map(p=>p.snapshotId).filter((id):id is string=>!!id))],status:pages.some(p=>p.status==='failed')?'partial':'completed',version:1,reviewed:false,unread:true,documentPages:pages,result:{documentTaskId:task.id,resultVersion:version}});
  return{note,receipt:{key,operationId:options.operationId,resultVersion:version,kind:'draft',noteId:note.id,draftId:id,createdAt:at()}};
}
export function buildIndependentDocumentNote(task:DocumentTask,options:DocumentArchiveOptions):{note:Notebook;receipt:DocumentArchiveReceipt}{
  const version=options.resultVersion??task.resultVersion,key=documentArchiveKey(task.id,version,'note',options.operationId),pages=documentResultPages(task,!!options.allowPartial);if(version!==task.resultVersion)throw new Error('任务结果版本已变化，请重新核对归档范围');
  const note=ensureNotebook(newNote());note.id='recognized-'+key.slice(0,40);note.title=options.title?.trim()||task.title+' · 识别版';note.folderId=options.folderId===undefined?task.folderId:options.folderId;note.folderRevision=0;note.pages=[];note.pageOrder=[];note.pageStrokes={};note.pageViews={};note.blocks=[];note.formulas=[];note.sources=[];note.markdown='';note.drafts=[];note.tasks=[];note.suggestions=[];note.links=[];note.resources={};note.insertions=[];note.placements=[];note.binaryResourceIds=[];note.inkEngine='experimental';note.butterflyPage='default';delete note.butterflyData;delete note.butterflyPageRevisions;delete note.butterflyContentRevisions;
  copyResources(note,task,pages);
  for(const[pIndex,result]of pages.entries()){
    const page:Page={id:newId(),noteId:note.id,nativePageId:pIndex===0?'default':'typeset-'+newId(),sourceRevision:0,revision:0,kind:'typeset',paper:'blank',blockOrder:[],title:task.pages[pIndex].title,recognitionOrigin:{kind:'document',batchId:task.id,sourcePageId:result.sourcePageId}};
    note.pages.push(page);note.pageOrder.push(page.id);note.pageStrokes[page.id]=[];note.pageViews[page.id]={zoom:1,panX:0,panY:0};
    const fallback={...clone(result.source),...(result.snapshotId?{snapshotResourceId:result.snapshotId}:{})};for(const sourcePage of ensurePageModel(result.content).pages)appendContent(note,result.content,sourcePage,page,fallback);
  }
  note.currentPageId=note.pages[0].id;note.strokes=[];note.updatedAt=at();return{note:ensureNotebook(note),receipt:{key,operationId:options.operationId,resultVersion:version,kind:'note',noteId:note.id,pageIds:[...note.pageOrder],createdAt:at()}};
}
/** Batch insertion preserves page boundaries and records one host command receipt. */
export function insertDocumentDraft(note:Note,draftId:string,afterPageId:string,operationId:string,selectedPageIds?:string[]):DocumentInsertionReceipt {
  const n=ensureNotebook(note),draft=n.drafts.find(d=>d.id===draftId&&!d.deletedAt);if(!draft||draft.type!=='document'||!draft.documentPages?.length)throw new Error('整文档草稿不存在或没有页面');
  const previous=n.currentPageId,pages=draft.documentPages.filter(p=>!selectedPageIds||selectedPageIds.includes(p.id));if(!pages.length)throw new Error('请选择至少一页');
  const old=n.insertions.filter(i=>i.operationId.startsWith(operationId+':'));if(old.length)return{operationId,noteId:n.id,draftId,pageIds:old.map(i=>i.pageId),insertionIds:old.map(i=>i.id),previousCurrentPageId:previous,createdAt:old[0].createdAt};
  if(!n.pages.some(p=>p.id===afterPageId&&!p.deletedAt))throw new Error('插入位置已删除');let after=afterPageId;const result:DocumentInsertionReceipt={operationId,noteId:n.id,draftId,pageIds:[],insertionIds:[],previousCurrentPageId:previous,createdAt:at()};
  for(const entry of pages){const page=addPage(n,{afterPageId:after,kind:'typeset',paper:'blank',title:draft.title});page.recognitionOrigin={kind:'document',draftId,taskId:draft.taskId,sourcePageId:entry.sourcePageId};const source={...clone(entry.source),...(entry.snapshotId?{snapshotResourceId:entry.snapshotId}:{})};for(const original of ensurePageModel(entry.content).pages)appendContent(n,entry.content,original,page,source);const insertion={id:newId(),draftId,draftVersion:draft.version,operationId:operationId+':'+entry.id,pageId:page.id,kind:'page' as const,snapshotIds:entry.snapshotId?[entry.snapshotId]:[],createdAt:result.createdAt};n.insertions.push(insertion);draft.uses.push({id:insertion.id,operationId:insertion.operationId,pageId:page.id,version:draft.version,instanceId:page.id,kind:'page',createdAt:result.createdAt,insertedAt:result.createdAt});result.pageIds.push(page.id);result.insertionIds.push(insertion.id);after=page.id;}
  n.revision++;n.contentRevision++;n.updatedAt=at();return result;
}
export function applyDocumentInsertionHistory(note:Note,receipt:DocumentInsertionReceipt,direction:'undo'|'redo'):boolean {
  const n=ensureNotebook(note);if(n.id!==receipt.noteId)throw new Error('不能对另一篇笔记应用插页历史');const pages=receipt.pageIds.map(id=>n.pages.find(p=>p.id===id));if(pages.some(p=>!p))throw new Error('插入页已永久缺失，历史未消费');const undo=direction==='undo';if(pages.every(p=>!!p!.deletedAt===undo))return false;const timestamp=at();
  for(const page of pages){if(undo)page!.deletedAt=timestamp;else delete page!.deletedAt;}
  for(const insertion of n.insertions.filter(i=>receipt.insertionIds.includes(i.id))){if(undo)insertion.undoneAt=timestamp;else delete insertion.undoneAt;const use=n.drafts.find(d=>d.id===receipt.draftId)?.uses.find(u=>u.id===insertion.id);if(use){if(undo)use.undoneAt=timestamp;else delete use.undoneAt;}}
  if(undo&&receipt.pageIds.includes(n.currentPageId)){const fallback=n.pages.find(p=>p.id===receipt.previousCurrentPageId&&!p.deletedAt)||n.pages.find(p=>!p.deletedAt);if(fallback){n.currentPageId=fallback.id;n.strokes=n.pageStrokes[fallback.id]||[];}}
  n.revision++;n.contentRevision++;n.updatedAt=timestamp;return true;
}
/** Notes, references and archival receipt commit atomically. Retrying cannot create a duplicate. */
export async function archiveDocumentTask(taskId:string,options:DocumentArchiveOptions):Promise<DocumentArchiveResult> {
  const db=await openNotebookDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction(['documentTasks','notes','tombstones','folders'],'readwrite'),tasks=tx.objectStore('documentTasks'),notes=tx.objectStore('notes');let failure:unknown,result:DocumentArchiveResult;
    const request=tasks.get(taskId);request.onsuccess=()=>{try{if(!request.result)throw new Error('文档任务不存在或已永久删除');const task=request.result as DocumentTask;validateDocumentTask(task);const version=options.resultVersion??task.resultVersion,key=documentArchiveKey(task.id,version,options.kind,options.operationId);const dead=tx.objectStore('tombstones').get(task.noteId);dead.onsuccess=()=>{if(dead.result){failure=new NoteDeletedError();tx.abort();return;}const owner=notes.get(task.noteId);owner.onsuccess=()=>{try{if(!owner.result)throw new NoteDeletedError();const prior=task.receipts.find(r=>r.key===key);if(prior){const saved=notes.get(prior.noteId);saved.onsuccess=()=>{if(!saved.result){failure=new Error('之前的归档产物已删除；请明确另存副本，不会重复原操作');tx.abort();return;}result={note:ensureNotebook(normalizeNote(saved.result)),receipt:clone(prior),reused:true};};return;}
      const product=options.kind==='draft'?buildDocumentDraft(ensureNotebook(normalizeNote(owner.result)),task,options):buildIndependentDocumentNote(task,options);const folderId=product.note.folderId;
      const commit=()=>{try{product.note.storageRevision=(options.kind==='draft'?owner.result.storageRevision||0:0)+1;const normalized=ensureNotebook(normalizeNote(product.note));task.receipts.push(product.receipt);task.updatedAt=at();task.revision++;validateDocumentTask(task);notes.put(normalized);tasks.put(task);result={note:normalized,receipt:product.receipt,reused:false};}catch(error){failure=error;tx.abort();}};
      if(options.kind==='note'){const existing=notes.get(product.note.id);existing.onsuccess=()=>{if(existing.result){failure=new Error('独立笔记标识冲突，未覆盖现有内容');tx.abort();return;}const tomb=tx.objectStore('tombstones').get(product.note.id);tomb.onsuccess=()=>{if(tomb.result){failure=new Error('该归档副本已永久删除，请明确另存副本');tx.abort();return;}if(folderId){const folder=tx.objectStore('folders').get(folderId);folder.onsuccess=()=>{if(!folder.result){failure=new Error('目标文件夹已删除，请改选未分类');tx.abort();return;}commit();};}else commit();};};}else commit();
    }catch(error){failure=error;tx.abort();}};};}catch(error){failure=error;tx.abort();}};
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||new Error('归档保存失败，任务结果仍保留，可重试保存'));tx.onerror=()=>reject(failure||new Error('归档保存失败，请导出结果保护内容'));
  });
}
