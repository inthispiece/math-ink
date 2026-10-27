import {openNotebookDatabase} from './model.ts';
import {getNote,NoteDeletedError} from './notebook-repository.ts';
import type {Notebook} from './notebook-domain.ts';
import {validateDocumentTask,type DocumentTask} from './document-model.ts';

export interface DocumentTaskRepository {
  get(id:string):Promise<DocumentTask|null>;
  list(noteId?:string):Promise<DocumentTask[]>;
  create(task:DocumentTask):Promise<DocumentTask>;
  update(id:string,change:(task:DocumentTask)=>void):Promise<DocumentTask|null>;
  owner(noteId:string):Promise<Notebook|null>;
}
async function list(noteId?:string):Promise<DocumentTask[]>{const db=await openNotebookDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction(['documentTasks','tombstones'],'readonly'),read=tx.objectStore('documentTasks').getAll(),dead=tx.objectStore('tombstones').getAllKeys();let result:DocumentTask[]=[];tx.oncomplete=()=>{try{const tombstones=new Set(dead.result);result=read.result.filter((task:DocumentTask)=>(!noteId||task.noteId===noteId)&&!tombstones.has(task.noteId));result.forEach(validateDocumentTask);resolve(structuredClone(result));}catch(error){reject(error);}};tx.onerror=()=>reject(new Error('无法读取整文档任务'));});}
async function write(id:string,create:DocumentTask|undefined,change?:(task:DocumentTask)=>void):Promise<DocumentTask|null>{
  const db=await openNotebookDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction(['documentTasks','notes','tombstones'],'readwrite'),store=tx.objectStore('documentTasks');let result:DocumentTask|null=null,failure:unknown;
    const read=store.get(id);read.onsuccess=()=>{try{const task=read.result as DocumentTask|undefined;if(create&&task)throw new Error('整文档任务标识已存在');if(!task&&!create)return;const candidate=structuredClone(task||create!);const dead=tx.objectStore('tombstones').get(candidate.noteId);dead.onsuccess=()=>{if(dead.result){failure=new NoteDeletedError();tx.abort();return;}const owner=tx.objectStore('notes').get(candidate.noteId);owner.onsuccess=()=>{try{if(!owner.result)throw new NoteDeletedError();if(create&&owner.result.deletedAt)throw new Error('原笔记已移入回收站，未启动识别');change?.(candidate);candidate.updatedAt=new Date().toISOString();candidate.revision=(task?.revision??-1)+1;validateDocumentTask(candidate);result=candidate;store.put(candidate);}catch(error){failure=error;tx.abort();}};};}catch(error){failure=error;tx.abort();}};
    tx.oncomplete=()=>resolve(result&&structuredClone(result));tx.onerror=()=>reject(failure||new Error('文档任务保存失败，请导出收到的结果后重试本地保存'));tx.onabort=()=>reject(failure||new Error('文档任务保存中断，原请求不会自动重发'));
  });
}
export const documentTaskRepository:DocumentTaskRepository={
  async get(id){const db=await openNotebookDatabase();const task=await new Promise<DocumentTask|null>((resolve,reject)=>{const request=db.transaction('documentTasks','readonly').objectStore('documentTasks').get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(new Error('无法读取整文档任务'));});if(!task)return null;const owner=await getNote(task.noteId);if(!owner)return null;validateDocumentTask(task);return structuredClone(task);},
  list,create:async task=>(await write(task.id,task))!,update:async(id,change)=>write(id,undefined,change),owner:getNote,
};
