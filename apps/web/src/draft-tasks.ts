import { newId, type Note } from './model.ts';
import { ensurePageModel,createSuggestion,createParagraphBlock } from './page-model.ts';
import { requestJson } from './recognition-request.ts';
import { getNote, updateNote, NoteDeletedError } from './notebook-repository.ts';
import { createDraft, addSnapshot, ensureNotebook, type Draft, type DraftKind, type Notebook, type NotebookTask } from './notebook-domain.ts';
import { pageDraftContent, addReviewSuggestions, record } from './draft-content.ts';
import type { FullPageImage } from './page-render.ts';
import type { SourceRef } from './page-model.ts';
import { ConnectionVault, type Connection } from './connection-vault.ts';
import { manuscriptDigest } from './source-copy.ts';

interface Start { noteId:string;kind:DraftKind;title:string;connection:Connection;source:SourceRef;sourcePageId:string;sourceRevision:number;sourceNativeRevision?:string;image?:FullPageImage;content?:Note;request?:unknown }
interface Reply { taskId?:string;type?:string;provider?:string;status?:string;sourceRevision?:number;result?:unknown;error?:{code?:string;message?:string};usage?:{inputTokens:number;outputTokens:number};cost?:unknown }
interface Options { vault:ConnectionVault;saved:(note:Notebook,draftId:string,completed:boolean)=>void;notify:(message:string)=>void }
class KnownTaskFailure extends Error {}
class TaskReplyMismatch extends Error {}
type TaskRepository = Pick<typeof import('./notebook-repository.ts'), 'getNote'|'updateNote'>;
const now=()=>new Date().toISOString();
const contentFingerprint=(latex:string|undefined,content:Note|undefined)=>manuscriptDigest(JSON.stringify([latex??null,content?{blocks:content.blocks?.map(b=>({id:b.id,type:b.type,content:b.content,sourceRefIds:b.sourceRefIds})),formulas:content.formulas.map(f=>[f.id,f.latex]),markdown:content.markdown}:null]));
const remoteTypes:Record<DraftKind,string>={formula:'formula-transcribe',page:'page-transcribe',organization:'organize',review:'context-review',links:'knowledge-links',proof:'proof-assist'};
function verifyReply(task:NotebookTask,reply:Reply):void {
  const expectedId=task.remoteId||(record(task.request).formulaCheck?task.clientRequestId:undefined);
  if(typeof reply.taskId!=='string'||!reply.taskId||reply.provider!==task.provider||(expectedId&&reply.taskId!==expectedId))throw new TaskReplyMismatch('返回结果与原任务或后端不符，未采用结果；不会自动重新识别。');
  if(!Number.isSafeInteger(reply.sourceRevision)||reply.sourceRevision!==(task.sourceRevision??0))throw new TaskReplyMismatch('返回结果与原稿版本不符，未采用结果；不会自动重新识别。');
}
/** Application lifetime tasks, independent of views. Resume is GET-only; POST requires an explicit user action. */
export class DraftTaskManager {
  private options:Options;private running=new Map<string,AbortController>();
  private repository:TaskRepository;
  private unsaved=new Map<string,{noteId:string;draftId:string;reply:Reply}>();
  constructor(options:Options,repository:TaskRepository={getNote,updateNote}){this.options=options;this.repository=repository;window.addEventListener('online',()=>void this.resumeAll());}
  async start(input:Start):Promise<string>{const id=newId(),requestId=newId();const task:NotebookTask={kind:input.kind,clientRequestId:requestId,provider:input.connection.provider,gateway:input.connection.gateway,installationId:input.connection.installationId,principal:input.connection.principal,phase:'pending',request:input.request||{},createdAt:now(),updatedAt:now(),sourceRevision:input.source.sourceRevision,sourceHash:input.sourceNativeRevision,contentFingerprint:contentFingerprint(undefined,input.content)};
    const note=await this.repository.updateNote(input.noteId,n=>{const snapshotIds=input.image?[addSnapshot(n,input.image.imageUrl)]:[];createDraft(n,{id,type:input.kind,title:input.title,sourcePageId:input.sourcePageId,sourceRevision:input.sourceRevision,sourceNativeRevision:input.sourceNativeRevision,source:input.source,snapshotIds,task,taskId:requestId,content:input.content,version:0,status:'pending',unread:false});},{preserveEditedAt:true});if(!note)throw new Error('笔记不存在，未提交识别。');this.options.saved(note,id,false);void this.submit(input.noteId,id,input.image);return id;
  }
  async resumeAll(){const {loadNotes}=await import('./model');for(const note of await loadNotes())for(const draft of note.drafts||[])if(draft.task&&['pending','running','unknown','waiting-connection','partial'].includes(draft.status))void this.query(note.id,draft.id);}
  private key(noteId:string,draftId:string){return noteId+':'+draftId;}
  private async patch(noteId:string,draftId:string,change:(draft:Draft,note:Notebook)=>void){const n=await this.repository.updateNote(noteId,n=>{const d=n.drafts.find(d=>d.id===draftId);if(!d)throw new Error('草稿已永久删除');if(d.status==='cancelled')return;change(d,n);if(d.task)d.task.updatedAt=now();},{allowDeleted:true,preserveEditedAt:true});if(n)this.options.saved(n,draftId,false);return n;}
  private async submit(noteId:string,draftId:string,image?:FullPageImage){const key=this.key(noteId,draftId);if(this.running.has(key))return;const controller=new AbortController();this.running.set(key,controller);
    try{let note=await this.repository.getNote(noteId),draft=note?.drafts.find(d=>d.id===draftId);if(!note||!draft?.task||draft.status==='cancelled')return;const task=draft.task,token=await this.options.vault.tokenFor(task);if(token===null)throw new Error('等待恢复原服务和账号连接');
      const runningNote=await this.patch(noteId,draftId,d=>{d.status='running';d.task!.phase='running';});if(controller.signal.aborted||runningNote?.drafts.find(d=>d.id===draftId)?.status==='cancelled')return;
      const formulaCheck=record(record(task.request).formulaCheck);
      if(typeof formulaCheck.latex==='string'){
        const {response,data}=await requestJson<Record<string,unknown>>(`${task.gateway}/v1/review`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({clientRequestId:task.clientRequestId,installationId:task.installationId,provider:task.provider,sourceRevision:task.sourceRevision||0,latex:formulaCheck.latex,context:formulaCheck.context||''}),signal:controller.signal},{timeoutMs:240000});
        const review=record(data?.review);if(!response.ok||data?.status!=='ok'||data.provider!==task.provider||data.simulated!==false||data.originalLatex!==formulaCheck.latex||typeof review.summary!=='string'||!Array.isArray(review.issues)||(review.suggestedLatex!==null&&typeof review.suggestedLatex!=='string'))throw new KnownTaskFailure(String(record(data?.error).message||'公式检查未返回有效建议，原式已保留。'));
        if(data.sourceRevision!==(task.sourceRevision??0))throw new TaskReplyMismatch('公式检查结果与原稿版本不符，原式已保留。');
        await this.receive(noteId,draftId,{taskId:task.clientRequestId,provider:task.provider,sourceRevision:data.sourceRevision as number,status:'ok',result:{formulaCheck:true,originalLatex:formulaCheck.latex,...review},usage:data.usage as Reply['usage'],cost:data.cost});return;
      }
      const body=task.kind==='formula'?{clientRequestId:task.clientRequestId,installationId:task.installationId,provider:task.provider,sourceRevision:task.sourceRevision||0,imageBase64:image?.imageBase64}:{clientRequestId:task.clientRequestId,installationId:task.installationId,provider:task.provider,sourceRevision:task.sourceRevision||0,type:remoteTypes[task.kind],input:{...record(record(task.request).input||task.request),...(image?{imageBase64:image.imageBase64}:{})}};
      const {response,data}=await requestJson<Reply>(`${task.gateway}/v1/${task.kind==='formula'?'recognitions':'tasks'}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:controller.signal},{timeoutMs:20000});
      if(!response.ok)throw new KnownTaskFailure(data?.error?.message||`提交被服务拒绝（${response.status}），可保留原稿并检查配置。`);
      if(!data?.taskId)throw new Error('提交结果未知，请先查询原任务；未自动重发。');
      verifyReply(task,data);await this.patch(noteId,draftId,d=>{d.task!.remoteId=data.taskId;});
      if(data.status==='ok'||data.status==='error'||data.status==='result-unavailable')await this.receive(noteId,draftId,data);else await this.poll(noteId,draftId,controller);
    }catch(error){await this.fail(noteId,draftId,error,error instanceof KnownTaskFailure);}finally{this.running.delete(key);}
  }
  async query(noteId:string,draftId:string){const key=this.key(noteId,draftId);if(this.running.has(key))return;const controller=new AbortController();this.running.set(key,controller);try{await this.poll(noteId,draftId,controller);}catch(error){await this.fail(noteId,draftId,error,false);}finally{this.running.delete(key);}}
  private async poll(noteId:string,draftId:string,controller:AbortController){const deadline=Date.now()+300000;while(!controller.signal.aborted){const note=await this.repository.getNote(noteId),draft=note?.drafts.find(d=>d.id===draftId);if(!note||!draft?.task||draft.status==='cancelled')return;const task=draft.task;if(record(task.request).formulaCheck){await this.patch(noteId,draftId,d=>{d.status='unknown';d.error='此公式检查接口中断后无法查询结果；不会自动重新调用，明确重做可能再次计费。';d.task!.phase=d.status;});return;}const token=await this.options.vault.tokenFor(task);if(controller.signal.aborted)return;if(token===null){await this.patch(noteId,draftId,d=>{d.status='waiting-connection';d.error='等待恢复原服务和账号连接';d.task!.phase=d.status;});return;}
      const base=`${task.gateway}/v1/${task.kind==='formula'?'recognitions':'tasks'}`,path=task.remoteId?encodeURIComponent(task.remoteId):`by-request/${encodeURIComponent(task.clientRequestId)}`;
      const {response,data}=await requestJson<Reply>(`${base}/${path}?installationId=${encodeURIComponent(task.installationId)}&provider=${task.provider}`,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:controller.signal},{timeoutMs:12000});
      if(response.status===401||response.status===403){await this.patch(noteId,draftId,d=>{d.status='waiting-connection';d.error='原连接已失效，请恢复同一服务与账号后查询';d.task!.phase=d.status;});return;}
      if(response.status===404){await this.patch(noteId,draftId,d=>{d.status='unknown';d.error='未查询到原任务；状态未知，不会自动重新识别。';d.task!.phase=d.status;});return;}
      if(controller.signal.aborted)return;
      if(!response.ok||!data)throw new Error(data?.error?.message||'原任务查询未完成，恢复连接后可再次查询。');verifyReply(task,data);
      if(!task.remoteId)await this.patch(noteId,draftId,d=>{d.task!.remoteId=data.taskId;});
      if(['ok','error','result-unavailable'].includes(data.status||'')){await this.receive(noteId,draftId,data);return;}
      if(Date.now()>deadline){await this.patch(noteId,draftId,d=>{d.status='unknown';d.error='等待时间较长，可稍后查询原任务；不会自动重发。';d.task!.phase=d.status;});return;}
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    }
  }
  private async receive(noteId:string,draftId:string,reply:Reply){const note=await this.repository.getNote(noteId),draft=note?.drafts.find(d=>d.id===draftId);if(!note||!draft?.task||draft.status==='cancelled')return;verifyReply(draft.task,reply);if(['completed','failed'].includes(draft.status)&&draft.task.remoteId===reply.taskId)return;
    if(reply.status!=='ok'){await this.patch(noteId,draftId,d=>{d.status=reply.status==='result-unavailable'?'unknown':reply.error?.code?.includes('CANCELLED')?'cancelled':'failed';d.error=reply.error?.message||(reply.status==='result-unavailable'?'服务未保留原结果，可保留原稿并明确重做；可能再次计费。':'识别未完成');d.task!.phase=d.status;d.result=reply.result;d.usage=reply.usage;d.cost=reply.cost;});return;}
    let content:Note|undefined;let latex:string|undefined;let result=reply.result;
    try{
      if(draft.type==='formula'){const recognition=record(result);if(recognition.simulated!==false||recognition.provider!==draft.task.provider||typeof recognition.latex!=='string'||!recognition.latex.trim())throw new Error('识别没有返回真实的同后端公式，未采用演示内容。');latex=recognition.latex;}
      else if(draft.type==='page'){const resource=note.resources[draft.snapshotIds[0]];if(!resource||!draft.source?.bounds)throw new Error('原稿快照缺失，无法安全建立草稿');const image:FullPageImage={page:draft.source.nativePageId,revision:String(draft.sourceRevision),bounds:draft.source.bounds,strokeIds:draft.source.strokeIds,imageUrl:resource.dataUrl,imageBase64:resource.dataUrl.split(',')[1],transform:draft.source.transform||{scaleX:1,scaleY:1,offsetX:0,offsetY:0}};content=await pageDraftContent(note,draft,result,image);}
      else if(draft.content){content=structuredClone(draft.content);if(draft.type==='review'){
        const check=record(result);if(check.formulaCheck===true){const n=ensurePageModel(content),target=n.blocks.find(b=>b.content.formulaId);if(!target)throw new Error('检查原式缺失');const suggested=check.suggestedLatex;if(typeof suggested==='string'&&suggested.trim()&&suggested!==check.originalLatex)createSuggestion(n,{targetBlockId:target.id,proposed:target.content,proposedLatex:suggested,reason:[check.summary,...(Array.isArray(check.issues)?check.issues:[])].join('；'),category:'mathematics'});}else addReviewSuggestions(content,result);
      }else if(draft.type==='organization'){
        const n=ensurePageModel(content),data=record(result);if(!Array.isArray(data.outline))throw new Error('整理结果缺少内容顺序');const ids=data.outline.map(raw=>String(record(raw).blockId));if(new Set(ids).size!==ids.length||ids.length!==n.blocks.length||ids.some(id=>!n.blocks.some(b=>b.id===id)))throw new Error('整理结果未完整保留原内容');const page=n.pages[0];n.pages.forEach(p=>p.blockOrder=[]);page.blockOrder=ids;n.blocks.forEach(b=>b.pageId=page.id);if(typeof data.summary==='string'&&data.summary)createParagraphBlock(n,'AI 摘要（非原文）：'+data.summary,page.id);if(Array.isArray(data.newExplanations))for(const text of data.newExplanations)createParagraphBlock(n,'AI 新增说明（待核对）：'+String(text),page.id);
      }}
    }catch(error){await this.patch(noteId,draftId,d=>{d.status='failed';d.error=(error as Error).message+'；结果未采用，原稿保留。';d.task!.phase='failed';d.result=result;});return;}
    try{
      let savedDraftId=draftId,accepted=false;
      const n=await this.repository.updateNote(noteId,n=>{let d=n.drafts.find(d=>d.id===draftId);if(!d?.task||d.status==='cancelled')return;verifyReply(d.task,reply);const expected=d.task.contentFingerprint;if(expected&&contentFingerprint(d.latex,d.content)!==expected){const original=d,alternateId='result-'+manuscriptDigest(noteId+'\0'+draftId+'\0'+d.task.clientRequestId).slice(0,40);original.status='completed';original.task!.phase='completed';original.task!.remoteId=reply.taskId;original.error='已保留你的手工内容；模型结果另存为一条草稿。';d=n.drafts.find(d=>d.id===alternateId)||createDraft(n,{...structuredClone(original),id:alternateId,title:original.title+' · 识别结果',version:0,latex:undefined,content:undefined,uses:[],reviewed:false});savedDraftId=d.id;}d.status='completed';d.task!.phase='completed';d.task!.remoteId=reply.taskId;d.task!.updatedAt=now();d.result=result;d.usage=reply.usage;d.cost=reply.cost;if(latex!==undefined)d.latex=latex;if(content)d.content=content;d.version++;d.reviewed=false;d.unread=true;d.updatedAt=now();if(d.type==='formula'){const r=record(result);d.uncertainties=Array.isArray(r.uncertainSymbols)?r.uncertainSymbols.filter((s):s is string=>typeof s==='string'):[];}accepted=true;},{allowDeleted:true,preserveEditedAt:true});
      this.unsaved.delete(this.key(noteId,draftId));if(n&&accepted){this.options.saved(n,savedDraftId,true);if(!n.deletedAt)this.options.notify(`“${n.title}”的${draft.type==='formula'?'公式':'页面'}已存入草稿箱${savedDraftId!==draftId?'；手工修改单独保留':''}`);}
    }catch(error){if(error instanceof NoteDeletedError)return;if(error instanceof TaskReplyMismatch){await this.fail(noteId,draftId,error,false);return;}this.unsaved.set(this.key(noteId,draftId),{noteId,draftId,reply});this.options.notify(`结果已收到但未保存：${(error as Error).message}。请重试保存或导出结果，勿重新识别。`);}
  }
  private async fail(noteId:string,draftId:string,error:unknown,known:boolean){if(error instanceof NoteDeletedError)return;try{await this.patch(noteId,draftId,d=>{if(['completed','cancelled'].includes(d.status))return;d.status=known?'failed':'unknown';d.error=(error as Error).message||'连接已中断，结果未知；未自动重复调用';if(d.task)d.task.phase=d.status;});}catch{} }
  hasUnsaved(noteId:string,draftId:string){return this.unsaved.has(this.key(noteId,draftId));}
  async retrySaving(noteId:string,draftId:string){const item=this.unsaved.get(this.key(noteId,draftId));if(item)await this.receive(noteId,draftId,item.reply);}
  unsavedResult(noteId:string,draftId:string){return this.unsaved.get(this.key(noteId,draftId))?.reply;}
  async cancel(noteId:string,draftId:string){let task:NotebookTask|undefined;await this.patch(noteId,draftId,d=>{if(!d.task||d.status==='completed')return;d.status='cancelled';d.error='已取消收取；供应商可能已开始计算，费用仍需核对。';d.task.phase=d.status;task=structuredClone(d.task);});if(!task)return;this.unsaved.delete(this.key(noteId,draftId));this.running.get(this.key(noteId,draftId))?.abort();if(!task.remoteId)return;const token=await this.options.vault.tokenFor(task);if(token!==null)try{await requestJson(`${task.gateway}/v1/${task.kind==='formula'?'recognitions':'tasks'}/${encodeURIComponent(task.remoteId)}/cancel?installationId=${encodeURIComponent(task.installationId)}`,{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{ }},{timeoutMs:5000});}catch{}}
  forget(noteId:string){for(const[key,controller]of this.running)if(key.startsWith(noteId+':'))controller.abort();for(const key of this.unsaved.keys())if(key.startsWith(noteId+':'))this.unsaved.delete(key);}
}
