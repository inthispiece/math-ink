import type { Note } from './model.ts';
import type { Draft } from './notebook-domain.ts';
import { orderedBlocks, type ContentBlock } from './page-model.ts';

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const retry=(reason:string):never=>{throw new Error(reason+'，请重新检查关联建议后再采用。');};
function sentVersion(values:unknown,id:string,label:string):number {
  if(!Array.isArray(values))return retry('缺少'+label+'的原始发送范围与版本记录');
  const matches=values.map(record).filter(block=>block.id===id);
  if(matches.length!==1||!Number.isSafeInteger(matches[0].version)||Number(matches[0].version)<0)return retry('无法核对'+label+'的原始发送版本');
  return matches[0].version as number;
}
function currentBlock(note:Note,id:string,label:string):ContentBlock {
  if(note.deletedAt)return retry(label+'所在笔记已删除');
  // Normalization can update formula/block revisions. Work on a copy so this
  // assertion never changes the caller's note while checking the latest content.
  const block=orderedBlocks(structuredClone(note)).find(block=>block.id===id);
  return block||retry(label+'已删除或已不在有效页面中');
}

/** A generated relation may only be adopted against the exact blocks sent to it. */
export function assertLinkEvidenceCurrent(owner:Note,target:Note,draft:Draft,rawLink:unknown):void {
  if(draft.deletedAt||draft.noteId!==owner.id)return retry('关联草稿已删除或不属于当前笔记');
  const link=record(rawLink),fromId=link.fromBlockId,toId=link.toBlockId;
  if(typeof fromId!=='string'||!fromId||typeof toId!=='string'||!toId)return retry('关联建议缺少有效的来源或目标');
  const request=record(draft.task?.request),input=request.input===undefined?request:record(request.input);
  if(input.noteId!==undefined&&input.noteId!==owner.id)return retry('原始发送记录与当前笔记不匹配');
  const owners=record(request.candidateOwners);
  if(owners[toId]!==undefined&&owners[toId]!==target.id)return retry('关联目标与原始候选笔记不匹配');
  const fromVersion=sentVersion(input.blocks,fromId,'来源内容'),toVersion=sentVersion(input.candidates,toId,'目标内容');
  const from=currentBlock(owner,fromId,'来源内容'),to=currentBlock(target,toId,'目标内容');
  if(from.revision!==fromVersion)return retry('来源内容在生成建议后已修改');
  if(to.revision!==toVersion)return retry('目标内容在生成建议后已修改');
  if(Array.isArray(link.evidence))for(const raw of link.evidence){const evidence=record(raw),expected=evidence.blockId===fromId?fromVersion:evidence.blockId===toId?toVersion:undefined;if(expected!==undefined&&evidence.version!==expected)return retry('关联引文版本与原始发送记录不一致');}
}
