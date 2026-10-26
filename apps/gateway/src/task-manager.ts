import { createHash, randomUUID } from 'node:crypto';
import type { GatewayConfig } from './config.ts';
import { GatewayError } from './types.ts';
import type { ProviderName, RecognitionProvider, TaskRequest, TaskResponse, TokenUsage } from './types.ts';
import { QuotaStore } from './store.ts';
import { estimateCost, reserveAmount, unknownUsage } from './accounting.ts';
import { validateTaskOutput } from './tasks.ts';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
/** One bounded generation per task. Request bodies and result text never enter SQLite. */
export class TaskManager {
  private readonly tasks=new Map<string,{principal:string;expires:number;value:TaskResponse}>();
  private readonly controllers=new Map<string,AbortController>();
  private closed=false;
  private readonly config:GatewayConfig;
  private readonly store:QuotaStore;
  private readonly now:()=>number;
  constructor(config:GatewayConfig,store:QuotaStore,now:()=>number=Date.now){this.config=config;this.store=store;this.now=now;}
  get(id:string,principalHash:string):TaskResponse|undefined {
    const cached=this.tasks.get(id);
    if(cached&&cached.principal===principalHash&&cached.expires>this.now())return cached.value;
    if(cached&&cached.expires<=this.now())this.tasks.delete(id);
    return this.store.taskMetadata(id,principalHash);
  }
  byRequest(clientRequestId:string,provider:ProviderName,principalHash:string):TaskResponse|undefined {
    const key=hash(`${provider}\0task\0${principalHash}\0${clientRequestId}`);
    const id=this.store.taskIdByRequestKey(key,principalHash);
    return id?this.get(id,principalHash):undefined;
  }
  submit(input:TaskRequest,selected:RecognitionProvider,principalHash:string):TaskResponse {
    if(selected.name!=='deepseek'||!selected.task||selected.simulated)throw new GatewayError('PROVIDER_CAPABILITY_UNSUPPORTED','所选模式尚未开放这项任务。可手动编辑；只有主动选择 DeepSeek 后才会上传云端。',422);
    if(!selected.configured)throw new GatewayError('PROVIDER_NOT_CONFIGURED','DeepSeek 尚未配置，未提交任何生成请求；请在服务端配置密钥。',503);
    const requestKey=hash(`${selected.name}\0task\0${principalHash}\0${input.clientRequestId}`);
    const fingerprint=hash(JSON.stringify(input));
    // The UTF-8 byte upper bound plus visual/system allowance is deliberately conservative.
    const reserve=reserveAmount(this.config,selected.model,this.config.taskMaxContextBytes+49152,this.config.taskMaxOutputTokens);
    const reservation=this.store.reserve({requestKey,requestId:randomUUID(),installationHash:principalHash,fingerprint,now:this.now(),countQuota:true,budget:{principalHash,amountCny:reserve,provider:selected.name,model:selected.model,operation:input.type,deadlineMs:this.config.taskTimeoutMs}},this.config);
    if(reservation.existing){
      const found=this.get(reservation.requestId,principalHash);
      if(found)return found;
      return this.metadata(input,selected,reservation.requestId,'result-unavailable');
    }
    const task=this.metadata(input,selected,reservation.requestId,'pending');
    this.store.createTask(task,requestKey,principalHash);
    this.set(task,principalHash);
    const controller=new AbortController();this.controllers.set(task.taskId,controller);
    queueMicrotask(()=>void this.run(input,selected,task,principalHash,requestKey,reserve,controller));
    return {...task};
  }
  cancel(id:string,principalHash:string):TaskResponse|undefined {
    const task=this.get(id,principalHash);if(!task)return;
    if(task.status==='pending'||task.status==='running')this.controllers.get(id)?.abort(new GatewayError('TASK_CANCELLED','任务已取消，原稿和已保存草稿保留。供应商可能已计费，未知费用仍占用预留金额。',409));
    return task;
  }
  private metadata(input:TaskRequest,selected:RecognitionProvider,id:string,status:TaskResponse['status']):TaskResponse {
    const time=new Date(this.now()).toISOString();
    return {taskId:id,type:input.type,provider:selected.name,model:selected.model||null,status,sourceRevision:input.sourceRevision,contentRevision:input.input.contentRevision,createdAt:time,updatedAt:time,steps:[{id:'generate',status:status==='pending'?'pending':'error'}],...(status==='result-unavailable'?{error:{code:'TASK_RESULT_UNAVAILABLE',message:'任务曾经提交，结果当前不可用；不会自动重做，云端新任务可能再次计费。',retryable:false}}:{})};
  }
  private set(task:TaskResponse,principal:string){
    for(const [id,cached]of this.tasks)if(cached.expires<=this.now()&&!this.controllers.has(id))this.tasks.delete(id);
    // Never evict running tasks; enforce configured concurrency before this point.
    while(this.tasks.size>=this.config.maxCachedResults){const id=[...this.tasks.keys()].find(k=>!this.controllers.has(k));if(!id)break;this.tasks.delete(id);}
    this.tasks.set(task.taskId,{principal,expires:this.now()+this.config.resultTtlMs,value:task});
  }
  private async run(input:TaskRequest,selected:RecognitionProvider,task:TaskResponse,principal:string,key:string,reserved:number,controller:AbortController){
    let timer:ReturnType<typeof setTimeout>|undefined;
    let usage:TokenUsage|undefined;
    try{
      if(controller.signal.aborted)throw controller.signal.reason;
      task.status='running';task.steps=[{id:'generate',status:'running'}];task.updatedAt=new Date(this.now()).toISOString();
      if(!this.closed)this.store.updateTask(task.taskId,'running',this.now());
      const aborted=new Promise<never>((_,reject)=>{const fail=()=>reject(controller.signal.reason instanceof GatewayError?controller.signal.reason:new GatewayError('TASK_CANCELLED','任务已取消；云端可能已计费。',409));controller.signal.addEventListener('abort',fail,{once:true});timer=setTimeout(()=>controller.abort(new GatewayError('TASK_TIMEOUT','整页任务超过总执行时间。未自动重试；供应商可能已计费，请核对设备中的草稿。',504)),this.config.taskTimeoutMs);});
      const generated=await Promise.race([selected.task!(input,controller.signal),aborted]);
      usage=generated.usage;
      task.result=validateTaskOutput(generated.result,input);task.status='ok';task.steps=[{id:'generate',status:'ok'}];
    }catch(error){
      const safe=error instanceof GatewayError?error:new GatewayError('TASK_FAILED','任务服务暂时不可用，未应用任何内容，请核对后手动提交新任务。',502);
      usage=safe.usage||usage;task.status='error';task.steps=[{id:'generate',status:'error'}];task.error={code:safe.code,message:safe.message,retryable:false};
    }finally{
      if(timer)clearTimeout(timer);this.controllers.delete(task.taskId);
      task.usage=usage||unknownUsage();task.cost=estimateCost(usage,selected.model,this.config.priceConfig,reserved);task.updatedAt=new Date(this.now()).toISOString();
      if(!this.closed){this.store.complete(key,task.status==='ok'?'ok':'error');this.store.settle(key,usage,task.cost);this.store.updateTask(task.taskId,task.status,this.now(),task.error?.code);this.set(task,principal);}
    }
  }
  close(){this.closed=true;for(const controller of this.controllers.values())controller.abort();this.controllers.clear();this.tasks.clear();}
}
