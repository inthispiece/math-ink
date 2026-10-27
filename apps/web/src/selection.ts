import { boundsOf, containsPoint, selectedStrokes, type Bounds, type Stroke } from './geometry.ts';

export interface SelectionFormula { id:string; latex:string; x:number; y:number; scale?:number; deletedAt?:string }
export interface ContentSelection { objectIds:string[]; strokeIds:string[]; formulaIds:string[]; bounds:Bounds|null }
export interface SelectionState extends ContentSelection { noteId:string; pageId:string; revision:number|string; generation:number; otherIds?:string[] }
export interface ContentTransform { origin:{x:number;y:number}; scale:number; dx:number; dy:number }
export type FormulaBounds=(formula:SelectionFormula)=>Bounds;
export const defaultFormulaBounds:FormulaBounds=p=>({x:p.x,y:p.y,width:Math.max(120,Math.min(1200,p.latex.length*13+28))*(p.scale??1),height:68*(p.scale??1)});

export function contentBounds(strokes:Stroke[],placements:SelectionFormula[],ids:string[],mathBounds:FormulaBounds=defaultFormulaBounds):Bounds|null {
  const selected=new Set(ids),ink=boundsOf(strokes.filter(s=>selected.has(s.id)),8),boxes=placements.filter(p=>!p.deletedAt&&selected.has(p.id)).map(mathBounds);
  if(ink)boxes.push(ink);if(!boxes.length)return null;
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  return{x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
}
export function selectContent(strokes:Stroke[],placements:SelectionFormula[],polygon:{x:number;y:number}[],mathBounds:FormulaBounds=defaultFormulaBounds):ContentSelection {
  const strokeIds=selectedStrokes(strokes,polygon).map(s=>s.id),formulaIds:string[]=[];
  for(const p of placements.filter(p=>!p.deletedAt)){
    const b=mathBounds(p),corners=[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
    // Reuse the segment/polygon intersection used by handwriting, including a
    // polygon that crosses a rectangle without containing one of its corners.
    const edge:Stroke={id:p.id,width:.01,color:'#000',points:[...corners,corners[0]].map(c=>({...c,pressure:.5}))};
    if(polygon.length>=3&&(selectedStrokes([edge],polygon).length||polygon.some(c=>containsPoint(c,corners))))formulaIds.push(p.id);
  }
  const objectIds=[...strokeIds,...formulaIds];return{objectIds,strokeIds,formulaIds,bounds:contentBounds(strokes,placements,objectIds,mathBounds)};
}
export function constrainScale(strokes:Stroke[],placements:SelectionFormula[],selection:Pick<ContentSelection,'strokeIds'|'formulaIds'>,requested:number):number {
  if(!Number.isFinite(requested)||requested<=0)throw new Error('缩放比例无效');let min=.05,max=20;
  for(const p of placements.filter(p=>selection.formulaIds.includes(p.id))){min=Math.max(min,.05/(p.scale??1));max=Math.min(max,20/(p.scale??1));}
  for(const s of strokes.filter(s=>selection.strokeIds.includes(s.id))){min=Math.max(min,.1/s.width);max=Math.min(max,200/s.width);}
  return Math.max(min,Math.min(max,requested));
}
/** Apply every preview from the gesture's initial state, never from last frame. */
export function transformContent<T extends SelectionFormula>(strokes:Stroke[],placements:T[],selection:Pick<ContentSelection,'strokeIds'|'formulaIds'>,input:ContentTransform):{strokes:Stroke[];placements:T[]} {
  if(![input.origin.x,input.origin.y,input.dx,input.dy,input.scale].every(Number.isFinite))throw new Error('内容变换包含无效坐标');
  const scale=constrainScale(strokes,placements,selection,input.scale),move=(x:number,y:number)=>{const point={x:input.origin.x+(x-input.origin.x)*scale+input.dx,y:input.origin.y+(y-input.origin.y)*scale+input.dy};if(Math.abs(point.x)>1e6||Math.abs(point.y)>1e6)throw new Error('内容位置超出支持范围');return point;};
  const outStrokes=strokes.map(s=>selection.strokeIds.includes(s.id)?{...s,width:s.width*scale,points:s.points.map(p=>({...p,...move(p.x,p.y)}))}:structuredClone(s));
  const outPlacements=placements.map(p=>selection.formulaIds.includes(p.id)?{...p,...move(p.x,p.y),scale:(p.scale??1)*scale}:structuredClone(p));
  return{strokes:outStrokes,placements:outPlacements};
}
