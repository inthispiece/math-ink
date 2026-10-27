import type { Note, ModelProvider } from './model.ts';
import type { Notebook } from './notebook-domain.ts';
import type { SourceRef } from './page-model.ts';
import type { FullPageImage } from './page-render.ts';

export type DocumentPageMode='image'|'copied'|'blank';
export type DocumentPagePhase='unsubmitted'|'submitting'|'running'|'completed'|'failed'|'unknown'|'unavailable'|'cancelled'|'copied'|'blank';
export type DocumentSavePhase='input-pending'|'input-saved'|'raw-saved'|'parsed'|'save-failed'|'parse-failed';
export interface DocumentIdentity {gateway:string;provider:ModelProvider;installationId:string;principal:string}
export interface DocumentReply {taskId?:string;provider?:string;sourceRevision?:number;status?:string;result?:unknown;error?:{code?:string;message?:string};usage?:{inputTokens:number;outputTokens:number};cost?:unknown}
export interface DocumentPageResult {
  id:string;pageId:string;index:number;title:string;mode:DocumentPageMode;source:SourceRef;
  sourceRevision:number;sourcePageRevision:number;phase:DocumentPagePhase;savePhase:DocumentSavePhase;
  input?:FullPageImage;content?:Note;clientRequestId:string;remoteId?:string;submittedAt?:string;
  rawReply?:DocumentReply;parseVersion?:number;error?:string;attempts:{clientRequestId:string;remoteId?:string;phase:DocumentPagePhase;at:string}[];
}
export interface DocumentArchiveReceipt {key:string;operationId:string;resultVersion:number;kind:'draft'|'note'|'insert';noteId:string;draftId?:string;pageIds?:string[];createdAt:string}
export interface DocumentTask {
  id:string;noteId:string;title:string;folderId:string|null;identity:DocumentIdentity;frozen:Notebook;
  sourceRevision:number;sourceStorageRevision:number;pages:DocumentPageResult[];
  phase:'ready'|'running'|'paused'|'partial'|'completed'|'cancelled'|'waiting-connection';
  resultVersion:number;revision:number;createdAt:string;updatedAt:string;pauseReason?:string;
  receipts:DocumentArchiveReceipt[];resumeRequiresConfirmation?:boolean;
}
export interface DocumentDraftPage {id:string;sourcePageId:string;sourceRevision:number;source:SourceRef;snapshotId?:string;status:'completed'|'blank'|'copied'|'failed';content:Note;error?:string}
export interface FrozenDocumentPage {pageId:string;mode:DocumentPageMode;source:SourceRef;image?:FullPageImage;content?:Note}
export interface FrozenDocumentInput {note:Notebook;pages:FrozenDocumentPage[]}
export interface DocumentProgress {total:number;completed:number;failed:number;pending:number;modelPages:number;submitted:number;unsaved:number}
export function documentProgress(task:Pick<DocumentTask,'pages'>):DocumentProgress {
  const completed=task.pages.filter(p=>['completed','copied','blank'].includes(p.phase)&&p.savePhase==='parsed').length;
  const failed=task.pages.filter(p=>['failed','unavailable','cancelled'].includes(p.phase)||p.savePhase==='parse-failed').length;
  return{total:task.pages.length,completed,failed,pending:task.pages.length-completed-failed,modelPages:task.pages.filter(p=>p.mode==='image').length,submitted:task.pages.filter(p=>p.mode==='image'&&p.phase!=='unsubmitted').length,unsaved:task.pages.filter(p=>p.savePhase==='save-failed').length};
}
export function documentPhase(task:Pick<DocumentTask,'pages'|'phase'>):DocumentTask['phase'] {
  if(task.phase==='cancelled')return'cancelled';const p=documentProgress(task);
  return p.completed===p.total?'completed':p.pending===0?'partial':task.phase==='running'?'running':task.phase==='waiting-connection'?'waiting-connection':task.phase==='ready'?'ready':'paused';
}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function assertNoDocumentCredentials(value:unknown):void {
  const visit=(v:unknown,depth:number)=>{if(depth>64)throw new Error('文档任务结构过深');if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(c=>visit(c,depth+1));return;}for(const[key,child]of Object.entries(v)){if(/^(?:api_?key|app_?key|authorization|password|secret|access_?token|pairing_?token|session_?token|credential|token)$/i.test(key))throw new Error('文档任务不能保存服务凭据');visit(child,depth+1);}};visit(value,0);
}
/** Pure backup/store boundary validation; credentials are never part of a task. */
export function validateDocumentTask(value:unknown):asserts value is DocumentTask {
  assertNoDocumentCredentials(value);
  if(!object(value)||!id(value.id)||!id(value.noteId)||typeof value.title!=='string'||!(value.folderId===null||id(value.folderId))||!object(value.identity)||!['deepseek','ollama','mathpix'].includes(String(value.identity.provider))||!['gateway','installationId','principal'].every(k=>typeof(value.identity as Record<string,unknown>)[k]==='string')||!object(value.frozen)||value.frozen.id!==value.noteId||!integer(value.sourceRevision)||!integer(value.sourceStorageRevision)||!integer(value.resultVersion)||!integer(value.revision)||!date(value.createdAt)||!date(value.updatedAt)||!['ready','running','paused','partial','completed','cancelled','waiting-connection'].includes(String(value.phase))||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>2000||!Array.isArray(value.receipts))throw new Error('文档任务格式无效');
  const ids=new Set<string>(),pages=new Set<string>();
  for(const raw of value.pages){if(!object(raw)||!id(raw.id)||!id(raw.pageId)||ids.has(raw.id)||pages.has(raw.pageId)||!integer(raw.index)||typeof raw.title!=='string'||!['image','copied','blank'].includes(String(raw.mode))||!['unsubmitted','submitting','running','completed','failed','unknown','unavailable','cancelled','copied','blank'].includes(String(raw.phase))||!['input-pending','input-saved','raw-saved','parsed','save-failed','parse-failed'].includes(String(raw.savePhase))||!integer(raw.sourceRevision)||!integer(raw.sourcePageRevision)||typeof raw.clientRequestId!=='string'||!raw.clientRequestId||!object(raw.source)||raw.source.noteId!==value.noteId||raw.source.pageId!==raw.pageId||!Array.isArray(raw.attempts))throw new Error('文档逐页任务或来源无效');ids.add(raw.id);pages.add(raw.pageId);
    if(raw.input!==undefined){const image=raw.input as FullPageImage;if(!image||typeof image.imageUrl!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image.imageUrl)||typeof image.imageBase64!=='string'||image.imageUrl.split(',')[1]!==image.imageBase64||!image.bounds||![image.bounds.x,image.bounds.y,image.bounds.width,image.bounds.height].every(Number.isFinite)||image.bounds.width<=0||image.bounds.height<=0)throw new Error('文档逐页输入快照无效');}
    if(raw.phase==='completed'&&(raw.savePhase!=='parsed'||!object(raw.content)))throw new Error('文档成功页缺少持久化排版内容');
    if(raw.rawReply!==undefined&&!object(raw.rawReply))throw new Error('文档原始响应无效');
  }
  const receiptKeys=new Set<string>();for(const raw of value.receipts){if(!object(raw)||typeof raw.key!=='string'||receiptKeys.has(raw.key)||typeof raw.operationId!=='string'||!integer(raw.resultVersion)||!['draft','note','insert'].includes(String(raw.kind))||!id(raw.noteId)||!date(raw.createdAt))throw new Error('文档归档回执无效');receiptKeys.add(raw.key);}
}
