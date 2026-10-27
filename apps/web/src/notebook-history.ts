import {createBackup,type Note,type Formula} from './model.ts';
import type {Stroke} from './geometry.ts';
import type {ContentBlock} from './page-model.ts';
import {refreshBlockHashes} from './page-model.ts';
import type {Notebook,DraftInsertion,FormulaPlacement,DraftUsage} from './notebook-domain.ts';

export type HistoryKind='ink'|'insert'|'delete'|'edit'|'move'|'scale'|'transform';
export type HistoryDirection='undo'|'redo';
interface PageUse {draftId:string;use:DraftUsage}
export interface PageContentSnapshot {noteId:string;pageId:string;strokes:Stroke[];placements:FormulaPlacement[];formulas:Formula[];blocks:ContentBlock[];blockOrder:string[];insertions:DraftInsertion[];uses:PageUse[]}
export interface HistoryCommand {id:string;kind:HistoryKind;noteId:string;pageId:string;before:PageContentSnapshot;after:PageContentSnapshot}
export interface HistoryTicket {readonly id:string;readonly commandId:string;readonly kind:HistoryKind;readonly noteId:string;readonly pageId:string;readonly direction:HistoryDirection}
const copy=<T>(value:T):T=>structuredClone(value);
const useKey=(item:PageUse)=>item.draftId+'\0'+item.use.operationId;
const entityKey=(item:{id:string})=>item.id;
type Collection='strokes'|'placements'|'formulas'|'blocks'|'insertions'|'uses';

/** Read only: view state, draft bodies, resources and other pages never enter content history. */
export function capturePageContent(note:Note,pageId:string):PageContentSnapshot {
  const n=note as Notebook,page=n.pages?.find(p=>p.id===pageId);
  if(!page||!n.pageStrokes?.[pageId])throw new Error('历史页面不存在');
  const blocks=n.blocks.filter(b=>b.pageId===pageId),insertions=n.insertions.filter(i=>i.pageId===pageId);
  const ids=new Set([...insertions.map(i=>i.formulaId),...blocks.flatMap(b=>[b.content.formulaId,...(b.content.runs||[]).filter(r=>r.type==='formula').map(r=>r.formulaId)])]);
  return copy({noteId:note.id,pageId,strokes:n.pageStrokes[pageId],placements:n.placements.filter(p=>p.pageId===pageId),formulas:n.formulas.filter(f=>ids.has(f.id)),blocks,blockOrder:page.blockOrder,insertions,uses:n.drafts.flatMap(d=>d.uses.filter(u=>u.pageId===pageId).map(use=>({draftId:d.id,use})))});
}

