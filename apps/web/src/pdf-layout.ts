export const PDF_QUALITY={screen:1.5,standard:2,print:3} as const;
export type PdfQuality=keyof typeof PDF_QUALITY;
export function parsePageRange(value:string,total:number):number[]{
  if(!Number.isSafeInteger(total)||total<1)throw new Error('文档页数无效');if(!value.trim())return Array.from({length:total},(_,i)=>i);
  const selected=new Set<number>();for(const part of value.split(/[,，]/)){const match=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);if(!match)throw new Error('页码格式应为 1-3,5');const start=Number(match[1]),end=Number(match[2]||match[1]);if(start<1||end>total||end<start)throw new Error('页码范围超出文档或顺序无效');for(let i=start;i<=end;i++)selected.add(i-1);}return[...selected].sort((a,b)=>a-b);
}
export interface BlockSlice{id:string;offset:number;height:number}
/** Layout at the chosen font size. Tall blocks continue, never shrink the whole document. */
export function paginateBlocks(blocks:{id:string;height:number;groupId?:string}[],height:number):BlockSlice[][]{
  if(!Number.isFinite(height)||height<1)throw new Error('PDF 可用高度无效');const pages:BlockSlice[][]=[];let page:BlockSlice[]=[],used=0;
  const push=()=>{if(page.length){pages.push(page);page=[];used=0;}};
  const append=(block:typeof blocks[number])=>{if(block.height<=height){if(used+block.height>height)push();page.push({id:block.id,offset:0,height:block.height});used+=block.height;return;}push();for(let offset=0;offset<block.height;){const take=Math.min(height,block.height-offset);page.push({id:block.id,offset,height:take});used=take;offset+=take;if(offset<block.height)push();}};
  for(let start=0;start<blocks.length;){let end=start+1;const group=blocks[start].groupId;if(group)while(end<blocks.length&&blocks[end].groupId===group)end++;let total=0;for(let i=start;i<end;i++){if(!Number.isFinite(blocks[i].height)||blocks[i].height<0)throw new Error('内容块高度无效');total+=blocks[i].height;}if(total<=height&&used+total>height)push();for(let i=start;i<end;i++)append(blocks[i]);start=end;}
  push();return pages.length?pages:[[]];
}
