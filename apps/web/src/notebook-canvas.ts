import { drawStroke, hitStroke, selectedStrokes, boundsOf, cropSelection, type Stroke, type Bounds, type Point } from './geometry.ts';
import { renderInkPage, type FullPageImage } from './page-render.ts';
import { newId } from './model.ts';
import type { PageView, PaperType } from './notebook-domain.ts';
import katex from 'katex';

export type InkTool = 'pen' | 'eraser' | 'lasso' | 'pan';
export interface CanvasMath { id:string; latex:string; x:number; y:number; deletedAt?:string }
interface State { noteId:string; pageId:string; strokes:Stroke[]; paper:PaperType; view:PageView }
interface Options { parent:HTMLElement; state:()=>State; changed:(strokes:Stroke[],reason:'ink'|'history')=>void; viewChanged:(view:PageView)=>void; selected:(ids:string[])=>void; placing:(point:{x:number;y:number})=>void; renderObjects:(transform:PageView)=>void }
const WIDTH=1000, HEIGHT=1414;
/** One mounted canvas, stable world coordinates and an independent history for every page. */
export class NotebookCanvas {
  readonly canvas=document.createElement('canvas');
  private preview=document.createElement('div');
  tool:InkTool='pen'; color='#253d35'; width=3; fingerWriting=false;
  private options:Options; private ctx:CanvasRenderingContext2D; private active:Stroke|null=null; private strokePointer:number|null=null;
  private touches=new Map<number,{x:number;y:number}>(); private palm=false; private start:{x:number;y:number;panX:number;panY:number}|null=null;
  private pinch:{distance:number;zoom:number;worldX:number;worldY:number}|null=null; private lasso:Point[]=[]; private selectedIds=new Set<string>();
  private view:PageView={zoom:1,panX:0,panY:0}; private pageId=''; private before:Stroke[]|null=null;
  private histories=new Map<string,{undo:Stroke[][];redo:Stroke[][]}>(); private placement=false; private ghost:Point|null=null; private observer:ResizeObserver;
  constructor(options:Options){this.options=options;this.ctx=this.canvas.getContext('2d')!;this.canvas.id='ink-canvas';this.canvas.setAttribute('aria-label','当前页手写纸面');this.canvas.tabIndex=0;options.parent.append(this.canvas);
    this.canvas.addEventListener('pointerdown',e=>this.down(e));this.canvas.addEventListener('pointermove',e=>this.move(e));this.canvas.addEventListener('pointerup',e=>this.up(e));this.canvas.addEventListener('pointercancel',e=>this.up(e,true));
    this.canvas.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();const p=this.local(e),old=this.view.zoom,next=Math.max(.25,Math.min(3,old*Math.exp(-e.deltaY*.003)));this.view.panX=p.x-(p.x-this.view.panX)*next/old;this.view.panY=p.y-(p.y-this.view.panY)*next/old;this.view.zoom=next;}else{e.preventDefault();this.view.panX-=e.deltaX;this.view.panY-=e.deltaY;}this.saveView();this.draw();},{passive:false});
    this.preview.className='placement-formula-preview';this.preview.hidden=true;options.parent.append(this.preview);
    this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(options.parent);
  }
  private local(e:Pick<PointerEvent,'clientX'|'clientY'>){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  private point(e:PointerEvent):Point{const p=this.local(e);return{x:(p.x-this.view.panX)/this.view.zoom,y:(p.y-this.view.panY)/this.view.zoom,pressure:e.pointerType==='pen'?(e.pressure||.5):.5};}
  private history(){let h=this.histories.get(this.pageId);if(!h){h={undo:[],redo:[]};this.histories.set(this.pageId,h);}return h;}
  private capture(){if(!this.before)this.before=structuredClone(this.options.state().strokes);}
  private commit(reason:'ink'|'history'='ink'){if(this.before&&JSON.stringify(this.before)!==JSON.stringify(this.options.state().strokes)){if(reason==='ink'){const h=this.history();h.undo.push(this.before);if(h.undo.length>50)h.undo.shift();h.redo=[];}this.options.changed(this.options.state().strokes,reason);}this.before=null;}
  private inside(p:Point){return p.x>=0&&p.x<=WIDTH&&p.y>=0&&p.y<=HEIGHT;}
  private down(e:PointerEvent){if(e.button!==0)return;this.canvas.setPointerCapture(e.pointerId);const p=this.point(e);
    if(e.pointerType==='touch'){if(this.strokePointer!==null&&this.palm)return;this.touches.set(e.pointerId,this.local(e));if(this.touches.size===2){this.cancelStroke();const[a,b]=[...this.touches.values()];const x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:this.view.zoom,worldX:(x-this.view.panX)/this.view.zoom,worldY:(y-this.view.panY)/this.view.zoom};return;}if(this.touches.size>2)return;}
    if(this.placement){this.ghost=p;this.draw();return;}
    if(this.tool==='pan'||e.pointerType==='touch'&&!this.fingerWriting){const q=this.local(e);this.start={...q,panX:this.view.panX,panY:this.view.panY};return;}
    if(e.pointerType==='pen')this.palm=true;
    this.strokePointer=e.pointerId;
    if(this.tool==='pen'&&this.inside(p)){this.capture();this.active={id:newId(),color:this.color,width:this.width,points:[p]};}
    if(this.tool==='eraser'){this.capture();this.erase(p);}
    if(this.tool==='lasso'){this.lasso=[p];this.selectedIds.clear();this.options.selected([]);}
    this.draw();
  }
  private move(e:PointerEvent){if(this.placement){this.ghost=this.point(e);this.draw();return;}
    if(e.pointerType==='touch'){if(this.palm)return;if(this.touches.has(e.pointerId))this.touches.set(e.pointerId,this.local(e));if(this.pinch&&this.touches.size===2){const[a,b]=[...this.touches.values()],x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.view.zoom=Math.max(.25,Math.min(3,this.pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,this.pinch.distance)));this.view.panX=x-this.pinch.worldX*this.view.zoom;this.view.panY=y-this.pinch.worldY*this.view.zoom;this.saveView();this.draw();return;}}
    if(this.start&&this.canvas.hasPointerCapture(e.pointerId)){const p=this.local(e);this.view.panX=this.start.panX+p.x-this.start.x;this.view.panY=this.start.panY+p.y-this.start.y;this.saveView();this.draw();return;}
    if(e.pointerId!==this.strokePointer)return;const events=e.getCoalescedEvents?.()||[e];for(const event of events){const p=this.point(event);if(this.active&&this.inside(p))this.active.points.push(p);if(this.tool==='eraser')this.erase(p);if(this.tool==='lasso')this.lasso.push(p);}this.draw();
  }
  private up(e:PointerEvent,cancel=false){if(this.placement&&!cancel){const p=this.point(e);if(this.inside(p))this.options.placing({x:p.x,y:p.y});return;}
    this.touches.delete(e.pointerId);if(this.touches.size<2)this.pinch=null;this.start=null;
    if(e.pointerId===this.strokePointer){if(cancel)this.cancelStroke();else{if(this.active){this.options.state().strokes.push(this.active);this.active=null;}if(this.tool==='lasso'&&this.lasso.length>2){this.selectedIds=new Set(selectedStrokes(this.options.state().strokes,this.lasso).map(s=>s.id));this.options.selected([...this.selectedIds]);}this.lasso=[];this.commit();}this.strokePointer=null;this.palm=false;}
    if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);this.draw();
  }
  private erase(p:Point){const strokes=this.options.state().strokes;for(let i=strokes.length-1;i>=0;i--)if(hitStroke(strokes[i],p,10/this.view.zoom))strokes.splice(i,1);}
  private cancelStroke(){if(this.before){const strokes=this.options.state().strokes;strokes.splice(0,strokes.length,...this.before);}this.active=null;this.before=null;this.lasso=[];this.strokePointer=null;}
  finish(){if(this.active){this.options.state().strokes.push(this.active);this.active=null;}this.commit();this.strokePointer=null;this.lasso=[];this.palm=false;this.touches.clear();this.start=null;this.pinch=null;this.saveView();}
  setPage(){const state=this.options.state();this.active=null;this.before=null;this.lasso=[];this.strokePointer=null;this.pageId=state.noteId+':'+state.pageId;this.view={...state.view};this.selectedIds.clear();this.options.selected([]);this.placement=false;this.ghost=null;this.preview.hidden=true;this.draw();}
  setTool(tool:InkTool){this.finish();this.tool=tool;this.canvas.dataset.tool=tool;this.draw();}
  setPlacement(enabled:boolean,latex=''){this.finish();this.placement=enabled;this.ghost=null;this.preview.hidden=!enabled;try{katex.render(latex,this.preview,{throwOnError:false,trust:false});}catch{this.preview.textContent=latex;}this.canvas.classList.toggle('placing',enabled);this.draw();}
  selectAll(){this.selectedIds=new Set(this.options.state().strokes.map(s=>s.id));this.options.selected([...this.selectedIds]);this.draw();}
  selection(){const strokes=this.options.state().strokes.filter(s=>this.selectedIds.has(s.id));const image=cropSelection(strokes);return{...image,strokeIds:strokes.map(s=>s.id)};}
  fullPage(revision:string,page:string):FullPageImage{return renderInkPage(this.options.state().strokes,{revision,page});}
  hasSelection(){return this.selectedIds.size>0;}
  undo(){this.finish();const h=this.history(),previous=h.undo.pop();if(!previous)return false;h.redo.push(structuredClone(this.options.state().strokes));this.options.state().strokes.splice(0,this.options.state().strokes.length,...previous);this.options.changed(this.options.state().strokes,'history');this.draw();return true;}
  redo(){this.finish();const h=this.history(),next=h.redo.pop();if(!next)return false;h.undo.push(structuredClone(this.options.state().strokes));this.options.state().strokes.splice(0,this.options.state().strokes.length,...next);this.options.changed(this.options.state().strokes,'history');this.draw();return true;}
  currentView(){return{...this.view};}
  locate(bounds:Bounds){this.view.zoom=Math.min(1.5,Math.max(.4,(this.canvas.clientWidth-100)/Math.max(1,bounds.width)));this.view.panX=this.canvas.clientWidth/2-(bounds.x+bounds.width/2)*this.view.zoom;this.view.panY=this.canvas.clientHeight/3-(bounds.y+bounds.height/2)*this.view.zoom;this.saveView();this.draw();}
  fit(){this.view={zoom:Math.min(1,(this.canvas.clientWidth-48)/WIDTH),panX:24,panY:24};this.saveView();this.draw();}
  private saveView(){if(this.pageId)this.options.viewChanged({...this.view});}
  draw(){const state=this.options.state();if(!state)return;const dpr=devicePixelRatio||1,w=this.options.parent.clientWidth,h=this.options.parent.clientHeight;if(w<=0||h<=0)return;if(this.canvas.width!==Math.round(w*dpr)||this.canvas.height!==Math.round(h*dpr)){this.canvas.width=Math.round(w*dpr);this.canvas.height=Math.round(h*dpr);}const c=this.ctx;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);c.save();c.translate(this.view.panX,this.view.panY);c.scale(this.view.zoom,this.view.zoom);c.shadowColor='#1e36220e';c.shadowBlur=24;c.fillStyle='#fffefa';c.fillRect(0,0,WIDTH,HEIGHT);c.shadowBlur=0;c.save();c.beginPath();c.rect(0,0,WIDTH,HEIGHT);c.strokeStyle='#e5e8df';c.lineWidth=.7;if(state.paper!=='blank'){c.beginPath();for(let y=48;y<HEIGHT;y+=36){c.moveTo(0,y);c.lineTo(WIDTH,y);}if(state.paper==='grid')for(let x=28;x<WIDTH;x+=36){c.moveTo(x,0);c.lineTo(x,HEIGHT);}c.stroke();}state.strokes.forEach(s=>drawStroke(c,s));if(this.active)drawStroke(c,this.active);c.restore();const bounds=boundsOf(state.strokes.filter(s=>this.selectedIds.has(s.id)),8);if(bounds){c.strokeStyle='#35856b';c.lineWidth=1.5/this.view.zoom;c.setLineDash([7/this.view.zoom,5/this.view.zoom]);c.strokeRect(bounds.x,bounds.y,bounds.width,bounds.height);c.setLineDash([]);}if(this.lasso.length){c.strokeStyle='#35856b';c.lineWidth=1.5/this.view.zoom;c.beginPath();this.lasso.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.stroke();}c.restore();this.preview.hidden=!this.placement;if(this.placement){const p=this.ghost||{x:80,y:80};this.preview.style.left=(p.x*this.view.zoom+this.view.panX)+'px';this.preview.style.top=(p.y*this.view.zoom+this.view.panY)+'px';this.preview.style.transform='scale('+this.view.zoom+')';}this.options.renderObjects({...this.view});}
}