function normalized(value:unknown,kind:Collection):string {
  if(value===undefined)return 'absent';
  const next=copy(value) as Record<string,unknown>;
  if(kind==='blocks'){delete next.revision;delete next.contentHash;}
  if(kind==='placements'||kind==='formulas')next.scale??=1;
  if(kind==='uses'){const use=next.use as Record<string,unknown>;use.insertedAt??=use.createdAt;}
  // Persistence may reconstruct records with the same values in another key order.
  // Canonicalize object keys recursively; array order and every field value remain significant.
  return JSON.stringify(next,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
}
function changed<T>(before:T[],after:T[],key:(item:T)=>string,kind:Collection):Set<string>{
  const a=new Map(before.map(item=>[key(item),item])),b=new Map(after.map(item=>[key(item),item]));
  const ids=new Set([...a.keys(),...b.keys()].filter(id=>normalized(a.get(id),kind)!==normalized(b.get(id),kind)));
  const commonA=before.map(key).filter(id=>b.has(id)),commonB=after.map(key).filter(id=>a.has(id));
  if(commonA.join('\0')!==commonB.join('\0'))commonA.forEach((id,index)=>{if(commonB[index]!==id){ids.add(id);ids.add(commonB[index]);}});
  return ids;
}
function insertOrdered<T>(current:T[],target:T[],ids:Set<string>,key:(item:T)=>string):T[]{
  const result=current.filter(item=>!ids.has(key(item))),order=target.map(key);
  for(const item of target){const id=key(item);if(!ids.has(id))continue;const index=order.indexOf(id);let position=-1;
    for(let i=index-1;i>=0;i--){const found=result.findIndex(x=>key(x)===order[i]);if(found>=0){position=found+1;break;}}
    if(position<0)for(let i=index+1;i<order.length;i++){const found=result.findIndex(x=>key(x)===order[i]);if(found>=0){position=found;break;}}
    result.splice(position<0?result.length:position,0,copy(item));
  }
  return result;
}
function isInsertTombstone<T>(current:T|undefined,target:T|undefined,kind:Collection):boolean {
  if(!current||!target||!['placements','insertions','uses'].includes(kind))return false;
  const item=copy(current) as Record<string,unknown>;
  const state=kind==='uses'?item.use as Record<string,unknown>:item,field=kind==='placements'?'deletedAt':'undoneAt';
  if(!state[field])return false;delete state[field];
  return normalized(item,kind)===normalized(target,kind);
}
function patchCollection<T>(current:T[],from:T[],to:T[],ids:Set<string>,key:(item:T)=>string,kind:Collection,ticket:HistoryTicket,at:string):T[]{
  const a=new Map(from.map(item=>[key(item),item])),b=new Map(to.map(item=>[key(item),item]));
  for(const id of ids){const actual=current.find(item=>key(item)===id),expected=a.get(id);
    if(normalized(actual,kind)!==normalized(expected,kind)&&!(ticket.kind==='insert'&&ticket.direction==='redo'&&expected===undefined&&isInsertTombstone(actual,b.get(id),kind)))throw new Error('相关内容已变化，未执行历史操作');
  }
  const target=copy(to);
  if(ticket.kind==='insert'&&ticket.direction==='undo'&&['placements','insertions','uses'].includes(kind))for(const id of ids)if(!b.has(id)){
    const previous=current.find(item=>key(item)===id);if(!previous)continue;
    const tombstone=copy(previous) as Record<string,unknown>,state=kind==='uses'?tombstone.use as Record<string,unknown>:tombstone;
    state[kind==='placements'?'deletedAt':'undoneAt']=at;target.push(tombstone as T);
  }
  return insertOrdered(current,target,ids,key);
}
function relevantChange(before:PageContentSnapshot,after:PageContentSnapshot):boolean {
  return (['strokes','placements','formulas','blocks','insertions'] as const).some(kind=>changed(before[kind] as {id:string}[],after[kind] as {id:string}[],entityKey,kind).size)||changed(before.uses,after.uses,useKey,'uses').size>0||before.blockOrder.join('\0')!==after.blockOrder.join('\0');
}

/** Applies a command to a clone of the CURRENT note, then publishes only its related content. */
function applyCommand(note:Note,command:HistoryCommand,ticket:HistoryTicket):void {
  if(note.id!==command.noteId)throw new Error('历史操作不属于当前笔记');
  const n=note as Notebook,page=n.pages.find(p=>p.id===command.pageId&&!p.deletedAt&&!p.nativeMissing);
  if(!page||n.currentPageId!==page.id)throw new Error('历史操作不属于当前页面');
  const from=ticket.direction==='undo'?command.after:command.before,to=ticket.direction==='undo'?command.before:command.after;
  const next=copy(n),at=new Date().toISOString(),nextPage=next.pages.find(p=>p.id===page.id)!;
  const strokes=changed(from.strokes,to.strokes,entityKey,'strokes'),placements=changed(from.placements,to.placements,entityKey,'placements'),formulas=changed(from.formulas,to.formulas,entityKey,'formulas'),blocks=changed(from.blocks,to.blocks,entityKey,'blocks'),insertions=changed(from.insertions,to.insertions,entityKey,'insertions');
  next.pageStrokes[page.id]=patchCollection(next.pageStrokes[page.id],from.strokes,to.strokes,strokes,entityKey,'strokes',ticket,at);
  next.placements=patchCollection(next.placements,from.placements,to.placements,placements,entityKey,'placements',ticket,at);
  next.formulas=patchCollection(next.formulas,from.formulas,to.formulas,formulas,entityKey,'formulas',ticket,at);
  next.blocks=patchCollection(next.blocks,from.blocks,to.blocks,blocks,entityKey,'blocks',ticket,at);
  next.insertions=patchCollection(next.insertions,from.insertions,to.insertions,insertions,entityKey,'insertions',ticket,at);
  const draftIds=new Set(next.drafts.map(d=>d.id)),fromUses=from.uses.filter(u=>draftIds.has(u.draftId)),toUses=to.uses.filter(u=>draftIds.has(u.draftId)),uses=changed(fromUses,toUses,useKey,'uses');
  const currentUses=next.drafts.flatMap(d=>d.uses.map(use=>({draftId:d.id,use}))),patchedUses=patchCollection(currentUses,fromUses,toUses,uses,useKey,'uses',ticket,at);
  for(const draft of next.drafts)draft.uses=patchedUses.filter(item=>item.draftId===draft.id).map(item=>item.use);
  const orderChanged=new Set([...blocks,...changed(from.blockOrder.map(id=>({id})),to.blockOrder.map(id=>({id})),entityKey,'blocks')]);
  nextPage.blockOrder=insertOrdered(nextPage.blockOrder.map(id=>({id})),to.blockOrder.map(id=>({id})),orderChanged,entityKey).map(item=>item.id);
  const revised:string[]=[];
  for(const block of next.blocks)if(block.pageId===page.id&&(blocks.has(block.id)||formulas.has(block.content.formulaId||'')||(block.content.runs||[]).some(run=>run.type==='formula'&&formulas.has(run.formulaId)))){
    block.revision=Math.max(block.revision,n.blocks.find(b=>b.id===block.id)?.revision||0)+1;revised.push(block.id);
  }
  refreshBlockHashes(next,revised);
  if(formulas.size||blocks.size)next.contentRevision++;
  next.strokes=next.pageStrokes[page.id];
  createBackup([next]); // Integrity validation does not mutate the current note or draft body.
  n.pageStrokes[page.id]=next.pageStrokes[page.id];n.strokes=n.pageStrokes[page.id];n.placements=next.placements;n.formulas=next.formulas;n.blocks=next.blocks;n.insertions=next.insertions;page.blockOrder=nextPage.blockOrder;n.contentRevision=next.contentRevision;
  for(const draft of n.drafts)draft.uses=next.drafts.find(item=>item.id===draft.id)!.uses;
}

/** One lock covers execution; commit immediately after apply, BEFORE persistence. */
export class NotebookHistory {
  private sequence=0;
  private stacks=new Map<string,{undo:HistoryCommand[];redo:HistoryCommand[]}>();
  private pending:{ticket:HistoryTicket;command:HistoryCommand;applied:boolean}|undefined;
  private key(noteId:string,pageId:string){return noteId+'\0'+pageId;}
  private stack(noteId:string,pageId:string){const key=this.key(noteId,pageId);let stack=this.stacks.get(key);if(!stack){stack={undo:[],redo:[]};this.stacks.set(key,stack);}return stack;}
  record(kind:HistoryKind,before:PageContentSnapshot,after:PageContentSnapshot):HistoryCommand|null {
    if(this.pending)throw new Error('历史操作正在执行，请先完成或取消');
    if(before.noteId!==after.noteId||before.pageId!==after.pageId)throw new Error('不能记录跨笔记或跨页历史');
    if(!relevantChange(before,after))return null;
    const command:HistoryCommand={id:'content-history-'+(++this.sequence),kind,noteId:before.noteId,pageId:before.pageId,before:copy(before),after:copy(after)},stack=this.stack(before.noteId,before.pageId);stack.undo.push(command);if(stack.undo.length>100)stack.undo.shift();stack.redo=[];return copy(command);
  }
  canUndo(noteId:string,pageId:string){return !this.pending&&this.stack(noteId,pageId).undo.length>0;}
  canRedo(noteId:string,pageId:string){return !this.pending&&this.stack(noteId,pageId).redo.length>0;}
  peek(noteId:string,pageId:string,direction:HistoryDirection):HistoryTicket|null {
    if(this.pending)return null;const command=this.stack(noteId,pageId)[direction].at(-1);if(!command)return null;
    const ticket:HistoryTicket={id:'history-ticket-'+(++this.sequence),commandId:command.id,kind:command.kind,noteId,pageId,direction};this.pending={ticket,command,applied:false};return {...ticket};
  }
  apply(note:Note,ticket:HistoryTicket):boolean {const active=this.pending;if(!active||active.ticket.id!==ticket.id||active.applied)return false;applyCommand(note,active.command,active.ticket);active.applied=true;return true;}
  commit(ticket:HistoryTicket):boolean {const active=this.pending;if(!active||active.ticket.id!==ticket.id||!active.applied)return false;const stack=this.stack(active.command.noteId,active.command.pageId),direction=active.ticket.direction;if(stack[direction].at(-1)?.id!==active.command.id)throw new Error('历史顺序已变化');stack[direction].pop();stack[direction==='undo'?'redo':'undo'].push(active.command);this.pending=undefined;return true;}
  cancel(ticket:HistoryTicket):boolean {if(!this.pending||this.pending.ticket.id!==ticket.id||this.pending.applied)return false;this.pending=undefined;return true;}
  clear(noteId?:string,pageId?:string):void {if(this.pending)throw new Error('历史操作尚未结束');if(!noteId){this.stacks.clear();return;}for(const key of this.stacks.keys())if(key.startsWith(noteId+'\0')&&(!pageId||key===this.key(noteId,pageId)))this.stacks.delete(key);}
}
